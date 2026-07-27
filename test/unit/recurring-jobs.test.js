'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecurringJobRegistry } = require('../../src/runtime/recurring-jobs');

test('recurring jobs schedule a full quiet interval after completion without overlapping slow work', async () => {
  let time = 0;
  const timers = [];
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let active = 0;
  let maximumActive = 0;
  const handle = registry.register('slow projection', 100, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await held;
    active -= 1;
  }, { initialDelayMs: 0 });

  const first = timers.shift();
  const running = first.fn();
  assert.equal(handle.snapshot().running, true);
  assert.equal(timers.length, 0, 'the next timer must not arm while work is active');
  time = 260;
  release();
  await running;
  assert.equal(maximumActive, 1);
  assert.equal(handle.snapshot().skipped_ticks, 2);
  assert.equal(handle.snapshot().slow_runs, 1);
  assert.equal(handle.snapshot().consecutive_slow_runs, 1);
  assert.equal(handle.snapshot().last_skipped_at, new Date(260).toISOString());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);
});

test('recurring job failures are contained, observable, and rescheduled', async () => {
  let time = 1000;
  const timers = [];
  const errors = [];
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
    onError: (name, error) => errors.push([name, error.message]),
  });
  registry.register('bounded failure', 500, async () => { throw new Error('provider unavailable'); },
    { initialDelayMs: 0 });
  await timers.shift().fn();
  const snapshot = registry.snapshot();
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.jobs[0].running, false);
  assert.equal(snapshot.jobs[0].last_error, 'provider unavailable');
  assert.equal(snapshot.jobs[0].consecutive_failures, 1);
  assert.equal(snapshot.jobs_with_unresolved_failures, 1);
  assert.deepEqual(errors, [['bounded failure', 'provider unavailable']]);
  assert.equal(timers.length, 1);
  registry.close();
  assert.equal(timers[0].cleared, true);
});

test('a successful retry clears unresolved failure health', async () => {
  let time = 1000;
  const timers = [];
  let attempts = 0;
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  registry.register('recovering', 500, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient');
  }, { initialDelayMs: 0 });

  await timers.shift().fn();
  assert.equal(registry.snapshot().jobs_with_unresolved_failures, 1);
  time = 1500;
  await timers.shift().fn();
  const recovered = registry.snapshot();
  assert.equal(recovered.jobs_with_unresolved_failures, 0);
  assert.equal(recovered.jobs[0].consecutive_failures, 0);
  assert.equal(recovered.jobs[0].last_error, null);
});

test('closing and re-registering a named job supports clean server restarts', () => {
  const timers = [];
  const registry = createRecurringJobRegistry({
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  const first = registry.register('restartable', 1000, () => {});
  first.close();
  assert.equal(timers[0].cleared, true);
  assert.doesNotThrow(() => registry.register('restartable', 1000, () => {}));
  assert.equal(registry.snapshot().registered, 1);
});

test('drain waits for active work after scheduling has closed', async () => {
  const timers = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const registry = createRecurringJobRegistry({
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  const handle = registry.register('drained', 1000, () => held, { initialDelayMs: 0 });
  const running = timers.shift().fn();
  handle.close();
  const draining = registry.drain({ timeoutMs: 5000 });
  release();
  await running;
  assert.equal(await draining, true);
  assert.equal(registry.snapshot().registered, 0);
});

test('drain reaches a bounded false result when active work is wedged', async () => {
  const timers = [];
  const registry = createRecurringJobRegistry({
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  registry.register('wedged', 1000, () => new Promise(() => {}), { initialDelayMs: 0 });
  timers.shift().fn();
  const timeout = timers.find(timer => timer.delay === 25);
  const draining = registry.drain({ timeoutMs: 25 });
  const drainTimer = timers.find(timer => timer.delay === 25);
  assert.ok(drainTimer || timeout);
  (drainTimer || timeout).fn();
  assert.equal(await draining, false);
});

test('a recurring job runtime budget aborts cooperative work and records the timeout', async () => {
  let time = 1000;
  const timers = [];
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  let aborted = false;
  const handle = registry.register('bounded provider job', 500, ({ signal, deadline_at: deadlineAt }) => {
    assert.equal(deadlineAt, new Date(1100).toISOString());
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  }, { initialDelayMs: 0, timeoutMs: 50 });

  const running = timers.shift().fn();
  await Promise.resolve();
  const terminalTimer = timers.find(timer => timer.delay === 100);
  // Runtime budgets are clamped to a safe 100ms minimum.
  assert.ok(terminalTimer);
  time = 1100;
  terminalTimer.fn();
  await running;
  const snapshot = handle.snapshot();
  assert.equal(aborted, true);
  assert.equal(snapshot.timed_out, 1);
  assert.equal(snapshot.consecutive_timeouts, 1);
  assert.equal(snapshot.blocked_by_timed_out_execution, false);
  assert.match(snapshot.last_error, /exceeded 100ms runtime budget/);
});

test('timed-out work that ignores cancellation is quarantined from overlapping retries', async () => {
  let time = 1000;
  const timers = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
  });
  let starts = 0;
  const handle = registry.register('noncooperative job', 500, async () => {
    starts += 1;
    await held;
  }, { initialDelayMs: 0, timeoutMs: 100 });

  const running = timers.shift().fn();
  await Promise.resolve();
  time = 1100;
  timers.find(timer => timer.delay === 100).fn();
  await running;
  assert.equal(handle.snapshot().blocked_by_timed_out_execution, true);
  const retryTimer = timers.find(timer => timer.delay === 500 && !timer.cleared);
  time = 1600;
  await retryTimer.fn();
  assert.equal(starts, 1, 'the unresolved timed-out execution must never overlap a retry');
  assert.equal(handle.snapshot().skipped_ticks, 1);
  release();
  await held;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handle.snapshot().blocked_by_timed_out_execution, false);
});

test('noncooperative timeout escalates only after grace and is cancelled by late settlement', async () => {
  const timers = [];
  const escalations = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const registry = createRecurringJobRegistry({
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
    nonCooperativeGraceMs: 250,
    onNonCooperativeTimeout: (name, error) => escalations.push([name, error.code]),
  });
  const handle = registry.register('restart-worthy job', 1000, () => held,
    { initialDelayMs: 0, timeoutMs: 100 });
  const running = timers.shift().fn();
  await Promise.resolve();
  timers.find(timer => timer.delay === 100).fn();
  await running;
  const graceTimer = timers.find(timer => timer.delay === 250);
  assert.ok(graceTimer);
  graceTimer.fn();
  assert.deepEqual(escalations, [
    ['restart-worthy job', 'recurring_job_noncooperative_timeout'],
  ]);
  assert.equal(handle.snapshot().noncooperative_escalations, 1);

  let releaseSecond;
  const secondHeld = new Promise(resolve => { releaseSecond = resolve; });
  const second = registry.register('late cooperative job', 1000, () => secondHeld,
    { initialDelayMs: 0, timeoutMs: 100 });
  const initial = timers.find(timer => timer.delay === 0 && !timer.cleared);
  const secondRun = initial.fn();
  await Promise.resolve();
  const secondTimeout = timers.filter(timer => timer.delay === 100 && !timer.cleared).at(-1);
  secondTimeout.fn();
  await secondRun;
  const secondGrace = timers.filter(timer => timer.delay === 250 && !timer.cleared).at(-1);
  releaseSecond();
  await secondHeld;
  await new Promise(resolve => setImmediate(resolve));
  secondGrace.fn();
  assert.equal(second.snapshot().noncooperative_escalations, 0);
  assert.equal(escalations.length, 1);
});

// A preemptible cache warmer took the whole service down in a restart loop. The job hung past its
// timeout and ignored cancellation, the registry escalated to a fatal restart, and every fresh
// start marked the same projections build-stale, so the replacement process scheduled the identical
// hang. Restarting was not a remedy; it was the loop.
function stuckJobHarness(options) {
  const fatal = [];
  const quarantined = [];
  const timers = [];
  let time = 0;
  const registry = createRecurringJobRegistry({
    now: () => time,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    onNonCooperativeTimeout: name => fatal.push(name),
    onQuarantine: name => quarantined.push(name),
    nonCooperativeGraceMs: 10,
  });
  // Never settles and never observes cancellation, which is the shape that escalates.
  registry.register('warmer', 50, () => new Promise(() => {}),
    { initialDelayMs: 0, timeoutMs: 20, ...options });
  const fire = () => {
    const pending = timers.filter(timer => !timer.cleared && !timer.fired);
    for (const timer of pending) { timer.fired = true; timer.fn(); }
  };
  return { registry, fatal, quarantined, fire, advance: ms => { time += ms; } };
}

test('a job that restarting cannot rescue is quarantined instead of killing the process', async () => {
  const h = stuckJobHarness({ restartRecoversStuck: false });
  h.fire();
  await new Promise(resolve => setImmediate(resolve));
  h.advance(100); h.fire();
  await new Promise(resolve => setImmediate(resolve));
  h.fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.fatal, [], 'a preemptible warmer must never take the process down');
  assert.deepEqual(h.quarantined, ['warmer']);
  const job = h.registry.snapshot().jobs.find(item => item.name === 'warmer');
  assert.equal(job.quarantined, true, 'and it stops scheduling rather than hanging again');
  h.registry.close();
});

// The default is unchanged. A job that genuinely recovers on a clean process still escalates.
test('an ordinary stuck job still escalates to a restart', async () => {
  const h = stuckJobHarness({});
  h.fire();
  await new Promise(resolve => setImmediate(resolve));
  h.advance(100); h.fire();
  await new Promise(resolve => setImmediate(resolve));
  h.fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.quarantined, []);
  assert.deepEqual(h.fatal, ['warmer']);
  h.registry.close();
});
