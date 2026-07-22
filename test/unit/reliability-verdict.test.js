'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessRuntimeReliability } = require('../../src/runtime/reliability-verdict');

const now = Date.parse('2026-07-22T19:00:00.000Z');

function healthySnapshot() {
  return {
    requests: { recent_slow_requests: [], recent_deadline_exceeded: [], active: [] },
    persistence: { failures: 0, pending_revisions: 0, strict_waiters: 0,
      database: { background_degraded: false, pool: { waiting: 0 } } },
    interactive_responsiveness: { current_protocol_samples: 0, surfaces: {
      slack: { gate: 'collecting', prompt_gate: 'collecting' },
      realtime: { gate: 'collecting', prompt_gate: 'collecting' },
    } },
    interactive_priority: { background_budget_cancellations: 0 },
    background_work: { post_interaction: { queued: 0 }, transcript_checkpoints: { pending: 0 } },
    entity_writes: { pending: 0, in_flight: 0, current_errors: 0 },
    deferred_jobs: { consecutive_worker_failures: 0, pending_finalizations: 0,
      memory_queue: { queued: 0 } },
    process_health: { state: 'running', fatal: false },
    research_projections: {},
    realtime_transport: { recent_stale: [] },
  };
}

test('reliability remains healthy while a fresh latency protocol collects samples', () => {
  const verdict = assessRuntimeReliability(healthySnapshot(), { now });
  assert.equal(verdict.status, 'healthy');
  assert.equal(verdict.observations[0].code, 'interactive_samples_collecting');
});

test('reliability calls recent slowness and connection contention degraded', () => {
  const snapshot = healthySnapshot();
  snapshot.requests.recent_slow_requests.push({ completed_at: '2026-07-22T18:55:00.000Z' });
  snapshot.persistence.database.pool.waiting = 2;
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'degraded');
  assert.deepEqual(verdict.degraded.map(item => item.code),
    ['recent_slow_requests', 'database_pool_waiting']);
});

test('reliability ignores stale slow requests', () => {
  const snapshot = healthySnapshot();
  snapshot.requests.recent_slow_requests.push({ completed_at: '2026-07-22T18:30:00.000Z' });
  snapshot.persistence.failures = 2;
  assert.equal(assessRuntimeReliability(snapshot, { now }).status, 'healthy');
});

test('reliability requires action for persistence or measured interaction failure', () => {
  const snapshot = healthySnapshot();
  snapshot.persistence.last_error = 'connection reset';
  snapshot.interactive_responsiveness.surfaces.slack.gate = 'failing';
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'action_required');
  assert.deepEqual(verdict.action_required.map(item => item.code),
    ['persistence_failure', 'interactive_latency_failing']);
});

test('reliability exposes unresolved entity writes and meaningful queue accumulation', () => {
  const snapshot = healthySnapshot();
  snapshot.entity_writes = { pending: 7, in_flight: 1, current_errors: 1 };
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'entity_persistence_failure');
  assert.equal(verdict.degraded[0].code, 'entity_write_backlog');
});

test('reliability surfaces active and completed request deadline pressure', () => {
  const snapshot = healthySnapshot();
  snapshot.requests.active.push({ path: '/intelligence/cycles', age_ms: 40000, deadline_ms: 45000 });
  snapshot.requests.recent_deadline_exceeded.push({
    path: '/self-model/forecast-prior', at: '2026-07-22T18:58:00.000Z',
  });
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'degraded');
  assert.deepEqual(verdict.degraded.map(item => item.code),
    ['recent_request_deadline', 'requests_nearing_deadline']);

  snapshot.requests.recent_deadline_exceeded.push(
    { path: '/cognition', at: '2026-07-22T18:57:00.000Z' },
    { path: '/expectations', at: '2026-07-22T18:56:00.000Z' });
  const repeated = assessRuntimeReliability(snapshot, { now });
  assert.equal(repeated.status, 'action_required');
  assert.equal(repeated.action_required[0].code, 'repeated_request_deadlines');
});

test('reliability escalates repeated half-open meeting sockets', () => {
  const snapshot = healthySnapshot();
  snapshot.realtime_transport.recent_stale = [1, 2, 3].map(index => ({
    label: `socket-${index}`, reason: 'pong_timeout', at: `2026-07-22T18:5${index}:00.000Z`,
  }));
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'repeated_realtime_transport_stalls');
});

test('deferred job persistence failures require action while one transient failure degrades', () => {
  const transient = healthySnapshot();
  transient.deferred_jobs.consecutive_worker_failures = 1;
  const recovering = assessRuntimeReliability(transient, { now });
  assert.equal(recovering.status, 'degraded');
  assert.equal(recovering.degraded[0].code, 'deferred_job_worker_recovering');

  const stuck = healthySnapshot();
  stuck.deferred_jobs.pending_finalizations = 1;
  const failed = assessRuntimeReliability(stuck, { now });
  assert.equal(failed.status, 'action_required');
  assert.equal(failed.action_required[0].code, 'deferred_job_worker_failure');
});

test('fatal process recovery is visible as action required during its drain window', () => {
  const snapshot = healthySnapshot();
  snapshot.process_health = { state: 'draining', fatal: true };
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'fatal_process_recovery');
});

test('slow and repeatedly failing research projections escalate without taxing live requests', () => {
  const slow = healthySnapshot();
  slow.research_projections.research_status = {
    in_flight: true, consecutive_failures: 0,
    last_refresh_started_at: new Date(now - (2 * 60 * 1000 + 1)).toISOString(),
  };
  const degraded = assessRuntimeReliability(slow, { now });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.degraded[0].code, 'research_projection_recovering');

  slow.research_projections.research_status.last_refresh_started_at =
    new Date(now - 166000).toISOString();
  const stuck = assessRuntimeReliability(slow, { now });
  assert.equal(stuck.status, 'action_required');
  assert.equal(stuck.action_required[0].code, 'research_projection_stuck');

  const failed = healthySnapshot();
  failed.research_projections.self_model = { in_flight: false, consecutive_failures: 3 };
  assert.equal(assessRuntimeReliability(failed, { now }).status, 'action_required');
});
