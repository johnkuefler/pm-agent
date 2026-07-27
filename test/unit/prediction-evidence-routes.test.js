'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditCanonicalEvidence,
  commitment,
} = require('../../src/intelligence/canonical-evidence-resolver');
const { __test } = require('../../server');

const AUTONOMY_PRINCIPAL = Object.freeze({
  kind: 'nora_autonomy',
  id: 'nora-cowork',
  authentication: 'bearer',
});
const NOW = '2026-07-26T15:30:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function responseHarness() {
  const output = { statusCode: 200, body: null };
  const res = {
    headersSent: false,
    status(code) {
      output.statusCode = code;
      return this;
    },
    json(value) {
      output.body = value;
      this.headersSent = true;
      return this;
    },
  };
  return { output, res };
}

function resolvedEvidence({ references, principal, capturedAt }) {
  if (!Array.isArray(references) || !references.length) {
    throw new Error('resolution evidence requires at least one evidence reference');
  }
  return references.map(reference => {
    if (reference.id === 'fabricated') {
      throw new Error(`resolution evidence reference not found: ${reference.type}:fabricated`);
    }
    const canonical = {
      type: reference.type,
      id: reference.id,
      canonical_evidence: {
        protocol_version: 1,
        mode: 'canonical_resolution',
        source_snapshot: { id: reference.id, observed: true },
        captured_at: capturedAt,
        source_commitment: `source:${reference.type}:${reference.id}`,
        resolved_by: { kind: principal.kind, id: principal.id },
      },
    };
    canonical.canonical_evidence.receipt_commitment = commitment(canonical);
    return canonical;
  });
}

function resolutionHarness({
  initialItems = [{
    id: 'pred-1',
    prediction: 'The implementation lands by Friday.',
    confidence: 0.8,
    evidence: [{ type: 'memory', id: 'formation-memory' }],
    basis: 'Formation-only basis',
    made: '2026-07-20T10:00:00.000Z',
    outcome: null,
    resolved: null,
    notes: null,
    resolution: null,
  }],
  resolveEvidence = resolvedEvidence,
  persistenceError = null,
  cognitionPersistenceError = null,
  recordResolution = () =>
    ({ surprise: { id: 'surprise-1' }, mind_change: null, brier: 0.64 }),
} = {}) {
  let state = { items: clone(initialItems), updated_at: '2026-07-20T10:00:00.000Z' };
  const calls = {
    persist: [],
    publish: [],
    cognition: [],
    cognitionPersist: 0,
    cacheOutcomesDuringPersist: [],
    errors: [],
  };
  const handler = __test.createPredictionResolutionHandler({
    databaseReady: () => true,
    loadItems: () => state.items,
    resolveEvidence,
    persistRecord: async record => {
      calls.persist.push(clone(record));
      calls.cacheOutcomesDuringPersist.push(state.items.map(item => item.outcome));
      if (persistenceError) throw persistenceError;
    },
    publishRecord: record => {
      calls.publish.push(clone(record));
      state = clone(record);
    },
    recordResolution: input => {
      calls.cognition.push(clone(input));
      return recordResolution(input, calls.cognition.length);
    },
    persistCognition: async () => {
      calls.cognitionPersist += 1;
      if (cognitionPersistenceError) throw cognitionPersistenceError;
    },
    clock: () => new Date(NOW),
    reportError: (phase, error) => calls.errors.push({ phase, message: error.message }),
  });

  async function invoke(body, {
    id = 'pred-1',
    principal = AUTONOMY_PRINCIPAL,
  } = {}) {
    const { output, res } = responseHarness();
    await handler({ body, params: { id }, principal }, res);
    return output;
  }

  return { calls, invoke, state: () => clone(state) };
}

test('prediction resolution commits server-stamped actor/time and sends only outcome evidence to cognition', async () => {
  const harness = resolutionHarness();
  const response = await harness.invoke({
    outcome: 'wrong',
    notes: 'The retained Teamwork task shows the actual slip.',
    evidence: [{ type: 'teamwork_task', id: 'tw-42' }],
    resolved: '1900-01-01T00:00:00.000Z',
    resolved_by: { kind: 'forged', id: 'caller' },
    resolution: { evidence_receipt_commitment: 'forged' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.idempotent, false);
  assert.equal(harness.calls.persist.length, 2);
  assert.deepEqual(harness.calls.cacheOutcomesDuringPersist, [[null], ['wrong']],
    'the cached prediction must remain unresolved until persistence succeeds');
  assert.equal(harness.calls.publish.length, 2);

  const prediction = harness.state().items[0];
  assert.deepEqual(prediction.evidence,
    [{ type: 'memory', id: 'formation-memory' }],
    'formation evidence remains distinct from resolution evidence');
  assert.equal(prediction.resolved, NOW);
  assert.equal(prediction.resolution.resolved_at, NOW);
  assert.deepEqual(prediction.resolution.resolved_by, AUTONOMY_PRINCIPAL);
  assert.equal(prediction.resolution.evidence_mode, 'canonical_resolution');
  assert.equal(prediction.resolution.evidence[0].id, 'tw-42');
  assert.equal(prediction.resolution.evidence_receipt_commitment,
    commitment(prediction.resolution.evidence));
  assert.equal(prediction.resolution.cognition_projection.status, 'recorded');
  assert.equal(prediction.resolution.cognition_projection.attempts, 1);
  assert.equal(prediction.resolution.cognition_projection.result.surprise_id,
    'surprise-1');

  assert.equal(harness.calls.cognition.length, 1);
  assert.equal(harness.calls.cognitionPersist, 1);
  assert.deepEqual(harness.calls.cognition[0].evidence,
    prediction.resolution.evidence);
  assert.equal(harness.calls.cognition[0].notes, undefined);
  assert.notDeepEqual(harness.calls.cognition[0].evidence, prediction.evidence);
});

test('prediction resolution rejects missing or fabricated canonical evidence before persistence', async () => {
  const harness = resolutionHarness();
  const missing = await harness.invoke({ outcome: 'right' });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.error, /requires at least one evidence reference/);

  const fabricated = await harness.invoke({
    outcome: 'right',
    evidence: [{ type: 'teamwork_task', id: 'fabricated' }],
  });
  assert.equal(fabricated.statusCode, 400);
  assert.match(fabricated.body.error, /reference not found/);
  assert.equal(harness.calls.persist.length, 0);
  assert.equal(harness.calls.publish.length, 0);
  assert.equal(harness.calls.cognition.length, 0);
  assert.equal(harness.state().items[0].outcome, null);
});

test('a prediction cannot use its own formation record as canonical outcome evidence', async () => {
  const harness = resolutionHarness();
  const response = await harness.invoke({
    outcome: 'right',
    evidence: [{ type: 'prediction', id: 'pred-1' }],
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /cannot use its own formation record/);
  assert.equal(harness.calls.persist.length, 0);
  assert.equal(harness.calls.cognition.length, 0);
  assert.equal(harness.state().items[0].outcome, null);
});

test('prediction resolution leaves the cache and cognition untouched when persistence fails', async () => {
  const harness = resolutionHarness({
    persistenceError: new Error('database unavailable'),
  });
  const response = await harness.invoke({
    outcome: 'right',
    evidence: [{ type: 'marker', id: 'shipped-marker' }],
  });

  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /database unavailable/);
  assert.equal(harness.calls.persist.length, 1);
  assert.equal(harness.calls.publish.length, 0);
  assert.equal(harness.calls.cognition.length, 0);
  assert.equal(harness.state().items[0].outcome, null);
  assert.deepEqual(harness.state().items[0].evidence,
    [{ type: 'memory', id: 'formation-memory' }]);
});

test('already-resolved predictions are idempotent only for the same outcome and evidence receipt', async () => {
  const harness = resolutionHarness();
  const body = {
    outcome: 'right',
    evidence: [{ type: 'project', id: 'Canonical Project' }],
    notes: 'First resolution note.',
  };
  const first = await harness.invoke(body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.idempotent, false);

  const retry = await harness.invoke({
    ...body,
    notes: 'A retry cannot rewrite the committed note.',
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(harness.calls.persist.length, 2);
  assert.equal(harness.calls.cognition.length, 1);
  assert.equal(harness.state().items[0].notes, 'First resolution note.');

  const changedEvidence = await harness.invoke({
    outcome: 'right',
    evidence: [{ type: 'project', id: 'Different Project' }],
  });
  assert.equal(changedEvidence.statusCode, 409);
  assert.match(changedEvidence.body.error, /different outcome or evidence receipt/);

  const changedOutcome = await harness.invoke({
    outcome: 'wrong',
    evidence: body.evidence,
  });
  assert.equal(changedOutcome.statusCode, 409);
  assert.equal(harness.calls.persist.length, 2);
  assert.equal(harness.calls.cognition.length, 1);
});

test('a same-receipt retry reconciles a failed cognition projection exactly once', async () => {
  const harness = resolutionHarness({
    recordResolution: (_input, attempt) => {
      if (attempt === 1) throw new Error('temporary cognition failure');
      return {
        surprise: { id: 'surprise-recovered' },
        mind_change: { id: 'mind-recovered' },
        brier: 0.64,
      };
    },
  });
  const body = {
    outcome: 'wrong',
    evidence: [{ type: 'teamwork_task', id: 'tw-recovery' }],
  };

  const first = await harness.invoke(body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.cognition_recorded, false);
  assert.equal(first.body.resolution.cognition_projection.status, 'failed');
  assert.equal(first.body.resolution.cognition_projection.attempts, 1);
  assert.match(first.body.resolution.cognition_projection.last_error,
    /temporary cognition failure/);
  assert.equal(harness.calls.persist.length, 2,
    'the durable resolution and failed projection status are separate commits');
  assert.equal(harness.calls.cognition.length, 1);

  const retry = await harness.invoke(body);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.cognition_recorded, true);
  assert.equal(retry.body.resolution.cognition_projection.status, 'recorded');
  assert.equal(retry.body.resolution.cognition_projection.attempts, 2);
  assert.equal(retry.body.resolution.cognition_projection.result.surprise_id,
    'surprise-recovered');
  assert.equal(retry.body.resolution.cognition_projection.result.mind_change_id,
    'mind-recovered');
  assert.equal(harness.calls.persist.length, 3);
  assert.equal(harness.calls.cognition.length, 2);

  const settledRetry = await harness.invoke(body);
  assert.equal(settledRetry.statusCode, 200);
  assert.equal(settledRetry.body.idempotent, true);
  assert.equal(settledRetry.body.cognition_recorded, true);
  assert.equal(harness.calls.persist.length, 3);
  assert.equal(harness.calls.cognition.length, 2,
    'a recorded projection must not run again on later retries');
});

test('prediction projection is not marked recorded when strict cognition persistence fails', async () => {
  const failingHarness = resolutionHarness({
    cognitionPersistenceError: new Error('intelligence durability unavailable'),
  });
  const body = {
    outcome: 'wrong',
    evidence: [{ type: 'teamwork_task', id: 'tw-recovery' }],
  };

  const first = await failingHarness.invoke(body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.cognition_recorded, false);
  assert.equal(first.body.resolution.cognition_projection.status, 'failed');
  assert.match(first.body.resolution.cognition_projection.last_error,
    /intelligence durability unavailable/);
  assert.equal(failingHarness.calls.cognitionPersist, 1);
  assert.equal(failingHarness.calls.persist.length, 2);
});

test('prediction evidence resolver supports tasks, projects, and markers as canonical sources', () => {
  const tasks = [
    { id: 'tw-1', action: 'Ship the release', status: 'done' },
    { id: 'tw-2', action: 'Verify the release', status: 'done' },
  ];
  const projects = [{ name: 'Canonical Project', status: 'active' }];
  const markers = {
    'release-shipped': { set_at: NOW, note: 'Release artifact observed.' },
  };
  const resolver = __test.createPredictionCanonicalEvidenceResolver({
    store: { list: () => [], autobiographyEvidence: () => null },
    getDreams: () => [],
    getWants: () => [],
    getInteractions: () => [],
    getPredictions: () => [],
    getMemory: () => [],
    getConsequenceReviews: () => ({}),
    getTasks: () => tasks,
    getProjects: () => projects,
    getMarkers: () => markers,
    clock: () => new Date(NOW),
  });

  const evidence = resolver.resolve([
    { type: 'task', id: 'tw-1' },
    { type: 'teamwork_task', id: 'tw-2' },
    { type: 'project', id: 'Canonical Project' },
    { type: 'marker', id: 'release-shipped' },
  ], { principal: AUTONOMY_PRINCIPAL, field: 'resolution evidence' });

  assert.deepEqual(evidence.map(reference => reference.type),
    ['teamwork_task', 'teamwork_task', 'project', 'marker']);
  assert.equal(evidence[0].canonical_evidence.source_snapshot.action,
    'Ship the release');
  assert.equal(evidence[2].canonical_evidence.source_snapshot.name,
    'Canonical Project');
  assert.equal(evidence[3].canonical_evidence.source_snapshot.note,
    'Release artifact observed.');
  for (const reference of evidence) {
    assert.equal(auditCanonicalEvidence(reference).complete_chain_verified, true);
  }
  assert.throws(() => resolver.resolve(
    [{ type: 'marker', id: 'fabricated' }],
    { principal: AUTONOMY_PRINCIPAL, field: 'resolution evidence' },
  ), /reference not found/);
});

test('manual prediction evidence requires an explicit authenticated operator or research lane', () => {
  for (const [authority, principal] of [
    ['operator', {
      kind: 'dashboard_operator',
      id: 'dashboard_operator',
      authentication: 'signed_operator_session',
    }],
    ['research', {
      kind: 'research',
      id: 'research-harness',
      authentication: 'research_key',
    }],
  ]) {
    let gated = 0;
    let continued = 0;
    const middleware = __test.createPredictionManualAttestationMiddleware({
      requireOperator: (req, _res, next) => {
        gated += 1;
        req.principal = principal;
        next();
      },
      requireResearch: (req, _res, next) => {
        gated += 1;
        req.principal = principal;
        next();
      },
    });
    const { output, res } = responseHarness();
    const req = {
      body: {
        manual_attestation: {
          authority,
          rationale: 'The canonical source is unavailable; an authorized reviewer checked it.',
        },
      },
      principal: AUTONOMY_PRINCIPAL,
    };
    middleware(req, res, () => { continued += 1; });
    assert.equal(output.statusCode, 200);
    assert.equal(gated, 1);
    assert.equal(continued, 1);
    assert.deepEqual(req.principal, principal);
  }

  const middleware = __test.createPredictionManualAttestationMiddleware();
  const { output, res } = responseHarness();
  let continued = 0;
  middleware({
    body: {
      manual_attestation: {
        authority: 'self',
        rationale: 'Caller-authored outcome.',
      },
    },
    principal: AUTONOMY_PRINCIPAL,
  }, res, () => { continued += 1; });
  assert.equal(output.statusCode, 400);
  assert.match(output.body.error, /operator or research/);
  assert.equal(continued, 0);
});
