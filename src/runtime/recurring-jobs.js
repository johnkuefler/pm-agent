'use strict';

function cleanError(error) {
  return String(error?.message || error || 'unknown recurring job failure').slice(0, 500);
}

function createRecurringJobRegistry({
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
  onError = () => {},
} = {}) {
  const jobs = new Map();
  const activeRuns = new Set();
  let closed = false;

  function register(name, intervalMs, work, { initialDelayMs = intervalMs } = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('recurring job name is required');
    if (jobs.has(key)) throw new Error(`recurring job ${key} is already registered`);
    if (typeof work !== 'function') throw new Error('recurring job work must be a function');
    const interval = Math.max(100, Number(intervalMs) || 100);
    const initialDelay = Math.max(0, Number(initialDelayMs) || 0);
    const state = {
      name: key, interval_ms: interval, running: false, closed: false, timer: null,
      runs: 0, successes: 0, failures: 0, skipped_ticks: 0, slow_runs: 0,
      consecutive_failures: 0, consecutive_slow_runs: 0,
      next_due_at: now() + initialDelay, last_started_at: null, last_completed_at: null,
      last_duration_ms: null, maximum_duration_ms: 0, last_error: null,
      last_error_at: null, last_skipped_at: null,
    };

    const schedule = () => {
      if (closed || state.closed || state.timer) return;
      const delay = Math.max(0, state.next_due_at - now());
      state.timer = setTimer(run, delay);
      state.timer?.unref?.();
    };

    const run = async () => {
      state.timer = null;
      if (closed || state.closed) return;
      if (state.running) {
        state.skipped_ticks += 1;
        state.next_due_at += interval;
        schedule();
        return;
      }
      const scheduledAt = state.next_due_at;
      const startedAt = now();
      state.running = true;
      state.runs += 1;
      state.last_started_at = new Date(startedAt).toISOString();
      const execution = Promise.resolve().then(() => work({
        name: key,
        run_number: state.runs,
        scheduled_at: new Date(scheduledAt).toISOString(),
      }));
      activeRuns.add(execution);
      try {
        await execution;
        state.successes += 1;
        state.consecutive_failures = 0;
        state.last_error = null;
        state.last_error_at = null;
      } catch (error) {
        state.failures += 1;
        state.consecutive_failures += 1;
        state.last_error = cleanError(error);
        state.last_error_at = new Date(now()).toISOString();
        try { onError(key, error); } catch {}
      } finally {
        activeRuns.delete(execution);
        const completedAt = now();
        const duration = Math.max(0, completedAt - startedAt);
        state.running = false;
        state.last_completed_at = new Date(completedAt).toISOString();
        state.last_duration_ms = duration;
        state.maximum_duration_ms = Math.max(state.maximum_duration_ms, duration);
        if (duration >= interval * 0.8) {
          state.slow_runs += 1;
          state.consecutive_slow_runs += 1;
        } else {
          state.consecutive_slow_runs = 0;
        }
        const missedTicks = Math.max(0, Math.floor((completedAt - scheduledAt) / interval));
        state.skipped_ticks += missedTicks;
        if (missedTicks > 0) state.last_skipped_at = new Date(completedAt).toISOString();
        // Fixed-delay scheduling gives the process a complete quiet interval after each job.
        // A nearly interval-length run must not create a back-to-back CPU/provider burst.
        state.next_due_at = completedAt + interval;
        schedule();
      }
    };

    const handle = {
      close() {
        if (state.closed) return;
        state.closed = true;
        if (state.timer) clearTimer(state.timer);
        state.timer = null;
        jobs.delete(key);
      },
      runNow: run,
      snapshot: () => {
        const { timer, ...visible } = state;
        return { ...visible, next_due_at: new Date(state.next_due_at).toISOString() };
      },
    };
    jobs.set(key, { state, handle });
    schedule();
    return handle;
  }

  function snapshot() {
    const values = [...jobs.values()].map(({ handle }) => handle.snapshot());
    return {
      protocol_version: 1,
      registered: values.length,
      running: values.filter(job => job.running).length,
      failures: values.reduce((sum, job) => sum + job.failures, 0),
      jobs_with_unresolved_failures: values.filter(job => job.consecutive_failures > 0).length,
      skipped_ticks: values.reduce((sum, job) => sum + job.skipped_ticks, 0),
      slow_runs: values.reduce((sum, job) => sum + job.slow_runs, 0),
      jobs: values,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const { handle } of jobs.values()) handle.close();
  }

  async function drain({ timeoutMs = 10000 } = {}) {
    const pending = [...activeRuns];
    if (!pending.length) return true;
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimer(() => resolve(false), Math.max(1, Number(timeoutMs) || 10000));
      timer?.unref?.();
    });
    const settled = Promise.allSettled(pending).then(() => true);
    const drained = await Promise.race([settled, timeout]);
    if (timer) clearTimer(timer);
    return drained;
  }

  return { register, snapshot, close, drain };
}

module.exports = { createRecurringJobRegistry };
