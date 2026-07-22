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

test('a failed lane remains visible until its next durable success', async () => {
  const errors = [];
  const queue = createWriteThroughQueue({ onError: (entity, error) => errors.push([entity, error.message]) });
  await queue.enqueue('tasks', async () => { throw new Error('database unavailable'); });
  assert.equal(queue.snapshot().current_errors, 1);
  assert.equal(queue.snapshot().entities.tasks.failures, 1);
  assert.deepEqual(errors, [['tasks', 'database unavailable']]);
  await queue.enqueue('tasks', async () => 'recovered');
  assert.equal(queue.snapshot().current_errors, 0);
  assert.equal(queue.snapshot().entities.tasks.completed, 1);
});

test('strict writes reject their caller but do not poison later queued work', async () => {
  const queue = createWriteThroughQueue();
  await assert.rejects(queue.enqueue('dreams', async () => { throw new Error('commit failed'); },
    { strict: true }), /commit failed/);
  await queue.enqueue('dreams', async () => 'next commit');
  assert.equal(queue.snapshot().entities.dreams.completed, 1);
  assert.equal(queue.snapshot().current_errors, 0);
});
