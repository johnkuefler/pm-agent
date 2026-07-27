'use strict';

const DEFAULT_POLL_MS = 3000;
const MAX_BACKOFF_MS = 60000;
const RECENT_FAILURE_LIMIT = 12;

function errorMessage(error) {
  return String(error?.message || error || 'unknown deferred worker failure').slice(0, 300);
}

function createDeferredJobHealth({ pollMs = DEFAULT_POLL_MS, maxBackoffMs = MAX_BACKOFF_MS } = {}) {
  const state = {
    poll_ms: Math.max(100, Number(pollMs) || DEFAULT_POLL_MS),
    max_backoff_ms: Math.max(1000, Number(maxBackoffMs) || MAX_BACKOFF_MS),
    polls: 0, jobs_completed: 0, jobs_failed: 0, worker_failures: 0,
    consecutive_worker_failures: 0, fallback_enqueued: 0, fallback_rejected: 0,
    last_poll_at: null, last_success_at: null, last_failure_at: null, last_error: null,
    next_poll_at: null, recent_failures: [],
  };

  function workerDelayMs() {
    if (!state.consecutive_worker_failures) return state.poll_ms;
    return Math.min(state.max_backoff_ms,
      state.poll_ms * (2 ** Math.min(8, state.consecutive_worker_failures)));
  }

  return {
    pollStarted(now = Date.now()) { state.polls += 1; state.last_poll_at = new Date(now).toISOString(); },
    workerSucceeded(now = Date.now()) {
      state.consecutive_worker_failures = 0;
      state.last_success_at = new Date(now).toISOString();
    },
    workerFailed(error, now = Date.now()) {
      const at = new Date(now).toISOString();
      const message = errorMessage(error);
      state.worker_failures += 1;
      state.consecutive_worker_failures += 1;
      state.last_failure_at = at;
      state.last_error = message;
      state.recent_failures.push({ at, message });
      if (state.recent_failures.length > RECENT_FAILURE_LIMIT) state.recent_failures.shift();
    },
    jobCompleted() { state.jobs_completed += 1; },
    jobFailed() { state.jobs_failed += 1; },
    fallbackEnqueued() { state.fallback_enqueued += 1; },
    fallbackRejected() { state.fallback_rejected += 1; },
    schedule(now = Date.now()) {
      const delay = workerDelayMs();
      state.next_poll_at = new Date(now + delay).toISOString();
      return delay;
    },
    snapshot({ busy = false, memoryJobs = [], pendingFinalizations = 0, now = Date.now() } = {}) {
      const queuedJobs = memoryJobs.filter(job => job?.status === 'queued');
      const oldest = queuedJobs.map(job => Number(job?._queued_at) || 0)
        .filter(Boolean).sort((a, b) => a - b)[0] || 0;
      return {
        ...state,
        busy: Boolean(busy),
        current_backoff_ms: workerDelayMs(),
        memory_queue: {
          queued: queuedJobs.length,
          running: memoryJobs.filter(job => job?.status === 'running').length,
          delivery_pending: memoryJobs.filter(job => job?.status === 'delivery_pending').length,
          delivering: memoryJobs.filter(job => job?.status === 'delivering').length,
          delivery_failed: memoryJobs.filter(job => job?.status === 'delivery_failed').length,
          retained: memoryJobs.length,
          oldest_queued_age_ms: oldest ? Math.max(0, Number(now) - oldest) : 0,
        },
        pending_finalizations: Math.max(0, Number(pendingFinalizations) || 0),
        recent_failures: state.recent_failures.slice(),
      };
    },
  };
}

module.exports = { createDeferredJobHealth, DEFAULT_POLL_MS, MAX_BACKOFF_MS };
