'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeferredJobHealth } = require('../../src/runtime/deferred-job-health');

test('deferred worker failures back off exponentially and a success resets recovery', () => {
  const health = createDeferredJobHealth({ pollMs: 3000, maxBackoffMs: 60000 });
  health.pollStarted(1000);
  health.workerFailed(new Error('database unavailable'), 1100);
  assert.equal(health.schedule(1100), 6000);
  health.workerFailed(new Error('still unavailable'), 1200);
  assert.equal(health.schedule(1200), 12000);
  health.workerSucceeded(1300);
  assert.equal(health.schedule(1300), 3000);
  assert.equal(health.snapshot().worker_failures, 2);
  assert.equal(health.snapshot().consecutive_worker_failures, 0);
});

test('deferred worker snapshot exposes fallback pressure and pending durable outcomes', () => {
  const health = createDeferredJobHealth();
  health.fallbackEnqueued();
  health.fallbackRejected();
  const snapshot = health.snapshot({ busy: true, pendingFinalizations: 2, now: 10_000,
    memoryJobs: [
      { status: 'queued', _queued_at: 7000 },
      { status: 'running', _queued_at: 8000 },
      { status: 'done', _queued_at: 1000 },
    ] });
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.fallback_enqueued, 1);
  assert.equal(snapshot.fallback_rejected, 1);
  assert.equal(snapshot.pending_finalizations, 2);
  assert.deepEqual(snapshot.memory_queue, {
    queued: 1, running: 1, retained: 3, oldest_queued_age_ms: 3000,
  });
});
