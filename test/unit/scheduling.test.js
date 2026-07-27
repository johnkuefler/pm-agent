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
const { SCHEDULE_TZ, isValidScheduledFor } = require('../../src/lib/scheduling');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('task extraction timezone is exported and valid for date formatting', () => {
  assert.equal(SCHEDULE_TZ, 'America/Chicago');
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ }).format(new Date()));
});

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

test('multi-week recurrence supports a true biweekly cadence in Central time', () => {
  assert.equal(
    helpers.computeNextRun('every:2:weeks:09:00', new Date('2026-07-21T18:30:00.000Z')),
    '2026-08-04T14:00:00.000Z'
  );
  assert.equal(helpers.isValidRecurrence('every:2:weeks:09:00'), true);
  assert.equal(helpers.isValidRecurrence('every:0:weeks:09:00'), false);
  assert.equal(helpers.isValidRecurrence('every:2:days:09:00'), false);
});

test('recurrence remains on the requested wall time across DST', () => {
  assert.equal(
    helpers.computeNextRun('daily:09:00', new Date('2026-03-08T12:00:00.000Z')),
    '2026-03-08T14:00:00.000Z'
  );
  assert.equal(
    helpers.computeNextRun('daily:09:00', new Date('2026-11-01T12:00:00.000Z')),
    '2026-11-01T15:00:00.000Z'
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

test('recurrence clocks reject malformed and out-of-range values', () => {
  const invalid = [
    'daily:24:00',
    'daily:09:60',
    'daily:-1:00',
    'daily:9.5:00',
    'daily:09:00:extra',
    'weekdays:24:00',
    'weekdays:09:60',
    'weekly:friday:24:00',
    'weekly:friday:09:60',
    'monthly:1:24:00',
    'monthly:1:09:60',
    'monthly:1.5:09:00',
  ];
  for (const rule of invalid) {
    assert.equal(helpers.computeNextRun(rule), null, rule);
    assert.equal(helpers.isValidRecurrence(rule), false, rule);
  }
  assert.equal(
    helpers.computeNextRun('daily:9:05', new Date('2026-01-15T15:00:00.000Z')),
    '2026-01-15T15:05:00.000Z'
  );
});

test('scheduled_for accepts real ISO instants and rejects malformed calendar dates', () => {
  assert.equal(isValidScheduledFor(null), true);
  assert.equal(isValidScheduledFor(''), true);
  assert.equal(isValidScheduledFor('2026-01-15T09:00:00.000-06:00'), true);
  assert.equal(isValidScheduledFor('2026-03-08T09:00:00-05:00'), true);
  assert.equal(isValidScheduledFor('2026-01-15T15:00Z'), true);
  for (const value of [
    'not-a-date',
    '2026-02-30T09:00:00.000Z',
    '2026-01-15',
    '2026-01-15T09:00:00',
    '2026-01-15T24:00:00.000Z',
    '2026-01-15T09:60:00.000Z',
    1770000000000,
  ]) {
    assert.equal(isValidScheduledFor(value), false, String(value));
  }
});

test('task eligibility respects status and scheduled time', () => {
  const now = new Date('2026-01-15T15:00:00.000Z');
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: null }, now), true);
  assert.equal(helpers.isTaskEligibleNow({ status: 'done', scheduled_for: null }, now), false);
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: '2026-01-15T14:59:00.000Z' }, now), true);
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: '2026-01-15T15:01:00.000Z' }, now), false);
  assert.equal(helpers.isTaskEligibleNow({ status: 'pending', scheduled_for: 'not-a-date' }, now), false);
});

