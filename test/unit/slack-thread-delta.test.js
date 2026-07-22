'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureSlackThreadPersistence, diffSlackThreadPersistence } =
  require('../../src/runtime/slack-thread-delta');
const { createWriteThroughQueue } = require('../../src/runtime/write-through-queue');

function thread(lastAddressed = '2026-07-22T00:00:00.000Z', messages = 0) {
  return { joined_at: '2026-07-21T00:00:00.000Z', last_addressed: lastAddressed,
    msgs_since_addressed: messages };
}

test('one Slack thread counter update produces one targeted upsert', () => {
  const threads = { 'C1:1': thread(), 'C2:2': thread() };
  const before = captureSlackThreadPersistence(threads);
  threads['C2:2'].msgs_since_addressed = 1;
  assert.deepEqual(diffSlackThreadPersistence(before, threads), {
    upserts: [{ key: 'C2:2', value: threads['C2:2'] }], deleted_keys: [],
  });
});

test('Slack thread additions and evictions touch only affected keys', () => {
  const threads = { 'C1:1': thread(), 'C2:2': thread() };
  const before = captureSlackThreadPersistence(threads);
  delete threads['C1:1'];
  threads['C3:3'] = thread('2026-07-22T01:00:00.000Z');
  assert.deepEqual(diffSlackThreadPersistence(before, threads), {
    upserts: [{ key: 'C3:3', value: threads['C3:3'] }], deleted_keys: ['C1:1'],
  });
});

test('Slack thread deltas are immutable snapshots', () => {
  const threads = { 'C1:1': thread() };
  const delta = diffSlackThreadPersistence(new Map(), threads);
  threads['C1:1'].msgs_since_addressed = 4;
  assert.equal(delta.upserts[0].value.msgs_since_addressed, 0);
});

test('a large Slack thread ledger isolates one changed row quickly', () => {
  const threads = Object.fromEntries(Array.from({ length: 1000 }, (_, index) =>
    [`C${index}:${index}`, thread()]));
  const before = captureSlackThreadPersistence(threads);
  threads['C700:700'].msgs_since_addressed = 2;
  const started = performance.now();
  const delta = diffSlackThreadPersistence(before, threads);
  assert.ok(performance.now() - started < 100);
  assert.deepEqual(delta.upserts.map(item => item.key), ['C700:700']);
});

test('queued Slack thread snapshots preserve rapid counter changes in order', async () => {
  let persisted = captureSlackThreadPersistence({ 'C1:1': thread() });
  const applied = [];
  const queue = createWriteThroughQueue();
  const enqueueSnapshot = threads => {
    const snapshot = JSON.parse(JSON.stringify(threads));
    return queue.enqueue('slack_threads', async () => {
      const delta = diffSlackThreadPersistence(persisted, snapshot);
      applied.push(delta);
      persisted = captureSlackThreadPersistence(snapshot);
    });
  };
  await Promise.all([
    enqueueSnapshot({ 'C1:1': thread(undefined, 1) }),
    enqueueSnapshot({ 'C1:1': thread(undefined, 2) }),
  ]);
  assert.equal(applied[0].upserts[0].value.msgs_since_addressed, 1);
  assert.equal(applied[1].upserts[0].value.msgs_since_addressed, 2);
});
