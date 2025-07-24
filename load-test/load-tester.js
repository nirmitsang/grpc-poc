const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const axios = require('axios');
const path = require('path');

class LoadTester {
  constructor() {
    this.restBaseUrl = 'http://localhost:3001';
    this.grpcPort = 50051;
    this.loadProtoDefinition();
    this.results = {
      rest: {},
      grpc: {}
    };
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
    this.grpcClient = new this.proto.DataService(
      `localhost:${this.grpcPort}`,
      grpc.credentials.createInsecure()
    );
  }

  // Utility methods
  generateTestData() {
    const accountNumbers = [];
    const customerIds = [];
    const recordIds = [];

    for (let i = 0; i < 1000; i++) {
      accountNumbers.push(`GB${Math.random().toString().slice(2, 12)}`);
      customerIds.push(`cust_${Math.random().toString(36).substr(2, 9)}`);
      recordIds.push(`acc_${i.toString().padStart(8, '0')}`);
    }

    return { accountNumbers, customerIds, recordIds };
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // REST API Tests
  async testRestSingleRecord(recordId) {
    const startTime = Date.now();
    
    try {
      const response = await axios.get(`${this.restBaseUrl}/api/records/${recordId}`);
      const endTime = Date.now();
      
      return {
        success: true,
        responseTime: endTime - startTime,
        dataSize: JSON.stringify(response.data).length,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        error: error.message,
        statusCode: error.response?.status || 0
      };
    }
  }

  async testRestBatchRecords(recordIds) {
    const startTime = Date.now();
    
    try {
      const response = await axios.post(`${this.restBaseUrl}/api/records/batch`, {
        ids: recordIds,
        include_transactions: true
      });
      const endTime = Date.now();
      
      return {
        success: true,
        responseTime: endTime - startTime,
        dataSize: JSON.stringify(response.data).length,
        recordCount: response.data.records.length,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        error: error.message,
        statusCode: error.response?.status || 0
      };
    }
  }

  async testRestComplexQuery(queryParams) {
    const startTime = Date.now();
    
    try {
      const response = await axios.post(`${this.restBaseUrl}/api/records/query`, queryParams);
      const endTime = Date.now();
      
      return {
        success: true,
        responseTime: endTime - startTime,
        dataSize: JSON.stringify(response.data).length,
        recordCount: response.data.records.length,
        queryTimeMs: response.data.query_time_ms,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        responseTime: Date.now() - startTime,
        error: error.message,
        statusCode: error.response?.status || 0
      };
    }
  }

  // gRPC Tests
  async testGrpcSingleRecord(recordId) {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      this.grpcClient.GetRecord(
        { id: recordId, include_transactions: true },
        (error, response) => {
          const endTime = Date.now();
          
          if (error) {
            resolve({
              success: false,
              responseTime: endTime - startTime,
              error: error.message,
              grpcCode: error.code
            });
          } else {
            resolve({
              success: true,
              responseTime: endTime - startTime,
              dataSize: JSON.stringify(response).length,
              grpcCode: 0
            });
          }
        }
      );
    });
  }

  async testGrpcBatchRecords(recordIds) {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      this.grpcClient.GetRecords(
        { ids: recordIds, include_transactions: true },
        (error, response) => {
          const endTime = Date.now();
          
          if (error) {
            resolve({
              success: false,
              responseTime: endTime - startTime,
              error: error.message,
              grpcCode: error.code
            });
          } else {
            resolve({
              success: true,
              responseTime: endTime - startTime,
              dataSize: JSON.stringify(response).length,
              recordCount: response.records.length,
              grpcCode: 0
            });
          }
        }
      );
    });
  }

  async testGrpcComplexQuery(queryParams) {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      this.grpcClient.GetMultipleRecords(queryParams, (error, response) => {
        const endTime = Date.now();
        
        if (error) {
          resolve({
            success: false,
            responseTime: endTime - startTime,
            error: error.message,
            grpcCode: error.code
          });
        } else {
          resolve({
            success: true,
            responseTime: endTime - startTime,
            dataSize: JSON.stringify(response).length,
            recordCount: response.records.length,
            queryTimeMs: response.query_time_ms,
            grpcCode: 0
          });
        }
      });
    });
  }

  async testGrpcStreaming(batchSize = 100) {
    const startTime = Date.now();
    let recordCount = 0;
    let totalDataSize = 0;

    return new Promise((resolve) => {
      const call = this.grpcClient.StreamRecords({
        filter: '',
        batch_size: batchSize,
        real_time: false
      });

      call.on('data', (record) => {
        recordCount++;
        totalDataSize += JSON.stringify(record).length;
      });

      call.on('end', () => {
        const endTime = Date.now();
        resolve({
          success: true,
          responseTime: endTime - startTime,
          recordCount,
          dataSize: totalDataSize,
          avgRecordSize: totalDataSize / recordCount
        });
      });

      call.on('error', (error) => {
        resolve({
          success: false,
          responseTime: Date.now() - startTime,
          error: error.message,
          recordCount,
          grpcCode: error.code
        });
      });
    });
  }

  // Load Testing Scenarios
  async runSingleRecordTest(concurrency = 50, iterations = 100) {
    console.log(`\n📊 Running Single Record Test (${concurrency} concurrent, ${iterations} iterations each)`);
    
    const testData = this.generateTestData();
    const restResults = [];
    const grpcResults = [];

    // REST Test
    console.log('Testing REST API...');
    const restPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const recordId = testData.recordIds[Math.floor(Math.random() * testData.recordIds.length)];
          const result = await this.testRestSingleRecord(recordId);
          results.push(result);
          await this.delay(10); // Small delay to simulate real usage
        }
        return results;
      })();
      restPromises.push(promise);
    }

    const restBatches = await Promise.all(restPromises);
    restBatches.forEach(batch => restResults.push(...batch));

    // gRPC Test
    console.log('Testing gRPC API...');
    const grpcPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const recordId = testData.recordIds[Math.floor(Math.random() * testData.recordIds.length)];
          const result = await this.testGrpcSingleRecord(recordId);
          results.push(result);
          await this.delay(10);
        }
        return results;
      })();
      grpcPromises.push(promise);
    }

    const grpcBatches = await Promise.all(grpcPromises);
    grpcBatches.forEach(batch => grpcResults.push(...batch));

    return this.analyzeResults('Single Record', restResults, grpcResults);
  }

  async runBatchQueryTest(concurrency = 20, iterations = 50) {
    console.log(`\n📊 Running Batch Query Test (${concurrency} concurrent, ${iterations} iterations each)`);
    
    const testData = this.generateTestData();
    const restResults = [];
    const grpcResults = [];

    const batchSizes = [10, 25, 50, 100];

    // REST Test
    console.log('Testing REST Batch API...');
    const restPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const batchSize = batchSizes[Math.floor(Math.random() * batchSizes.length)];
          const recordIds = testData.recordIds.slice(0, batchSize);
          const result = await this.testRestBatchRecords(recordIds);
          results.push(result);
          await this.delay(50);
        }
        return results;
      })();
      restPromises.push(promise);
    }

    const restBatches = await Promise.all(restPromises);
    restBatches.forEach(batch => restResults.push(...batch));

    // gRPC Test
    console.log('Testing gRPC Batch API...');
    const grpcPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const batchSize = batchSizes[Math.floor(Math.random() * batchSizes.length)];
          const recordIds = testData.recordIds.slice(0, batchSize);
          const result = await this.testGrpcBatchRecords(recordIds);
          results.push(result);
          await this.delay(50);
        }
        return results;
      })();
      grpcPromises.push(promise);
    }

    const grpcBatches = await Promise.all(grpcPromises);
    grpcBatches.forEach(batch => grpcResults.push(...batch));

    return this.analyzeResults('Batch Query', restResults, grpcResults);
  }

  async runComplexQueryTest(concurrency = 10, iterations = 30) {
    console.log(`\n📊 Running Complex Query Test (${concurrency} concurrent, ${iterations} iterations each)`);
    
    const testData = this.generateTestData();
    const restResults = [];
    const grpcResults = [];

    const queryTemplates = [
      {
        account_numbers: testData.accountNumbers.slice(0, 10),
        status_filter: 'active',
        min_balance: 1000,
        include_transactions: true,
        limit: 50
      },
      {
        customer_ids: testData.customerIds.slice(0, 5),
        min_balance: 5000,
        max_balance: 50000,
        include_transactions: true,
        limit: 100
      },
      {
        account_numbers: testData.accountNumbers.slice(10, 30),
        customer_ids: testData.customerIds.slice(5, 15),
        status_filter: 'active',
        include_transactions: false,
        limit: 25
      }
    ];

    // REST Test
    console.log('Testing REST Complex Queries...');
    const restPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const query = queryTemplates[Math.floor(Math.random() * queryTemplates.length)];
          const result = await this.testRestComplexQuery(query);
          results.push(result);
          await this.delay(100); // Longer delay for complex queries
        }
        return results;
      })();
      restPromises.push(promise);
    }

    const restBatches = await Promise.all(restPromises);
    restBatches.forEach(batch => restResults.push(...batch));

    // gRPC Test
    console.log('Testing gRPC Complex Queries...');
    const grpcPromises = [];
    
    for (let i = 0; i < concurrency; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < iterations; j++) {
          const query = queryTemplates[Math.floor(Math.random() * queryTemplates.length)];
          const result = await this.testGrpcComplexQuery(query);
          results.push(result);
          await this.delay(100);
        }
        return results;
      })();
      grpcPromises.push(promise);
    }

    const grpcBatches = await Promise.all(grpcPromises);
    grpcBatches.forEach(batch => grpcResults.push(...batch));

    return this.analyzeResults('Complex Query', restResults, grpcResults);
  }

  async runStreamingTest() {
    console.log('\n📊 Running Streaming Test (gRPC Only)');
    
    const result = await this.testGrpcStreaming(500);
    
    console.log('Streaming Results:');
    console.log(`✅ Success: ${result.success}`);
    console.log(`⏱️  Total Time: ${result.responseTime}ms`);
    console.log(`📦 Records Streamed: ${result.recordCount}`);
    console.log(`💾 Total Data Size: ${(result.dataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`📊 Throughput: ${(result.recordCount / (result.responseTime / 1000)).toFixed(0)} records/sec`);
    
    return result;
  }

  analyzeResults(testName, restResults, grpcResults) {
    const restSuccess = restResults.filter(r => r.success);
    const grpcSuccess = grpcResults.filter(r => r.success);

    const restStats = this.calculateStats(restSuccess.map(r => r.responseTime));
    const grpcStats = this.calculateStats(grpcSuccess.map(r => r.responseTime));

    const restDataSize = restSuccess.reduce((sum, r) => sum + (r.dataSize || 0), 0);
    const grpcDataSize = grpcSuccess.reduce((sum, r) => sum + (r.dataSize || 0), 0);

    const analysis = {
      testName,
      rest: {
        totalRequests: restResults.length,
        successfulRequests: restSuccess.length,
        failedRequests: restResults.length - restSuccess.length,
        successRate: (restSuccess.length / restResults.length) * 100,
        responseTime: restStats,
        totalDataTransferred: restDataSize,
        avgDataSize: restDataSize / restSuccess.length
      },
      grpc: {
        totalRequests: grpcResults.length,
        successfulRequests: grpcSuccess.length,
        failedRequests: grpcResults.length - grpcSuccess.length,
        successRate: (grpcSuccess.length / grpcResults.length) * 100,
        responseTime: grpcStats,
        totalDataTransferred: grpcDataSize,
        avgDataSize: grpcDataSize / grpcSuccess.length
      },
      comparison: {
        speedImprovement: ((restStats.avg - grpcStats.avg) / restStats.avg) * 100,
        throughputImprovement: ((grpcStats.rps - restStats.rps) / restStats.rps) * 100,
        dataSizeReduction: ((restDataSize - grpcDataSize) / restDataSize) * 100
      }
    };

    this.printAnalysis(analysis);
    return analysis;
  }

  calculateStats(responseTimes) {
    if (responseTimes.length === 0) return {};
    
    responseTimes.sort((a, b) => a - b);
    
    return {
      min: responseTimes[0],
      max: responseTimes[responseTimes.length - 1],
      avg: responseTimes.reduce((sum, rt) => sum + rt, 0) / responseTimes.length,
      median: responseTimes[Math.floor(responseTimes.length / 2)],
      p95: responseTimes[Math.floor(responseTimes.length * 0.95)],
      p99: responseTimes[Math.floor(responseTimes.length * 0.99)],
      rps: responseTimes.length / (Math.max(...responseTimes) / 1000)
    };
  }

  printAnalysis(analysis) {
    console.log(`\n🔍 ${analysis.testName} Analysis:`);
    console.log('=====================================');
    
    console.log('\n📈 REST API Results:');
    console.log(`   Requests: ${analysis.rest.totalRequests} (${analysis.rest.successRate.toFixed(1)}% success)`);
    console.log(`   Avg Response Time: ${analysis.rest.responseTime.avg?.toFixed(2)}ms`);
    console.log(`   P95 Response Time: ${analysis.rest.responseTime.p95?.toFixed(2)}ms`);
    console.log(`   Data Transferred: ${(analysis.rest.totalDataTransferred / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n🚀 gRPC API Results:');
    console.log(`   Requests: ${analysis.grpc.totalRequests} (${analysis.grpc.successRate.toFixed(1)}% success)`);
    console.log(`   Avg Response Time: ${analysis.grpc.responseTime.avg?.toFixed(2)}ms`);
    console.log(`   P95 Response Time: ${analysis.grpc.responseTime.p95?.toFixed(2)}ms`);
    console.log(`   Data Transferred: ${(analysis.grpc.totalDataTransferred / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n💡 Performance Improvement:');
    console.log(`   ⚡ Speed: ${analysis.comparison.speedImprovement.toFixed(1)}% faster`);
    console.log(`   📊 Throughput: ${analysis.comparison.throughputImprovement.toFixed(1)}% higher`);
    console.log(`   💾 Data Size: ${Math.abs(analysis.comparison.dataSizeReduction).toFixed(1)}% ${analysis.comparison.dataSizeReduction > 0 ? 'smaller' : 'larger'}`);
  }

  async runFullTestSuite() {
    console.log('🧪 Starting Comprehensive Performance Test Suite');
    console.log('================================================');
    
    const results = {};
    
    try {
      // Single record performance
      results.singleRecord = await this.runSingleRecordTest(50, 100);
      
      // Batch query performance
      results.batchQuery = await this.runBatchQueryTest(20, 50);
      
      // Complex query performance (the problematic scenario)
      results.complexQuery = await this.runComplexQueryTest(10, 30);
      
      // Streaming performance (gRPC advantage)
      results.streaming = await this.runStreamingTest();
      
      console.log('\n🎯 FINAL SUMMARY');
      console.log('================');
      console.log(`Single Record - gRPC is ${results.singleRecord.comparison.speedImprovement.toFixed(1)}% faster`);
      console.log(`Batch Query - gRPC is ${results.batchQuery.comparison.speedImprovement.toFixed(1)}% faster`);
      console.log(`Complex Query - gRPC is ${results.complexQuery.comparison.speedImprovement.toFixed(1)}% faster`);
      console.log(`Streaming - ${results.streaming.recordCount} records in ${results.streaming.responseTime}ms (gRPC only)`);
      
      const avgImprovement = (
        results.singleRecord.comparison.speedImprovement +
        results.batchQuery.comparison.speedImprovement +
        results.complexQuery.comparison.speedImprovement
      ) / 3;
      
      console.log(`\n🏆 Average Performance Improvement: ${avgImprovement.toFixed(1)}%`);
      
      return results;
    } catch (error) {
      console.error('Test suite failed:', error);
      throw error;
    }
  }
}

// CLI interface
if (require.main === module) {
  const tester = new LoadTester();
  
  const testType = process.argv[2] || 'full';
  
  async function runTests() {
    try {
      switch (testType) {
        case 'single':
          await tester.runSingleRecordTest();
          break;
        case 'batch':
          await tester.runBatchQueryTest();
          break;
        case 'complex':
          await tester.runComplexQueryTest();
          break;
        case 'streaming':
          await tester.runStreamingTest();
          break;
        case 'full':
        default:
          await tester.runFullTestSuite();
          break;
      }
      
      console.log('\n✅ Load testing completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('\n❌ Load testing failed:', error.message);
      process.exit(1);
    }
  }
  
  runTests();
}

module.exports = LoadTester;
