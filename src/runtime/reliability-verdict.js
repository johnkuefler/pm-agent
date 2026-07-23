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
  const recurringJobs = background.recurring_jobs || {};
  const startupTasks = background.startup_tasks || {};
  const apiOpportunityOperations = background.api_opportunity_operations || {};
  const slackWebhookEvents = background.slack_webhook_events || {};
  const acknowledgedMeetingWork = background.acknowledged_meeting_work || {};
  const recentMeetingsCache = background.recent_meetings_cache || {};
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
  const deferredWorkerFailures = Math.max(Number(deferredJobs.consecutive_worker_failures) || 0,
    Number(deferredJobs.loop?.consecutive_failures) || 0);
  if (deferredWorkerFailures >= 3 || Number(deferredJobs.pending_finalizations) > 0) {
    actionRequired.push({ code: 'deferred_job_worker_failure',
      count: deferredWorkerFailures || Number(deferredJobs.pending_finalizations),
      message: 'The deferred connector worker cannot durably advance its queue.' });
  } else if (deferredWorkerFailures > 0) {
    degraded.push({ code: 'deferred_job_worker_recovering',
      count: deferredWorkerFailures,
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
  for (const job of recurringJobs.jobs || []) {
    const failures = Number(job?.consecutive_failures) || 0;
    const timeouts = Number(job?.consecutive_timeouts) || 0;
    const slowRuns = Number(job?.consecutive_slow_runs) || 0;
    const intervalMs = Math.max(100, Number(job?.interval_ms) || 0);
    const startedAt = new Date(job?.last_started_at || 0).getTime();
    const runningAgeMs = job?.running && Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, (Number(now) || Date.now()) - startedAt) : 0;
    const skippedAt = new Date(job?.last_skipped_at || 0).getTime();
    const skippedRecently = Number.isFinite(skippedAt) && skippedAt > 0
      && (Number(now) || Date.now()) - skippedAt <= RECENT_SLOW_WINDOW_MS;
    const timedOutAt = new Date(job?.last_timed_out_at || 0).getTime();
    const timeoutBlockedAgeMs = job?.blocked_by_timed_out_execution
      && Number.isFinite(timedOutAt) && timedOutAt > 0
      ? Math.max(0, (Number(now) || Date.now()) - timedOutAt) : 0;
    if (failures >= 3 || timeouts >= 3 || runningAgeMs >= intervalMs * 2
      || timeoutBlockedAgeMs >= intervalMs) {
      actionRequired.push({ code: 'recurring_job_stuck', job: job.name,
        count: failures || timeouts || undefined,
        age_ms: runningAgeMs || timeoutBlockedAgeMs || undefined,
        message: `${job.name} cannot complete its non-overlapping runtime cycle.` });
    } else if (failures > 0 || timeouts > 0 || job?.blocked_by_timed_out_execution
      || runningAgeMs >= intervalMs || slowRuns > 0 || skippedRecently) {
      degraded.push({ code: 'recurring_job_recovering', job: job.name,
        count: failures || timeouts || slowRuns || undefined,
        age_ms: runningAgeMs || timeoutBlockedAgeMs || undefined,
        skipped_recently: skippedRecently || undefined,
        message: `${job.name} is slow or recovering; overlapping executions remain suppressed.` });
    }
  }
  const oldestStartupTaskMs = Math.max(0,
    ...(startupTasks.active || []).map(task => Number(task?.age_ms) || 0));
  if (oldestStartupTaskMs >= 3 * 60 * 1000) {
    actionRequired.push({ code: 'startup_background_task_stuck', age_ms: oldestStartupTaskMs,
      message: 'A startup warmup has remained active long enough to threaten clean recovery.' });
  } else if (oldestStartupTaskMs >= 60 * 1000) {
    degraded.push({ code: 'startup_background_task_slow', age_ms: oldestStartupTaskMs,
      message: 'A startup warmup is taking longer than its normal isolated window.' });
  }
  if ((startupTasks.recent_failures || []).length) {
    degraded.push({ code: 'startup_background_task_failure',
      count: startupTasks.recent_failures.length,
      message: 'An optional startup warmup recently failed; core service remains available.' });
  }
  if (hourlyLifecycle.state === 'stale' || hourlyLifecycle.state === 'unobserved') {
    degraded.push({ code: 'hourly_runner_stale', state: hourlyLifecycle.state,
      age_ms: hourlyLifecycle.age_ms ?? undefined,
      estimated_missed_runs: hourlyLifecycle.estimated_missed_runs ?? undefined,
      trigger_source: hourlyLifecycle.trigger_source || 'operational_scheduler',
      message: 'No operational hourly runner is opening durable lifecycles on schedule.' });
  } else if (hourlyLifecycle.state === 'late') {
    degraded.push({ code: 'hourly_runner_late', age_ms: hourlyLifecycle.age_ms,
      message: 'The operational hourly runner is outside its normal cadence grace window.' });
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
  const transcriptCheckpoints = background.transcript_checkpoints || {};
  const checkpointPending = Number(transcriptCheckpoints.pending) || 0;
  if (backgroundQueued + checkpointPending > 5) {
    degraded.push({ code: 'background_backlog', count: backgroundQueued + checkpointPending,
      message: 'Deferred background work is accumulating.' });
  }
  if (Number(transcriptCheckpoints.maximum_retry_attempt) >= 3) {
    actionRequired.push({ code: 'transcript_checkpoint_repeated_failure',
      count: Number(transcriptCheckpoints.retrying) || undefined,
      attempts: Number(transcriptCheckpoints.maximum_retry_attempt),
      message: 'At least one meeting transcript is repeatedly failing its durable checkpoint.' });
  } else if (Number(transcriptCheckpoints.retrying) > 0) {
    degraded.push({ code: 'transcript_checkpoint_retry',
      count: Number(transcriptCheckpoints.retrying),
      attempts: Number(transcriptCheckpoints.maximum_retry_attempt) || undefined,
      message: 'A meeting transcript checkpoint is retrying after a persistence failure.' });
  }
  if (Number(apiOpportunityOperations.pending) > 5) {
    degraded.push({ code: 'api_opportunity_operation_backlog',
      count: Number(apiOpportunityOperations.pending),
      message: 'Approved third-party API operations or their outcome receipts are accumulating.' });
  }
  if (apiOpportunityOperations.last_error) {
    degraded.push({ code: 'api_opportunity_operation_failure',
      message: 'An approved third-party API operation or outcome receipt recently failed.' });
  }
  const recentSlackWebhookFailures = (slackWebhookEvents.recent_failures || []).filter(item => {
    const at = new Date(item?.at || 0).getTime();
    return Number.isFinite(at) && at > 0 && assessedAt - at <= RECENT_SLOW_WINDOW_MS;
  });
  if (recentSlackWebhookFailures.length >= 3 || Number(slackWebhookEvents.oldest_active_ms) >= 45000) {
    actionRequired.push({ code: 'slack_webhook_work_stuck',
      count: recentSlackWebhookFailures.length || Number(slackWebhookEvents.active_count) || undefined,
      age_ms: Number(slackWebhookEvents.oldest_active_ms) || undefined,
      message: 'Acknowledged Slack event work is repeatedly failing or has exceeded its terminal window.' });
  } else if (recentSlackWebhookFailures.length || Number(slackWebhookEvents.oldest_active_ms) >= 20000
    || Number(slackWebhookEvents.active_count) > 10) {
    degraded.push({ code: 'slack_webhook_work_pressure',
      count: recentSlackWebhookFailures.length || Number(slackWebhookEvents.active_count) || undefined,
      age_ms: Number(slackWebhookEvents.oldest_active_ms) || undefined,
      message: 'Acknowledged Slack event work is slow, failing, or accumulating.' });
  }
  const recentMeetingWorkFailures = (acknowledgedMeetingWork.recent_failures || []).filter(item => {
    const at = new Date(item?.at || 0).getTime();
    return Number.isFinite(at) && at > 0 && assessedAt - at <= RECENT_SLOW_WINDOW_MS;
  });
  if (recentMeetingWorkFailures.length >= 3
    || Number(acknowledgedMeetingWork.oldest_active_ms) >= 45000) {
    actionRequired.push({ code: 'meeting_webhook_work_stuck',
      count: recentMeetingWorkFailures.length
        || Number(acknowledgedMeetingWork.active_count) || undefined,
      age_ms: Number(acknowledgedMeetingWork.oldest_active_ms) || undefined,
      message: 'Acknowledged meeting work is repeatedly failing or has exceeded its terminal window.' });
  } else if (recentMeetingWorkFailures.length
    || Number(acknowledgedMeetingWork.oldest_active_ms) >= 20000
    || Number(acknowledgedMeetingWork.active_count) > 10) {
    degraded.push({ code: 'meeting_webhook_work_pressure',
      count: recentMeetingWorkFailures.length
        || Number(acknowledgedMeetingWork.active_count) || undefined,
      age_ms: Number(acknowledgedMeetingWork.oldest_active_ms) || undefined,
      message: 'Acknowledged meeting work is slow, failing, or accumulating.' });
  }
  if (Number(recentMeetingsCache.consecutive_failures) >= 3
    || Number(recentMeetingsCache.active_ms) >= 30000) {
    actionRequired.push({ code: 'recent_meetings_cache_stuck',
      count: Number(recentMeetingsCache.consecutive_failures) || undefined,
      age_ms: Number(recentMeetingsCache.active_ms) || undefined,
      message: 'The recent-meetings cache is repeatedly failing or has exceeded its terminal window.' });
  } else if (Number(recentMeetingsCache.consecutive_failures) > 0
    || Number(recentMeetingsCache.active_ms) >= 10000) {
    degraded.push({ code: 'recent_meetings_cache_pressure',
      count: Number(recentMeetingsCache.consecutive_failures) || undefined,
      age_ms: Number(recentMeetingsCache.active_ms) || undefined,
      message: 'The recent-meetings cache is slow or has a current refresh failure.' });
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
  const recentStuckVoiceResponses = (realtimeTransport.response_watchdog?.recent_timeouts || [])
    .filter(item => {
      const at = new Date(item?.at || 0).getTime();
      return Number.isFinite(at) && at > 0 && assessedAt - at <= RECENT_SLOW_WINDOW_MS;
    });
  if (recentStuckVoiceResponses.length >= 3) {
    actionRequired.push({ code: 'repeated_realtime_response_stalls',
      count: recentStuckVoiceResponses.length,
      message: 'Live meeting responses repeatedly exceeded their terminal deadline.' });
  } else if (recentStuckVoiceResponses.length) {
    degraded.push({ code: 'realtime_response_recovered',
      count: recentStuckVoiceResponses.length,
      message: 'A stuck live meeting response was cancelled and its turn gate recovered.' });
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
