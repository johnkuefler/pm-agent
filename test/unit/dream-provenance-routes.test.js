'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerDreamRoutes } = require('../../src/routes/registerDreamRoutes');
const dreamIdeaSeed = require('../../src/intelligence/dream-idea-seed');
const dreamProvenance = require('../../src/intelligence/dream-provenance');

const NOW = new Date('2026-07-26T08:30:00.000Z');
const LIFECYCLE = Object.freeze({
  cycle_id: 'cycle-nightly-1',
  moment_id: 'moment-nightly-1',
  holder: 'run-nightly-1',
  cycle_started_at: '2026-07-26T08:00:00.000Z',
  moment_started_at: '2026-07-26T08:00:00.000Z',
  start_commitment: 'a'.repeat(64),
  self_forecast_commitment: 'b'.repeat(64),
  lifecycle_stage: 'operational_cycle_active',
  lifecycle_projection_integrity_verified: true,
});

function createHarness(overrides = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) =>
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
  }
  let dreams = structuredClone(overrides.dreams || []);
  let onDreamCalls = 0;
  let strictSaves = 0;
  let strictAttempts = 0;
  const projectedDreams = [];
  const projectionContexts = [];
  const sourceStatesAtCallback = [];
  const hasPersistenceSequence = Object.prototype.hasOwnProperty.call(overrides, 'persistenceErrors');
  const onDream = overrides.onDream === null ? undefined : async (dream, context) => {
    onDreamCalls += 1;
    projectedDreams.push(structuredClone(dream));
    projectionContexts.push(structuredClone(context));
    sourceStatesAtCallback.push(structuredClone(
      dreams.find(candidate => candidate.id === dream.id)?.downstream_projection || null));
    return typeof overrides.onDream === 'function'
      ? overrides.onDream(dream, context) : undefined;
  };
  registerDreamRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    requireOperatorAuth: overrides.requireOperatorAuth
      || ((req, _res, next) => { req.operatorAuthority = 'test-signed-operator'; next(); }),
    requireEvaluatorAuth: (_req, _res, next) => next(),
    loadDreams: () => dreams,
    saveDreams: value => { dreams = structuredClone(value); },
    saveDreamsStrict: async value => {
      const attempt = strictAttempts++;
      const persistenceError = hasPersistenceSequence
        ? overrides.persistenceErrors[attempt] : overrides.persistenceError;
      if (persistenceError) throw persistenceError;
      dreams = structuredClone(value);
      strictSaves += 1;
    },
    listExperiments: () => [],
    dreamInsightStudyActive: () => false,
    resolveAutonomousDreamLifecycle: overrides.resolveAutonomousDreamLifecycle || (() => null),
    authorizeDreamImport: overrides.authorizeDreamImport || (() => null),
    MAX_DREAMS_KEPT: overrides.MAX_DREAMS_KEPT || 120,
    onDream,
    clock: overrides.clock || (() => NOW),
  });

  function invoke(method, path, request = {}) {
    const output = { statusCode: 200, body: null };
    const req = {
      headers: {}, query: {}, params: {}, body: {},
      ...request,
    };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
    };
    const handlers = routes.get(`${method} ${path}`);
    assert.ok(handlers, `missing route ${method} ${path}`);
    let index = 0;
    const next = () => {
      const handler = handlers[index++];
      if (handler) handler(req, res, next);
    };
    next();
    return output;
  }
  async function invokeAsync(method, path, request = {}) {
    const output = { statusCode: 200, body: null };
    const req = {
      headers: {}, query: {}, params: {}, body: {},
      ...request,
    };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
    };
    const handlers = routes.get(`${method} ${path}`);
    assert.ok(handlers, `missing route ${method} ${path}`);
    let index = 0;
    const next = () => {
      const handler = handlers[index++];
      return handler ? handler(req, res, next) : undefined;
    };
    await next();
    return output;
  }
  return {
    invoke, invokeAsync,
    dreams: () => structuredClone(dreams),
    onDreamCalls: () => onDreamCalls,
    projectionState: () => ({
      strictSaves,
      strictAttempts,
      projectedDreams: structuredClone(projectedDreams),
      projectionContexts: structuredClone(projectionContexts),
      sourceStatesAtCallback: structuredClone(sourceStatesAtCallback),
    }),
  };
}

function dreamBody(overrides = {}) {
  return {
    id: 'caller-controlled-id',
    date: '1999-01-01',
    started: '1999-01-01T00:00:00.000Z',
    finished: '2099-01-01T00:00:00.000Z',
    consolidation: { memories_before: 4, memories_after: 3, duplicates_removed: 1 },
    reflection: {
      ideas: ['A bounded coordination hypothesis.'],
      takes_added: ['A current professional view.'],
      insight_candidates: [{ id: 'fabricated-system-lifecycle' }],
    },
    review: { interactions_reviewed: 1, learnings_added: ['Ask for one concrete owner.'] },
    narrative: 'I consolidated a repeated coordination pattern.',
    provenance: {
      origin: 'autonomous_nightly_cycle',
      lifecycle: { cycle_id: 'fabricated-cycle' },
    },
    ...overrides,
  };
}

test('an API-key caller cannot fabricate autonomous dream provenance', () => {
  const harness = createHarness();
  const response = harness.invoke('POST', '/dreams', { body: dreamBody() });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'dream_provenance_required');
  assert.deepEqual(harness.dreams(), []);
  assert.equal(harness.onDreamCalls(), 0);
});

test('autonomous ingestion server-stamps the live lifecycle and strips system-owned fields', async () => {
  const harness = createHarness({
    resolveAutonomousDreamLifecycle: req =>
      req.headers['x-nora-run-fencing-token'] === 'private-capability' ? LIFECYCLE : null,
  });
  const response = await harness.invokeAsync('POST', '/dreams', {
    headers: { 'x-nora-run-fencing-token': 'private-capability' },
    body: dreamBody(),
  });
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.body.dream.id, 'caller-controlled-id');
  assert.equal(response.body.dream.date, '2026-07-26');
  assert.equal(response.body.dream.started, LIFECYCLE.cycle_started_at);
  assert.equal(response.body.dream.finished, NOW.toISOString());
  assert.equal(response.body.dream.reflection.insight_candidates, undefined);
  assert.equal(response.body.dream.provenance.origin, 'autonomous_nightly_cycle');
  assert.equal(response.body.dream.provenance.lifecycle.cycle_id, LIFECYCLE.cycle_id);
  assert.equal(response.body.dream.provenance.lifecycle.start_commitment, LIFECYCLE.start_commitment);
  assert.equal(response.body.provenance_audit.complete_chain_verified, true);
  assert.equal(response.body.provenance_audit.self_improvement_eligible, true);
  assert.equal(response.body.downstream_projection.status, 'completed');
  assert.equal(response.body.downstream_projection.attempts, 1);
  assert.deepEqual(response.body.downstream_projection.receipt,
    { acknowledged: true, result: null });
  assert.equal(harness.onDreamCalls(), 1);
  assert.equal(harness.projectionState().strictSaves, 2);
  assert.equal(harness.projectionState().projectedDreams[0].downstream_projection, undefined);
  assert.equal(harness.projectionState().projectionContexts[0].projection.attempt, 1);
  assert.equal(harness.projectionState().sourceStatesAtCallback[0].status, 'pending');

  const tampered = structuredClone(response.body.dream);
  tampered.reflection.ideas[0] = 'Rewritten after the receipt was stamped.';
  assert.equal(dreamProvenance.audit(tampered).complete_chain_verified, false);

  const replay = await harness.invokeAsync('POST', '/dreams', {
    headers: { 'x-nora-run-fencing-token': 'private-capability' },
    body: dreamBody(),
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.dream.id, response.body.dream.id);
  assert.equal(harness.onDreamCalls(), 1);
  assert.equal(harness.projectionState().strictSaves, 2);
});

test('manual imports require separate authority and cannot masquerade as autonomous', async () => {
  const harness = createHarness({
    authorizeDreamImport: req => req.headers['x-nora-research-key'] === 'research-authority'
      ? { kind: 'research', id: 'research-fixture' } : null,
  });
  const response = await harness.invokeAsync('POST', '/dreams', {
    headers: { 'x-nora-research-key': 'research-authority' },
    body: dreamBody({ import_mode: 'manual', id: 'preserved-import-id' }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dream.id, 'preserved-import-id');
  assert.equal(response.body.dream.date, '1999-01-01');
  assert.equal(response.body.dream.provenance.origin, 'authorized_manual_import');
  assert.equal(response.body.dream.provenance.authority.kind, 'research');
  assert.equal(response.body.dream.provenance.lifecycle, undefined);
  assert.equal(response.body.provenance_audit.authorized_import_verified, true);
});

test('an exact dream replay retries failed downstream work and never duplicates the source', async () => {
  const harness = createHarness({
    authorizeDreamImport: () => ({ kind: 'research', id: 'fixture-research' }),
    onDream: (_dream, context) => {
      if (context.projection.attempt === 1) throw new Error('experiment ledger temporarily unavailable');
      return { experiment_receipt: 'experiment-42' };
    },
  });
  const body = dreamBody({ import_mode: 'manual', id: 'dream-retryable-projection' });

  const failed = await harness.invokeAsync('POST', '/dreams', { body });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.code, 'dream_downstream_projection_failed');
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.source_committed, true);
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.dreams()[0].downstream_projection.status, 'failed');
  assert.equal(harness.dreams()[0].downstream_projection.attempts, 1);
  assert.match(harness.dreams()[0].downstream_projection.error, /temporarily unavailable/);

  const retried = await harness.invokeAsync('POST', '/dreams', { body });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.replayed, true);
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.dreams()[0].downstream_projection.status, 'completed');
  assert.equal(harness.dreams()[0].downstream_projection.attempts, 2);
  assert.deepEqual(harness.dreams()[0].downstream_projection.receipt.result,
    { experiment_receipt: 'experiment-42' });
  assert.equal(harness.onDreamCalls(), 2);
  assert.equal(harness.projectionState().strictSaves, 4);

  const completedReplay = await harness.invokeAsync('POST', '/dreams', { body });
  assert.equal(completedReplay.statusCode, 200);
  assert.equal(completedReplay.body.idempotent, true);
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.onDreamCalls(), 2);
  assert.equal(harness.projectionState().strictSaves, 4);

  const conflictingReplay = await harness.invokeAsync('POST', '/dreams', {
    body: { ...body, narrative: 'Different content under a previously committed dream ID.' },
  });
  assert.equal(conflictingReplay.statusCode, 409);
  assert.equal(conflictingReplay.body.code, 'dream_id_conflict');
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.onDreamCalls(), 2);
});

test('a dream with an uncommitted completion receipt stays pending and retries safely', async () => {
  const harness = createHarness({
    authorizeDreamImport: () => ({ kind: 'research', id: 'fixture-research' }),
    persistenceErrors: [null, new Error('dream completion receipt store unavailable'), null, null],
    onDream: () => ({ experiment_receipt: 'experiment-replayed' }),
  });
  const body = dreamBody({ import_mode: 'manual', id: 'dream-pending-receipt' });

  const incomplete = await harness.invokeAsync('POST', '/dreams', { body });
  assert.equal(incomplete.statusCode, 503);
  assert.equal(incomplete.body.retryable, true);
  assert.match(incomplete.body.error, /receipt was not committed/);
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.dreams()[0].downstream_projection.status, 'pending');
  assert.equal(harness.onDreamCalls(), 1);

  const recovered = await harness.invokeAsync('POST', '/dreams', { body });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.replayed, true);
  assert.equal(harness.dreams()[0].downstream_projection.status, 'completed');
  assert.equal(harness.dreams()[0].downstream_projection.attempts, 2);
  assert.equal(harness.onDreamCalls(), 2);
});

test('a dream keeps its pending source when a callback and its failure receipt both fail', async () => {
  const harness = createHarness({
    authorizeDreamImport: () => ({ kind: 'research', id: 'fixture-research' }),
    persistenceErrors: [null, new Error('dream failure receipt store unavailable')],
    onDream: () => { throw new Error('dream experiment creation failed'); },
  });
  const response = await harness.invokeAsync('POST', '/dreams', {
    body: dreamBody({ import_mode: 'manual', id: 'dream-failed-receipt' }),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.source_committed, true);
  assert.match(response.body.error, /retry state was not committed/);
  assert.equal(harness.dreams().length, 1);
  assert.equal(harness.dreams()[0].downstream_projection.status, 'pending');
  assert.equal(harness.dreams()[0].downstream_projection.attempts, 1);
});

test('operator deletion archives with a reason, preserves source replay, and supports committed restore', () => {
  const seedDream = dreamProvenance.normalizeDreamInput(dreamBody({
    id: 'dream-source',
    date: '2026-07-25',
    started: '2026-07-25T08:00:00.000Z',
    finished: '2026-07-25T08:30:00.000Z',
  }), { id: 'dream-source', now: NOW });
  dreamProvenance.stampAuthorizedImport(seedDream,
    { kind: 'operator', id: 'fixture-operator' }, NOW);
  const seed = dreamIdeaSeed.seedFor(seedDream, 0);
  const harness = createHarness({ dreams: [seedDream] });

  const missingReason = harness.invoke('DELETE', '/dreams/:id', {
    params: { id: seedDream.id }, body: {},
  });
  assert.equal(missingReason.statusCode, 409);
  assert.equal(dreamProvenance.isArchived(harness.dreams()[0]), false);

  const archived = harness.invoke('DELETE', '/dreams/:id', {
    params: { id: seedDream.id },
    body: { reason: 'Retain the source while removing it from future autonomous selection.' },
  });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.body.archived, true);
  assert.equal(archived.body.archive_audit.chain_verified, true);
  assert.equal(harness.dreams().length, 1);
  assert.equal(dreamIdeaSeed.audit(seed, harness.dreams()).content_commitment_verified, true);
  assert.equal(dreamIdeaSeed.audit(seed, harness.dreams()).archived, true);
  assert.equal(dreamIdeaSeed.list(harness.dreams(), [])[0].status, 'archived');
  assert.throws(() => dreamIdeaSeed.resolve(seed, harness.dreams()), /archived dream ideas/);
  const tamperedArchive = harness.dreams()[0];
  tamperedArchive.reflection.ideas[0] = 'Mutated after the archive event was committed.';
  assert.equal(dreamProvenance.archiveHistoryAudit(tamperedArchive)
    .record_commitment_verified, false);
  assert.equal(dreamProvenance.archiveHistoryAudit(tamperedArchive).chain_verified, false);

  const restored = harness.invoke('POST', '/dreams/:id/restore', {
    params: { id: seedDream.id },
    body: { reason: 'The operator reviewed the record and restored it to active use.' },
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.archive_audit.chain_verified, true);
  assert.equal(dreamProvenance.isArchived(harness.dreams()[0]), false);
  assert.equal(dreamIdeaSeed.resolve(seed, harness.dreams()).id, seed.id);
});

test('dream archival is operator-only and active-window retention never hard-deletes provenance', async () => {
  const blocked = createHarness({
    dreams: [{ id: 'dream-existing', reflection: { ideas: ['Keep this source.'] } }],
    requireOperatorAuth: (_req, res) => res.status(401).json({ error: 'operator required' }),
  });
  const denied = blocked.invoke('DELETE', '/dreams/:id', {
    params: { id: 'dream-existing' },
    body: { reason: 'Attempted archival without signed operator authority.' },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(dreamProvenance.isArchived(blocked.dreams()[0]), false);

  const older = dreamProvenance.normalizeDreamInput({
    date: '2026-07-24', started: '2026-07-24T08:00:00.000Z',
    finished: '2026-07-24T08:30:00.000Z',
    reflection: { ideas: ['Older retained source.'] },
  }, { id: 'dream-older', now: new Date('2026-07-24T08:30:00.000Z') });
  dreamProvenance.stampAuthorizedImport(older,
    { kind: 'operator', id: 'fixture-operator' }, new Date(older.finished));
  const bounded = createHarness({
    dreams: [older],
    MAX_DREAMS_KEPT: 1,
    authorizeDreamImport: () => ({ kind: 'research', id: 'fixture-research' }),
  });
  const created = await bounded.invokeAsync('POST', '/dreams', {
    body: dreamBody({ import_mode: 'manual', id: 'dream-newer',
      date: '2026-07-26', started: '2026-07-26T08:00:00.000Z',
      finished: '2026-07-26T08:30:00.000Z' }),
  });
  assert.equal(created.statusCode, 200);
  assert.equal(bounded.dreams().length, 2);
  assert.equal(dreamProvenance.isArchived(
    bounded.dreams().find(item => item.id === 'dream-older')), true);
  assert.equal(dreamProvenance.isArchived(
    bounded.dreams().find(item => item.id === 'dream-newer')), false);
});

test('dream downstream effects wait for a successful strict source commit', async () => {
  const harness = createHarness({
    authorizeDreamImport: () => ({ kind: 'research', id: 'fixture-research' }),
    persistenceError: new Error('dream store unavailable'),
  });
  const response = await harness.invokeAsync('POST', '/dreams', {
    body: dreamBody({ import_mode: 'manual', id: 'dream-failed-persistence' }),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'dream_persistence_failed');
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.source_committed, false);
  assert.match(response.body.error, /dream store unavailable/);
  assert.deepEqual(harness.dreams(), []);
  assert.equal(harness.onDreamCalls(), 0);
});

test('the production strict dream writer is atomic and never delegates to the best-effort writer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function saveDreamsStrict(dreams)');
  const end = source.indexOf('\nconst MAX_DREAMS_KEPT', start);
  assert.ok(start >= 0 && end > start, 'strict dream writer must remain discoverable');
  const implementation = source.slice(start, end);

  assert.match(implementation, /fs\.writeFileSync\(temp,/);
  assert.match(implementation, /fs\.renameSync\(temp, target\)/);
  assert.doesNotMatch(implementation, /\bsaveDreams\(dreams\)/,
    'strict writes must not call the error-swallowing compatibility writer');
  assert.match(implementation, /const priorCache = _cache\.dreams/);
  assert.match(implementation, /if \(_cache\.dreams === dreams\) _cache\.dreams = priorCache/);
  assert.match(implementation, /\{ strict: true \}/);
});

test('the production dream projector awaits reflection and seals all intelligence writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const registration = source.slice(
    source.indexOf('registerDreamRoutes(app, {'),
    source.indexOf("app.get('/capability-boundaries'", source.indexOf('registerDreamRoutes(app, {')),
  );
  assert.match(registration, /onDream: async \(dream, projectionContext = \{\}\) =>/);
  assert.match(registration, /await intelligence\.persistStrict\(\)/);
  assert.match(registration, /await runDreamReflectionLifecycleWithPriorityRuntime\(\)/);
  assert.doesNotMatch(registration,
    /runDreamReflectionLifecycleWithPriorityRuntime\(\)\s*\.catch/);
  assert.match(registration, /return receipt/);
});
