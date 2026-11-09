'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduledResultDelivery, nextTaskOccurrence } = require('../../src/runtime/scheduled-result-delivery');
const { computeNextRun } = require('../../src/lib/scheduling');

const task = { id: 'agenda', status: 'pending', scheduled_for: '2026-11-09T19:00:00Z',
  metadata: { destination_channel: 'CAGENDA' }, detail: 'Summarize verified wins' };

test('prepared result survives a delivery failure and restart without collecting sources again', async () => {
  let markers = {};
  let sends = 0;
  const deps = {
    loadMarkers: () => structuredClone(markers),
    mutateMarkers: async (fn, options) => {
      assert.equal(options.strict, true);
      const next = structuredClone(markers); fn(next); markers = next;
    },
    deliver: async body => {
      assert.equal(markers['scheduled-result:agenda'].text, body.text, 'save before sending');
      if (++sends === 1) throw new Error('Slack unavailable');
      return { ok: true, delivery: { ts: '123.4' } };
    },
  };
  const first = createScheduledResultDelivery(task, deps);
  assert.equal(first.prepare({ text: 'Verified wins' }).delivered, false);
  assert.equal(sends, 0);
  assert.equal((await first.flush()).completed, false);
  const resumed = createScheduledResultDelivery(task, deps);
  assert.equal(resumed.hasPrepared(), true);
  assert.equal((await resumed.flush()).completed, true);
  assert.deepEqual(markers, {});
});

test('a prepared result is invalidated by a new occurrence, instructions, or destination', async () => {
  const markers = {};
  const deps = { loadMarkers: () => markers, mutateMarkers: async fn => fn(markers),
    deliver: async () => { throw new Error('Unavailable'); } };
  const first = createScheduledResultDelivery(task, deps);
  first.prepare({ text: 'Old result' }); await first.flush();
  for (const changed of [
    { ...task, scheduled_for: '2026-11-23T19:00:00Z' },
    { ...task, detail: 'Different instructions' },
    { ...task, metadata: { destination_channel: 'COTHER' } },
  ]) assert.equal(createScheduledResultDelivery(changed, deps).hasPrepared(), false);
});

test('failed persistence prevents Slack delivery and a missing receipt prevents completion', async () => {
  let sends = 0;
  const deps = { loadMarkers: () => ({}), mutateMarkers: async () => { throw new Error('Database unavailable'); },
    deliver: async () => { sends++; return { ok: true }; } };
  const first = createScheduledResultDelivery(task, deps);
  first.prepare({ text: 'Result' });
  assert.equal((await first.flush()).completed, false);
  assert.equal(sends, 0);
  const second = createScheduledResultDelivery(task, { ...deps, mutateMarkers: async () => {} });
  second.prepare({ text: 'Result' });
  assert.equal((await second.flush()).completed, false);
  assert.equal(sends, 1);
});

test('late biweekly recovery keeps the original weekday and skips missed intervals', () => {
  const recurring = { ...task, recurrence: 'every:2:weeks:13:00' };
  assert.equal(nextTaskOccurrence(recurring, new Date('2026-11-10T20:00:00Z'), computeNextRun),
    '2026-11-23T19:00:00.000Z');
  assert.equal(nextTaskOccurrence(recurring, new Date('2026-11-25T20:00:00Z'), computeNextRun),
    '2026-12-07T19:00:00.000Z');
});
