'use strict';

function cleanError(error) {
  return String(error?.message || error || 'unknown write failure').slice(0, 500);
}

function createWriteThroughQueue({ clock = () => new Date(), onError = () => {} } = {}) {
  const queues = new Map();
  const states = new Map();

  function stateFor(entity) {
    const key = String(entity || 'unknown');
    if (!states.has(key)) states.set(key, { requested: 0, completed: 0, failures: 0,
      pending: 0, in_flight: 0, oldest_pending_at: null, last_started_at: null,
      last_completed_at: null, last_error: null, last_error_at: null });
    return [key, states.get(key)];
  }

  function enqueue(entity, operation, { strict = false } = {}) {
    if (typeof operation !== 'function') throw new Error('write-through operation must be a function');
    const [key, state] = stateFor(entity);
    state.requested += 1;
    state.pending += 1;
    if (!state.oldest_pending_at) state.oldest_pending_at = clock().toISOString();
    const previous = queues.get(key) || Promise.resolve();
    const work = previous.then(async () => {
      state.in_flight += 1;
      state.last_started_at = clock().toISOString();
      try {
        const result = await operation();
        state.completed += 1;
        state.last_completed_at = clock().toISOString();
        state.last_error = null;
        state.last_error_at = null;
        return result;
      } catch (error) {
        state.failures += 1;
        state.last_error = cleanError(error);
        state.last_error_at = clock().toISOString();
        throw error;
      } finally {
        state.in_flight = Math.max(0, state.in_flight - 1);
        state.pending = Math.max(0, state.pending - 1);
        if (state.pending === 0) state.oldest_pending_at = null;
      }
    });
    const safe = work.catch(error => { onError(key, error); });
    queues.set(key, safe);
    return strict ? work : safe;
  }

  function snapshot() {
    const entities = Object.fromEntries([...states.entries()].sort(([left], [right]) =>
      left.localeCompare(right)).map(([entity, state]) => [entity, { ...state }]));
    const values = Object.values(entities);
    return {
      protocol_version: 1,
      pending: values.reduce((sum, state) => sum + state.pending, 0),
      in_flight: values.reduce((sum, state) => sum + state.in_flight, 0),
      current_errors: values.filter(state => state.last_error).length,
      entities,
    };
  }

  async function drain({ timeoutMs = 10000 } = {}) {
    const boundedTimeout = Math.max(1, Number(timeoutMs) || 10000);
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
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed) return false;
    }
  }

  return { enqueue, snapshot, drain };
}

module.exports = { createWriteThroughQueue };
