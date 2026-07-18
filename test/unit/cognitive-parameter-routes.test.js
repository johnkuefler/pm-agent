'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCognitiveParameterRoutes } = require('../../src/routes/cognitive-parameters');

function harness(overrides = {}) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers.at(-1); },
    put(path, ...handlers) { routes[`PUT ${path}`] = handlers.at(-1); },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers.at(-1); },
  };
  registerCognitiveParameterRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    isDbReady: () => true,
    snapshot: options => ({ options, status: { parameter_count: 111 } }),
    update: async input => ({ changed_paths: ['workspace.capacity'], input }),
    rollback: async input => ({ changed_paths: ['workspace.capacity'], input }),
    ...overrides,
  });
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

test('DIALS edits require persistence and preserve actor, note, and patch', async () => {
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
    updatedBy: 'John', note: 'Bounded trial setup' });
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
    updatedBy: 'John', note: 'Restore known-good behavior' });
});
