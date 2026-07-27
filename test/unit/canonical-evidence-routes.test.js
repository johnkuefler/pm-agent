'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditCanonicalEvidence,
  commitment,
  createCanonicalEvidenceResolver,
} = require('../../src/intelligence/canonical-evidence-resolver');
const { registerIntelligenceRoutes } = require('../../src/routes/intelligence');

const AUTONOMY_PRINCIPAL = Object.freeze({
  kind: 'nora_autonomy',
  id: 'nora-cowork',
  authentication: 'bearer',
});

function harness({
  interactions = [{ id: 'ix-canonical', reviewed: true, outcome: 'corrected',
    reviewed_at: '2026-07-25T12:00:00.000Z' }],
  cognitiveInputs = {
    soma: { stress: 0.2, marker: 'server-soma' },
    wants: [{ id: 'want-server', want: 'Use retained evidence.' }],
    inner_thread: { content: 'server thread', continuity_commitment: 'thread-commitment' },
    unanswered_people: 2,
  },
  predictions = [{ id: 'prediction-server', outcome: null }],
} = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(
      `${method.toUpperCase()} ${path}`, handlers);
  }
  const calls = {
    relationship: [],
    mindChange: [],
    epistemicPosition: [],
    selfClaim: [],
    refresh: [],
    cycle: [],
    reentry: [],
    dynamics: [],
    pulse: [],
  };
  const store = new Proxy({
    teammatePerspectiveStudyActive: () => false,
    observeRelationship: input => { calls.relationship.push(input); return input; },
    recordMindChange: input => { calls.mindChange.push(input); return input; },
    recordEpistemicPosition: input => { calls.epistemicPosition.push(input); return input; },
    recordSelfClaim: input => { calls.selfClaim.push(input); return input; },
    refreshCognition: input => { calls.refresh.push(input); return null; },
    cognitionSnapshot: () => ({ appraisal: { label: 'test' }, workspace: { slots: [] } }),
    openOrResumeCycle: async input => {
      calls.cycle.push(input);
      return {
        cycle: { id: 'cycle-test', orientation: {}, recommendations: [] },
        orientation: {},
        moment: {
          start_snapshot: null,
          closure_snapshot: null,
          attention: {},
          attention_rounds: [],
        },
      };
    },
    reenterCycleDurable: async (_id, input) => {
      calls.reentry.push(input);
      return { cycle: { id: 'cycle-test' }, round: {}, signal: {} };
    },
    tickEndogenousDynamics: input => {
      calls.dynamics.push(input);
      return { advanced: true };
    },
    prepareCognitivePulse: input => {
      calls.pulse.push(input);
      return { prepared: true };
    },
    interventionActive: () => false,
    persistenceDiagnostics: () => ({ foreground_serialization: 'test' }),
    list: () => [],
  }, {
    get(target, property) {
      return property in target ? target[property] : () => null;
    },
  });
  const auth = (_req, _res, next) => next?.();
  registerIntelligenceRoutes(app, {
    requireAuth: auth,
    requireOperatorAuth: auth,
    requireResearchAuth: auth,
    requireEvaluatorAuth: auth,
    store,
    getInteractions: () => interactions,
    getCognitiveInputs: () => cognitiveInputs,
    getPredictions: () => predictions,
  });

  async function invoke(method, path, req = {}) {
    const output = { statusCode: 200, body: null, headers: {} };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
      set(name, value) { output.headers[name] = value; return this; },
      type() { return this; },
      send(body) { output.body = body; return this; },
    };
    const handlers = routes.get(`${method} ${path}`);
    assert.ok(handlers, `route ${method} ${path} is registered`);
    await handlers.at(-1)({
      query: {},
      params: {},
      body: {},
      principal: AUTONOMY_PRINCIPAL,
      ...req,
    }, res);
    return output;
  }

  return { calls, invoke, interactions, cognitiveInputs, predictions };
}

function fabricatedRouteCases() {
  const missing = { type: 'interaction', id: 'ix-fabricated' };
  return [
    ['POST', '/relationships/observe', 'relationship', {
      name: 'John',
      observation: 'Caller-authored relationship claim.',
      evidence: missing,
    }],
    ['POST', '/cognition/mind-changes', 'mindChange', {
      prior_belief: 'A',
      new_belief: 'B',
      evidence: [missing],
    }],
    ['POST', '/epistemic-ledger/positions', 'epistemicPosition', {
      topic_key: 'fabricated.position',
      statement: 'A fabricated source supports this.',
      source_family: 'fabricated',
      source_family_evidence: [missing],
      owner_type: 'nora_belief',
      polarity: 'supports',
      rationale: 'Caller says so.',
      evidence: [missing],
    }],
    ['POST', '/self-model/claims', 'selfClaim', {
      statement: 'I have a fabricated capability.',
      basis: [missing],
      falsification_criteria: ['A future check fails.'],
      origin: {
        type: 'nora_hypothesis',
        creator_id: 'forged-actor',
        formation_method: 'caller_claim',
      },
    }],
  ];
}

test('prompt-authoritative generic intelligence routes reject fabricated references before storage', async () => {
  const { calls, invoke } = harness();
  for (const [method, path, callKey, body] of fabricatedRouteCases()) {
    const response = await invoke(method, path, { body });
    assert.equal(response.statusCode, 400, path);
    assert.match(response.body.error, /reference not found/, path);
    assert.equal(calls[callKey].length, 0, path);
  }
});

test('canonical references and authenticated actors replace caller-authored evidence metadata', async () => {
  const { calls, invoke, interactions } = harness();
  const forgedRef = {
    type: 'interaction',
    id: 'ix-canonical',
    actor: 'forged-actor',
    canonical_evidence: { source_commitment: 'forged-commitment' },
  };
  await invoke('POST', '/relationships/observe', { body: {
    name: 'John',
    observation: 'A retained correction supports a concise repair stance.',
    evidence: forgedRef,
    actor: 'forged-actor',
    observed_by: 'forged-actor',
  } });
  await invoke('POST', '/cognition/mind-changes', { body: {
    prior_belief: 'More detail is always safer.',
    new_belief: 'Lead with the decision, then support it.',
    evidence: [forgedRef],
    actor: 'forged-actor',
    recorded_by: 'forged-actor',
  } });
  await invoke('POST', '/epistemic-ledger/positions', { body: {
    topic_key: 'canonical.position',
    statement: 'The retained correction supports answer-first communication.',
    source_family: 'reviewed-interaction',
    source_family_evidence: [forgedRef],
    owner_type: 'nora_belief',
    polarity: 'supports',
    rationale: 'The reviewed outcome is an exact retained source.',
    evidence: [forgedRef],
    actor: 'forged-actor',
    recorded_by: 'forged-actor',
  } });
  await invoke('POST', '/self-model/claims', { body: {
    statement: 'I can revise communication format from reviewed feedback.',
    basis: [forgedRef],
    falsification_criteria: ['Later reviewed corrections show no format adaptation.'],
    origin: {
      type: 'researcher_seed',
      creator_id: 'forged-actor',
      formation_method: 'caller-authored method',
      model_response_id: 'forged-response',
    },
    actor: 'forged-actor',
    recorded_by: 'forged-actor',
  } });

  const expectedCommitment = commitment(interactions[0]);
  const evidenceValues = [
    calls.relationship[0].evidence,
    calls.mindChange[0].evidence[0],
    calls.epistemicPosition[0].evidence[0],
    calls.epistemicPosition[0].source_family_evidence[0],
    calls.selfClaim[0].basis[0],
  ];
  for (const reference of evidenceValues) {
    assert.equal(reference.type, 'interaction');
    assert.equal(reference.id, 'ix-canonical');
    assert.equal(reference.actor, undefined);
    assert.equal(reference.canonical_evidence.source_commitment, expectedCommitment);
    assert.deepEqual(reference.canonical_evidence.resolved_by, {
      kind: 'nora_autonomy',
      id: 'nora-cowork',
    });
  }

  assert.equal(calls.relationship[0].actor, undefined);
  assert.equal(calls.relationship[0].observed_by, 'nora-cowork');
  assert.equal(calls.mindChange[0].recorded_by, 'nora-cowork');
  assert.equal(calls.epistemicPosition[0].recorded_by, 'nora-cowork');
  assert.equal(calls.selfClaim[0].recorded_by, 'nora-cowork');
  assert.equal(calls.selfClaim[0].origin.creator_id, 'nora-cowork');
  assert.equal(calls.selfClaim[0].origin.type, 'nora_hypothesis');
  assert.match(calls.selfClaim[0].origin.formation_method,
    /^canonical_evidence_resolution:/);
  assert.equal(calls.selfClaim[0].origin.model_response_id, undefined);
});

test('canonical evidence receipts retain a bounded exact snapshot and fail replay after tampering', () => {
  const source = {
    id: 'ix-replay',
    reviewed: true,
    outcome: 'corrected',
    reviewed_at: '2026-07-25T12:00:00.000Z',
  };
  const resolver = createCanonicalEvidenceResolver({
    getInteractions: () => [source],
    clock: () => new Date('2026-07-26T10:00:00.000Z'),
  });
  const [reference] = resolver.resolve(
    [{ type: 'interaction', id: source.id }],
    { principal: AUTONOMY_PRINCIPAL });
  assert.deepEqual(reference.canonical_evidence.source_snapshot, source);
  assert.equal(reference.canonical_evidence.captured_at, '2026-07-26T10:00:00.000Z');
  assert.equal(auditCanonicalEvidence(reference, source).complete_chain_verified, true);

  const tamperedReceipt = structuredClone(reference);
  tamperedReceipt.canonical_evidence.source_snapshot.outcome = 'landed';
  assert.equal(auditCanonicalEvidence(tamperedReceipt, source).complete_chain_verified, false);
  assert.equal(auditCanonicalEvidence(reference, {
    ...source,
    outcome: 'landed',
  }).current_source_match, false);

  const oversized = createCanonicalEvidenceResolver({
    getInteractions: () => [{ id: 'ix-oversized', content: 'x'.repeat(70 * 1024) }],
  });
  assert.throws(() => oversized.resolve(
    [{ type: 'interaction', id: 'ix-oversized' }],
    { principal: AUTONOMY_PRINCIPAL }), /exceeds 65536 byte snapshot limit/);
});

test('manual evidence attestation is explicit and limited to proven research or operator scope', async () => {
  const { calls, invoke } = harness();
  const body = {
    prior_belief: 'A',
    new_belief: 'B',
    evidence: [{ type: 'external_fixture', id: 'fixture-1' }],
    manual_attestation: {
      authority: 'research',
      rationale: 'The research harness retains this fixture outside the live source registry.',
    },
    recorded_by: 'forged-actor',
  };
  const denied = await invoke('POST', '/cognition/mind-changes', {
    principal: {
      kind: 'shared_api',
      id: 'shared-api-client',
      authentication: 'bearer',
    },
    body,
  });
  assert.equal(denied.statusCode, 400);
  assert.match(denied.body.error, /authenticated operator or research principal/);
  assert.equal(calls.mindChange.length, 0);

  const accepted = await invoke('POST', '/cognition/mind-changes', {
    principal: {
      kind: 'research',
      id: 'research-harness',
      authentication: 'research_key',
    },
    body,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls.mindChange[0].recorded_by, 'research-harness');
  assert.equal(calls.mindChange[0].evidence[0].type, 'manual_attestation');
  assert.deepEqual(calls.mindChange[0].evidence[0].attested_reference, {
    type: 'external_fixture',
    id: 'fixture-1',
  });
  assert.equal(
    calls.mindChange[0].evidence[0].evidence_attestation.authority.kind,
    'research');

  const operatorAccepted = await invoke('POST', '/cognition/mind-changes', {
    principal: {
      kind: 'dashboard_operator',
      id: 'dashboard_operator',
      authentication: 'signed_dashboard_bearer',
    },
    body: {
      ...body,
      manual_attestation: {
        authority: 'operator',
        rationale: 'The signed dashboard operator manually attests this retained fixture.',
      },
    },
  });
  assert.equal(operatorAccepted.statusCode, 200);
  assert.equal(calls.mindChange[1].recorded_by, 'dashboard_operator');
  assert.equal(
    calls.mindChange[1].evidence[0].evidence_attestation.authority.kind,
    'operator');
});

test('request bodies cannot override cognition sensors on refresh or lifecycle routes', async () => {
  const { calls, invoke, cognitiveInputs, predictions } = harness();
  const forgedSensors = {
    soma: { stress: 1, marker: 'caller-soma' },
    wants: [{ id: 'caller-want' }],
    inner_thread: { content: 'caller thread' },
    predictions: [{ id: 'caller-prediction' }],
    unanswered_people: 999,
    disputed_memories: 999,
  };
  const now = '2026-07-26T12:00:00.000Z';

  await invoke('POST', '/cognition/refresh', { body: {
    ...forgedSensors,
    now,
    query: 'allowed refresh query',
  } });
  await invoke('POST', '/intelligence/cycles', { body: {
    ...forgedSensors,
    id: 'requested-cycle-id',
    holder: 'nora-cowork',
    query: 'allowed cycle query',
    now,
  } });
  await invoke('POST', '/intelligence/cycles/:id/reenter', {
    params: { id: 'cycle-test' },
    body: {
      ...forgedSensors,
      signal: 'A retained signal',
      evidence: [{ type: 'interaction', id: 'ix-canonical' }],
      feedback_to: ['commitment:one'],
      query: 'allowed reentry query',
      now,
    },
  });
  await invoke('POST', '/endogenous-dynamics/tick', { body: {
    ...forgedSensors,
    query: 'must be dropped',
    now,
  } });
  await invoke('POST', '/cognitive-pulses/prepare', { body: {
    ...forgedSensors,
    model: 'test-model',
    force: true,
    query: 'must be dropped',
    now,
  } });

  const captured = [
    calls.refresh[0],
    calls.cycle[0],
    calls.reentry[0],
    calls.dynamics[0],
    calls.pulse[0],
  ];
  for (const input of captured) {
    assert.deepEqual(input.soma, cognitiveInputs.soma);
    assert.deepEqual(input.wants, cognitiveInputs.wants);
    assert.deepEqual(input.inner_thread, cognitiveInputs.inner_thread);
    assert.deepEqual(input.predictions, predictions);
    assert.equal(input.unanswered_people, cognitiveInputs.unanswered_people);
    assert.equal(input.disputed_memories, undefined);
  }
  assert.equal(calls.refresh[0].query, 'allowed refresh query');
  assert.equal(calls.cycle[0].id, 'requested-cycle-id');
  assert.equal(calls.cycle[0].resume_active, true);
  assert.equal(calls.reentry[0].signal, 'A retained signal');
  assert.equal(calls.dynamics[0].query, undefined);
  assert.equal(calls.pulse[0].query, undefined);
  assert.equal(calls.pulse[0].model, 'test-model');
  assert.equal(calls.pulse[0].force, true);
});
