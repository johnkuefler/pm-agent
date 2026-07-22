'use strict';

const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncJsonSerializer } = require('../../src/runtime/async-json-serializer');

test('a wedged serializer worker is terminated and the next write gets a fresh worker', async t => {
  const serializer = new AsyncJsonSerializer({
    workerPath: path.join(__dirname, '../fixtures/hanging-json-worker.js'),
    jobTimeoutMs: 100,
  });
  t.after(() => serializer.close());

  await assert.rejects(serializer.stringify({ revision: 1 }), error => {
    assert.equal(error.code, 'JSON_SERIALIZER_TIMEOUT');
    return true;
  });
  assert.deepEqual(serializer.diagnostics(), {
    protocol_version: 1, timeout_ms: 100, pending: 0, worker_active: false,
    jobs: 1, completions: 0, failures: 1, timeouts: 1, worker_restarts: 1,
    last_error: 'JSON serializer worker exceeded 100ms',
    last_error_at: serializer.diagnostics().last_error_at,
  });
  assert.ok(serializer.diagnostics().last_error_at);

  serializer.workerPath = path.join(__dirname, '../../src/runtime/json-stringify-worker.js');
  serializer.jobTimeoutMs = 2000;
  const recovered = await serializer.stringify({ revision: 2 }, { compress: true });
  assert.deepEqual(JSON.parse(gunzipSync(recovered.compressed).toString('utf8')), { revision: 2 });
  assert.ok(recovered.compressed.byteLength > 0);
  assert.equal(serializer.diagnostics().completions, 1);
  assert.equal(serializer.diagnostics().last_error, null);
});
