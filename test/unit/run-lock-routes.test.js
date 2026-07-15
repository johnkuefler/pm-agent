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

  const refreshed = await call('POST', '/run-lock', { body: { holder: 'run-one', ttl_seconds: 120 } });
  assert.equal(refreshed.body.acquired, true);
  assert.equal(refreshed.body.lifecycle.moment_id, 'moment-1');
  assert.equal(acquired.length, 1, 'refreshing the same lock must not open another lifecycle');

  const contender = await call('POST', '/run-lock', { body: { holder: 'run-two' } });
  assert.equal(contender.body.acquired, false);
  assert.equal(contender.body.held_by, 'run-one');
  assert.equal((await call('DELETE', '/run-lock', { query: { holder: 'run-two' } })).body.released, false);
  assert.equal(released.length, 0);

  const final = await call('DELETE', '/run-lock', { query: { holder: 'run-one' } });
  assert.equal(final.body.released, true);
  assert.equal(final.body.lifecycle.closure_status, 'explicit_gap_recorded');
  assert.equal(final.body.lifecycle.evidence_eligible, false);
  assert.equal(released.length, 1);
  assert.equal(released[0].lifecycle.cycle_id, 'cycle-1');
  assert.equal((await call('GET', '/run-lock')).body.locked, false);
});

test('run lock fails closed when its lifecycle cannot start', async () => {
  const { call } = routeHarness({ onAcquire: () => { throw new Error('ledger unavailable'); } });
  const result = await call('POST', '/run-lock', { body: { holder: 'run-failed' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.acquired, false);
  assert.equal(result.body.reason, 'lifecycle_start_failed');
  assert.equal((await call('GET', '/run-lock')).body.locked, false);
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
    body: { holder: 'run-durable', ttl_seconds: 3000 },
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
  await call('POST', '/run-lock', { body: { holder: 'run-protected', ttl_seconds: 3000 } });
  const release = await call('DELETE', '/run-lock', { query: { holder: 'run-protected' } });
  assert.equal(release.statusCode, 503);
  assert.equal(release.body.released, false);
  assert.equal(release.body.reason, 'lifecycle_release_failed');
  assert.equal(release.body.lifecycle.release_error, 'ledger temporarily unavailable');
  assert.equal(persisted.holder, 'run-protected');
  assert.equal((await call('GET', '/run-lock')).body.locked, true);
});
