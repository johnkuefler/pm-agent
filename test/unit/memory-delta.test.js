'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { captureMemoryPersistence, diffMemoryPersistence } = require('../../src/runtime/memory-delta');

function memory(id, fact = `Fact ${id}`) {
  return { id, fact, source: 'manual', added: '2026-07-22', salience: 0.5,
    kind: 'fact', confidence: 0.9, status: 'active' };
}

test('one appended memory produces one row upsert', () => {
  const items = [memory('a'), memory('b')];
  const before = captureMemoryPersistence(items);
  items.push(memory('c'));
  const delta = diffMemoryPersistence(before, items);
  assert.deepEqual(delta.upserts.map(change => [change.item.id, change.ord]), [['c', 2]]);
  assert.deepEqual(delta.deleted_ids, []);
});

test('one memory edit updates only that row and preserves its order', () => {
  const items = [memory('a'), memory('b'), memory('c')];
  const before = captureMemoryPersistence(items);
  items[1].fact = 'Revised fact';
  const delta = diffMemoryPersistence(before, items);
  assert.deepEqual(delta.upserts.map(change => [change.item.id, change.ord]), [['b', 1]]);
  assert.deepEqual(delta.deleted_ids, []);
});

test('deleting rows does not rewrite every row whose array index shifted', () => {
  const items = [memory('a'), memory('b'), memory('c')];
  const before = captureMemoryPersistence(items);
  items.splice(0, 2);
  const delta = diffMemoryPersistence(before, items);
  assert.deepEqual(delta.upserts, []);
  assert.deepEqual(delta.deleted_ids, ['a', 'b']);
});

test('an unchanged mutation produces no database work', () => {
  const items = [memory('a')];
  assert.deepEqual(diffMemoryPersistence(captureMemoryPersistence(items), items),
    { upserts: [], deleted_ids: [] });
});

test('a large memory ledger still identifies one appended row without a rewrite', () => {
  const items = Array.from({ length: 2500 }, (_, index) => memory(`m-${index}`));
  const before = captureMemoryPersistence(items);
  items.push(memory('new-memory'));
  const started = performance.now();
  const delta = diffMemoryPersistence(before, items);
  assert.ok(performance.now() - started < 100);
  assert.equal(delta.upserts.length, 1);
  assert.equal(delta.upserts[0].item.id, 'new-memory');
});
