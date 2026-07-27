'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerInteractionRoutes } = require('../../src/routes/registerInteractionRoutes');

function setup(initial, options = {}) {
  const routes = {};
  const app = {
    get: (path, _auth, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, _auth, handler) => { routes[`POST ${path}`] = handler; },
  };
  let items = structuredClone(initial);
  let saves = 0;
  let strictAttempts = 0;
  const outcomes = [];
  const projectionContexts = [];
  const sourceStatesAtCallback = [];
  const hasPersistenceSequence = Object.prototype.hasOwnProperty.call(options, 'persistenceErrors');
  const outcomeHandler = options.onOutcome === null ? undefined : async (item, context) => {
    outcomes.push(structuredClone(item));
    projectionContexts.push(structuredClone(context));
    sourceStatesAtCallback.push(structuredClone(
      items.find(candidate => candidate.id === item.id)?.downstream_projection || null));
    return typeof options.onOutcome === 'function'
      ? options.onOutcome(item, context) : { accepted: true };
  };
  registerInteractionRoutes(app, {
    requireAuth: (_req, _res, next) => next(), MAX_INTERACTIONS_KEPT: 600,
    loadInteractions: () => items,
    saveInteractions: next => { items = structuredClone(next); saves += 1; },
    saveInteractionsStrict: async next => {
      const attempt = strictAttempts++;
      const persistenceError = hasPersistenceSequence
        ? options.persistenceErrors[attempt] : options.persistenceError;
      if (persistenceError) throw persistenceError;
      items = structuredClone(next);
      saves += 1;
    },
    onOutcome: outcomeHandler,
    clock: options.clock || (() => new Date('2026-07-26T08:30:00.000Z')),
  });
  async function post(id, body) {
    let status = 200; let payload = null;
    const res = { status: code => { status = code; return res; },
      json: value => { payload = value; return res; } };
    await routes['POST /interactions/:id/outcome']({ params: { id }, body }, res);
    return { status, payload };
  }
  return { post, state: () => ({
    items, saves, strictAttempts, outcomes, projectionContexts, sourceStatesAtCallback,
  }) };
}

test('interaction review durably queues before projection, records its receipt, and is idempotent', async () => {
  const fixture = setup([{ id: 'ix-1', reviewed: false, outcome: null }]);
  const invalid = await fixture.post('ix-1', { outcome: 'great', signal: 'nice' });
  assert.equal(invalid.status, 400);
  assert.equal(fixture.state().saves, 0);

  const valid = await fixture.post('ix-1', {
    outcome: 'appreciated', signal: 'The teammate explicitly thanked Nora for the useful check.',
  });
  assert.equal(valid.status, 200);
  assert.equal(fixture.state().saves, 2);
  assert.equal(fixture.state().outcomes.length, 1);
  assert.equal(fixture.state().items[0].reviewed, true);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'completed');
  assert.equal(fixture.state().items[0].downstream_projection.attempts, 1);
  assert.deepEqual(fixture.state().items[0].downstream_projection.receipt,
    { acknowledged: true, result: { accepted: true } });
  assert.equal(fixture.state().outcomes[0].downstream_projection, undefined);
  assert.equal(fixture.state().projectionContexts[0].projection.attempt, 1);
  assert.equal(fixture.state().sourceStatesAtCallback[0].status, 'pending');

  const repeated = await fixture.post('ix-1', {
    outcome: 'appreciated', signal: 'The teammate explicitly thanked Nora for the useful check.',
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.payload.idempotent, true);
  assert.equal(fixture.state().saves, 2);
  assert.equal(fixture.state().outcomes.length, 1);
});

test('interaction review never runs dependent learning when the source commit fails', async () => {
  const fixture = setup([{ id: 'ix-failed-source', reviewed: false, outcome: null }], {
    persistenceError: new Error('durable interaction store unavailable'),
  });
  const result = await fixture.post('ix-failed-source', {
    outcome: 'corrected',
    signal: 'The teammate supplied an exact correction that would otherwise feed learning.',
  });

  assert.equal(result.status, 503);
  assert.match(result.payload.error, /durable interaction store unavailable/);
  assert.equal(result.payload.source_committed, false);
  assert.equal(fixture.state().items[0].reviewed, false);
  assert.equal(fixture.state().saves, 0);
  assert.equal(fixture.state().outcomes.length, 0);
});

test('an exact interaction replay retries a failed projection and completed replay is a no-op', async () => {
  const fixture = setup([{ id: 'ix-retry', reviewed: false, outcome: null }], {
    onOutcome: (_item, context) => {
      if (context.projection.attempt === 1) throw new Error('learning ledger temporarily unavailable');
      return { ledger_receipt: 'learning-42' };
    },
  });
  const body = {
    outcome: 'landed',
    signal: 'The teammate used the proposed plan and confirmed the result in the channel.',
  };

  const failed = await fixture.post('ix-retry', body);
  assert.equal(failed.status, 503);
  assert.equal(failed.payload.retryable, true);
  assert.equal(failed.payload.source_committed, true);
  assert.equal(fixture.state().items[0].reviewed, true);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'failed');
  assert.equal(fixture.state().items[0].downstream_projection.attempts, 1);
  assert.match(fixture.state().items[0].downstream_projection.error, /temporarily unavailable/);

  const retried = await fixture.post('ix-retry', body);
  assert.equal(retried.status, 200);
  assert.equal(retried.payload.replayed, true);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'completed');
  assert.equal(fixture.state().items[0].downstream_projection.attempts, 2);
  assert.deepEqual(fixture.state().items[0].downstream_projection.receipt.result,
    { ledger_receipt: 'learning-42' });
  assert.equal(fixture.state().outcomes.length, 2);
  assert.equal(fixture.state().saves, 4);

  const completedReplay = await fixture.post('ix-retry', body);
  assert.equal(completedReplay.status, 200);
  assert.equal(completedReplay.payload.idempotent, true);
  assert.equal(fixture.state().outcomes.length, 2);
  assert.equal(fixture.state().saves, 4);
});

test('a missing completion receipt remains pending and is retried instead of claiming success', async () => {
  const fixture = setup([{ id: 'ix-receipt', reviewed: false, outcome: null }], {
    persistenceErrors: [null, new Error('completion receipt store unavailable'), null, null],
  });
  const body = {
    outcome: 'appreciated',
    signal: 'The teammate explicitly thanked Nora and linked the recommendation they adopted.',
  };

  const incomplete = await fixture.post('ix-receipt', body);
  assert.equal(incomplete.status, 503);
  assert.equal(incomplete.payload.retryable, true);
  assert.match(incomplete.payload.error, /receipt was not committed/);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'pending');
  assert.equal(fixture.state().outcomes.length, 1);

  const recovered = await fixture.post('ix-receipt', body);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.payload.replayed, true);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'completed');
  assert.equal(fixture.state().items[0].downstream_projection.attempts, 2);
  assert.equal(fixture.state().outcomes.length, 2);
});

test('a failed projection whose failure receipt cannot persist retains its durable pending source', async () => {
  const fixture = setup([{ id: 'ix-failed-receipt', reviewed: false, outcome: null }], {
    persistenceErrors: [null, new Error('failure receipt store unavailable')],
    onOutcome: () => { throw new Error('downstream learning failed'); },
  });
  const result = await fixture.post('ix-failed-receipt', {
    outcome: 'corrected',
    signal: 'The teammate supplied a concrete correction that must remain available for replay.',
  });

  assert.equal(result.status, 503);
  assert.equal(result.payload.retryable, true);
  assert.equal(result.payload.source_committed, true);
  assert.match(result.payload.error, /retry state was not committed/);
  assert.equal(fixture.state().items[0].reviewed, true);
  assert.equal(fixture.state().items[0].downstream_projection.status, 'pending');
  assert.equal(fixture.state().items[0].downstream_projection.attempts, 1);
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

test('the production interaction projector awaits every durable learning boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function handleInteractionOutcome');
  const end = source.indexOf('\nasync function commitAutomatedInteractionOutcome', start);
  assert.ok(start >= 0 && end > start);
  const projector = source.slice(start, end);
  assert.match(projector, /await recordApiUseOutcomesForInteraction\(interaction\)/);
  assert.match(projector, /await saveConsequenceReviews\(result\.ledger\)/);
  assert.match(projector, /observation_id: `interaction-feedback:\$\{interaction\.id\}`/);
  assert.match(projector, /await intelligence\.persistStrict\(\)/);
  assert.doesNotMatch(projector, /\bvoid\s+recordApiUseOutcomesForInteraction/);
  assert.doesNotMatch(projector, /outcome capture failed/);

  const automatedStart = source.indexOf('async function commitAutomatedInteractionOutcome');
  const automatedEnd = source.indexOf(
    '\nasync function recordAutomatedInteractionReviewAttempt', automatedStart);
  const automated = source.slice(automatedStart, automatedEnd);
  assert.match(automated, /status: 'pending'/);
  assert.match(automated, /status: 'failed'/);
  assert.match(automated, /status: 'completed'/);
  assert.match(automated, /await saveInteractionsStrict\(items\)/);
});
