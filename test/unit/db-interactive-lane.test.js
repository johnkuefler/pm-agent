'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

test('semantic recall uses an independent fast-fail database pool and degrades cleanly', async () => {
  const pools = [];
  class FakeClient {
    constructor(plan = {}) {
      this.plan = plan;
      this.queries = [];
      this.releaseError = null;
    }
    async query(text) {
      const sql = typeof text === 'string' ? text : text.text;
      this.queries.push(sql);
      if (sql === 'ROLLBACK' && this.plan.rollbackError) throw this.plan.rollbackError;
      if (this.plan.failPattern?.test(sql)) throw this.plan.error;
      return { rows: [] };
    }
    release(error) { this.releaseError = error || null; }
  }
  class FakePool extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
      this.queries = [];
      this.clients = [];
      this.nextClientPlan = null;
      pools.push(this);
    }
    async connect() {
      const client = new FakeClient(this.nextClientPlan || {});
      this.nextClientPlan = null;
      this.clients.push(client);
      return client;
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
      addedSince: '2026-07-08',
    });
    assert.equal(rows[0].emotional_weight, 0.4);
    assert.equal(pools.length, 1, 'interactive recall must not initialize the background pool');
    assert.equal(pools[0].options.max, 2);
    assert.equal(pools[0].options.connectionTimeoutMillis, 400);
    assert.equal(pools[0].queries[0].query_timeout, 400);
    assert.match(pools[0].queries[0].text,
      /COALESCE\(metadata ->> 'status', 'active'\) = 'active'/);
    assert.match(pools[0].queries[0].text, /added >= \$4/);
    assert.equal(pools[0].queries[0].values[3], '2026-07-08');

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

    await db.applyMarkerChanges({ upserts: [{ key: 'healthy', value: { ok: true } }] });
    assert.equal(pools.length, 2, 'durable writes must retain their separate background pool');
    const normalClient = pools[1].clients[0];
    assert.deepEqual(normalClient.queries.slice(0, 2), ['BEGIN', 'SET LOCAL search_path TO public, public']);
    assert.equal(normalClient.queries.at(-1), 'COMMIT');
    assert.equal(normalClient.releaseError, null);

    const timeoutError = new Error('Query read timeout');
    pools[1].nextClientPlan = { failPattern: /INSERT INTO .*markers/, error: timeoutError };
    await assert.rejects(() => db.applyMarkerChanges({
      upserts: [{ key: 'timeout', value: { ok: false } }],
    }), timeoutError);
    const timedOutClient = pools[1].clients[1];
    assert.equal(timedOutClient.queries.includes('ROLLBACK'), false,
      'a timed-out query may still be running and must not be reused for rollback');
    assert.equal(timedOutClient.releaseError, timeoutError,
      'pg-pool must destroy a client whose query timed out');
    assert.equal(db.diagnostics().transactions.discarded_clients, 1);

    const validationError = new Error('duplicate key');
    pools[1].nextClientPlan = { failPattern: /INSERT INTO .*markers/, error: validationError };
    await assert.rejects(() => db.applyMarkerChanges({
      upserts: [{ key: 'ordinary-error', value: { ok: false } }],
    }), validationError);
    const rolledBackClient = pools[1].clients[2];
    assert.equal(rolledBackClient.queries.at(-1), 'ROLLBACK');
    assert.equal(rolledBackClient.releaseError, null,
      'a successfully rolled-back ordinary SQL error leaves the connection reusable');
    assert.deepEqual(db.diagnostics().transactions, {
      attempts: 3, failures: 2, discarded_clients: 1, rollback_failures: 0,
    });
  } finally {
    if (db) await db.close();
    Module._load = originalLoad;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
});
