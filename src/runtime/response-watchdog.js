'use strict';

function createResponseWatchdogMonitor({
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const active = new Map();
  const health = {
    armed: 0,
    completed: 0,
    cancelled: 0,
    timed_out: 0,
    ignored_stale_owners: 0,
    last_timeout: null,
    recent_timeouts: [],
  };

  function finish(key, outcome = 'completed') {
    const entry = active.get(key);
    if (!entry) return false;
    clearTimer(entry.timer);
    active.delete(key);
    if (outcome === 'completed') health.completed += 1;
    else if (outcome === 'cancelled') health.cancelled += 1;
    return true;
  }

  function arm(key, {
    timeoutMs,
    label = 'realtime response',
    isCurrent = () => true,
    onTimeout = () => {},
  } = {}) {
    if (!key) throw new Error('response watchdog requires an ownership key');
    const boundedTimeoutMs = Math.max(1000, Number(timeoutMs) || 20000);
    finish(key, 'rearmed');
    const startedAt = clock();
    const entry = {
      label,
      started_at: startedAt.toISOString(),
      last_progress_at: startedAt.toISOString(),
      timeout_ms: boundedTimeoutMs,
      timer: null,
      generation: 0,
    };
    entry.schedule = () => {
      const generation = ++entry.generation;
      entry.timer = setTimer(() => {
        if (active.get(key) !== entry || entry.generation !== generation) return;
        active.delete(key);
        if (!isCurrent()) {
          health.ignored_stale_owners += 1;
          return;
        }
        const timeout = {
          at: clock().toISOString(),
          label,
          timeout_ms: boundedTimeoutMs,
        };
        health.timed_out += 1;
        health.last_timeout = timeout;
        health.recent_timeouts.push(timeout);
        while (health.recent_timeouts.length > 20) health.recent_timeouts.shift();
        onTimeout(timeout);
      }, boundedTimeoutMs);
      entry.timer.unref?.();
    };
    entry.schedule();
    active.set(key, entry);
    health.armed += 1;
    return entry;
  }

  function touch(key) {
    const entry = active.get(key);
    if (!entry) return false;
    clearTimer(entry.timer);
    entry.last_progress_at = clock().toISOString();
    entry.schedule();
    return true;
  }

  function snapshot() {
    const now = clock().getTime();
    return {
      ...health,
      active_count: active.size,
      oldest_active_ms: active.size
        ? Math.max(...[...active.values()].map(entry =>
          Math.max(0, now - new Date(entry.started_at).getTime())))
        : 0,
      active: [...active.values()].map(entry => ({
        label: entry.label,
        started_at: entry.started_at,
        last_progress_at: entry.last_progress_at,
        timeout_ms: entry.timeout_ms,
        age_ms: Math.max(0, now - new Date(entry.last_progress_at).getTime()),
      })),
    };
  }

  return { arm, touch, finish, snapshot };
}

module.exports = { createResponseWatchdogMonitor };
