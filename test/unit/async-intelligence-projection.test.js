'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncIntelligenceProjection } = require('../../src/runtime/async-intelligence-projection');
const { emptyState } = require('../../src/intelligence/store');

test('a silent projection worker is terminated and the next projection gets a fresh worker', async t => {
  const projection = new AsyncIntelligenceProjection({
    workerPath: path.join(__dirname, '../fixtures/hanging-intelligence-projection-worker.js'),
    jobTimeoutMs: 100,
  });
  t.after(() => projection.close());

  await assert.rejects(projection.run({}, 'dashboardIntelligenceSummary'), error => {
    assert.equal(error.code, 'INTELLIGENCE_PROJECTION_TIMEOUT');
    return true;
  });
  const failed = projection.diagnostics();
  assert.equal(failed.pending, 0);
  assert.equal(failed.worker_active, false);
  assert.equal(failed.jobs, 1);
  assert.equal(failed.completions, 0);
  assert.equal(failed.failures, 1);
  assert.equal(failed.timeouts, 1);
  assert.equal(failed.worker_restarts, 1);
  assert.match(failed.last_error, /exceeded 100ms/);
  assert.ok(failed.last_error_at);

  projection.workerPath = path.join(__dirname,
    '../../src/runtime/intelligence-projection-worker.js');
  projection.jobTimeoutMs = 5000;
  const recovered = await projection.run(emptyState(), 'experienceStreamSnapshot', { limit: 6 });
  assert.deepEqual(recovered.value.moments, []);
  const healthy = projection.diagnostics();
  assert.equal(healthy.completions, 1);
  assert.equal(healthy.pending, 0);
  assert.equal(healthy.last_error, null);
});
