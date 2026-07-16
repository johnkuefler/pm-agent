'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerDreamRoutes } = require('../../src/routes/registerDreamRoutes');

function harness(studyActive = true) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  registerDreamRoutes(app, {
    requireAuth: (_req, _res, next) => next?.(),
    requireEvaluatorAuth: (_req, _res, next) => next?.(),
    loadDreams: () => [],
    saveDreams: () => {},
    listExperiments: () => [],
    dreamInsightStudyActive: () => studyActive,
    MAX_DREAMS_KEPT: 120,
  });
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

test('active insight-synthesis study seals every subject-facing dream route', () => {
  const { invoke } = harness(true);
  const routes = [
    ['GET', '/dreams'],
    ['GET', '/dreams/:id'],
    ['GET', '/dream-idea-seeds'],
    ['GET', '/dream-insights'],
    ['POST', '/dream-insights'],
    ['POST', '/dream-insights/:id/resolve'],
    ['POST', '/dreams'],
    ['DELETE', '/dreams/:id'],
  ];
  for (const [method, path] of routes) {
    const response = invoke(method, path);
    assert.equal(response.statusCode, 423, `${method} ${path}`);
    assert.equal(response.body.experimental_access_sealed, true, `${method} ${path}`);
  }
});

test('independently authenticated insight review queue remains outside the subject seal', () => {
  const response = harness(true).invoke('GET', '/dream-insights/review-queue', {
    evaluatorId: 'independent-reviewer',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { evaluator_id: 'independent-reviewer', insights: [] });
});
