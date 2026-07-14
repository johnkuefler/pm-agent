const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const pulseProtocol = require('../../src/intelligence/cognitive-pulse');
const initiationProtocol = require('../../src/intelligence/cognitive-initiation');

test('production cognitive pulses default on only with a provider credential and retain a hard kill switch', () => {
  const { __test } = require('../../server');
  const credentialDefault = __test.cognitivePulseRuntimeConfig({ ANTHROPIC_API_KEY: 'configured-for-test' });
  assert.equal(credentialDefault.enabled, true);
  assert.equal(credentialDefault.reason, 'provider_credential_default');
  assert.equal(credentialDefault.minimum_interval_minutes, 180);
  assert.equal(credentialDefault.daily_budget, 6);
  assert.equal(credentialDefault.maximum_ordinary_provider_calls_per_day, 12);
  assert.equal(credentialDefault.actionless, true);
  assert.equal(credentialDefault.tools_available, false);

  const killed = __test.cognitivePulseRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured-for-test', COGNITIVE_PULSE_ENABLED: 'false',
  });
  assert.equal(killed.enabled, false);
  assert.equal(killed.reason, 'explicitly_disabled');

  const missingCredential = __test.cognitivePulseRuntimeConfig({ COGNITIVE_PULSE_ENABLED: 'true' });
  assert.equal(missingCredential.enabled, false);
  assert.equal(missingCredential.reason, 'missing_api_key');

  const bounded = __test.cognitivePulseRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured-for-test', COGNITIVE_PULSE_INTERVAL_MINUTES: '1',
    COGNITIVE_PULSE_DAILY_BUDGET: '999',
  });
  assert.equal(bounded.minimum_interval_minutes, 30);
  assert.equal(bounded.daily_budget, 24);
});

async function setup(suffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nora-cognitive-initiation-${suffix}-`));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  store.addCommitment({ id: `${suffix}-commitment-a`, what: 'Reconcile contradictory release evidence', owner: 'Nora' });
  store.addCommitment({ id: `${suffix}-commitment-b`, what: 'Check whether the new accessibility result changes the recommendation', owner: 'Nora' });
  store.tickEndogenousDynamics({ now });
  now = new Date('2026-07-13T16:00:00.000Z');
  store.tickEndogenousDynamics({ now });
  return { dir, filePath, store };
}

function decision(packet, action) {
  return {
    decision: action, expected_value: action === 'think' ? 0.82 : 0.21,
    focus_refs: [packet.evidence[0].ref],
    predicted_gain: action === 'think' ? 'Resolve whether the new evidence changes the launch recommendation.' : 'Reconsider after additional release evidence arrives.',
    reconsider_after_minutes: 60,
    rationale: action === 'think' ? 'The unresolved evidence is current and decision-relevant.' : 'A deeper pass is unlikely to add information before new evidence.',
  };
}

function validOutput(packet) {
  return {
    focus_refs: [packet.evidence[0].ref],
    hypothesis: 'The new result may change which release recommendation is supportable.',
    alternatives: ['The result may be independent of the release decision.'], uncertainty: 0.4,
    predicted_relevance: 'A later recommendation can test the evidence relation.',
    disconfirming_observation: 'The result has no bearing on either release option.',
    predecessor_update: packet.predecessor
      ? { predecessor_id: packet.predecessor.id, disposition: 'revise', rationale: 'New evidence bears on the prior hypothesis.', evidence_refs: [packet.evidence[0].ref] }
      : { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists.', evidence_refs: [] },
    self_inquiry: null, self_claim_proposal: null,
    metacognitive_forecast: {
      next_focus_refs: [packet.evidence[0].ref], expected_uncertainty: 0.4,
      expected_continuation_probability: 0.7, expected_value_of_next_pulse: 0.6,
      rationale: 'The strongest unresolved evidence is likely to remain relevant.',
      falsifier: 'The next accepted pulse focuses elsewhere or drops this line of inference.',
    },
  };
}

function complete(store, begun, action, responseId) {
  const system = initiationProtocol.systemPrompt('self');
  const user = initiationProtocol.userPrompt(begun.packet);
  return store.completeCognitivePulseInitiation(begun.id, {
    decision: decision(begun.packet, action), response_id: responseId, model: 'test-model',
    input_tokens: 40, output_tokens: 20,
    prompt_commitment: initiationProtocol.commitment({ system, user }),
  });
}

test('endogenous initiation prospectively commits THINK or WAIT and applies the choice tamper-evidently', async () => {
  const thinking = await setup('think');
  assert.equal(thinking.store.snapshot().version, 90);
  const prepared = thinking.store.prepareCognitivePulse({ id: 'think-pulse', model: 'test-model', force: true });
  const begun = thinking.store.beginCognitivePulseInitiation(prepared.pulse.id, { id: 'think-gate', model: 'test-model' });
  assert.equal(begun.packet.target, 'nora_current_agent');
  assert.equal(begun.packet.pulse_input_commitment, prepared.pulse.input_commitment);
  assert.throws(() => initiationProtocol.parseDecision(JSON.stringify({ ...decision(begun.packet, 'think'), focus_refs: [{ type: 'invented', id: 'outside' }] }), begun.packet), /supplied references/);
  const committed = complete(thinking.store, begun, 'think', 'think-provider');
  assert.equal(committed.audit.complete_chain_verified, false, 'the decision is not fully applied until the deeper pulse outcome is committed');
  assert.throws(() => thinking.store.deferCognitivePulse(prepared.pulse.id), /wait initiation decision/);
  thinking.store.recordCognitivePulseResult(prepared.pulse.id, {
    input_commitment: prepared.pulse.input_commitment, output: validOutput(prepared.pulse.input_packet),
    response_id: 'pulse-provider', model: 'test-model', input_tokens: 100, output_tokens: 70,
  });
  thinking.store.resolveCognitivePulse(prepared.pulse.id, { outcome: 'useful', evaluator_id: 'independent-rater',
    evidence: [{ type: 'later_release_review', id: 'review-1' }], rationale: 'The hypothesis improved the later evidence review.' });
  const thinkingSnapshot = thinking.store.cognitivePulseSnapshot();
  assert.equal(thinkingSnapshot.initiations[0].audit.complete_chain_verified, true);
  assert.equal(thinkingSnapshot.report.initiated_thoughts, 1);
  assert.equal(thinking.store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'collecting');

  const waiting = await setup('wait');
  const waitPrepared = waiting.store.prepareCognitivePulse({ id: 'wait-pulse', model: 'test-model', force: true });
  const waitBegun = waiting.store.beginCognitivePulseInitiation(waitPrepared.pulse.id, { id: 'wait-gate', model: 'test-model' });
  complete(waiting.store, waitBegun, 'wait', 'wait-provider');
  const deferred = waiting.store.deferCognitivePulse(waitPrepared.pulse.id);
  assert.equal(deferred.pulse.status, 'deferred');
  assert.equal(deferred.initiation.audit.complete_chain_verified, true);
  assert.equal(waiting.store.cognitivePulseSnapshot().report.deferred_thoughts, 1);
  assert.equal(waiting.store.cognitivePulseSnapshot().pulses.some(item => item.status === 'accepted'), false);

  await thinking.store.persist();
  const raw = JSON.parse(fs.readFileSync(thinking.filePath, 'utf8'));
  raw.cognition.background_inference.initiation_records[0].packet.evidence[0].summary = 'tampered gate evidence';
  fs.writeFileSync(thinking.filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath: thinking.filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation');
  assert.equal(indicator.evidence.replay_valid_applied_decisions, 0);

  fs.rmSync(thinking.dir, { recursive: true, force: true });
  fs.rmSync(waiting.dir, { recursive: true, force: true });
});

test('the background runtime obeys WAIT before any deeper pulse call and THINK before exactly one pulse', async () => {
  const { __test } = require('../../server');
  const store = __test.intelligenceStore;
  const originals = {
    prepare: store.prepareCognitivePulse, begin: store.beginCognitivePulseInitiation,
    complete: store.completeCognitivePulseInitiation, defer: store.deferCognitivePulse,
    result: store.recordCognitivePulseResult, failure: store.recordCognitivePulseFailure,
  };
  const pulse = { id: 'runtime-pulse', input_commitment: pulseProtocol.commitment('runtime-packet'),
    input_packet: { captured_at: '2026-07-13T16:00:00.000Z', endogenous_tick: 2,
      evidence: [{ ref: { type: 'commitment', id: 'runtime-evidence' }, summary: 'A runtime issue remains unresolved.', activation: 0.8 }],
      self_model_candidates: [], predecessor: null, constraints: { protocol_version: 4, actionless: true, no_tools: true } } };
  const packet = initiationProtocol.buildPacket(pulse, { binding: 'self', dailyBudgetRemaining: 10 });
  let recordedResult = 0; let deferred = 0;
  store.prepareCognitivePulse = () => ({ prepared: true, pulse });
  store.beginCognitivePulseInitiation = () => ({ id: 'runtime-gate', packet });
  store.completeCognitivePulseInitiation = (id, input) => ({ id, decision: input.decision });
  store.deferCognitivePulse = () => { deferred++; return { initiation: { audit: { complete_chain_verified: true } } }; };
  store.recordCognitivePulseResult = () => { recordedResult++; return { id: pulse.id, audit: { complete_chain_verified: true } }; };
  store.recordCognitivePulseFailure = () => null;
  const priorMode = process.env.COGNITIVE_PULSE_INITIATION_MODE;
  const priorModel = process.env.COGNITIVE_PULSE_MODEL;
  process.env.COGNITIVE_PULSE_INITIATION_MODE = 'endogenous'; process.env.COGNITIVE_PULSE_MODEL = 'test-model';
  try {
    let calls = 0;
    const waitResult = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++;
      return { data: { id: 'wait-runtime-provider', model: 'test-model', usage: {}, content: [{ type: 'text', text: JSON.stringify(decision(packet, 'wait')) }] } };
    } });
    assert.equal(waitResult.reason, 'endogenously_deferred');
    assert.equal(calls, 1); assert.equal(deferred, 1); assert.equal(recordedResult, 0);

    calls = 0; deferred = 0;
    const thinkResult = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++;
      return calls === 1
        ? { data: { id: 'think-runtime-provider', model: 'test-model', usage: {}, content: [{ type: 'text', text: JSON.stringify(decision(packet, 'think')) }] } }
        : { data: { id: 'pulse-runtime-provider', model: 'test-model', usage: {}, content: [{ type: 'text', text: '{}' }] } };
    } });
    assert.equal(thinkResult.ran, true);
    assert.equal(calls, 2); assert.equal(deferred, 0); assert.equal(recordedResult, 1);
  } finally {
    store.prepareCognitivePulse = originals.prepare; store.beginCognitivePulseInitiation = originals.begin;
    store.completeCognitivePulseInitiation = originals.complete; store.deferCognitivePulse = originals.defer;
    store.recordCognitivePulseResult = originals.result; store.recordCognitivePulseFailure = originals.failure;
    if (priorMode == null) delete process.env.COGNITIVE_PULSE_INITIATION_MODE; else process.env.COGNITIVE_PULSE_INITIATION_MODE = priorMode;
    if (priorModel == null) delete process.env.COGNITIVE_PULSE_MODEL; else process.env.COGNITIVE_PULSE_MODEL = priorModel;
  }
});

test('the background runtime applies randomized deidentified and schedule-only initiation policies', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { prepare: store.prepareCognitivePulse, policy: store.cognitiveInitiationPolicyForPulse,
    begin: store.beginCognitivePulseInitiation, complete: store.completeCognitivePulseInitiation,
    defer: store.deferCognitivePulse, result: store.recordCognitivePulseResult, failure: store.recordCognitivePulseFailure };
  const pulse = { id: 'applied-runtime-pulse', input_commitment: pulseProtocol.commitment('applied-runtime'),
    cognitive_initiation_policy_study_id: 'applied-runtime-study', cognitive_initiation_policy_item_id: 'applied-runtime-item',
    input_packet: { captured_at: '2026-07-13T16:00:00.000Z', endogenous_tick: 2,
      evidence: [{ ref: { type: 'commitment', id: 'applied-runtime-evidence' }, summary: 'Applied policy evidence.', activation: 0.8 }],
      self_model_candidates: [], predecessor: null, constraints: { protocol_version: 4, actionless: true, no_tools: true } } };
  let policy; let begunBinding = null; let deferred = 0; let recorded = 0;
  store.prepareCognitivePulse = () => ({ prepared: true, pulse });
  store.cognitiveInitiationPolicyForPulse = () => policy;
  store.beginCognitivePulseInitiation = (id, input) => { begunBinding = input.binding;
    return { id: 'applied-runtime-gate', packet: initiationProtocol.buildPacket(pulse, { binding: input.binding }) }; };
  store.completeCognitivePulseInitiation = (id, input) => ({ id, decision: input.decision });
  store.deferCognitivePulse = () => { deferred++; return { initiation: { audit: { complete_chain_verified: true } } }; };
  store.recordCognitivePulseResult = () => { recorded++; return { id: pulse.id, audit: { complete_chain_verified: true } }; };
  store.recordCognitivePulseFailure = () => null;
  try {
    policy = { study_id: 'applied-runtime-study', item_id: 'applied-runtime-item',
      condition: 'deidentified_policy', binding: 'deidentified', schedule_only: false };
    let calls = 0;
    const waitResult = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++; const packet = initiationProtocol.buildPacket(pulse, { binding: 'deidentified' });
      return { data: { id: 'applied-runtime-deidentified-gate', model: 'test-model', usage: {},
        content: [{ type: 'text', text: JSON.stringify(decision(packet, 'wait')) }] } };
    } });
    assert.equal(waitResult.reason, 'applied_policy_deferred'); assert.equal(begunBinding, 'deidentified');
    assert.equal(calls, 1); assert.equal(deferred, 1); assert.equal(recorded, 0);

    policy = { study_id: 'applied-runtime-study', item_id: 'applied-runtime-item',
      condition: 'schedule_only_policy', binding: null, schedule_only: true };
    begunBinding = null; calls = 0; deferred = 0;
    const scheduleResult = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++; return { data: { id: 'applied-runtime-schedule-pulse', model: 'test-model', usage: {}, content: [{ type: 'text', text: '{}' }] } };
    } });
    assert.equal(scheduleResult.ran, true); assert.equal(calls, 1); assert.equal(begunBinding, null);
    assert.equal(deferred, 0); assert.equal(recorded, 1);
  } finally {
    store.prepareCognitivePulse = originals.prepare; store.cognitiveInitiationPolicyForPulse = originals.policy;
    store.beginCognitivePulseInitiation = originals.begin; store.completeCognitivePulseInitiation = originals.complete;
    store.deferCognitivePulse = originals.defer; store.recordCognitivePulseResult = originals.result;
    store.recordCognitivePulseFailure = originals.failure;
  }
});
