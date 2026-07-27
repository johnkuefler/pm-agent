'use strict';

function cleanError(error) {
  return String(error?.message || error || 'unknown write failure').slice(0, 500);
}

function createWriteThroughQueue({
  clock = () => new Date(),
  onError = () => {},
  retryBaseMs = 250,
  retryMaxMs = 30000,
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  const queues = new Map();
  const states = new Map();
  const baseDelayMs = Math.max(1, Number.isFinite(Number(retryBaseMs))
    ? Number(retryBaseMs) : 250);
  const maxDelayMs = Math.max(baseDelayMs, Number.isFinite(Number(retryMaxMs))
    ? Number(retryMaxMs) : 30000);

  function nowDate() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  function nowIso() {
    return nowDate().toISOString();
  }

  function stateFor(entity) {
    const key = String(entity || 'unknown');
    if (!states.has(key)) states.set(key, { requested: 0, completed: 0, failures: 0,
      retries: 0, consecutive_failures: 0, pending: 0, in_flight: 0,
      retry_scheduled: false, next_retry_at: null, last_retry_delay_ms: null,
      oldest_pending_at: null, last_started_at: null, last_retry_at: null,
      last_completed_at: null, last_error: null, last_error_at: null });
    return [key, states.get(key)];
  }

  function finishPending(state) {
    state.pending = Math.max(0, state.pending - 1);
    state.retry_scheduled = false;
    state.next_retry_at = null;
    if (state.pending === 0) state.oldest_pending_at = null;
  }

  function reportFailure(key, state, error) {
    state.failures += 1;
    state.consecutive_failures += 1;
    state.last_error = cleanError(error);
    state.last_error_at = nowIso();
    try { onError(key, error); } catch {}
  }

  function retryDelay(consecutiveFailures) {
    const exponent = Math.min(30, Math.max(0, consecutiveFailures - 1));
    return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
  }

  function waitForRetry(state, delay) {
    state.retry_scheduled = true;
    state.last_retry_delay_ms = delay;
    state.next_retry_at = new Date(nowDate().getTime() + delay).toISOString();
    return new Promise(resolve => {
      const timer = setTimer(() => {
        state.retry_scheduled = false;
        state.next_retry_at = null;
        resolve();
      }, delay);
      timer?.unref?.();
    });
  }

  async function runOperation(key, state, operation, { strict, settleCaller }) {
    let retryAttempt = 0;
    while (true) {
      if (retryAttempt > 0) {
        state.retries += 1;
        state.last_retry_at = nowIso();
      }
      state.in_flight += 1;
      state.last_started_at = nowIso();
      let result;
      let failed = false;
      let failure = null;
      try {
        result = await operation();
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        state.in_flight = Math.max(0, state.in_flight - 1);
      }

      if (!failed) {
        state.completed += 1;
        state.consecutive_failures = 0;
        state.last_completed_at = nowIso();
        state.last_error = null;
        state.last_error_at = null;
        finishPending(state);
        settleCaller(result);
        return result;
      }

      reportFailure(key, state, failure);
      settleCaller(undefined);
      if (strict) {
        finishPending(state);
        throw failure;
      }

      const delay = retryDelay(state.consecutive_failures);
      await waitForRetry(state, delay);
      retryAttempt += 1;
    }
  }

  function enqueue(entity, operation, { strict = false } = {}) {
    if (typeof operation !== 'function') throw new Error('write-through operation must be a function');
    const [key, state] = stateFor(entity);
    state.requested += 1;
    state.pending += 1;
    if (!state.oldest_pending_at) state.oldest_pending_at = nowIso();
    const previous = queues.get(key) || Promise.resolve();
    let callerSettled = strict;
    let resolveCaller;
    const caller = strict ? null : new Promise(resolve => { resolveCaller = resolve; });
    const settleCaller = value => {
      if (callerSettled) return;
      callerSettled = true;
      resolveCaller(value);
    };
    const work = previous.then(() => runOperation(key, state, operation, { strict, settleCaller }));
    const safe = work.catch(() => { settleCaller(undefined); });
    queues.set(key, safe);
    return strict ? work : caller;
  }

  function snapshot() {
    const entities = Object.fromEntries([...states.entries()].sort(([left], [right]) =>
      left.localeCompare(right)).map(([entity, state]) => [entity, { ...state }]));
    const values = Object.values(entities);
    return {
      protocol_version: 2,
      pending: values.reduce((sum, state) => sum + state.pending, 0),
      in_flight: values.reduce((sum, state) => sum + state.in_flight, 0),
      current_errors: values.filter(state => state.last_error).length,
      retrying: values.filter(state => state.pending > 0 && state.consecutive_failures > 0).length,
      retries: values.reduce((sum, state) => sum + state.retries, 0),
      failures: values.reduce((sum, state) => sum + state.failures, 0),
      retry_policy: { base_delay_ms: baseDelayMs, max_delay_ms: maxDelayMs },
      entities,
    };
  }

  async function drain({ timeoutMs = 10000 } = {}) {
    const requestedTimeout = Number(timeoutMs);
    const boundedTimeout = Math.max(1, Number.isFinite(requestedTimeout)
      ? requestedTimeout : 10000);
    const deadline = Date.now() + boundedTimeout;
    while (true) {
      const pending = [...queues.entries()]
        .filter(([key]) => (states.get(key)?.pending || 0) > 0)
        .map(([, promise]) => promise);
      if (!pending.length) {
        // Give an enqueue scheduled by a just-settled operation one microtask to become visible.
        await Promise.resolve();
        if (![...states.values()].some(state => state.pending > 0)) return true;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer;
      const completed = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise(resolve => {
          timer = setTimer(() => resolve(false), remaining);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimer(timer);
      if (!completed) return false;
    }
  }

  return { enqueue, snapshot, drain };
}

module.exports = { createWriteThroughQueue };
