'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureMarkerPersistence, diffMarkerPersistence } = require('../../src/runtime/marker-delta');

test('one marker set produces one targeted upsert', () => {
  const markers = { a: { set_at: '2026-07-22T00:00:00Z' } };
  const before = captureMarkerPersistence(markers);
  markers.b = { set_at: '2026-07-22T01:00:00Z', note: 'new' };
  assert.deepEqual(diffMarkerPersistence(before, markers), {
    upserts: [{ key: 'b', value: markers.b }], deleted_keys: [],
  });
});

test('marker edits and deletions persist only touched keys', () => {
  const markers = { a: { value: 1 }, b: { value: 2 }, c: { value: 3 } };
  const before = captureMarkerPersistence(markers);
  markers.b.value = 4;
  delete markers.a;
  const delta = diffMarkerPersistence(before, markers);
  assert.deepEqual(delta.upserts, [{ key: 'b', value: { value: 4 } }]);
  assert.deepEqual(delta.deleted_keys, ['a']);
});

test('unchanged markers perform no database work', () => {
  const markers = { a: { value: 1 } };
  assert.deepEqual(diffMarkerPersistence(captureMarkerPersistence(markers), markers),
    { upserts: [], deleted_keys: [] });
});

test('a large marker ledger isolates one changed key quickly', () => {
  const markers = Object.fromEntries(Array.from({ length: 1000 }, (_, index) =>
    [`marker:${index}`, { value: index }]));
  const before = captureMarkerPersistence(markers);
  markers['marker:500'] = { value: 'updated' };
  const started = performance.now();
  const delta = diffMarkerPersistence(before, markers);
  assert.ok(performance.now() - started < 100);
  assert.deepEqual(delta.upserts, [{ key: 'marker:500', value: { value: 'updated' } }]);
});
