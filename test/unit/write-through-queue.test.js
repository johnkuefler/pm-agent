'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWriteThroughQueue } = require('../../src/runtime/write-through-queue');

test('write-through queue serializes one entity and exposes pending work', async () => {
  const order = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const queue = createWriteThroughQueue();
  const first = queue.enqueue('memory', async () => { order.push('first-start'); await held;
    order.push('first-end'); });
  const second = queue.enqueue('memory', async () => { order.push('second'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.snapshot().pending, 2);
  assert.equal(queue.snapshot().in_flight, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().entities.memory.completed, 2);
});

test('a final non-strict revision retries and recovers without a subsequent mutation', async () => {
  const errors = [];
  let attempts = 0;
  const queue = createWriteThroughQueue({
    retryBaseMs: 5,
    retryMaxMs: 20,
    onError: (entity, error) => errors.push([entity, error.message]),
  });
  const accepted = await queue.enqueue('tasks', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('database unavailable');
    return 'recovered';
  });
  assert.equal(accepted, undefined);
  assert.equal(queue.snapshot().current_errors, 1);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().retrying, 1);
  assert.equal(queue.snapshot().entities.tasks.failures, 1);
  assert.deepEqual(errors, [['tasks', 'database unavailable']]);
  assert.equal(await queue.drain({ timeoutMs: 500 }), true);
  assert.equal(attempts, 2);
  assert.equal(queue.snapshot().current_errors, 0);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().retrying, 0);
  assert.equal(queue.snapshot().entities.tasks.retries, 1);
  assert.equal(queue.snapshot().entities.tasks.completed, 1);
});

test('strict writes reject their caller but do not poison later queued work', async () => {
  let strictAttempts = 0;
  const queue = createWriteThroughQueue({ retryBaseMs: 5, retryMaxMs: 20 });
  await assert.rejects(queue.enqueue('dreams', async () => {
    strictAttempts += 1;
    throw new Error('commit failed');
  }, { strict: true }), /commit failed/);
  assert.equal(strictAttempts, 1);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().retrying, 0);
  await queue.enqueue('dreams', async () => 'next commit');
  assert.equal(queue.snapshot().entities.dreams.completed, 1);
  assert.equal(queue.snapshot().current_errors, 0);
});

test('non-strict retries use one capped exponential timer per lane', async () => {
  let now = Date.parse('2026-07-26T12:00:00.000Z');
  const timers = [];
  const setTimer = (fn, delay) => {
    const timer = { delay, active: true, unref() {}, fire() {
      if (!this.active) return;
      this.active = false;
      now += delay;
      fn();
    } };
    timers.push(timer);
    return timer;
  };
  let attempts = 0;
  const queue = createWriteThroughQueue({
    clock: () => new Date(now),
    retryBaseMs: 10,
    retryMaxMs: 25,
    setTimer,
    clearTimer: timer => { timer.active = false; },
  });
  await queue.enqueue('markers', async () => {
    attempts += 1;
    if (attempts < 4) throw new Error(`failure ${attempts}`);
  });

  assert.deepEqual(timers.filter(timer => timer.active).map(timer => timer.delay), [10]);
  timers.find(timer => timer.active).fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.filter(timer => timer.active).map(timer => timer.delay), [20]);
  timers.find(timer => timer.active).fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.filter(timer => timer.active).map(timer => timer.delay), [25]);
  timers.find(timer => timer.active).fire();
  await new Promise(resolve => setImmediate(resolve));

  const snapshot = queue.snapshot();
  assert.equal(attempts, 4);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.retries, 3);
  assert.equal(snapshot.failures, 3);
  assert.equal(snapshot.current_errors, 0);
  assert.equal(timers.filter(timer => timer.active).length, 0);
});

test('drain waits for queued writes and work enqueued by a settling operation', async () => {
  const queue = createWriteThroughQueue();
  const order = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  queue.enqueue('transcript:one', async () => {
    order.push('first-start');
    await held;
    order.push('first-end');
    queue.enqueue('transcript:two', async () => { order.push('follow-up'); });
  });
  const draining = queue.drain({ timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  release();
  assert.equal(await draining, true);
  assert.deepEqual(order, ['first-start', 'first-end', 'follow-up']);
  assert.equal(queue.snapshot().pending, 0);
});

test('drain is bounded when a write does not settle', async () => {
  const queue = createWriteThroughQueue();
  queue.enqueue('hung', () => new Promise(() => {}));
  assert.equal(await queue.drain({ timeoutMs: 20 }), false);
  assert.equal(queue.snapshot().pending, 1);
});

test('drain is bounded while a failed revision waits for a later retry', async () => {
  const queue = createWriteThroughQueue({ retryBaseMs: 60000, retryMaxMs: 60000 });
  await queue.enqueue('offline', async () => { throw new Error('still offline'); });
  const started = Date.now();
  assert.equal(await queue.drain({ timeoutMs: 20 }), false);
  assert.ok(Date.now() - started < 500);
  const snapshot = queue.snapshot();
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.retrying, 1);
  assert.equal(snapshot.entities.offline.next_retry_at !== null, true);
});
