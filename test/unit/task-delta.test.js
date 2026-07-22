'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureTaskPersistence, diffTaskPersistence } = require('../../src/runtime/task-delta');
const { createWriteThroughQueue } = require('../../src/runtime/write-through-queue');

function task(id, status = 'pending') {
  return { id, action: `Do ${id}`, status, created: '2026-07-22T00:00:00.000Z' };
}

test('one task update produces one targeted upsert', () => {
  const tasks = [task('a'), task('b')];
  const before = captureTaskPersistence(tasks);
  tasks[1].status = 'completed';
  assert.deepEqual(diffTaskPersistence(before, tasks), {
    upserts: [tasks[1]], deleted_ids: [],
  });
});

test('task additions and deletions touch only their ids', () => {
  const tasks = [task('a'), task('b')];
  const before = captureTaskPersistence(tasks);
  tasks.shift();
  tasks.push(task('c'));
  const delta = diffTaskPersistence(before, tasks);
  assert.deepEqual(delta.upserts, [tasks[1]]);
  assert.deepEqual(delta.deleted_ids, ['a']);
});

test('task delta snapshots do not change with later live-object mutation', () => {
  const tasks = [task('a')];
  const delta = diffTaskPersistence(captureTaskPersistence([]), tasks);
  tasks[0].status = 'cancelled';
  assert.equal(delta.upserts[0].status, 'pending');
});

test('a large task ledger isolates one changed row quickly', () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => task(`task-${index}`));
  const before = captureTaskPersistence(tasks);
  tasks[700].scheduled_for = '2026-07-23T15:00:00.000Z';
  const started = performance.now();
  const delta = diffTaskPersistence(before, tasks);
  assert.ok(performance.now() - started < 100);
  assert.deepEqual(delta.upserts.map(item => item.id), ['task-700']);
});

test('queued task snapshots persist a later reversal in the correct order', async () => {
  let persisted = captureTaskPersistence([task('a')]);
  const applied = [];
  const queue = createWriteThroughQueue();
  const enqueueSnapshot = tasks => {
    const snapshot = JSON.parse(JSON.stringify(tasks));
    return queue.enqueue('tasks', async () => {
      const delta = diffTaskPersistence(persisted, snapshot);
      applied.push(delta);
      persisted = captureTaskPersistence(snapshot);
    });
  };
  const changed = [task('a', 'completed')];
  const reverted = [task('a', 'pending')];
  await Promise.all([enqueueSnapshot(changed), enqueueSnapshot(reverted)]);
  assert.equal(applied[0].upserts[0].status, 'completed');
  assert.equal(applied[1].upserts[0].status, 'pending');
});
