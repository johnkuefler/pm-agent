'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-unit-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test: helpers } = require('../../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('daily recurrence selects the next Central-time occurrence', () => {
  assert.equal(
    helpers.computeNextRun('daily:10:30', new Date('2026-01-15T15:00:00.000Z')),
    '2026-01-15T16:30:00.000Z'
  );
  assert.equal(
    helpers.computeNextRun('daily:08:00', new Date('2026-01-15T15:00:00.000Z')),
    '2026-01-16T14:00:00.000Z'
  );
});

test('weekday recurrence skips weekends', () => {
  assert.equal(
    helpers.computeNextRun('weekdays:09:00', new Date('2026-01-16T23:00:00.000Z')),
    '2026-01-19T15:00:00.000Z'
  );
});

test('weekly recurrence selects the requested weekday', () => {
  assert.equal(
    helpers.computeNextRun('weekly:friday:16:00', new Date('2026-01-15T15:00:00.000Z')),
    '2026-01-16T22:00:00.000Z'
  );
});

test('monthly recurrence clamps oversized days to month end', () => {
  assert.equal(
    helpers.computeNextRun('monthly:31:09:00', new Date('2026-02-01T15:00:00.000Z')),
    '2026-02-28T15:00:00.000Z'
  );
});

test('recurrence remains on the requested wall time across DST', () => {
  assert.equal(
    helpers.computeNextRun('daily:09:00', new Date('2026-03-08T12:00:00.000Z')),
    '2026-03-08T14:00:00.000Z'
  );
});

test('invalid recurrence rules are rejected', () => {
  assert.equal(helpers.computeNextRun('sometimes:09:00'), null);
  assert.equal(helpers.computeNextRun('weekly:noday:09:00'), null);
  assert.equal(helpers.computeNextRun('monthly:0:09:00'), null);
  assert.equal(helpers.isValidRecurrence('weekly:friday:16:00'), true);
  assert.equal(helpers.isValidRecurrence('weekly:noday:16:00'), false);
  assert.equal(helpers.isValidRecurrence(''), true);
});

test('task eligibility respects status and scheduled time', () => {
  const now = new Date('2026-01-15T15:00:00.000Z');
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: null }, now), true);
  assert.equal(helpers.isTaskEligibleNow({ status: 'done', scheduled_for: null }, now), false);
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: '2026-01-15T14:59:00.000Z' }, now), true);
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: '2026-01-15T15:01:00.000Z' }, now), false);
});

