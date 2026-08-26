'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hourlyFallbackDecision, fallbackForecast, FALLBACK_COOLDOWN_MS,
  FAILED_FALLBACK_RETRY_MS } =
  require('../../src/runtime/hourly-fallback');

const now = Date.parse('2026-07-23T03:00:00.000Z');
const stale = { state: 'stale' };

test('fallback becomes due only when the primary is stale and foreground is quiet', () => {
  const due = hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: false }, interactive: { active_interactions: 0, quiet_remaining_ms: 0 },
    admission: { allowed: true }, cycles: [] });
  assert.equal(due.due, true);
  assert.equal(due.reason, 'primary_scheduler_stale');

  assert.equal(hourlyFallbackDecision({ primaryHealth: { state: 'fresh' }, now,
    lock: { locked: false }, admission: { allowed: true } }).reason,
  'primary_scheduler_within_grace');
  assert.equal(hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: true }, admission: { allowed: true } }).reason,
  'operational_lock_active');
  assert.equal(hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: false }, interactive: { active_interactions: 1 },
    admission: { allowed: true } }).reason, 'interactive_priority');
});

test('hot standby covers a late or failed primary before another hour is lost', () => {
  const quiet = { now, lock: { locked: false },
    interactive: { active_interactions: 0, quiet_remaining_ms: 0 },
    admission: { allowed: true }, cycles: [] };
  const late = hourlyFallbackDecision({ ...quiet, primaryHealth: {
    state: 'late', latest: { status: 'completed' },
  } });
  assert.equal(late.due, true);
  assert.equal(late.reason, 'primary_scheduler_late');

  const failed = hourlyFallbackDecision({ ...quiet, primaryHealth: {
    state: 'fresh', latest: { status: 'failed' },
  } });
  assert.equal(failed.due, true);
  assert.equal(failed.reason, 'primary_run_failed');
});

test('recent fallback enforces cooldown without satisfying primary freshness', () => {
  const decision = hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: false }, admission: { allowed: true }, cycles: [{
      id: 'fallback-recent', kind: 'fallback_hourly', status: 'completed',
      started: new Date(now - FALLBACK_COOLDOWN_MS + 1000).toISOString(),
    }] });
  assert.equal(decision.due, false);
  assert.equal(decision.reason, 'fallback_cooldown');
  assert.equal(decision.latest_fallback.id, 'fallback-recent');
});

test('native health remains effective while scheduling still watches the external source', () => {
  const primaryHealth = {
    state: 'fresh',
    trigger_source: 'railway_native_scheduler',
    external_primary: { state: 'stale', latest: { status: 'completed' } },
  };
  const decision = hourlyFallbackDecision({ primaryHealth, now,
    lock: { locked: false }, admission: { allowed: true }, cycles: [{
      id: 'native-recent', kind: 'fallback_hourly', status: 'completed',
      started: new Date(now - FALLBACK_COOLDOWN_MS + 1000).toISOString(),
    }] });
  assert.equal(decision.reason, 'fallback_cooldown');
  assert.equal(decision.primary_state, 'stale');
});

test('failed fallback retries on a shorter bounded backoff', () => {
  const recentFailure = hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: false }, admission: { allowed: true }, cycles: [{
      id: 'fallback-failed', kind: 'fallback_hourly', status: 'failed',
      started: new Date(now - FAILED_FALLBACK_RETRY_MS + 1000).toISOString(),
    }] });
  assert.equal(recentFailure.due, false);
  assert.equal(recentFailure.cooldown_ms, FAILED_FALLBACK_RETRY_MS);
  const retry = hourlyFallbackDecision({ primaryHealth: stale, now,
    lock: { locked: false }, admission: { allowed: true }, cycles: [{
      id: 'fallback-failed', kind: 'fallback_hourly', status: 'failed',
      started: new Date(now - FAILED_FALLBACK_RETRY_MS - 1).toISOString(),
    }] });
  assert.equal(retry.due, true);
});

test('fallback forecast is a valid v4 payload without a mature prior', () => {
  const input = fallbackForecast({ cycleId: 'fallback-cycle', soma: { vitals: {
    errors10: 0, warns10: 0, onBackup: false, embedBacklog: 0,
  } } });
  assert.equal(input.protocol_version, 4);
  assert.deepEqual([...input.predicted_action_types].sort(),
    ['explicit_task_check', 'local_task_execution', 'slack_request_recovery']);
});

test('fallback forecast binds but does not overclaim use of a mature behavioral prior', () => {
  const commitment = 'a'.repeat(64);
  const input = fallbackForecast({ cycleId: 'fallback-v7', priorSnapshot: {
    available: true, prior: { id: 'prior-1', content_commitment: commitment },
  } });
  assert.equal(input.protocol_version, 7);
  assert.equal(input.behavioral_self_prior_commitment, commitment);
  assert.equal(input.behavioral_self_prior_use.disposition, 'not_relevant');
});
