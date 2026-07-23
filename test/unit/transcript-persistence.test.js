'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

test('Postgres transcript append is atomic, suffix-only, and expected-count guarded', async () => {
  const queries = [];
  class FakePool extends EventEmitter {
    async query(text, params) {
      queries.push({ text, params });
      return { rows: [{ utterance_count: 3 }] };
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
    const delta = [{ speaker: 'Nora', text: 'new line', timestamp: '2026-07-23T10:00:00Z' }];
    const result = await db.appendTranscript('bot-one', null, delta, 2);
    assert.deepEqual(result, { applied: true, utterance_count: 3 });
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /current\.transcript \|\| EXCLUDED\.transcript/);
    assert.match(queries[0].text, /WHERE \$5=0/);
    assert.match(queries[0].text, /WHERE current\.utterance_count=\$5/);
    assert.deepEqual(queries[0].params,
      ['bot-one', null, JSON.stringify(delta), 1, 2]);
  } finally {
    if (db) await db.close();
    Module._load = originalLoad;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
});

test('Postgres transcript append reports a compare-and-swap conflict without overwriting', async () => {
  class FakePool extends EventEmitter {
    async query() { return { rows: [] }; }
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
    assert.deepEqual(await db.appendTranscript('bot-one', null, [], 4),
      { applied: false, utterance_count: null });
  } finally {
    if (db) await db.close();
    Module._load = originalLoad;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
});
