'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCognitiveParameterStudyRoutes } = require('../../src/routes/cognitive-parameter-studies');

function harness(overrides = {}) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers.at(-1); },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers.at(-1); },
  };
  registerCognitiveParameterStudyRoutes(app, {
    requireResearchAuth: (_req, _res, next) => next(),
    isDbReady: () => true,
    snapshot: options => ({ studies: options?.studyId === 'missing' ? [] : [{ id: options?.studyId || 'dial-1' }], options }),
    create: input => ({ id: input.id || 'dial-1', conditions_sealed: true }),
    finalize: id => id === 'missing' ? null : ({ id, status: 'completed' }),
    abort: (id, input) => id === 'missing' ? null : ({ id, status: 'aborted', input }),
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

test('public DIALS studies projection remains condition-sealed', () => {
  const routes = harness();
  const res = response();
  routes['GET /cognitive-parameter-studies']({}, res);
  assert.equal(res.body.studies[0].id, 'dial-1');
  assert.equal(res.body.options, undefined);
});

test('research projection is explicit and returns 404 for an unknown study', () => {
  const routes = harness();
  const found = response();
  routes['GET /cognitive-parameter-studies/:id/research']({ params: { id: 'dial-1' } }, found);
  assert.deepEqual(found.body.options, { research: true, studyId: 'dial-1' });
  const missing = response();
  routes['GET /cognitive-parameter-studies/:id/research']({ params: { id: 'missing' } }, missing);
  assert.equal(missing.statusCode, 404);
});

test('study mutations require durable state and preserve preregistration input', () => {
  let received = null;
  const unavailable = harness({ isDbReady: () => false });
  const unavailableResponse = response();
  unavailable['POST /cognitive-parameter-studies']({ body: {} }, unavailableResponse);
  assert.equal(unavailableResponse.statusCode, 503);

  const routes = harness({ create: input => { received = input; return { id: input.id, conditions_sealed: true }; } });
  const res = response();
  routes['POST /cognitive-parameter-studies']({ body: { id: 'dial-pilot', candidate_value: 2.4 } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(received, { id: 'dial-pilot', candidate_value: 2.4 });
  assert.equal(res.body.study.conditions_sealed, true);
});

test('finalize and abort expose only explicit research actions', () => {
  const routes = harness();
  const premature = harness({ finalize: () => { throw new Error('not at stopping condition'); } });
  const prematureResponse = response();
  premature['POST /cognitive-parameter-studies/:id/finalize']({ params: { id: 'dial-1' } }, prematureResponse);
  assert.equal(prematureResponse.statusCode, 400);

  const aborted = response();
  routes['POST /cognitive-parameter-studies/:id/abort']({ params: { id: 'dial-1' }, body: { reason: 'integrity concern' } }, aborted);
  assert.equal(aborted.body.study.status, 'aborted');
  assert.equal(aborted.body.study.input.reason, 'integrity concern');
});
