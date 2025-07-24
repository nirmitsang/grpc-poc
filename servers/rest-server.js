const express = require('express');
const cors = require('cors');
const compression = require('compression');
const MockDatabase = require('../database/mock-database');

class RestServer {
  constructor(port = 3001) {
    this.app = express();
    this.port = port;
    this.db = new MockDatabase();
    this.metrics = {
      requests: 0,
      totalResponseTime: 0,
      errors: 0,
      bytesTransferred: 0,
      concurrentRequests: 0,
      maxConcurrentRequests: 0
    };
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Request timing middleware
    this.app.use((req, res, next) => {
      req.startTime = Date.now();
      this.metrics.concurrentRequests++;
      this.metrics.maxConcurrentRequests = Math.max(
        this.metrics.maxConcurrentRequests, 
        this.metrics.concurrentRequests
      );
      
      const originalSend = res.send;
      res.send = function(data) {
        const responseTime = Date.now() - req.startTime;
        req.server.metrics.requests++;
        req.server.metrics.totalResponseTime += responseTime;
        req.server.metrics.bytesTransferred += Buffer.byteLength(JSON.stringify(data));
        req.server.metrics.concurrentRequests--;
        
        // Add performance headers
        res.setHeader('X-Response-Time', `${responseTime}ms`);
        res.setHeader('X-Request-ID', req.headers['x-request-id'] || 'unknown');
        
        originalSend.call(this, data);
      };
      
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          this.metrics.errors++;
        }
      });
      
      req.server = this;
      next();
    });

    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
      });
    });

    // Get single record
    this.app.get('/api/records/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const includeTransactions = req.query.include_transactions !== 'false';
        
        const record = await this.db.findById(id, includeTransactions);
        
        if (!record) {
          return res.status(404).json({ error: 'Record not found' });
        }
        
        res.json({ record });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get multiple records by IDs
    this.app.post('/api/records/batch', async (req, res) => {
      try {
        const { ids, include_transactions = true, limit } = req.body;
        
        if (!ids || !Array.isArray(ids)) {
          return res.status(400).json({ error: 'IDs array is required' });
        }
        
        const recordIds = limit ? ids.slice(0, limit) : ids;
        const records = await this.db.findByIds(recordIds, include_transactions);
        
        res.json({
          records,
          total_count: records.length,
          has_more: limit && ids.length > limit
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Complex multi-field query (the problematic endpoint)
    this.app.post('/api/records/query', async (req, res) => {
      try {
        const startTime = Date.now();
        const {
          account_numbers = [],
          customer_ids = [],
          status_filter,
          min_balance,
          max_balance,
          include_transactions = true,
          limit = 100
        } = req.body;

        const filters = {
          account_numbers,
          customer_ids,
          status_filter,
          min_balance,
          max_balance,
          include_transactions,
          limit
        };

        const records = await this.db.findMultiple(filters);
        const queryTime = Date.now() - startTime;

        res.json({
          records,
          total_found: records.length,
          query_time_ms: queryTime,
          filters_applied: Object.keys(filters).filter(k => filters[k] !== undefined).length
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Search endpoint
    this.app.post('/api/records/search', async (req, res) => {
      try {
        const {
          query = '',
          fields = [],
          filters = {},
          page = 1,
          page_size = 50,
          sort_by,
          sort_desc = false
        } = req.body;

        const result = await this.db.search(query, filters, { page, page_size });

        res.json({
          records: result.records,
          total_results: result.total_results,
          page: result.page,
          total_pages: result.total_pages,
          facets: [] // Placeholder for faceted search
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Bulk operations (inefficient in REST)
    this.app.post('/api/records/bulk-query', async (req, res) => {
      try {
        const { queries } = req.body;
        
        if (!queries || !Array.isArray(queries)) {
          return res.status(400).json({ error: 'Queries array is required' });
        }

        const results = [];
        
        // Sequential processing (REST limitation)
        for (const queryParams of queries) {
          const records = await this.db.findMultiple(queryParams);
          results.push({
            query: queryParams,
            records,
            count: records.length
          });
        }

        res.json({
          results,
          total_queries: queries.length,
          total_records: results.reduce((sum, r) => sum + r.records.length, 0)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Metrics endpoint
    this.app.get('/metrics', (req, res) => {
      const dbMetrics = this.db.getMetrics();
      
      res.json({
        server: {
          ...this.metrics,
          avgResponseTime: this.metrics.totalResponseTime / Math.max(this.metrics.requests, 1),
          errorRate: (this.metrics.errors / Math.max(this.metrics.requests, 1)) * 100,
          requestsPerSecond: this.metrics.requests / (process.uptime() || 1),
          mbTransferred: this.metrics.bytesTransferred / (1024 * 1024)
        },
        database: dbMetrics,
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage()
        }
      });
    });

    // Reset metrics
    this.app.post('/metrics/reset', (req, res) => {
      this.metrics = {
        requests: 0,
        totalResponseTime: 0,
        errors: 0,
        bytesTransferred: 0,
        concurrentRequests: 0,
        maxConcurrentRequests: 0
      };
      this.db.resetMetrics();
      res.json({ message: 'Metrics reset successfully' });
    });
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`🚀 REST Server running on port ${this.port}`);
      console.log(`📊 Metrics available at http://localhost:${this.port}/metrics`);
      console.log(`🏥 Health check at http://localhost:${this.port}/health`);
    });
    
    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new RestServer();
  server.start();
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.stop();
  });
}

module.exports = RestServer;
