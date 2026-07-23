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
