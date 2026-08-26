'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readServerSource } = require('../helpers/server-source');
const { hourlyLifecycleHealth, EXPECTED_INTERVAL_MS } =
  require('../../src/runtime/hourly-lifecycle-health');

const now = Date.parse('2026-07-23T01:20:00.000Z');
const cycle = (started, status = 'completed', extra = {}) => ({
  id: `cycle-${started}`, kind: 'hourly', started, status, ...extra,
});

test('hourly lifecycle is fresh when a successful run opened within cadence', () => {
  const snapshot = hourlyLifecycleHealth([
    cycle('2026-07-23T00:20:00.000Z'),
    { kind: 'nightly', started: '2026-07-22T23:00:00.000Z', status: 'completed' },
  ], { now });
  assert.equal(snapshot.state, 'fresh');
  assert.equal(snapshot.healthy, true);
  assert.equal(snapshot.age_ms, EXPECTED_INTERVAL_MS);
  assert.equal(snapshot.estimated_missed_runs, 1);
});

test('hourly lifecycle distinguishes a late trigger from a stale external scheduler', () => {
  const late = hourlyLifecycleHealth([cycle('2026-07-22T23:40:00.000Z')], { now });
  assert.equal(late.state, 'late');
  assert.equal(late.requires_external_attention, false);

  const stale = hourlyLifecycleHealth([cycle('2026-07-22T21:05:00.000Z', 'failed', {
    recovery: { reason: 'run_lock_expired_before_cycle_close' },
  })], { now });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.requires_external_attention, true);
  assert.equal(stale.estimated_missed_runs, 4);
  assert.equal(stale.latest.failure_reason, 'run_lock_expired_before_cycle_close');
});

test('cadence grace admits Railway hot standby before a second hour is missed', () => {
  const withinGrace = hourlyLifecycleHealth([
    cycle('2026-07-23T00:06:00.000Z'),
  ], { now });
  assert.equal(withinGrace.state, 'fresh');

  const standbyDue = hourlyLifecycleHealth([
    cycle('2026-07-23T00:04:00.000Z'),
  ], { now });
  assert.equal(standbyDue.state, 'late');
  assert.equal(standbyDue.estimated_missed_runs, 1);
});

test('a newly failed run is visible without falsely claiming the scheduler stopped', () => {
  const snapshot = hourlyLifecycleHealth([
    cycle('2026-07-23T01:05:00.000Z', 'failed'),
    cycle('2026-07-23T00:05:00.000Z', 'completed'),
  ], { now });
  assert.equal(snapshot.state, 'fresh');
  assert.equal(snapshot.healthy, false);
  assert.equal(snapshot.requires_external_attention, false);
  assert.equal(snapshot.consecutive_failures, 1);
});

test('missing lifecycle history fails visibly instead of reporting healthy', () => {
  const snapshot = hourlyLifecycleHealth([], { now });
  assert.equal(snapshot.state, 'unobserved');
  assert.equal(snapshot.requires_external_attention, true);
  assert.equal(snapshot.latest, null);
});

test('native Railway coverage becomes the effective healthy hourly runner', () => {
  const snapshot = hourlyLifecycleHealth([
    cycle('2026-07-22T21:05:00.000Z'),
    { id: 'fallback-1', kind: 'fallback_hourly', started: '2026-07-23T01:05:00.000Z',
      finished: '2026-07-23T01:06:00.000Z', status: 'completed' },
  ], { now });
  assert.equal(snapshot.protocol_version, 2);
  assert.equal(snapshot.state, 'fresh');
  assert.equal(snapshot.healthy, true);
  assert.equal(snapshot.requires_external_attention, false);
  assert.equal(snapshot.trigger_source, 'railway_native_scheduler');
  assert.equal(snapshot.fallback.active, true);
  assert.equal(snapshot.operational_coverage, 'native_primary');
  assert.equal(snapshot.latest.id, 'fallback-1');
  assert.equal(snapshot.latest.kind, 'fallback_hourly');
  assert.equal(snapshot.external_primary.state, 'stale');
  assert.equal(snapshot.external_primary.latest.id.startsWith('cycle-'), true);
  assert.equal(snapshot.fallback.latest.id, 'fallback-1');
});

test('runtime health exposes hourly cadence without a dedicated live dashboard', () => {
  const server = readServerSource();
  assert.match(server, /hourly_lifecycle: hourlyLifecycleHealth\(intelligence\.list\('cycles'\)\)/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'public', 'js', 'dashboard-activity.js')), false);
});
