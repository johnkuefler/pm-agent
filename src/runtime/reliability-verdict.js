'use strict';

const RECENT_SLOW_WINDOW_MS = 15 * 60 * 1000;

function recentSlowRequests(requests, now) {
  return (requests?.recent_slow_requests || []).filter(item => {
    const completedAt = new Date(item?.completed_at || 0).getTime();
    return Number.isFinite(completedAt) && completedAt > 0
      && now - completedAt <= RECENT_SLOW_WINDOW_MS;
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
  const responsiveness = snapshot.interactive_responsiveness || {};
  const entityWrites = snapshot.entity_writes || {};

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
  if (Object.values(responsiveness.surfaces || {}).some(surface => surface?.gate === 'failing')) {
    actionRequired.push({ code: 'interactive_latency_failing',
      message: 'A human-facing response surface is failing its measured latency gate.' });
  }
  if (Object.values(responsiveness.surfaces || {}).some(surface => surface?.prompt_gate === 'failing')) {
    actionRequired.push({ code: 'interactive_prompt_failing',
      message: 'A human-facing response surface is exceeding its prompt-size gate.' });
  }

  const slowRequests = recentSlowRequests(snapshot.requests, Number(now) || Date.now());
  if (slowRequests.length) {
    degraded.push({ code: 'recent_slow_requests', count: slowRequests.length,
      message: `${slowRequests.length} request(s) exceeded the slow-response threshold recently.` });
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
  if (Number(entityWrites.pending) > 5) {
    degraded.push({ code: 'entity_write_backlog', count: Number(entityWrites.pending),
      message: 'Durable entity writes are accumulating.' });
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

module.exports = { assessRuntimeReliability, RECENT_SLOW_WINDOW_MS };
