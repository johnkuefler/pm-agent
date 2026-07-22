'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureDreamPersistence, diffDreamPersistence } = require('../../src/runtime/dream-delta');
const { createWriteThroughQueue } = require('../../src/runtime/write-through-queue');

function dream(id, date = '2026-07-22') {
  return { id, date, started: `${date}T06:00:00.000Z`, finished: `${date}T06:10:00.000Z`,
    reflection: { ideas: [] }, review: {} };
}

test('one dream reflection update produces one targeted upsert', () => {
  const dreams = [dream('a'), dream('b')];
  const before = captureDreamPersistence(dreams);
  dreams[1].reflection.ideas.push('A bounded idea');
  assert.deepEqual(diffDreamPersistence(before, dreams), {
    upserts: [dreams[1]], deleted_ids: [],
  });
});

test('new dreams and retention pruning touch only affected ids', () => {
  const dreams = [dream('a', '2026-07-21'), dream('b', '2026-07-20')];
  const before = captureDreamPersistence(dreams);
  dreams.pop();
  dreams.unshift(dream('c', '2026-07-22'));
  assert.deepEqual(diffDreamPersistence(before, dreams), {
    upserts: [dreams[0]], deleted_ids: ['b'],
  });
});

test('dream deltas remain immutable after live mutation', () => {
  const dreams = [dream('a')];
  const delta = diffDreamPersistence(new Map(), dreams);
  dreams[0].reflection.ideas.push('late mutation');
  assert.deepEqual(delta.upserts[0].reflection.ideas, []);
});

test('a large dream ledger isolates one changed row quickly', () => {
  const dreams = Array.from({ length: 1000 }, (_, index) => dream(`dream-${index}`));
  const before = captureDreamPersistence(dreams);
  dreams[500].review.outcome = 'supported';
  const started = performance.now();
  const delta = diffDreamPersistence(before, dreams);
  assert.ok(performance.now() - started < 100);
  assert.deepEqual(delta.upserts.map(item => item.id), ['dream-500']);
});

test('queued dream snapshots preserve sequential reflection states', async () => {
  let persisted = captureDreamPersistence([dream('a')]);
  const applied = [];
  const queue = createWriteThroughQueue();
  const enqueueSnapshot = dreams => {
    const snapshot = JSON.parse(JSON.stringify(dreams));
    return queue.enqueue('dreams', async () => {
      const delta = diffDreamPersistence(persisted, snapshot);
      applied.push(delta);
      persisted = captureDreamPersistence(snapshot);
    });
  };
  const candidate = [{ ...dream('a'), development: { state: 'candidate' } }];
  const reviewed = [{ ...dream('a'), development: { state: 'reviewed' } }];
  await Promise.all([enqueueSnapshot(candidate), enqueueSnapshot(reviewed)]);
  assert.equal(applied[0].upserts[0].development.state, 'candidate');
  assert.equal(applied[1].upserts[0].development.state, 'reviewed');
});
