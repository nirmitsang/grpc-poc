const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const MockDatabase = require('../database/mock-database');

class GrpcServer {
  constructor(port = 50051) {
    this.port = port;
    this.server = new grpc.Server();
    this.db = new MockDatabase();
    this.metrics = {
      requests: 0,
      totalResponseTime: 0,
      errors: 0,
      bytesTransferred: 0,
      streamingConnections: 0,
      maxStreamingConnections: 0,
      messagesSent: 0
    };
    
    this.loadProtoDefinition();
    this.setupServices();
  }

  loadProtoDefinition() {
    const PROTO_PATH = path.join(__dirname, '../proto/data-service.proto');
    
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });

    this.proto = grpc.loadPackageDefinition(packageDefinition).dataservice;
  }

  setupServices() {
    this.server.addService(this.proto.DataService.service, {
      GetRecord: this.getRecord.bind(this),
      GetRecords: this.getRecords.bind(this),
      GetMultipleRecords: this.getMultipleRecords.bind(this),
      SearchRecords: this.searchRecords.bind(this),
      StreamRecords: this.streamRecords.bind(this),
      BulkUpload: this.bulkUpload.bind(this),
      BidirectionalSync: this.bidirectionalSync.bind(this)
    });
  }

  // Utility method to track metrics
  trackRequest(startTime, bytesEstimate = 0, isError = false) {
    const responseTime = Date.now() - startTime;
    this.metrics.requests++;
    this.metrics.totalResponseTime += responseTime;
    this.metrics.bytesTransferred += bytesEstimate;
    
    if (isError) {
      this.metrics.errors++;
    }
  }

  // Convert database record to protobuf format
  convertToProtoRecord(record) {
    return {
      id: record.id,
      account_number: record.account_number,
      customer_id: record.customer_id,
      balance: record.balance,
      currency: record.currency,
      status: record.status,
      created_timestamp: record.created_timestamp,
      updated_timestamp: record.updated_timestamp,
      recent_transactions: record.recent_transactions || [],
      metadata: {
        branch_code: record.metadata.branch_code,
        product_type: record.metadata.product_type,
        tags: record.metadata.tags || [],
        custom_fields: record.metadata.custom_fields || {}
      }
    };
  }

  async getRecord(call, callback) {
    const startTime = Date.now();
    
    try {
      const { id, include_transactions = true } = call.request;
      
      const record = await this.db.findById(id, include_transactions);
      
      if (!record) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: 'Record not found'
        });
      }

      const protoRecord = this.convertToProtoRecord(record);
      this.trackRequest(startTime, JSON.stringify(protoRecord).length);
      
      callback(null, protoRecord);
    } catch (error) {
      this.trackRequest(startTime, 0, true);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    }
  }

  async getRecords(call, callback) {
    const startTime = Date.now();
    
    try {
      const { ids, include_transactions = true, limit } = call.request;
      
      const recordIds = limit ? ids.slice(0, limit) : ids;
      const records = await this.db.findByIds(recordIds, include_transactions);
      
      const response = {
        records: records.map(r => this.convertToProtoRecord(r)),
        total_count: records.length,
        has_more: limit && ids.length > limit
      };

      this.trackRequest(startTime, JSON.stringify(response).length);
      callback(null, response);
    } catch (error) {
      this.trackRequest(startTime, 0, true);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    }
  }

  async getMultipleRecords(call, callback) {
    const startTime = Date.now();
    
    try {
      const filters = call.request;
      const records = await this.db.findMultiple(filters);
      const queryTime = Date.now() - startTime;

      const response = {
        records: records.map(r => this.convertToProtoRecord(r)),
        total_found: records.length,
        query_time_ms: queryTime
      };

      this.trackRequest(startTime, JSON.stringify(response).length);
      callback(null, response);
    } catch (error) {
      this.trackRequest(startTime, 0, true);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    }
  }

  async searchRecords(call, callback) {
    const startTime = Date.now();
    
    try {
      const { query, fields, filters, page, page_size, sort_by, sort_desc } = call.request;
      
      const result = await this.db.search(query, filters, { page, page_size });

      const response = {
        records: result.records.map(r => this.convertToProtoRecord(r)),
        total_results: result.total_results,
        page: result.page,
        total_pages: result.total_pages,
        facets: []
      };

      this.trackRequest(startTime, JSON.stringify(response).length);
      callback(null, response);
    } catch (error) {
      this.trackRequest(startTime, 0, true);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    }
  }

  // Server-side streaming - Big advantage of gRPC!
  async streamRecords(call) {
    const startTime = Date.now();
    this.metrics.streamingConnections++;
    this.metrics.maxStreamingConnections = Math.max(
      this.metrics.maxStreamingConnections, 
      this.metrics.streamingConnections
    );

    try {
      const { filter, batch_size = 100, real_time = false } = call.request;
      
      // Simulate streaming large dataset
      const allRecords = Array.from(this.db.data.values());
      let sentCount = 0;

      for (let i = 0; i < allRecords.length; i += batch_size) {
        const batch = allRecords.slice(i, i + batch_size);
        
        for (const record of batch) {
          if (call.cancelled) {
            break;
          }

          const protoRecord = this.convertToProtoRecord(record);
          call.write(protoRecord);
          this.metrics.messagesSent++;
          sentCount++;

          // Simulate real-time delay
          if (real_time && sentCount % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      this.trackRequest(startTime, sentCount * 500); // Estimate bytes
      call.end();
    } catch (error) {
      this.trackRequest(startTime, 0, true);
      call.destroy(error);
    } finally {
      this.metrics.streamingConnections--;
    }
  }

  // Client-side streaming
  bulkUpload(call, callback) {
    const startTime = Date.now();
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    call.on('data', (record) => {
      processedCount++;
      
      try {
        // Simulate processing and validation
        if (record.id && record.account_number) {
          this.db.data.set(record.id, record);
          successCount++;
        } else {
          errorCount++;
          errors.push(`Invalid record ${processedCount}: missing required fields`);
        }
      } catch (error) {
        errorCount++;
        errors.push(`Error processing record ${processedCount}: ${error.message}`);
      }
    });

    call.on('end', () => {
      const response = {
        processed_count: processedCount,
        success_count: successCount,
        error_count: errorCount,
        errors: errors.slice(0, 10) // Limit error messages
      };

      this.trackRequest(startTime, JSON.stringify(response).length);
      callback(null, response);
    });

    call.on('error', (error) => {
      this.trackRequest(startTime, 0, true);
      callback({
        code: grpc.status.INTERNAL,
        message: error.message
      });
    });
  }

  // Bidirectional streaming
  bidirectionalSync(call) {
    const startTime = Date.now();
    this.metrics.streamingConnections++;

    const clientId = `client_${Date.now()}`;
    console.log(`Bidirectional sync started for ${clientId}`);

    call.on('data', async (syncRequest) => {
      try {
        const { client_id, last_sync_timestamp, record_ids } = syncRequest;
        
        // Find updated records since last sync
        const updatedRecords = [];
        const deletedRecordIds = [];

        if (record_ids && record_ids.length > 0) {
          for (const id of record_ids) {
            const record = this.db.data.get(id);
            if (record && record.updated_timestamp > last_sync_timestamp) {
              updatedRecords.push(this.convertToProtoRecord(record));
            } else if (!record) {
              deletedRecordIds.push(id);
            }
          }
        }

        const syncResponse = {
          updated_records: updatedRecords,
          deleted_record_ids: deletedRecordIds,
          sync_timestamp: Date.now()
        };

        call.write(syncResponse);
        this.metrics.messagesSent++;
      } catch (error) {
        call.destroy(error);
      }
    });

    call.on('end', () => {
      console.log(`Bidirectional sync ended for ${clientId}`);
      this.trackRequest(startTime, this.metrics.messagesSent * 200);
      this.metrics.streamingConnections--;
      call.end();
    });

    call.on('error', (error) => {
      console.error(`Sync error for ${clientId}:`, error);
      this.trackRequest(startTime, 0, true);
      this.metrics.streamingConnections--;
    });
  }

  getMetrics() {
    const dbMetrics = this.db.getMetrics();
    
    return {
      server: {
        ...this.metrics,
        avgResponseTime: this.metrics.totalResponseTime / Math.max(this.metrics.requests, 1),
        errorRate: (this.metrics.errors / Math.max(this.metrics.requests, 1)) * 100,
        requestsPerSecond: this.metrics.requests / (process.uptime() || 1),
        mbTransferred: this.metrics.bytesTransferred / (1024 * 1024),
        activeStreams: this.metrics.streamingConnections
      },
      database: dbMetrics,
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      }
    };
  }

  resetMetrics() {
    this.metrics = {
      requests: 0,
      totalResponseTime: 0,
      errors: 0,
      bytesTransferred: 0,
      streamingConnections: 0,
      maxStreamingConnections: 0,
      messagesSent: 0
    };
    this.db.resetMetrics();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `0.0.0.0:${this.port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) {
            reject(error);
            return;
          }

          this.server.start();
          console.log(`🚀 gRPC Server running on port ${port}`);
          console.log(`📊 Metrics available via gRPC calls`);
          resolve(port);
        }
      );
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.tryShutdown((error) => {
        if (error) {
          console.error('Error during shutdown:', error);
          this.server.forceShutdown();
        }
        resolve();
      });
    });
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new GrpcServer();
  
  server.start().then((port) => {
    console.log(`gRPC server started successfully on port ${port}`);
  }).catch((error) => {
    console.error('Failed to start gRPC server:', error);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await server.stop();
  });
}

module.exports = GrpcServer;
