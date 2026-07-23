'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessRuntimeReliability, RECENT_SLOW_WINDOW_MS } =
  require('../../src/runtime/reliability-verdict');

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
    background_work: { post_interaction: { queued: 0 }, transcript_checkpoints: { pending: 0 },
      recurring_jobs: { jobs: [] }, startup_tasks: { active: [], recent_failures: [] },
      api_opportunity_operations: { pending: 0, last_error: null },
      slack_webhook_events: { active_count: 0, oldest_active_ms: 0, recent_failures: [] } },
    entity_writes: { pending: 0, in_flight: 0, current_errors: 0 },
    deferred_jobs: { consecutive_worker_failures: 0, pending_finalizations: 0,
      memory_queue: { queued: 0 } },
    process_health: { state: 'running', fatal: false },
    hourly_lifecycle: { state: 'fresh', latest: { status: 'completed' } },
    research_projections: {},
    process_resources: { memory: { heap_utilization: 0.1, constrained_rss_utilization: 0.2 },
      event_loop: { current_window: { p99_ms: 20, max_ms: 30 }, last_complete_window: null } },
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

test('reliability exposes approved API operation backlog and failures', () => {
  const snapshot = healthySnapshot();
  snapshot.background_work.api_opportunity_operations = {
    pending: 7, in_flight: 1, last_error: 'connector failed',
  };
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'degraded');
  assert.deepEqual(verdict.degraded.map(item => item.code), [
    'api_opportunity_operation_backlog', 'api_opportunity_operation_failure',
  ]);
});

test('reliability escalates acknowledged Slack work that cannot reach a terminal state', () => {
  const slow = healthySnapshot();
  slow.background_work.slack_webhook_events = {
    active_count: 2, oldest_active_ms: 25000, recent_failures: [],
  };
  let verdict = assessRuntimeReliability(slow, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'slack_webhook_work_pressure');

  slow.background_work.slack_webhook_events.oldest_active_ms = 46000;
  verdict = assessRuntimeReliability(slow, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'slack_webhook_work_stuck');
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

  const bootstrap = healthySnapshot();
  bootstrap.deferred_jobs.loop = { consecutive_failures: 1 };
  assert.equal(assessRuntimeReliability(bootstrap, { now }).status, 'degraded',
    'worker bootstrap failures must be visible before polling begins');
});

test('fatal process recovery is visible as action required during its drain window', () => {
  const snapshot = healthySnapshot();
  snapshot.process_health = { state: 'draining', fatal: true };
  const verdict = assessRuntimeReliability(snapshot, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'fatal_process_recovery');
});

test('recurring jobs surface transient pressure and escalate repeated failure or a stuck run', () => {
  const transient = healthySnapshot();
  transient.background_work.recurring_jobs.jobs.push({
    name: 'operational-and-intelligence-cycle',
    interval_ms: 300000,
    running: false,
    consecutive_failures: 1,
    consecutive_slow_runs: 0,
  });
  let verdict = assessRuntimeReliability(transient, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'recurring_job_recovering');

  transient.background_work.recurring_jobs.jobs[0].consecutive_failures = 3;
  verdict = assessRuntimeReliability(transient, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'recurring_job_stuck');

  const stuck = healthySnapshot();
  stuck.background_work.recurring_jobs.jobs.push({
    name: 'soma-refresh',
    interval_ms: 60000,
    running: true,
    last_started_at: new Date(now - 120001).toISOString(),
    consecutive_failures: 0,
    consecutive_slow_runs: 0,
  });
  verdict = assessRuntimeReliability(stuck, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].job, 'soma-refresh');
});

test('recurring job health clears after a successful fast cycle', () => {
  const recovered = healthySnapshot();
  recovered.background_work.recurring_jobs.jobs.push({
    name: 'recent-meetings-refresh',
    interval_ms: 600000,
    running: false,
    consecutive_failures: 0,
    consecutive_slow_runs: 0,
    last_skipped_at: new Date(now - RECENT_SLOW_WINDOW_MS - 1).toISOString(),
  });
  assert.equal(assessRuntimeReliability(recovered, { now }).status, 'healthy');
});

test('startup task stalls and failures remain visible until recovery settles', () => {
  const slow = healthySnapshot();
  slow.background_work.startup_tasks.active.push({ label: 'transcript backfill', age_ms: 60001 });
  let verdict = assessRuntimeReliability(slow, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'startup_background_task_slow');

  slow.background_work.startup_tasks.active[0].age_ms = 180001;
  verdict = assessRuntimeReliability(slow, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'startup_background_task_stuck');

  const failed = healthySnapshot();
  failed.background_work.startup_tasks.recent_failures.push({
    label: 'dashboard warmup', at: new Date(now).toISOString(), error: 'worker unavailable',
  });
  assert.equal(assessRuntimeReliability(failed, { now }).status, 'degraded');
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

test('queued research projections are not called stuck before their worker starts', () => {
  const queued = healthySnapshot();
  queued.research_projections.research_status = {
    in_flight: true,
    last_refresh_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    worker_started_at: null,
    consecutive_failures: 0,
  };
  const verdict = assessRuntimeReliability(queued);
  assert.equal(verdict.degraded.some(item => item.code === 'research_projection_recovering'), false);
  assert.equal(verdict.action_required.some(item => item.code === 'research_projection_stuck'), false);
});

test('process memory and event-loop pressure escalate before requests time out', () => {
  const delayed = healthySnapshot();
  delayed.process_resources.event_loop.current_window = { p99_ms: 300, max_ms: 800 };
  let verdict = assessRuntimeReliability(delayed, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'event_loop_delay');

  delayed.process_resources.event_loop.current_window = { p99_ms: 1200, max_ms: 5200 };
  verdict = assessRuntimeReliability(delayed, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'critical_event_loop_delay');

  const memory = healthySnapshot();
  memory.process_resources.memory.constrained_rss_utilization = 0.93;
  verdict = assessRuntimeReliability(memory, { now });
  assert.equal(verdict.status, 'action_required');
  assert.equal(verdict.action_required[0].code, 'critical_process_memory_pressure');
});

test('post-interaction timeouts and resource shedding remain visible without failing live service', () => {
  const snapshot = healthySnapshot();
  snapshot.background_work.post_interaction = {
    queued: 1, busy: true, active_ms: 9000, timeout_ms: 10000,
    recent_failures: [{ code: 'background_step_timeout', at: '2026-07-22T19:59:00.000Z' }],
  };
  snapshot.background_admission = { allowed: false, reason: 'event_loop_pressure' };
  const verdict = assessRuntimeReliability(snapshot, {
    now: new Date('2026-07-22T20:00:00.000Z').getTime(),
  });
  assert.equal(verdict.status, 'degraded');
  assert.deepEqual(verdict.degraded.map(item => item.code), [
    'post_interaction_learning_failure', 'post_interaction_learning_near_timeout',
  ]);
  assert.ok(verdict.observations.some(item => item.code === 'background_resource_shedding'));
});

test('reliability distinguishes a stopped hourly trigger from one failed but fresh run', () => {
  const stale = healthySnapshot();
  stale.hourly_lifecycle = { state: 'stale', age_ms: 4 * 3600000,
    estimated_missed_runs: 4, trigger_source: 'external_cowork_scheduler',
    latest: { status: 'failed', failure_reason: 'run_lock_expired_before_cycle_close' } };
  let verdict = assessRuntimeReliability(stale, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'hourly_runner_stale');
  assert.equal(verdict.degraded[0].estimated_missed_runs, 4);

  const failed = healthySnapshot();
  failed.hourly_lifecycle = { state: 'fresh', age_ms: 15 * 60000,
    latest: { status: 'failed', failure_reason: 'cycle_close_failed' } };
  verdict = assessRuntimeReliability(failed, { now });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.degraded[0].code, 'latest_hourly_run_failed');

  const recovered = healthySnapshot();
  recovered.hourly_lifecycle = { state: 'fresh', latest: { status: 'completed' } };
  assert.equal(assessRuntimeReliability(recovered, { now }).status, 'healthy');

  const native = healthySnapshot();
  native.hourly_lifecycle = {
    state: 'fresh', healthy: true, operational_coverage: 'native_primary',
    trigger_source: 'railway_native_scheduler',
    latest: { kind: 'fallback_hourly', status: 'completed' },
    external_primary: { state: 'stale', latest: { status: 'failed' } },
  };
  assert.equal(assessRuntimeReliability(native, { now }).status, 'healthy',
    'a stale replaced scheduler must not degrade current native operational coverage');
});
