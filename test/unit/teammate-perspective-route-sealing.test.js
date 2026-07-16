'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIntelligenceRoutes } = require('../../src/routes/intelligence');

function harness(studyActive = true) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  const store = new Proxy({
    teammatePerspectiveStudyActive: () => studyActive,
    perspectiveReviewQueue: () => [],
  }, { get(target, property) { return property in target ? target[property] : () => null; } });
  const auth = (_req, _res, next) => next?.();
  registerIntelligenceRoutes(app, { requireAuth: auth, requireResearchAuth: auth,
    requireEvaluatorAuth: auth, store });
  const invoke = (method, path, req = {}) => {
    const output = { statusCode: 200, body: null };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
    };
    routes.get(`${method} ${path}`)({ query: {}, params: {}, body: {}, ...req }, res);
    return output;
  };
  return { invoke };
}

test('active teammate-perspective study seals subject-facing relationship routes', () => {
  const { invoke } = harness(true);
  const routes = [
    ['GET', '/relationships'],
    ['POST', '/relationships/observe'],
    ['POST', '/relationships/:name/perspectives'],
    ['PATCH', '/relationships/perspectives/:id'],
    ['POST', '/relationships/perspectives/:id/resolve'],
    ['GET', '/teammate-perspective-models'],
  ];
  for (const [method, path] of routes) {
    const response = invoke(method, path);
    assert.equal(response.statusCode, 423, `${method} ${path}`);
    assert.equal(response.body.experimental_access_sealed, true, `${method} ${path}`);
  }
});

test('independent perspective review queue remains outside the subject seal', () => {
  const response = harness(true).invoke('GET', '/relationships/perspectives/review-queue', {
    evaluatorId: 'independent-reviewer',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { evaluator_id: 'independent-reviewer', perspectives: [] });
});
