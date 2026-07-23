'use strict';

function createAdaptiveWorkerLoop({
  name = 'adaptive-worker',
  bootstrap = async () => {},
  tick,
  nextDelayMs = () => 1000,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
  onError = () => {},
} = {}) {
  if (typeof tick !== 'function') throw new Error('adaptive worker tick is required');
  let started = false;
  let closed = false;
  let timer = null;
  let active = null;
  let runs = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastError = null;

  const reportError = error => {
    failures += 1;
    consecutiveFailures += 1;
    lastError = String(error?.message || error || 'adaptive worker failure').slice(0, 500);
    try { onError(error); } catch {}
  };

  const schedule = () => {
    if (closed || timer || active) return;
    const delay = Math.max(1, Number(nextDelayMs()) || 1000);
    timer = setTimer(() => {
      timer = null;
      if (closed) return;
      runs += 1;
      lastStartedAt = new Date().toISOString();
      const execution = Promise.resolve().then(tick);
      active = execution;
      execution.then(() => {
        consecutiveFailures = 0;
        lastError = null;
      }, reportError).finally(() => {
        if (active === execution) active = null;
        lastCompletedAt = new Date().toISOString();
        if (!closed) schedule();
      });
    }, delay);
    timer?.unref?.();
  };

  async function start() {
    if (started) return;
    started = true;
    const execution = Promise.resolve().then(bootstrap);
    active = execution;
    try {
      await execution;
      consecutiveFailures = 0;
      lastError = null;
    } catch (error) { reportError(error); }
    finally {
      if (active === execution) active = null;
      if (!closed) schedule();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  async function drain({ timeoutMs = 10000 } = {}) {
    const pending = active;
    if (!pending) return true;
    let timeout = null;
    const deadline = new Promise(resolve => {
      timeout = setTimer(() => resolve(false), Math.max(1, Number(timeoutMs) || 10000));
      timeout?.unref?.();
    });
    const settled = Promise.resolve(pending).then(() => true, () => true);
    const drained = await Promise.race([settled, deadline]);
    if (timeout) clearTimer(timeout);
    return drained;
  }

  function snapshot() {
    return {
      name, started, closed, running: Boolean(active), scheduled: Boolean(timer),
      runs, failures, consecutive_failures: consecutiveFailures,
      last_started_at: lastStartedAt, last_completed_at: lastCompletedAt,
      last_error: lastError,
    };
  }

  return { start, close, drain, snapshot };
}

module.exports = { createAdaptiveWorkerLoop };
