'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureInteractionPersistence, diffInteractionPersistence } =
  require('../../src/runtime/interaction-delta');
const { createWriteThroughQueue } = require('../../src/runtime/write-through-queue');

function interaction(id, reviewed = false) {
  return { id, created: '2026-07-22T00:00:00.000Z', reviewed, outcome: null,
    text: `Response ${id}` };
}

test('one interaction review produces one targeted upsert', () => {
  const interactions = [interaction('a'), interaction('b')];
  const before = captureInteractionPersistence(interactions);
  interactions[1].reviewed = true;
  interactions[1].outcome = 'landed';
  assert.deepEqual(diffInteractionPersistence(before, interactions), {
    upserts: [interactions[1]], deleted_ids: [],
  });
});

test('interaction additions and retention deletions touch only their ids', () => {
  const interactions = [interaction('a'), interaction('b')];
  const before = captureInteractionPersistence(interactions);
  interactions.shift();
  interactions.push(interaction('c'));
  assert.deepEqual(diffInteractionPersistence(before, interactions), {
    upserts: [interactions[1]], deleted_ids: ['a'],
  });
});

test('interaction deltas remain immutable after live cache mutation', () => {
  const interactions = [interaction('a')];
  const delta = diffInteractionPersistence(new Map(), interactions);
  interactions[0].reviewed = true;
  assert.equal(delta.upserts[0].reviewed, false);
});

test('a large interaction ledger isolates one changed row quickly', () => {
  const interactions = Array.from({ length: 1000 }, (_, index) => interaction(`ix-${index}`));
  const before = captureInteractionPersistence(interactions);
  interactions[700].post_delivery_self_evaluation_attempt = { state: 'completed' };
  const started = performance.now();
  const delta = diffInteractionPersistence(before, interactions);
  assert.ok(performance.now() - started < 100);
  assert.deepEqual(delta.upserts.map(item => item.id), ['ix-700']);
});

test('queued interaction snapshots preserve rapid review state transitions', async () => {
  let persisted = captureInteractionPersistence([interaction('a')]);
  const applied = [];
  const queue = createWriteThroughQueue();
  const enqueueSnapshot = interactions => {
    const snapshot = JSON.parse(JSON.stringify(interactions));
    return queue.enqueue('interactions', async () => {
      const delta = diffInteractionPersistence(persisted, snapshot);
      applied.push(delta);
      persisted = captureInteractionPersistence(snapshot);
    });
  };
  const started = [{ ...interaction('a'), post_delivery_self_evaluation_attempt: { state: 'started' } }];
  const completed = [{ ...interaction('a'), post_delivery_self_evaluation_attempt: { state: 'completed' } }];
  await Promise.all([enqueueSnapshot(started), enqueueSnapshot(completed)]);
  assert.equal(applied[0].upserts[0].post_delivery_self_evaluation_attempt.state, 'started');
  assert.equal(applied[1].upserts[0].post_delivery_self_evaluation_attempt.state, 'completed');
});
