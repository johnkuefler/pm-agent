'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerInteractionRoutes } = require('../../src/routes/registerInteractionRoutes');

function setup(initial) {
  const routes = {};
  const app = {
    get: (path, _auth, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, _auth, handler) => { routes[`POST ${path}`] = handler; },
  };
  let items = structuredClone(initial);
  let saves = 0;
  const outcomes = [];
  registerInteractionRoutes(app, {
    requireAuth: (_req, _res, next) => next(), MAX_INTERACTIONS_KEPT: 600,
    loadInteractions: () => items,
    saveInteractions: next => { items = structuredClone(next); saves += 1; },
    onOutcome: item => outcomes.push(structuredClone(item)),
  });
  async function post(id, body) {
    let status = 200; let payload = null;
    const res = { status: code => { status = code; return res; },
      json: value => { payload = value; return res; } };
    await routes['POST /interactions/:id/outcome']({ params: { id }, body }, res);
    return { status, payload };
  }
  return { post, state: () => ({ items, saves, outcomes }) };
}

test('interaction review validates evidence, commits once, and is idempotent', async () => {
  const fixture = setup([{ id: 'ix-1', reviewed: false, outcome: null }]);
  const invalid = await fixture.post('ix-1', { outcome: 'great', signal: 'nice' });
  assert.equal(invalid.status, 400);
  assert.equal(fixture.state().saves, 0);

  const valid = await fixture.post('ix-1', {
    outcome: 'appreciated', signal: 'The teammate explicitly thanked Nora for the useful check.',
  });
  assert.equal(valid.status, 200);
  assert.equal(fixture.state().saves, 1);
  assert.equal(fixture.state().outcomes.length, 1);
  assert.equal(fixture.state().items[0].reviewed, true);

  const repeated = await fixture.post('ix-1', {
    outcome: 'appreciated', signal: 'The teammate explicitly thanked Nora for the useful check.',
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.payload.idempotent, true);
  assert.equal(fixture.state().saves, 1);
  assert.equal(fixture.state().outcomes.length, 1);
});

test('a reviewed interaction cannot be relabeled after downstream ledgers bind it', async () => {
  const fixture = setup([{ id: 'ix-2', reviewed: true, outcome: 'landed',
    signal: 'The teammate acknowledged the answer and continued with the supplied plan.',
    reviewed_at: '2026-07-18T12:00:00.000Z' }]);
  const result = await fixture.post('ix-2', {
    outcome: 'corrected', signal: 'A later reviewer attempted to replace the committed outcome.',
  });
  assert.equal(result.status, 409);
  assert.equal(fixture.state().items[0].outcome, 'landed');
  assert.equal(fixture.state().saves, 0);
  assert.equal(fixture.state().outcomes.length, 0);
});
