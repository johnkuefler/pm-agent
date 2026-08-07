'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lifecycle = require('../../src/intelligence/memory-lifecycle');
const { createMemoryMaintenance } = require('../../src/runtime/memory-maintenance');

const now = new Date('2026-08-07T18:00:00.000Z');

function memory(id, added, extra = {}) {
  return { id, fact: `Fact ${id}`, added, status: 'active', kind: 'fact',
    salience: 0.2, recall_count: 0, ...extra };
}

test('memory partitions into recent working, searchable long-term, and archive tiers', () => {
  const partition = lifecycle.partitionMemory([
    memory('recent', '2026-07-20'),
    memory('old', '2026-05-01', { retention_class: 'durable' }),
    memory('expired', '2026-05-01', { status: 'expired' }),
  ], now);
  assert.deepEqual(partition.working.map(item => item.id), ['recent']);
  assert.deepEqual(partition.long_term.map(item => item.id), ['old']);
  assert.deepEqual(partition.archive.map(item => item.id), ['expired']);
});

test('retention expires only old unprotected point-in-time snapshots', () => {
  const plan = lifecycle.planMemoryRetention([
    memory('stale-status', '2026-06-01', { fact: 'Project status is blocked as of 2026-06-01' }),
    memory('durable', '2026-06-01', { kind: 'preference', fact: 'A client prefers email' }),
    memory('recalled', '2026-06-01', { fact: 'Currently blocked', recall_count: 3 }),
    memory('hot', '2026-06-01', { fact: 'Deadline is Friday', salience: 0.8 }),
    memory('recent', '2026-08-01', { fact: 'Currently in QA' }),
  ], now);
  assert.deepEqual(plan.updates.map(update => update.id), ['stale-status']);
  assert.equal(plan.updates[0].status, 'expired');
});

test('autonomous research has a shared daily write budget without limiting human memory', () => {
  const memories = Array.from({ length: 15 }, (_, index) =>
    memory(`r-${index}`, '2026-08-07', { source: 'research' }));
  assert.equal(lifecycle.autonomousMemoryAdmission(memories,
    { source: 'research' }, now).allowed, false);
  assert.equal(lifecycle.autonomousMemoryAdmission(memories,
    { source: 'manual' }, now).allowed, true);
});

test('daily digest is bounded and retains exact source identities', () => {
  const memories = Array.from({ length: 80 }, (_, index) => memory(`m-${index}`,
    index < 40 ? '2026-08-01' : '2026-05-01', {
      project: `Project ${index % 12}`,
      fact: `Verified project fact number ${index} with concise supporting context`,
      retention_class: 'durable', salience: (index % 5) / 5,
    }));
  const digest = lifecycle.buildMemoryDigest(memories, now, {
    ...lifecycle.DEFAULT_MEMORY_POLICY, digest_max_chars: 1200,
  });
  assert.equal(digest.generated_for, '2026-08-07');
  assert.ok(digest.text.length <= 1200);
  assert.ok(digest.source_ids.length <= lifecycle.DEFAULT_MEMORY_POLICY.digest_max_items);
  assert.equal(new Set(digest.source_ids).size, digest.source_ids.length);
  assert.match(digest.content_commitment, /^[a-f0-9]{64}$/);
});

test('long-term recall is used only when recent relevant memory is insufficient', () => {
  const working = [
    { id: 'w1', distance: 0.2, _score: 5 },
    { id: 'w2', distance: 0.25, _score: 4 },
    { id: 'w3', distance: 0.3, _score: 3 },
  ];
  const old = [{ id: 'l1', distance: 0.1, _score: 10 }];
  assert.deepEqual(lifecycle.selectTieredRecall(working, old, 4).map(item => item.id),
    ['w1', 'w2', 'w3']);
  const fallback = lifecycle.selectTieredRecall(working.slice(0, 1), old, 4);
  assert.deepEqual(fallback.map(item => item.id), ['l1', 'w1']);
  assert.equal(fallback[0]._recall_mode, 'long_term_fallback');
});

test('maintenance runs once per day, applies expiry, and persists the digest', async () => {
  let items = [memory('stale', '2026-06-01', { fact: 'Currently blocked' })];
  const saved = [];
  const maintenance = createMemoryMaintenance({
    loadMemory: () => items,
    mutateMemory: async mutator => {
      const result = mutator(items);
      return { result, memory: items };
    },
    saveDigest: async digest => saved.push(digest),
    now: () => now,
  });
  const first = await maintenance.run();
  const second = await maintenance.run();
  assert.equal(first.ran, true);
  assert.equal(first.expired, 1);
  assert.equal(items[0].status, 'expired');
  assert.equal(saved.length, 1);
  assert.equal(second.ran, false);
});
