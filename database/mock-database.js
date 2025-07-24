const crypto = require('crypto');

class MockDatabase {
  constructor() {
    this.data = new Map();
    this.metrics = {
      queries: 0,
      slowQueries: 0,
      indexHits: 0,
      indexMisses: 0,
      totalQueryTime: 0,
      connectionPool: 0,
      maxConnections: 100
    };
    
    // Simulate indexed and non-indexed fields
    this.indexedFields = new Set(['id', 'account_number', 'customer_id', 'status']);
    this.nonIndexedFields = new Set(['balance', 'currency', 'created_timestamp', 'metadata.branch_code']);
    
    // Generate mock data
    this.generateMockData(10000);
  }

  generateMockData(count) {
    console.log(`Generating ${count} mock records...`);
    
    const statuses = ['active', 'inactive', 'suspended', 'closed'];
    const currencies = ['GBP', 'USD', 'EUR', 'JPY'];
    const branches = ['LON001', 'MAN002', 'BIR003', 'EDI004', 'GLA005'];
    const productTypes = ['current', 'savings', 'premium', 'business'];

    for (let i = 0; i < count; i++) {
      const id = `acc_${i.toString().padStart(8, '0')}`;
      const record = {
        id,
        account_number: `GB${Math.random().toString().slice(2, 12)}`,
        customer_id: `cust_${Math.random().toString(36).substr(2, 9)}`,
        balance: Math.random() * 100000,
        currency: currencies[Math.floor(Math.random() * currencies.length)],
        status: statuses[Math.floor(Math.random() * statuses.length)],
        created_timestamp: Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000,
        updated_timestamp: Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
        recent_transactions: this.generateTransactions(Math.floor(Math.random() * 10)),
        metadata: {
          branch_code: branches[Math.floor(Math.random() * branches.length)],
          product_type: productTypes[Math.floor(Math.random() * productTypes.length)],
          tags: [`tag${Math.floor(Math.random() * 5)}`, `category${Math.floor(Math.random() * 3)}`],
          custom_fields: {
            risk_score: Math.floor(Math.random() * 100).toString(),
            last_login: (Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toString()
          }
        }
      };
      
      this.data.set(id, record);
    }
  }

  generateTransactions(count) {
    const transactions = [];
    const types = ['debit', 'credit', 'transfer', 'fee'];
    
    for (let i = 0; i < count; i++) {
      transactions.push({
        transaction_id: `txn_${crypto.randomBytes(8).toString('hex')}`,
        amount: (Math.random() - 0.5) * 1000,
        type: types[Math.floor(Math.random() * types.length)],
        description: `Transaction ${i + 1}`,
        timestamp: Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
        reference: `ref_${Math.random().toString(36).substr(2, 8)}`
      });
    }
    
    return transactions;
  }

  // Simulate query performance based on field indexing
  simulateQueryDelay(fields, recordCount = 1) {
    const baseDelay = 1; // 1ms base
    let delay = baseDelay;
    let isIndexed = true;

    // Check if query uses non-indexed fields
    for (const field of fields) {
      if (this.nonIndexedFields.has(field)) {
        isIndexed = false;
        delay += recordCount * 0.1; // Linear scan penalty
        this.metrics.indexMisses++;
      } else if (this.indexedFields.has(field)) {
        this.metrics.indexHits++;
      }
    }

    // Additional delays for complex queries
    if (fields.length > 3) {
      delay += fields.length * 2;
    }

    // Connection pool simulation
    this.metrics.connectionPool++;
    if (this.metrics.connectionPool > this.metrics.maxConnections) {
      delay += 50; // Connection wait time
    }

    this.metrics.queries++;
    this.metrics.totalQueryTime += delay;
    
    if (delay > 100) {
      this.metrics.slowQueries++;
    }

    return new Promise(resolve => {
      setTimeout(() => {
        this.metrics.connectionPool = Math.max(0, this.metrics.connectionPool - 1);
        resolve();
      }, delay);
    });
  }

  async findById(id, includeTransactions = true) {
    await this.simulateQueryDelay(['id']);
    
    const record = this.data.get(id);
    if (!record) return null;

    const result = { ...record };
    if (!includeTransactions) {
      delete result.recent_transactions;
    }
    
    return result;
  }

  async findByIds(ids, includeTransactions = true) {
    await this.simulateQueryDelay(['id'], ids.length);
    
    const results = [];
    for (const id of ids) {
      const record = this.data.get(id);
      if (record) {
        const result = { ...record };
        if (!includeTransactions) {
          delete result.recent_transactions;
        }
        results.push(result);
      }
    }
    
    return results;
  }

  async findMultiple(filters) {
    const queryFields = Object.keys(filters);
    await this.simulateQueryDelay(queryFields, this.data.size);
    
    let results = Array.from(this.data.values());
    
    // Apply filters (simulating MongoDB query)
    if (filters.account_numbers && filters.account_numbers.length > 0) {
      results = results.filter(r => filters.account_numbers.includes(r.account_number));
    }
    
    if (filters.customer_ids && filters.customer_ids.length > 0) {
      results = results.filter(r => filters.customer_ids.includes(r.customer_id));
    }
    
    if (filters.status_filter) {
      results = results.filter(r => r.status === filters.status_filter);
    }
    
    if (filters.min_balance !== undefined) {
      results = results.filter(r => r.balance >= filters.min_balance);
    }
    
    if (filters.max_balance !== undefined) {
      results = results.filter(r => r.balance <= filters.max_balance);
    }

    // Apply limit
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    // Remove transactions if not needed
    if (!filters.include_transactions) {
      results = results.map(r => {
        const copy = { ...r };
        delete copy.recent_transactions;
        return copy;
      });
    }
    
    return results;
  }

  async search(query, filters = {}, pagination = {}) {
    const queryFields = ['account_number', 'customer_id', 'status', 'metadata.branch_code'];
    await this.simulateQueryDelay(queryFields, this.data.size);
    
    let results = Array.from(this.data.values());
    
    // Simple text search simulation
    if (query) {
      results = results.filter(r => 
        r.account_number.includes(query) ||
        r.customer_id.includes(query) ||
        r.metadata.branch_code.includes(query)
      );
    }
    
    // Apply filters
    Object.keys(filters).forEach(key => {
      const value = filters[key];
      results = results.filter(r => {
        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          return r[parent] && r[parent][child] === value;
        }
        return r[key] === value;
      });
    });
    
    const totalResults = results.length;
    
    // Pagination
    const { page = 1, page_size = 50 } = pagination;
    const offset = (page - 1) * page_size;
    results = results.slice(offset, offset + page_size);
    
    return {
      records: results,
      total_results: totalResults,
      page,
      total_pages: Math.ceil(totalResults / page_size)
    };
  }

  getMetrics() {
    return {
      ...this.metrics,
      avgQueryTime: this.metrics.totalQueryTime / Math.max(this.metrics.queries, 1),
      slowQueryPercentage: (this.metrics.slowQueries / Math.max(this.metrics.queries, 1)) * 100,
      indexHitRatio: (this.metrics.indexHits / Math.max(this.metrics.indexHits + this.metrics.indexMisses, 1)) * 100
    };
  }

  resetMetrics() {
    this.metrics = {
      queries: 0,
      slowQueries: 0,
      indexHits: 0,
      indexMisses: 0,
      totalQueryTime: 0,
      connectionPool: 0,
      maxConnections: 100
    };
  }
}

module.exports = MockDatabase;
