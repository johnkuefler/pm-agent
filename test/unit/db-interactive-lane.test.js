'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

test('semantic recall uses an independent fast-fail database pool and degrades cleanly', async () => {
  const pools = [];
  class FakePool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      this.queries = [];
      pools.push(this);
    }
    async query(config) {
      this.queries.push(config);
      if (this.fail) throw new Error('Query read timeout');
      return { rows: [{ id: 'm1', fact: 'remember this', metadata: { emotional_weight: 0.4 } }] };
    }
    async end() {}
  }

  const originalLoad = Module._load;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://test.invalid/nora';
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'pg') return { Pool: FakePool };
    return originalLoad.call(this, request, parent, isMain);
  };

  let db;
  try {
    const dbPath = require.resolve('../../db');
    delete require.cache[dbPath];
    db = require('../../db');
    const vector = Array(db.EMBED_DIM).fill(0);
    const rows = await db.searchMemoryByVector(vector, 4, {
      interactive: true, excludeSources: ['opinion'], signal: new AbortController().signal,
    });
    assert.equal(rows[0].emotional_weight, 0.4);
    assert.equal(pools.length, 1, 'interactive recall must not initialize the background pool');
    assert.equal(pools[0].options.max, 2);
    assert.equal(pools[0].options.connectionTimeoutMillis, 400);
    assert.equal(pools[0].queries[0].query_timeout, 400);

    pools[0].fail = true;
    assert.deepEqual(await db.searchMemoryByVector(vector, 4, { interactive: true }), []);
    const diagnostics = db.diagnostics();
    assert.equal(diagnostics.interactive.queries, 2);
    assert.equal(diagnostics.interactive.failures, 1);
    assert.equal(diagnostics.interactive.timeouts, 1);

    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await db.searchMemoryByVector(vector, 4,
      { interactive: true, signal: aborted.signal }), []);
    assert.equal(pools[0].queries.length, 2, 'an already-aborted recall must not touch Postgres');
  } finally {
    if (db) await db.close();
    Module._load = originalLoad;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
});
