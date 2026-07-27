'use strict';

function quarantineMessage(name, error) {
  return `⛔ Recurring runtime job ${name} quarantined after ignoring cancellation: `
    + `${cleanError(error)}. Restarting would schedule the same hang, so the job is stopped and `
    + 'the service stays up. Whatever it warms is now stale until this is fixed.';
}

function cleanError(error) {
  return String(error?.message || error || 'unknown recurring job failure').slice(0, 500);
}

function createRecurringJobRegistry({
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
  onError = () => {},
  onNonCooperativeTimeout = () => {},
  onQuarantine = () => {},
  nonCooperativeGraceMs = 5000,
} = {}) {
  const jobs = new Map();
  const activeRuns = new Set();
  let closed = false;

  // `restartRecoversStuck` says whether killing the process is a plausible remedy for this job
  // hanging. For most jobs it is: they wedge on a transient condition and come back clean.
  //
  // For a job whose work is guaranteed to be waiting again the moment the process restarts, it is
  // not a remedy at all, it is a crash loop. The build-stale projection warmer is exactly that
  // shape: every fresh start marks all three projections stale, so a restart schedules the same
  // hang. A preemptible cache warmer took the whole service down repeatedly this way.
  //
  // Those jobs quarantine instead: the job stops scheduling, the condition is reported, and the
  // service keeps serving in a degraded state rather than dying in a loop nobody can exit.
  function register(name, intervalMs, work, {
    initialDelayMs = intervalMs,
    timeoutMs = 0,
    restartRecoversStuck = true,
  } = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('recurring job name is required');
    if (jobs.has(key)) throw new Error(`recurring job ${key} is already registered`);
    if (typeof work !== 'function') throw new Error('recurring job work must be a function');
    const interval = Math.max(100, Number(intervalMs) || 100);
    const initialDelay = Math.max(0, Number(initialDelayMs) || 0);
    const timeout = Number(timeoutMs) > 0 ? Math.max(100, Number(timeoutMs)) : 0;
    const state = {
      name: key, interval_ms: interval, timeout_ms: timeout, running: false, closed: false,
      restart_recovers_stuck: restartRecoversStuck !== false, quarantined: false,
      timer: null, timeout_timer: null, quarantine_timer: null, controller: null,
      runs: 0, successes: 0, failures: 0, skipped_ticks: 0, slow_runs: 0,
      timed_out: 0, consecutive_timeouts: 0, blocked_by_timed_out_execution: false,
      noncooperative_escalations: 0,
      consecutive_failures: 0, consecutive_slow_runs: 0,
      next_due_at: now() + initialDelay, last_started_at: null, last_completed_at: null,
      last_duration_ms: null, maximum_duration_ms: 0, last_error: null,
      last_error_at: null, last_skipped_at: null, last_timed_out_at: null,
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
      if (state.running || state.blocked_by_timed_out_execution) {
        state.skipped_ticks += 1;
        state.last_skipped_at = new Date(now()).toISOString();
        state.next_due_at = now() + interval;
        schedule();
        return;
      }
      const scheduledAt = state.next_due_at;
      const startedAt = now();
      state.running = true;
      state.runs += 1;
      state.last_started_at = new Date(startedAt).toISOString();
      const controller = new AbortController();
      state.controller = controller;
      let executionSettled = false;
      const execution = Promise.resolve().then(() => work({
        name: key,
        run_number: state.runs,
        scheduled_at: new Date(scheduledAt).toISOString(),
        signal: controller.signal,
        deadline_at: timeout ? new Date(startedAt + timeout).toISOString() : null,
      }));
      activeRuns.add(execution);
      execution.then(
        () => {
          executionSettled = true;
          state.blocked_by_timed_out_execution = false;
          if (state.quarantine_timer) clearTimer(state.quarantine_timer);
          state.quarantine_timer = null;
          activeRuns.delete(execution);
        },
        () => {
          executionSettled = true;
          state.blocked_by_timed_out_execution = false;
          if (state.quarantine_timer) clearTimer(state.quarantine_timer);
          state.quarantine_timer = null;
          activeRuns.delete(execution);
        });
      const terminal = timeout ? Promise.race([
        execution,
        new Promise((_, reject) => {
          state.timeout_timer = setTimer(() => {
            const error = new Error(`recurring job ${key} exceeded ${timeout}ms runtime budget`);
            error.code = 'recurring_job_timeout';
            reject(error);
            controller.abort(error);
          }, timeout);
          state.timeout_timer?.unref?.();
        }),
      ]) : execution;
      try {
        await terminal;
        state.successes += 1;
        state.consecutive_failures = 0;
        state.consecutive_timeouts = 0;
        state.last_error = null;
        state.last_error_at = null;
      } catch (error) {
        state.failures += 1;
        state.consecutive_failures += 1;
        if (error?.code === 'recurring_job_timeout') {
          state.timed_out += 1;
          state.consecutive_timeouts += 1;
          state.last_timed_out_at = new Date(now()).toISOString();
        }
        state.last_error = cleanError(error);
        state.last_error_at = new Date(now()).toISOString();
        try { onError(key, error); } catch {}
      } finally {
        if (state.timeout_timer) clearTimer(state.timeout_timer);
        state.timeout_timer = null;
        state.controller = null;
        if (!executionSettled) {
          state.blocked_by_timed_out_execution = true;
          const graceMs = Math.max(100, Number(nonCooperativeGraceMs) || 5000);
          state.quarantine_timer = setTimer(() => {
            state.quarantine_timer = null;
            if (closed || state.closed || !state.blocked_by_timed_out_execution) return;
            state.noncooperative_escalations += 1;
            const error = new Error(
              `recurring job ${key} ignored cancellation for ${graceMs}ms after timeout`);
            error.code = 'recurring_job_noncooperative_timeout';
            if (!state.restart_recovers_stuck) {
              // Stop scheduling it and leave the process alive. The work is preemptible; the
              // service is not.
              state.quarantined = true;
              state.closed = true;
              if (state.timer) clearTimer(state.timer);
              state.timer = null;
              try { onQuarantine(key, error); } catch {}
              return;
            }
            try { onNonCooperativeTimeout(key, error); } catch {}
          }, graceMs);
          state.quarantine_timer?.unref?.();
        }
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
        if (state.timeout_timer) clearTimer(state.timeout_timer);
        if (state.quarantine_timer) clearTimer(state.quarantine_timer);
        state.controller?.abort(new Error(`recurring job ${key} closed`));
        state.timer = null;
        state.timeout_timer = null;
        state.quarantine_timer = null;
        jobs.delete(key);
      },
      runNow: run,
      snapshot: () => {
        const { timer, timeout_timer, quarantine_timer, controller, ...visible } = state;
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
      timed_out: values.reduce((sum, job) => sum + job.timed_out, 0),
      blocked_by_timed_out_execution: values.filter(job =>
        job.blocked_by_timed_out_execution).length,
      noncooperative_escalations: values.reduce((sum, job) =>
        sum + job.noncooperative_escalations, 0),
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

module.exports = { createRecurringJobRegistry, quarantineMessage };
