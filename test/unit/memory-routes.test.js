'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerMemoryRoutes } = require('../../src/routes/registerMemoryRoutes');
const memoryLifecycle = require('../../src/intelligence/memory-lifecycle');

function buildRoutes(memories) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1));
  }
  registerMemoryRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    loadMemory: () => memories,
    mutateMemory: async mutator => ({ result: mutator(memories), memory: memories }),
    ensureProject: value => value,
    bumpProjectActivity: () => {},
    newMemoryId: () => 'm-new',
    db: {},
    isDbReady: () => false,
    normalizeMemoryRecord: value => value,
    memoryLifecycle,
    getMemoryDigest: () => ({ version: 1, text: 'digest' }),
  });
  return routes;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('memory GET preserves the full default response and exposes tiered views', () => {
  const memories = [
    { id: 'recent', fact: 'Recent', added: new Date().toISOString(), status: 'active' },
    { id: 'old', fact: 'Old', added: '2020-01-01', status: 'active' },
  ];
  const handler = buildRoutes(memories).get('get:/memory');
  const full = response();
  handler({ query: {} }, full);
  assert.equal(full.body, memories);
  const longTerm = response();
  handler({ query: { view: 'long_term' } }, longTerm);
  assert.deepEqual(longTerm.body.map(item => item.id), ['old']);
  const digest = response();
  handler({ query: { view: 'digest' } }, digest);
  assert.equal(digest.body.text, 'digest');
});
