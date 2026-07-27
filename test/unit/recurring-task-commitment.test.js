'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-recurring-commitment-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test } = require('../../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function storeHarness(commitments) {
  const updates = [];
  const events = [];
  return {
    updates,
    events,
    list: (_entity, predicate) => commitments.filter(predicate),
    updateCommitment: (id, changes) => { updates.push({ id, changes }); },
    recordEpisodeEvent: event => { events.push(event); return event; },
  };
}

test('a recurring completion advances its open commitment instead of leaving it overdue', () => {
  const store = storeHarness([{
    id: 'commit-1',
    task_id: 'task-1',
    status: 'open',
    notes: 'Send the weekly report.',
  }]);
  const task = {
    id: 'task-1',
    action: 'Send weekly report',
    status: 'pending',
    recurrence: 'weekly:monday:09:00',
    scheduled_for: '2026-08-03T14:00:00.000Z',
    source_channel: 'slack:C123',
    source_thread_ts: '1800000000.000001',
  };

  const result = __test.taskCommitmentLifecycle(task, {
    recurring: true,
    completed_at: '2026-07-27T14:01:00.000Z',
  }, store);

  assert.deepEqual(result, {
    recurring: true,
    updated: 1,
    next_due: task.scheduled_for,
  });
  assert.equal(store.updates[0].id, 'commit-1');
  assert.equal(store.updates[0].changes.due, task.scheduled_for);
  assert.equal(store.updates[0].changes.next_check, task.scheduled_for);
  assert.equal(store.updates[0].changes.last_checked, '2026-07-27T14:01:00.000Z');
  assert.match(store.updates[0].changes.notes, /next due 2026-08-03/);
  assert.equal(store.updates[0].changes.status, undefined,
    'the recurring commitment must remain open for its next occurrence');
  assert.equal(store.events[0].kind, 'commitment_occurrence_fulfilled');
  assert.equal(store.events[0].status, 'open');
});

test('a one-shot completion still fulfills the bound commitment', () => {
  const store = storeHarness([{ id: 'commit-2', task_id: 'task-2', status: 'open' }]);
  const result = __test.taskCommitmentLifecycle({
    id: 'task-2',
    action: 'Ship deliverable',
  }, {
    recurring: false,
    completed_at: '2026-07-26T18:00:00.000Z',
  }, store);
  assert.equal(result.recurring, false);
  assert.equal(store.updates[0].changes.status, 'fulfilled');
  assert.equal(store.events[0].kind, 'commitment_fulfilled');
});
