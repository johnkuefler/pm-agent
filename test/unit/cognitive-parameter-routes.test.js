'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCognitiveParameterRoutes } = require('../../src/routes/cognitive-parameters');

function harness(overrides = {}) {
  const routes = {};
  const registrations = {};
  const record = (method, path, handlers) => {
    const key = `${method} ${path}`;
    registrations[key] = handlers;
    routes[key] = handlers.at(-1);
  };
  const app = {
    get(path, ...handlers) { record('GET', path, handlers); },
    put(path, ...handlers) { record('PUT', path, handlers); },
    post(path, ...handlers) { record('POST', path, handlers); },
  };
  registerCognitiveParameterRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    requireOperatorAuth: (_req, _res, next) => next(),
    isDbReady: () => true,
    snapshot: options => ({ options, status: { parameter_count: 113 } }),
    update: async input => ({ changed_paths: ['workspace.capacity'], input }),
    rollback: async input => ({ changed_paths: ['workspace.capacity'], input }),
    repairSchema: async input => ({ repaired: true, input }),
    ...overrides,
  });
  Object.defineProperty(routes, 'registrations', { value: registrations });
  return routes;
}

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('DIALS public status is read-only and authenticated history is bounded by default', () => {
  const routes = harness();
  const publicResponse = response();
  routes['GET /cognitive-parameters']({}, publicResponse);
  assert.deepEqual(publicResponse.body.options, { includeHistory: false });
  const historyResponse = response();
  routes['GET /cognitive-parameters/history']({ query: {} }, historyResponse);
  assert.deepEqual(historyResponse.body.options, { includeHistory: true, fullHistory: false });
});

test('DIALS reads retain their existing access policy while every mutation requires API and operator auth', () => {
  const requireAuth = () => {};
  const requireOperatorAuth = () => {};
  const routes = harness({ requireAuth, requireOperatorAuth });

  assert.deepEqual(routes.registrations['GET /cognitive-parameters'].slice(0, -1), []);
  assert.deepEqual(routes.registrations['GET /cognitive-parameters/history'].slice(0, -1),
    [requireAuth]);
  for (const key of [
    'PUT /cognitive-parameters',
    'POST /cognitive-parameters/rollback',
    'POST /cognitive-parameters/repair-schema',
  ]) {
    assert.deepEqual(routes.registrations[key].slice(0, -1),
      [requireAuth, requireOperatorAuth], `${key} must be sealed by both auth layers`);
  }
});

test('DIALS operator edits require persistence and preserve actor, note, and patch', async () => {
  let received = null;
  const unavailable = harness({ isDbReady: () => false });
  const unavailableResponse = response();
  await unavailable['PUT /cognitive-parameters']({ body: {} }, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 503);

  const routes = harness({ update: async input => { received = input; return { changed_paths: ['workspace.capacity'] }; } });
  const res = response();
  await routes['PUT /cognitive-parameters']({ body: {
    patch: { workspace: { capacity: 6 } }, updated_by: 'John', note: 'Bounded trial setup',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, { patch: { workspace: { capacity: 6 } },
    updatedBy: 'dashboard_operator', note: 'Bounded trial setup' });
  assert.equal(res.body.ok, true);
});

test('DIALS maps the autonomous-tuning lock to a forbidden response', async () => {
  const routes = harness({ update: async () => {
    throw new Error('autonomous cognitive parameter tuning is disabled until the preregistered experiment gate exists');
  } });
  const res = response();
  await routes['PUT /cognitive-parameters']({ body: { patch: {}, updated_by: 'Nora', note: 'Self tune' } }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /autonomous cognitive parameter tuning is disabled/);
});

test('DIALS rollback is an explicit new revision request, never a history rewrite', async () => {
  let received = null;
  const routes = harness({ rollback: async input => { received = input; return { changed_paths: ['workspace.capacity'] }; } });
  const res = response();
  await routes['POST /cognitive-parameters/rollback']({ body: {
    target_commitment: 'a'.repeat(64), updated_by: 'John', note: 'Restore known-good behavior',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, { targetCommitment: 'a'.repeat(64),
    updatedBy: 'dashboard_operator', note: 'Restore known-good behavior' });
});

test('DIALS schema repair is explicit and authenticated', async () => {
  let received = null;
  const unavailable = harness({ isDbReady: () => false });
  const unavailableResponse = response();
  await unavailable['POST /cognitive-parameters/repair-schema']({ body: {} }, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 503);

  const routes = harness({ repairSchema: async input => { received = input; return { repaired: true, adoption: { source_revision: 2 } }; } });
  const res = response();
  await routes['POST /cognitive-parameters/repair-schema']({ body: {
    updated_by: 'John', note: 'Adopt current DIALS schema',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(received, { updatedBy: 'dashboard_operator', note: 'Adopt current DIALS schema' });

  const noRepair = harness({ repairSchema: async () => ({ repaired: false, source_audit: { valid: false } }) });
  const noRepairResponse = response();
  await noRepair['POST /cognitive-parameters/repair-schema']({ body: {} }, noRepairResponse);
  assert.equal(noRepairResponse.statusCode, 409);
  assert.equal(noRepairResponse.body.ok, false);
});
