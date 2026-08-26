'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationStore, emptyState } = require('../../src/runtime/operation-store');
const db = require('../../db');

test('strict operation persistence has a bounded wait even when the database write wedges', async () => {
  const store = createOperationStore({
    filePath: null,
    initialState: emptyState(),
    isDbReady: () => true,
    db: { setStateSerialized: async () => new Promise(() => {}), diagnostics: () => ({ test: true }) },
    strictPersistenceTimeoutMs: 30,
  });
  await assert.rejects(store.persistStrict(), error => {
    assert.equal(error.code, 'OPERATION_PERSISTENCE_TIMEOUT');
    assert.match(error.message, /exceeded 30ms/);
    return true;
  });
  const diagnostics = store.persistenceDiagnostics();
  assert.equal(diagnostics.strict_timeout_ms, 30);
  assert.deepEqual(diagnostics.database, { test: true });
});

test('database runtime exposes bounded-query and background degradation diagnostics', () => {
  const diagnostics = db.diagnostics();
  assert.ok(diagnostics.query_timeout_ms >= 5000);
  assert.equal(typeof diagnostics.background_degraded, 'boolean');
  assert.equal(db.backgroundAllowed(), !diagnostics.background_degraded);
});
