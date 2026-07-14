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
  const call = (method, path, { body = {}, query = {} } = {}) => {
    const output = { statusCode: 200, body: null };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(value) { output.body = value; return this; },
    };
    routes.get(`${method} ${path}`)({ body, query }, res);
    return output;
  };
  return { call };
}

test('run lock carries one lifecycle from acquisition through holder-owned release', () => {
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

  const first = call('POST', '/run-lock', { body: { holder: 'run-one', ttl_seconds: 60 } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.acquired, true);
  assert.equal(first.body.lifecycle.cycle_id, 'cycle-1');
  assert.equal(acquired.length, 1);

  const refreshed = call('POST', '/run-lock', { body: { holder: 'run-one', ttl_seconds: 120 } });
  assert.equal(refreshed.body.acquired, true);
  assert.equal(refreshed.body.lifecycle.moment_id, 'moment-1');
  assert.equal(acquired.length, 1, 'refreshing the same lock must not open another lifecycle');

  const contender = call('POST', '/run-lock', { body: { holder: 'run-two' } });
  assert.equal(contender.body.acquired, false);
  assert.equal(contender.body.held_by, 'run-one');
  assert.equal(call('DELETE', '/run-lock', { query: { holder: 'run-two' } }).body.released, false);
  assert.equal(released.length, 0);

  const final = call('DELETE', '/run-lock', { query: { holder: 'run-one' } });
  assert.equal(final.body.released, true);
  assert.equal(final.body.lifecycle.closure_status, 'explicit_gap_recorded');
  assert.equal(final.body.lifecycle.evidence_eligible, false);
  assert.equal(released.length, 1);
  assert.equal(released[0].lifecycle.cycle_id, 'cycle-1');
  assert.equal(call('GET', '/run-lock').body.locked, false);
});

test('run lock fails closed when its lifecycle cannot start', () => {
  const { call } = routeHarness({ onAcquire: () => { throw new Error('ledger unavailable'); } });
  const result = call('POST', '/run-lock', { body: { holder: 'run-failed' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.acquired, false);
  assert.equal(result.body.reason, 'lifecycle_start_failed');
  assert.equal(call('GET', '/run-lock').body.locked, false);
});
