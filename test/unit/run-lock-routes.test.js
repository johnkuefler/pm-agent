'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRunLockRoutes } = require('../../src/routes/registerRunLockRoutes');

function routeHarness(options = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['post', 'get', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  registerRunLockRoutes(app, (_req, _res, next) => next?.(), options);
  const call = async (method, path, { body = {}, query = {} } = {}) => {
    const output = { statusCode: 200, body: null };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(value) { output.body = value; return this; },
    };
    await routes.get(`${method} ${path}`)({ body, query }, res);
    return output;
  };
  return { call };
}

test('concurrent fresh acquisitions admit exactly one holder and one lifecycle', async () => {
  let persisted = null;
  let acquisitions = 0;
  const { call } = routeHarness({
    loadLock: async () => {
      const snapshot = persisted == null ? null : JSON.parse(JSON.stringify(persisted));
      await new Promise(resolve => setImmediate(resolve));
      return snapshot;
    },
    saveLock: value => {
      persisted = value == null ? null : JSON.parse(JSON.stringify(value));
    },
    onAcquire: ({ holder }) => {
      acquisitions += 1;
      return { cycle_id: `cycle:${holder}`, moment_id: `moment:${holder}` };
    },
  });

  const results = await Promise.all([
    call('POST', '/run-lock', { body: { holder: 'run-racer-one', ttl_seconds: 60 } }),
    call('POST', '/run-lock', { body: { holder: 'run-racer-two', ttl_seconds: 60 } }),
  ]);
  const winners = results.filter(result => result.body.acquired);
  const deferred = results.filter(result => !result.body.acquired);

  assert.equal(winners.length, 1, 'only one request may observe and replace the empty lease');
  assert.equal(deferred.length, 1);
  assert.equal(acquisitions, 1, 'only the winning request may open a run-bound lifecycle');
  assert.equal(deferred[0].body.held_by, winners[0].body.holder);
  assert.equal(persisted.holder, winners[0].body.holder);
});

test('a caller-proposed strong fencing token makes acquisition retries recoverable', async () => {
  const { call } = routeHarness();
  const fencingToken = 'caller_owned_recovery_token_1234567890';
  const first = await call('POST', '/run-lock', {
    body: { holder: 'run-recoverable', fencing_token: fencingToken, ttl_seconds: 60 },
  });
  assert.equal(first.body.acquired, true);
  assert.equal(first.body.fencing_token, fencingToken);
  const retry = await call('POST', '/run-lock', {
    body: { holder: 'run-recoverable', fencing_token: fencingToken, ttl_seconds: 60 },
  });
  assert.equal(retry.body.acquired, true);
  assert.equal(retry.body.fencing_token, fencingToken);
  const invalid = await call('POST', '/run-lock', {
    body: { holder: 'another-run', fencing_token: 'too-short', ttl_seconds: 60 },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'run_lock_fencing_token_invalid');
});

test('run lock carries one lifecycle from acquisition through holder-owned release', async () => {
  const acquired = [];
  const released = [];
  const { call } = routeHarness({
    onAcquire: input => {
      acquired.push(input);
      return { kind: 'run_bound_intelligence_cycle', cycle_id: 'cycle-1', moment_id: 'moment-1' };
    },
    onRelease: input => {
      released.push(input);
      return { ...input.lifecycle, closure_status: 'explicit_gap_recorded', evidence_eligible: false };
    },
  });

  const first = await call('POST', '/run-lock', { body: { holder: 'run-one', ttl_seconds: 60 } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.acquired, true);
  assert.equal(first.body.lifecycle.cycle_id, 'cycle-1');
  assert.equal(acquired.length, 1);
  assert.match(first.body.fencing_token, /^[0-9a-f-]{36}$/);

  const unfencedRefresh = await call('POST', '/run-lock', {
    body: { holder: 'run-one', ttl_seconds: 120 },
  });
  assert.equal(unfencedRefresh.body.acquired, false);
  assert.equal(unfencedRefresh.body.code, 'run_lock_fencing_token_mismatch');

  const refreshed = await call('POST', '/run-lock', {
    body: { holder: 'run-one', fencing_token: first.body.fencing_token, ttl_seconds: 120 },
  });
  assert.equal(refreshed.body.acquired, true);
  assert.equal(refreshed.body.fencing_token, first.body.fencing_token);
  assert.equal(refreshed.body.lifecycle.moment_id, 'moment-1');
  assert.equal(acquired.length, 1, 'refreshing the same lock must not open another lifecycle');

  const contender = await call('POST', '/run-lock', { body: { holder: 'run-two' } });
  assert.equal(contender.body.acquired, false);
  assert.equal(contender.body.held_by, 'run-one');
  assert.equal((await call('DELETE', '/run-lock', { query: { holder: 'run-two' } })).body.released, false);
  assert.equal(released.length, 0);

  const final = await call('DELETE', '/run-lock', {
    query: { holder: 'run-one', fencing_token: first.body.fencing_token },
  });
  assert.equal(final.body.released, true);
  assert.equal(final.body.lifecycle.closure_status, 'explicit_gap_recorded');
  assert.equal(final.body.lifecycle.evidence_eligible, false);
  assert.equal(released.length, 1);
  assert.equal(released[0].lifecycle.cycle_id, 'cycle-1');
  assert.equal((await call('GET', '/run-lock')).body.locked, false);
});

test('run lock projects current lifecycle guidance without rewriting the durable lease', async () => {
  let persisted = null;
  let stage = 'forecast_required';
  const { call } = routeHarness({
    loadLock: () => persisted,
    saveLock: value => { persisted = value == null ? null : JSON.parse(JSON.stringify(value)); },
    onAcquire: () => ({
      kind: 'run_bound_intelligence_cycle', cycle_id: 'cycle-live', moment_id: 'moment-live',
      next_required_action: 'initial acquisition guidance',
    }),
    projectLifecycle: ({ lifecycle }) => ({
      ...lifecycle,
      lifecycle_stage: stage,
      next_required_action: stage === 'forecast_required' ? 'submit forecast' : 'continue operations',
    }),
  });
  const acquired = await call('POST', '/run-lock', {
    body: { holder: 'run-live', ttl_seconds: 3000 },
  });
  assert.equal(acquired.body.lifecycle.lifecycle_stage, 'forecast_required');
  assert.equal(persisted.lifecycle.lifecycle_stage, undefined,
    'derived guidance must not mutate the restart-durable acquisition tuple');
  stage = 'operational_cycle_active';
  const inspected = await call('GET', '/run-lock');
  assert.equal(inspected.body.lifecycle.lifecycle_stage, 'operational_cycle_active');
  assert.equal(inspected.body.lifecycle.next_required_action, 'continue operations');
  assert.equal(persisted.lifecycle.next_required_action, 'initial acquisition guidance');
});

test('run lock reports a projection failure without lying about lease ownership', async () => {
  let persisted = null;
  const { call } = routeHarness({
    loadLock: () => persisted,
    saveLock: value => { persisted = value; },
    onAcquire: () => ({ cycle_id: 'cycle-projection-failure', moment_id: 'moment-projection-failure' }),
    projectLifecycle: () => { throw new Error('cycle projection unavailable'); },
  });
  const acquired = await call('POST', '/run-lock', {
    body: { holder: 'run-projection-failure', ttl_seconds: 3000 },
  });
  assert.equal(acquired.statusCode, 200);
  assert.equal(acquired.body.acquired, true);
  assert.equal(acquired.body.lifecycle.lifecycle_stage, 'projection_failure');
  assert.equal(acquired.body.lifecycle.lifecycle_projection_integrity_verified, false);
  assert.equal(persisted.holder, 'run-projection-failure');
  const inspected = await call('GET', '/run-lock');
  assert.equal(inspected.body.locked, true);
  assert.equal(inspected.body.holder, 'run-projection-failure');
  assert.equal(inspected.body.lifecycle.lifecycle_stage, 'projection_failure');
});

test('run lock fails closed when its lifecycle cannot start', async () => {
  const { call } = routeHarness({ onAcquire: () => { throw new Error('ledger unavailable'); } });
  const result = await call('POST', '/run-lock', { body: { holder: 'run-failed' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.acquired, false);
  assert.equal(result.body.reason, 'lifecycle_start_failed');
  assert.equal((await call('GET', '/run-lock')).body.locked, false);
});

test('an expired holder cannot release a newer lease that reused the same holder name', async () => {
  let now = Date.parse('2026-07-26T12:00:00.000Z');
  const { call } = routeHarness({ clock: () => now });

  const first = await call('POST', '/run-lock', {
    body: { holder: 'run-reused', ttl_seconds: 60 },
  });
  now += 61_000;
  const successor = await call('POST', '/run-lock', {
    body: { holder: 'run-reused', ttl_seconds: 60 },
  });
  assert.equal(successor.body.acquired, true);
  assert.notEqual(successor.body.fencing_token, first.body.fencing_token);

  const staleRelease = await call('DELETE', '/run-lock', {
    query: { holder: 'run-reused', fencing_token: first.body.fencing_token },
  });
  assert.equal(staleRelease.body.released, false);
  assert.equal(staleRelease.body.code, 'run_lock_fencing_token_mismatch');
  const stillHeld = await call('GET', '/run-lock');
  assert.equal(stillHeld.body.locked, true);
  assert.equal(stillHeld.body.holder, 'run-reused');
  assert.equal(stillHeld.body.fencing_token, undefined,
    'read-only inspection must not disclose the ownership capability');

  const ownerRelease = await call('DELETE', '/run-lock', {
    query: { holder: 'run-reused', fencing_token: successor.body.fencing_token },
  });
  assert.equal(ownerRelease.body.released, true);
});

test('interactive priority defers a new hourly lifecycle but never strands its existing holder', async () => {
  let blocked = true;
  let acquisitions = 0;
  const { call } = routeHarness({
    canAcquire: () => blocked
      ? { allowed: false, reason: 'interactive_active', retry_after_ms: 30_000,
        active_surfaces: { realtime: 1 } }
      : { allowed: true },
    onAcquire: () => {
      acquisitions += 1;
      return { cycle_id: 'cycle-after-call', moment_id: 'moment-after-call' };
    },
  });

  const deferred = await call('POST', '/run-lock', {
    body: { holder: 'run-during-call', ttl_seconds: 3000 },
  });
  assert.equal(deferred.statusCode, 200);
  assert.equal(deferred.body.acquired, false);
  assert.equal(deferred.body.reason, 'interactive_active');
  assert.equal(deferred.body.retry_after_ms, 30_000);
  assert.deepEqual(deferred.body.active_surfaces, { realtime: 1 });
  assert.equal(acquisitions, 0);
  assert.equal((await call('GET', '/run-lock')).body.locked, false);

  blocked = false;
  const acquired = await call('POST', '/run-lock', {
    body: { holder: 'run-after-call', ttl_seconds: 3000 },
  });
  assert.equal(acquired.body.acquired, true);
  assert.equal(acquisitions, 1);

  blocked = true;
  const refreshed = await call('POST', '/run-lock', {
    body: { holder: 'run-after-call', fencing_token: acquired.body.fencing_token,
      ttl_seconds: 3000 },
  });
  assert.equal(refreshed.body.acquired, true,
    'the current holder must retain a path to close and release its lifecycle');
  assert.equal(acquisitions, 1);
});

test('durable run lock survives route reconstruction and preserves the exact lifecycle', async () => {
  let persisted = null;
  let now = Date.parse('2026-07-15T01:00:00.000Z');
  let acquired = 0;
  const options = {
    clock: () => now,
    loadLock: () => persisted,
    saveLock: value => { persisted = value == null ? null : JSON.parse(JSON.stringify(value)); },
    onAcquire: () => {
      acquired += 1;
      return { kind: 'run_bound_intelligence_cycle', cycle_id: 'durable-cycle',
        moment_id: 'durable-moment', forecast_protocol_version: 3 };
    },
  };
  const firstProcess = routeHarness(options);
  const first = await firstProcess.call('POST', '/run-lock', {
    body: { holder: 'run-durable', ttl_seconds: 3000 },
  });
  assert.equal(first.body.acquired, true);
  assert.equal(persisted.lifecycle.moment_id, 'durable-moment');

  const restartedProcess = routeHarness(options);
  const restored = await restartedProcess.call('GET', '/run-lock');
  assert.equal(restored.body.locked, true);
  assert.equal(restored.body.holder, 'run-durable');
  assert.equal(restored.body.lifecycle.cycle_id, 'durable-cycle');
  assert.equal(acquired, 1, 'restart must not open another lifecycle');
  const contender = await restartedProcess.call('POST', '/run-lock', {
    body: { holder: 'run-overlap', ttl_seconds: 3000 },
  });
  assert.equal(contender.body.acquired, false);
  assert.equal(contender.body.lifecycle.moment_id, 'durable-moment');
  const resumed = await restartedProcess.call('POST', '/run-lock', {
    body: { holder: 'run-durable', fencing_token: first.body.fencing_token,
      ttl_seconds: 3000 },
  });
  assert.equal(resumed.body.acquired, true);
  assert.equal(resumed.body.lifecycle.moment_id, 'durable-moment');
  assert.equal(acquired, 1);
});

test('expired durable lease closes its lifecycle before a successor can start', async () => {
  let persisted = null;
  let now = Date.parse('2026-07-15T01:00:00.000Z');
  const events = [];
  const options = {
    clock: () => now,
    loadLock: () => persisted,
    saveLock: value => { persisted = value; },
    onAcquire: ({ holder }) => {
      events.push(`acquire:${holder}`);
      return { cycle_id: `cycle:${holder}`, moment_id: `moment:${holder}` };
    },
    onRelease: ({ holder, expired }) => { events.push(`release:${holder}:${expired}`); },
  };
  const first = routeHarness(options);
  await first.call('POST', '/run-lock', { body: { holder: 'run-old', ttl_seconds: 60 } });
  now += 61_000;
  const restarted = routeHarness(options);
  const stale = await restarted.call('GET', '/run-lock');
  assert.equal(stale.body.locked, false);
  assert.equal(stale.body.expired_lease_pending_recovery, true);
  const successor = await restarted.call('POST', '/run-lock', {
    body: { holder: 'run-new', ttl_seconds: 60 },
  });
  assert.equal(successor.body.acquired, true);
  assert.deepEqual(events, ['acquire:run-old', 'release:run-old:true', 'acquire:run-new']);
  assert.equal(persisted.holder, 'run-new');
});

test('a restarted process gives the prior holder a bounded resume grace then gap-closes', async () => {
  let persisted = null;
  let now = Date.parse('2026-07-15T01:00:00.000Z');
  const events = [];
  const shared = {
    clock: () => now,
    loadLock: () => persisted,
    saveLock: value => { persisted = value == null ? null : JSON.parse(JSON.stringify(value)); },
    onAcquire: ({ holder }) => {
      events.push(`acquire:${holder}`);
      return { cycle_id: `cycle:${holder}`, moment_id: `moment:${holder}` };
    },
    onRelease: ({ holder, expired, restart_resume_expired }) => {
      events.push(`release:${holder}:${expired}:${restart_resume_expired}`);
    },
    restartResumeGraceMs: 10 * 60 * 1000,
  };
  const first = routeHarness({ ...shared, processEpochId: 'epoch-one' });
  await first.call('POST', '/run-lock', { body: { holder: 'run-before-restart', ttl_seconds: 3000 } });

  const restarted = routeHarness({ ...shared, processEpochId: 'epoch-two' });
  now += 9 * 60 * 1000;
  assert.equal((await restarted.call('GET', '/run-lock')).body.locked, true,
    'the original holder retains a fair restart-resume window');
  now += 61 * 1000;
  const stale = await restarted.call('GET', '/run-lock');
  assert.equal(stale.body.locked, false);
  assert.equal(stale.body.restart_resume_grace_expired, true);
  const successor = await restarted.call('POST', '/run-lock', {
    body: { holder: 'run-after-restart', ttl_seconds: 3000 },
  });
  assert.equal(successor.body.acquired, true);
  assert.deepEqual(events, [
    'acquire:run-before-restart',
    'release:run-before-restart:true:true',
    'acquire:run-after-restart',
  ]);
  assert.equal(persisted.process_epoch_id, 'epoch-two');
});

test('durable lease persistence failures fail closed and gap-close a just-opened lifecycle', async () => {
  const releases = [];
  const { call } = routeHarness({
    loadLock: () => null,
    saveLock: () => { throw new Error('database unavailable'); },
    onAcquire: () => ({ cycle_id: 'unprotected-cycle', moment_id: 'unprotected-moment' }),
    onRelease: input => { releases.push(input); },
  });
  const result = await call('POST', '/run-lock', {
    body: { holder: 'run-persistence-failure', ttl_seconds: 60 },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.reason, 'lock_persistence_write_failed');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].lifecycle.cycle_id, 'unprotected-cycle');
  assert.equal(releases[0].persistence_failed, true);
});

test('durable lease read failures do not fall back to process memory', async () => {
  const { call } = routeHarness({
    loadLock: () => { throw new Error('cannot read durable lease'); },
  });
  const result = await call('POST', '/run-lock', { body: { holder: 'run-read-failure' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.reason, 'lock_persistence_read_failed');
});

test('lifecycle release failures preserve the durable lease for recovery', async () => {
  let persisted = null;
  const options = {
    loadLock: () => persisted,
    saveLock: value => { persisted = value; },
    onAcquire: () => ({ cycle_id: 'protected-cycle', moment_id: 'protected-moment' }),
    onRelease: () => { throw new Error('ledger temporarily unavailable'); },
  };
  const { call } = routeHarness(options);
  const acquired = await call('POST', '/run-lock', {
    body: { holder: 'run-protected', ttl_seconds: 3000 },
  });
  const release = await call('DELETE', '/run-lock', {
    query: { holder: 'run-protected', fencing_token: acquired.body.fencing_token },
  });
  assert.equal(release.statusCode, 503);
  assert.equal(release.body.released, false);
  assert.equal(release.body.reason, 'lifecycle_release_failed');
  assert.equal(release.body.lifecycle.release_error, 'ledger temporarily unavailable');
  assert.equal(persisted.holder, 'run-protected');
  assert.equal((await call('GET', '/run-lock')).body.locked, true);
});

test('lifecycle release failures expose a machine-readable recovery action without dropping the lease', async () => {
  let persisted = null;
  const error = new Error('the bound cycle is still active');
  error.code = 'active_run_lifecycle_must_be_closed';
  error.next_required_action = 'PATCH /intelligence/cycles/cycle-live/complete';
  const { call } = routeHarness({
    loadLock: () => persisted,
    saveLock: value => { persisted = value; },
    onAcquire: () => ({ cycle_id: 'cycle-live', moment_id: 'moment-live' }),
    onRelease: () => { throw error; },
  });
  const acquired = await call('POST', '/run-lock', {
    body: { holder: 'run-live', ttl_seconds: 3000 },
  });
  const release = await call('DELETE', '/run-lock', {
    query: { holder: 'run-live', fencing_token: acquired.body.fencing_token },
  });
  assert.equal(release.statusCode, 503);
  assert.equal(release.body.code, 'active_run_lifecycle_must_be_closed');
  assert.equal(release.body.next_required_action,
    'PATCH /intelligence/cycles/cycle-live/complete');
  assert.equal((await call('GET', '/run-lock')).body.locked, true);
});
