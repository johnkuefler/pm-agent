'use strict';

const RECENT_SLOW_WINDOW_MS = 15 * 60 * 1000;
const PROJECTION_SLOW_REFRESH_MS = 2 * 60 * 1000;
const PROJECTION_STUCK_REFRESH_MS = 165 * 1000;

function recentSlowRequests(requests, now) {
  return (requests?.recent_slow_requests || []).filter(item => {
    const completedAt = new Date(item?.completed_at || 0).getTime();
    return Number.isFinite(completedAt) && completedAt > 0
      && now - completedAt <= RECENT_SLOW_WINDOW_MS;
  });
}

function recentRequestDeadlines(requests, now) {
  return (requests?.recent_deadline_exceeded || []).filter(item => {
    const at = new Date(item?.at || 0).getTime();
    return Number.isFinite(at) && at > 0 && now - at <= RECENT_SLOW_WINDOW_MS;
  });
}

function assessRuntimeReliability(snapshot = {}, { now = Date.now() } = {}) {
  const actionRequired = [];
  const degraded = [];
  const observations = [];
  const persistence = snapshot.persistence || {};
  const database = persistence.database || {};
  const priority = snapshot.interactive_priority || {};
  const background = snapshot.background_work || {};
  const backgroundAdmission = snapshot.background_admission || {};
  const responsiveness = snapshot.interactive_responsiveness || {};
  const entityWrites = snapshot.entity_writes || {};
  const realtimeTransport = snapshot.realtime_transport || {};
  const deferredJobs = snapshot.deferred_jobs || {};
  const processHealth = snapshot.process_health || {};
  const researchProjections = snapshot.research_projections || {};
  const processResources = snapshot.process_resources || {};
  const hourlyLifecycle = snapshot.hourly_lifecycle || {};

  if (database.background_degraded) {
    actionRequired.push({ code: 'database_degraded', message: 'Database persistence is degraded.' });
  }
  if (persistence.last_error) {
    actionRequired.push({ code: 'persistence_failure', message: 'State persistence has recorded a failure.' });
  }
  if (Number(entityWrites.current_errors) > 0) {
    actionRequired.push({ code: 'entity_persistence_failure',
      message: 'At least one durable entity write lane has an unresolved failure.' });
  }
  if (Number(deferredJobs.consecutive_worker_failures) >= 3 || Number(deferredJobs.pending_finalizations) > 0) {
    actionRequired.push({ code: 'deferred_job_worker_failure',
      count: Number(deferredJobs.consecutive_worker_failures) || Number(deferredJobs.pending_finalizations),
      message: 'The deferred connector worker cannot durably advance its queue.' });
  } else if (Number(deferredJobs.consecutive_worker_failures) > 0) {
    degraded.push({ code: 'deferred_job_worker_recovering',
      count: Number(deferredJobs.consecutive_worker_failures),
      message: 'The deferred connector worker is backing off after a transient failure.' });
  }
  if (Number(deferredJobs.memory_queue?.queued) > 10) {
    degraded.push({ code: 'deferred_job_memory_backlog', count: Number(deferredJobs.memory_queue.queued),
      message: 'Deferred connector work is accumulating in the bounded memory fallback.' });
  }
  if (processHealth.fatal === true && processHealth.state !== 'running') {
    actionRequired.push({ code: 'fatal_process_recovery',
      message: 'The process is draining after a fatal asynchronous error and will restart.' });
  }
  if (hourlyLifecycle.state === 'stale' || hourlyLifecycle.state === 'unobserved') {
    degraded.push({ code: 'hourly_runner_stale', state: hourlyLifecycle.state,
      age_ms: hourlyLifecycle.age_ms ?? undefined,
      estimated_missed_runs: hourlyLifecycle.estimated_missed_runs ?? undefined,
      trigger_source: hourlyLifecycle.trigger_source || 'external_cowork_scheduler',
      message: 'The external hourly runner is not opening durable lifecycles on schedule.' });
  } else if (hourlyLifecycle.state === 'late') {
    degraded.push({ code: 'hourly_runner_late', age_ms: hourlyLifecycle.age_ms,
      message: 'The external hourly runner is outside its normal cadence grace window.' });
  } else if (hourlyLifecycle.latest?.status === 'failed') {
    degraded.push({ code: 'latest_hourly_run_failed',
      failure_reason: hourlyLifecycle.latest.failure_reason || null,
      message: 'The latest hourly lifecycle failed; cadence remains observable.' });
  }
  for (const [projection, runtime] of Object.entries(researchProjections)) {
    const failures = Number(runtime?.consecutive_failures) || 0;
    const workerStartKnown = Object.prototype.hasOwnProperty.call(runtime || {}, 'worker_started_at');
    const startedAt = new Date(workerStartKnown
      ? runtime.worker_started_at || 0 : runtime?.last_refresh_started_at || 0).getTime();
    const inFlightAgeMs = runtime?.in_flight && Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, (Number(now) || Date.now()) - startedAt) : 0;
    if (failures >= 3 || inFlightAgeMs >= PROJECTION_STUCK_REFRESH_MS) {
      actionRequired.push({ code: 'research_projection_stuck', projection,
        count: failures || undefined, age_ms: inFlightAgeMs || undefined,
        message: `${projection} cannot complete its isolated background projection.` });
    } else if (failures > 0 || inFlightAgeMs >= PROJECTION_SLOW_REFRESH_MS) {
      degraded.push({ code: 'research_projection_recovering', projection,
        count: failures || undefined, age_ms: inFlightAgeMs || undefined,
        message: `${projection} is slow or backing off in its isolated background lane.` });
    }
  }
  const memory = processResources.memory || {};
  const memoryPressure = Math.max(Number(memory.heap_utilization) || 0,
    Number(memory.constrained_rss_utilization) || 0);
  if (memoryPressure >= 0.92) {
    actionRequired.push({ code: 'critical_process_memory_pressure', utilization: memoryPressure,
      message: 'The process is close to its measured memory ceiling.' });
  } else if (memoryPressure >= 0.8) {
    degraded.push({ code: 'process_memory_pressure', utilization: memoryPressure,
      message: 'Process memory pressure is elevated.' });
  }
  const loopWindows = [processResources.event_loop?.current_window,
    processResources.event_loop?.last_complete_window].filter(Boolean);
  const loopP99 = Math.max(0, ...loopWindows.map(window => Number(window.p99_ms) || 0));
  const loopMax = Math.max(0, ...loopWindows.map(window => Number(window.max_ms) || 0));
  if (loopP99 >= 1000 || loopMax >= 5000) {
    actionRequired.push({ code: 'critical_event_loop_delay', p99_ms: loopP99, max_ms: loopMax,
      message: 'The Node event loop is stalling long enough to jeopardize live responses.' });
  } else if (loopP99 >= 250 || loopMax >= 1500) {
    degraded.push({ code: 'event_loop_delay', p99_ms: loopP99, max_ms: loopMax,
      message: 'Recent event-loop delay is elevated.' });
  }
  if (Object.values(responsiveness.surfaces || {}).some(surface => surface?.gate === 'failing')) {
    actionRequired.push({ code: 'interactive_latency_failing',
      message: 'A human-facing response surface is failing its measured latency gate.' });
  }
  if (Object.values(responsiveness.surfaces || {}).some(surface => surface?.prompt_gate === 'failing')) {
    actionRequired.push({ code: 'interactive_prompt_failing',
      message: 'A human-facing response surface is exceeding its prompt-size gate.' });
  }

  const assessedAt = Number(now) || Date.now();
  const slowRequests = recentSlowRequests(snapshot.requests, assessedAt);
  const requestDeadlines = recentRequestDeadlines(snapshot.requests, assessedAt);
  if (requestDeadlines.length >= 3) {
    actionRequired.push({ code: 'repeated_request_deadlines', count: requestDeadlines.length,
      message: `${requestDeadlines.length} requests reached their terminal server deadline recently.` });
  } else if (requestDeadlines.length) {
    degraded.push({ code: 'recent_request_deadline', count: requestDeadlines.length,
      message: 'A request reached its terminal server deadline recently.' });
  }
  if (slowRequests.length) {
    degraded.push({ code: 'recent_slow_requests', count: slowRequests.length,
      message: `${slowRequests.length} request(s) exceeded the slow-response threshold recently.` });
  }
  const agingRequests = (snapshot.requests?.active || []).filter(item =>
    Number(item.deadline_ms) > 0 && Number(item.age_ms) >= Math.max(1000, Number(item.deadline_ms) * 0.8));
  if (agingRequests.length) {
    degraded.push({ code: 'requests_nearing_deadline', count: agingRequests.length,
      message: 'One or more active requests are nearing their terminal deadline.' });
  }
  if (Number(database.pool?.waiting) > 0) {
    degraded.push({ code: 'database_pool_waiting', count: Number(database.pool.waiting),
      message: 'Requests are waiting for a database connection.' });
  }
  if (Number(persistence.pending_revisions) > 2 || Number(persistence.strict_waiters) > 0) {
    degraded.push({ code: 'persistence_backlog', count: Number(persistence.pending_revisions) || 0,
      message: 'State persistence has a meaningful foreground backlog.' });
  }
  const backgroundQueued = Number(background.post_interaction?.queued) || 0;
  const checkpointPending = Number(background.transcript_checkpoints?.pending) || 0;
  if (backgroundQueued + checkpointPending > 5) {
    degraded.push({ code: 'background_backlog', count: backgroundQueued + checkpointPending,
      message: 'Deferred background work is accumulating.' });
  }
  const postInteraction = background.post_interaction || {};
  const recentPostInteractionFailures = (postInteraction.recent_failures || []).filter(item => {
    const at = new Date(item?.at || 0).getTime();
    return Number.isFinite(at) && at > 0 && assessedAt - at <= RECENT_SLOW_WINDOW_MS;
  });
  if (recentPostInteractionFailures.length) {
    degraded.push({ code: 'post_interaction_learning_failure',
      count: recentPostInteractionFailures.length,
      message: 'Optional post-response learning recently timed out or failed; live replies remained available.' });
  }
  if (postInteraction.busy && Number(postInteraction.timeout_ms) > 0
    && Number(postInteraction.active_ms) >= Number(postInteraction.timeout_ms) * 0.8) {
    degraded.push({ code: 'post_interaction_learning_near_timeout',
      age_ms: Number(postInteraction.active_ms),
      message: 'A post-response learning job is nearing its cancellation budget.' });
  }
  if (backgroundAdmission.allowed === false) {
    observations.push({ code: 'background_resource_shedding', reason: backgroundAdmission.reason,
      message: 'Optional background work is paused to preserve foreground responsiveness.' });
  }
  if (Number(entityWrites.pending) > 5) {
    degraded.push({ code: 'entity_write_backlog', count: Number(entityWrites.pending),
      message: 'Durable entity writes are accumulating.' });
  }
  const recentStaleSockets = (realtimeTransport.recent_stale || []).filter(item => {
    const at = new Date(item?.at || 0).getTime();
    return Number.isFinite(at) && at > 0 && assessedAt - at <= RECENT_SLOW_WINDOW_MS;
  });
  if (recentStaleSockets.length >= 3) {
    actionRequired.push({ code: 'repeated_realtime_transport_stalls', count: recentStaleSockets.length,
      message: 'The live meeting transport repeatedly became half-open recently.' });
  } else if (recentStaleSockets.length) {
    degraded.push({ code: 'realtime_transport_recovered', count: recentStaleSockets.length,
      message: 'A half-open live meeting socket was detected and recycled recently.' });
  }

  if (!Number(responsiveness.current_protocol_samples)) {
    observations.push({ code: 'interactive_samples_collecting',
      message: 'The current response-latency protocol is still collecting fresh samples.' });
  }
  if (Number(priority.background_budget_cancellations) > 0) {
    observations.push({ code: 'background_work_cancelled',
      count: Number(priority.background_budget_cancellations),
      message: 'Background work has been cancelled to protect responsiveness.' });
  }

  const status = actionRequired.length ? 'action_required' : degraded.length ? 'degraded' : 'healthy';
  return {
    protocol_version: 1,
    status,
    checked_at: new Date(Number(now) || Date.now()).toISOString(),
    action_required: actionRequired,
    degraded,
    observations,
  };
}

module.exports = { assessRuntimeReliability, RECENT_SLOW_WINDOW_MS,
  PROJECTION_SLOW_REFRESH_MS, PROJECTION_STUCK_REFRESH_MS, recentRequestDeadlines };
