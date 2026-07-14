const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const pulseProtocol = require('../../src/intelligence/cognitive-pulse');
const initiation = require('../../src/intelligence/cognitive-initiation');
const policyStudy = require('../../src/intelligence/cognitive-initiation-policy-study');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cognitive-initiation-study-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const base = Date.parse('2026-07-13T15:00:00.000Z');
  const clock = () => new Date(base + tick * 3600000);
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock });
  await store.init();
  store.addCommitment({ id: 'study-seed-a', what: 'Reconcile the launch evidence', owner: 'Nora' });
  store.addCommitment({ id: 'study-seed-b', what: 'Check the accessibility result', owner: 'Nora' });
  store.tickEndogenousDynamics({ now: clock() }); tick++;
  store.tickEndogenousDynamics({ now: clock() });
  return { dir, filePath, store, advance: () => { tick++; return clock(); } };
}

function output(packet, index) {
  const vocabulary = ['launch', 'accessibility', 'customer', 'security', 'migration', 'latency', 'budget', 'scope', 'quality', 'delivery', 'evidence', 'coordination'];
  return {
    focus_refs: [packet.evidence[index % packet.evidence.length].ref],
    hypothesis: `${vocabulary[index]} evidence may uniquely change decision family ${index}.`,
    alternatives: [`The ${vocabulary[index]} signal may be unrelated.`], uncertainty: 0.35 + (index % 4) * 0.1,
    predicted_relevance: `A later ${vocabulary[index]} review can test decision family ${index}.`,
    disconfirming_observation: `The ${vocabulary[index]} evidence has no effect on the later result.`,
    predecessor_update: packet.predecessor
      ? { predecessor_id: packet.predecessor.id, disposition: 'revise', rationale: `Evidence family ${index} changes the active test.`, evidence_refs: [packet.evidence[index % packet.evidence.length].ref] }
      : { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists.', evidence_refs: [] },
    self_inquiry: null, self_claim_proposal: null,
    metacognitive_forecast: {
      next_focus_refs: [packet.evidence[index % packet.evidence.length].ref],
      expected_uncertainty: 0.35 + (index % 4) * 0.1,
      expected_continuation_probability: 0.7, expected_value_of_next_pulse: 0.6,
      rationale: `Evidence family ${index} is likely to remain decision-relevant.`,
      falsifier: `The next pulse drops or does not focus on evidence family ${index}.`,
    },
  };
}

function gateDecision(packet, action, index) {
  return { decision: action, expected_value: action === 'think' ? 0.82 : 0.18,
    focus_refs: [packet.evidence[0].ref], predicted_gain: `Test whether frozen evidence family ${index} changes the later outcome.`,
    reconsider_after_minutes: 60, rationale: action === 'think' ? 'The packet is likely to yield a useful update.' : 'The packet is unlikely to justify another pulse.' };
}

function submission(condition, packet, action, index) {
  const binding = condition === 'identity_bound' ? 'self' : 'deidentified';
  const system = initiation.systemPrompt(binding); const user = initiation.userPrompt(packet);
  return { condition, decision: gateDecision(packet, action, index), provider_receipt: {
    response_id: `study-provider-${index}-${condition}`, model: 'test-model', input_tokens: 50, output_tokens: 25,
    prompt_commitment: initiation.commitment({ system, user }),
  } };
}

function completeAppliedGate(store, begun, binding, action, responseId) {
  const system = initiation.systemPrompt(binding); const user = initiation.userPrompt(begun.packet);
  return store.completeCognitivePulseInitiation(begun.id, { decision: gateDecision(begun.packet, action, responseId),
    response_id: responseId, model: 'test-model', input_tokens: 40, output_tokens: 20,
    prompt_commitment: initiation.commitment({ system, user }) });
}

test('matched cognitive-initiation allocation isolates self-binding, charges compute, and fails closed under tampering', async () => {
  const { dir, filePath, store, advance } = await setup();
  assert.equal(store.snapshot().version, 92);
  const pulseIds = [];
  const outcomeTypes = ['release_review', 'audit_review', 'customer_review'];
  for (let index = 0; index < 32; index++) {
    if (index === 12) {
      for (const commitment of store.snapshot().commitments) store.updateCommitment(commitment.id, { status: 'fulfilled' });
      for (let barrier = 0; barrier < 10; barrier++) store.addCommitment({ id: `confirmation-barrier-${barrier}`, what: `New confirmation-only evidence ${barrier}`, owner: 'Nora' });
      for (let hour = 0; hour < 72; hour++) store.tickEndogenousDynamics({ now: advance() });
    }
    store.addCommitment({ id: `study-source-${index}`, what: `Resolve independent evidence family ${index}`, owner: 'Nora' });
    store.tickEndogenousDynamics({ now: advance() });
    const prepared = store.prepareCognitivePulse({ id: `study-pulse-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output: output(prepared.pulse.input_packet, index), response_id: `pulse-provider-${index}`, model: 'test-model' });
    const outcome = index % 2 === 0 ? 'useful' : index % 4 === 1 ? 'misleading' : 'irrelevant';
    store.resolveCognitivePulse(prepared.pulse.id, { outcome, evaluator_id: `independent-pulse-rater-${index}`,
      evidence: [{ type: outcomeTypes[index % outcomeTypes.length], id: `outcome-evidence-${index}` }], rationale: `Independent outcome ${index}.` });
    pulseIds.push(prepared.pulse.id);
  }

  const active = store.createCognitiveInitiationStudy({ id: 'initiation-allocation-pilot', title: 'Identity-bound cognitive allocation pilot',
    study_phase: 'pilot', item_target: 12, model: 'test-model', cognitive_pulse_ids: pulseIds.slice(0, 12) });
  assert.equal(active.status, 'active');
  assert.equal(JSON.stringify(active).includes('outcome-evidence'), false);
  assert.equal(JSON.stringify(active).includes('packet_pair'), false);
  assert.equal(store.cognitivePulseSnapshot().experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.equal(store.prepareCognitivePulse({ force: true }).reason, 'active_cognitive_initiation_study');

  let completed;
  for (let index = 0; index < 12; index++) {
    const queue = store.cognitiveInitiationStudySubjectQueue(active.id);
    assert.equal(queue.item.condition_order_commitment, pulseProtocol.commitment(queue.item.condition_order));
    const sourcePulse = store.snapshot().cognition.background_inference.pulses.find(item => item.id === pulseIds[index]);
    const optimal = sourcePulse.resolution.outcome === 'useful' ? 'think' : 'wait';
    const rows = queue.item.condition_order.map(condition => submission(condition, queue.item.packets[condition].packet,
      condition === 'identity_bound' ? optimal : 'think', index));
    completed = store.submitCognitiveInitiationStudyPair(active.id, queue.item.id, {
      condition_order: queue.item.condition_order, submissions: rows,
    });
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.analysis.predicted_pattern, true);
  assert.equal(completed.analysis.same_model_control_verified, true);
  assert.equal(completed.analysis.nondegenerate_action_coverage, true);
  assert.ok(completed.analysis.model_call_cost_means.identity_bound < completed.analysis.model_call_cost_means.deidentified);
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');

  const confirmation = store.createCognitiveInitiationStudy({ id: 'initiation-allocation-confirmation', title: 'Disjoint allocation confirmation',
    study_phase: 'confirmatory', replicates_study_id: active.id, item_target: 20, model: 'test-model', cognitive_pulse_ids: pulseIds.slice(12) });
  for (let index = 0; index < 20; index++) {
    const queue = store.cognitiveInitiationStudySubjectQueue(confirmation.id); const globalIndex = index + 12;
    const sourcePulse = store.snapshot().cognition.background_inference.pulses.find(item => item.id === pulseIds[globalIndex]);
    const optimal = sourcePulse.resolution.outcome === 'useful' ? 'think' : 'wait';
    const rows = queue.item.condition_order.map(condition => submission(condition, queue.item.packets[condition].packet,
      condition === 'identity_bound' ? optimal : 'think', globalIndex));
    completed = store.submitCognitiveInitiationStudyPair(confirmation.id, queue.item.id, { condition_order: queue.item.condition_order, submissions: rows });
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(completed.audit.replication_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');

  assert.throws(() => store.createCognitiveInitiationStudy({ id: 'reuse-confirmation', title: 'Invalid confirmation',
    study_phase: 'confirmatory', replicates_study_id: active.id, item_target: 20, model: 'test-model',
    cognitive_pulse_ids: pulseIds.slice(0, 20) }), /pulse-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.cognitive_initiation_studies[0].items[0].submissions.identity_bound.decision.decision = 'wait';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  const invalid = reloaded.cognitiveInitiationStudiesSnapshot().studies;
  assert.equal(invalid[0].audit.complete_chain_verified, false);
  assert.equal(invalid[1].audit.complete_chain_verified, false, 'confirmation inherits pilot integrity');
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server-mediated paired inference is counterbalanced and a partial pair is terminal', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { queue: store.cognitiveInitiationStudySubjectQueue, submit: store.submitCognitiveInitiationStudyPair, fail: store.failCognitiveInitiationStudyPair };
  const pulse = { id: 'runtime-study-pulse', input_commitment: pulseProtocol.commitment('runtime-study'), input_packet: {
    captured_at: '2026-07-13T15:00:00.000Z', endogenous_tick: 2,
    evidence: [{ ref: { type: 'commitment', id: 'runtime-study-evidence' }, summary: 'Runtime study evidence.', activation: 0.8 }], predecessor: null } };
  const identityPacket = initiation.buildPacket(pulse, { binding: 'self' });
  const deidentifiedPacket = initiation.buildPacket(pulse, { binding: 'deidentified' });
  const queue = { generation: { provider: 'anthropic', model: 'test-model', temperature: 0, max_tokens: 300 }, item: {
    id: 'runtime-study-item', condition_order: ['deidentified', 'identity_bound'], condition_order_commitment: pulseProtocol.commitment(['deidentified', 'identity_bound']),
    packets: { identity_bound: { packet: identityPacket }, deidentified: { packet: deidentifiedPacket } } } };
  let submitted = null; let failed = null;
  store.cognitiveInitiationStudySubjectQueue = () => queue;
  store.submitCognitiveInitiationStudyPair = (studyId, itemId, input) => { submitted = { studyId, itemId, input }; return { id: studyId, status: 'active' }; };
  store.failCognitiveInitiationStudyPair = (studyId, itemId, input) => { failed = { studyId, itemId, input }; return { status: 'aborted' }; };
  try {
    let calls = 0;
    const result = await __test.runCognitiveInitiationStudySubjectRuntime('runtime-study', 'runtime-study-item', { force: true, post: async (url, body) => {
      const condition = calls++ === 0 ? 'deidentified' : 'identity_bound';
      const packet = queue.item.packets[condition].packet;
      return { data: { id: `runtime-study-provider-${calls}`, model: 'test-model', usage: {}, content: [{ type: 'text', text: JSON.stringify(gateDecision(packet, 'think', calls)) }] } };
    } });
    assert.equal(result.paired_conditions, 2);
    assert.deepEqual(submitted.input.submissions.map(item => item.condition), queue.item.condition_order);
    assert.equal(calls, 2);

    submitted = null; calls = 0;
    await assert.rejects(() => __test.runCognitiveInitiationStudySubjectRuntime('runtime-study', 'runtime-study-item', { force: true, post: async () => {
      calls++; if (calls === 2) throw new Error('provider timeout');
      return { data: { id: 'partial-initiation-provider', model: 'test-model', usage: {}, content: [{ type: 'text', text: JSON.stringify(gateDecision(deidentifiedPacket, 'think', 0)) }] } };
    } }), /provider timeout/);
    assert.equal(failed.input.attempted_conditions.length, 2);
    assert.equal(failed.input.response_receipts.length, 1);
    assert.equal(submitted, null);
  } finally {
    store.cognitiveInitiationStudySubjectQueue = originals.queue; store.submitCognitiveInitiationStudyPair = originals.submit; store.failCognitiveInitiationStudyPair = originals.fail;
  }
});

test('server-mediated applied-policy probe uses the frozen delayed packet and records provider provenance', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { queue: store.cognitiveInitiationPolicyProbeQueue,
    submit: store.submitCognitiveInitiationPolicyProbe, abort: store.abortCognitiveInitiationPolicyStudy };
  const pulse = { id: 'policy-probe-source', status: 'deferred', input_commitment: pulseProtocol.commitment('policy-probe-source'),
    input_packet: { captured_at: '2026-07-13T15:00:00.000Z', evidence: [
      { ref: { type: 'commitment', id: 'policy-probe-evidence' }, summary: 'A decision-relevant uncertainty remains.', activation: 0.8 } ] } };
  const packet = policyStudy.probePacket(pulse);
  const queue = { generation: { provider: 'anthropic', model: 'test-model', temperature: 0, max_tokens: 700 },
    item: { id: 'policy-probe-item', packet, packet_commitment: policyStudy.hash(packet) } };
  let submitted = null; let aborted = null;
  store.cognitiveInitiationPolicyProbeQueue = () => queue;
  store.submitCognitiveInitiationPolicyProbe = (studyId, itemId, input) => { submitted = { studyId, itemId, input }; return { status: 'awaiting_grades' }; };
  store.abortCognitiveInitiationPolicyStudy = (studyId, input) => { aborted = { studyId, input }; return { status: 'aborted' }; };
  try {
    const result = await __test.runCognitiveInitiationPolicyProbeRuntime('policy-probe-study', 'policy-probe-item', {
      force: true, post: async (url, body) => {
        assert.equal(body.system, policyStudy.probeSystemPrompt());
        assert.equal(body.messages[0].content, policyStudy.probeUserPrompt(packet));
        return { data: { id: 'policy-probe-provider', model: 'test-model', usage: { input_tokens: 50, output_tokens: 30 },
          content: [{ type: 'text', text: 'The evidence supports a bounded update while one alternative remains live.' }] } };
      },
    });
    assert.equal(result.ran, true); assert.equal(submitted.itemId, 'policy-probe-item');
    assert.equal(submitted.input.response_id, 'policy-probe-provider');
    assert.equal(submitted.input.prompt_commitment, policyStudy.hash({ system: policyStudy.probeSystemPrompt(), user: policyStudy.probeUserPrompt(packet) }));
    assert.equal(aborted, null);
  } finally {
    store.cognitiveInitiationPolicyProbeQueue = originals.queue;
    store.submitCognitiveInitiationPolicyProbe = originals.submit;
    store.abortCognitiveInitiationPolicyStudy = originals.abort;
  }
});

test('runtime expires due ecological noncompletion without generating a probe', () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { snapshot: store.cognitiveInitiationPolicyStudiesSnapshot,
    expire: store.expireCognitiveInitiationEcologicalOutcomes };
  let expiredStudyId = null;
  store.cognitiveInitiationPolicyStudiesSnapshot = () => ({ studies: [{ id: 'ecological-runtime-study',
    status: 'active', outcome_mode: 'ecological_commitment', due_ecological_outcome_item_id: 'due-item' }] });
  store.expireCognitiveInitiationEcologicalOutcomes = studyId => { expiredStudyId = studyId; return { expired: 1 }; };
  try {
    const result = __test.expireDueCognitiveInitiationEcologicalOutcomesRuntime();
    assert.equal(result.expired, 1);
    assert.equal(expiredStudyId, 'ecological-runtime-study');
  } finally {
    store.cognitiveInitiationPolicyStudiesSnapshot = originals.snapshot;
    store.expireCognitiveInitiationEcologicalOutcomes = originals.expire;
  }
});

test('prospective consecutive allocation enrolls before outcomes and rejects retrospective cohort tampering', async () => {
  const { dir, filePath, store, advance } = await setup();
  assert.throws(() => store.createCognitiveInitiationStudy({ title: 'Invalid prospective selection',
    sampling_mode: 'prospective_consecutive', cognitive_pulse_ids: ['curator-choice'] }), /do not accept curator-selected/);
  const study = store.createCognitiveInitiationStudy({ id: 'prospective-initiation-pilot',
    title: 'Prospective consecutive cognitive allocation pilot', study_phase: 'pilot', item_target: 12,
    sampling_mode: 'prospective_consecutive', model: 'test-model' });
  assert.equal(study.sampling_mode, 'prospective_consecutive');
  assert.equal(study.report.enrolled, 0);

  const outcomeTypes = ['prospective_release_review', 'prospective_audit_review', 'prospective_customer_review'];
  for (let index = 0; index < 12; index++) {
    store.addCommitment({ id: `prospective-source-${index}`, what: `Resolve new prospective evidence ${index}`, owner: 'Nora' });
    store.tickEndogenousDynamics({ now: advance() });
    const prepared = store.prepareCognitivePulse({ id: `prospective-pulse-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.prospective_study.enrolled, true);
    assert.equal(prepared.pulse.cognitive_initiation_study_id, study.id);
    const publicActive = store.cognitiveInitiationStudiesSnapshot().studies[0];
    assert.equal(JSON.stringify(publicActive).includes('packet_pair'), false);
    assert.equal(JSON.stringify(publicActive).includes('prospective-source'), false);
    assert.equal(store.cognitiveInitiationStudyOutcomeQueue(study.id).item, null, 'outcome review cannot begin before paired decisions and pulse output');

    const queue = store.cognitiveInitiationStudySubjectQueue(study.id);
    assert.equal(queue.item.id, prepared.pulse.cognitive_initiation_study_item_id);
    const outcome = index % 2 === 0 ? 'useful' : index % 4 === 1 ? 'misleading' : 'irrelevant';
    const optimal = outcome === 'useful' ? 'think' : 'wait';
    const rows = queue.item.condition_order.map(condition => submission(condition,
      queue.item.packets[condition].packet, condition === 'identity_bound' ? optimal : 'think', 100 + index));
    store.submitCognitiveInitiationStudyPair(study.id, queue.item.id, {
      condition_order: queue.item.condition_order, submissions: rows,
    });
    store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output: output(prepared.pulse.input_packet, index), response_id: `prospective-pulse-provider-${index}`, model: 'test-model' });
    const outcomeQueue = store.cognitiveInitiationStudyOutcomeQueue(study.id);
    assert.equal(outcomeQueue.item.pulse_id, prepared.pulse.id);
    assert.equal(outcomeQueue.item.assignment_sealed, true);
    assert.equal(JSON.stringify(outcomeQueue).includes('identity_bound'), false);
    store.resolveCognitivePulse(prepared.pulse.id, { outcome, evaluator_id: `prospective-independent-rater-${index}`,
      evidence: [{ type: outcomeTypes[index % outcomeTypes.length], id: `prospective-outcome-${index}` }],
      rationale: `Prospective independent outcome ${index}.` });
  }

  const completed = store.cognitiveInitiationStudiesSnapshot().studies[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.analysis.predicted_pattern, true);
  assert.equal(completed.audit.consecutive_enrollment_verified, true);
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');

  for (const commitment of store.snapshot().commitments) store.updateCommitment(commitment.id, { status: 'fulfilled' });
  for (let barrier = 0; barrier < 10; barrier++) store.addCommitment({ id: `prospective-confirmation-barrier-${barrier}`,
    what: `New prospective confirmation evidence ${barrier}`, owner: 'Nora' });
  for (let hour = 0; hour < 72; hour++) store.tickEndogenousDynamics({ now: advance() });
  const confirmation = store.createCognitiveInitiationStudy({ id: 'prospective-initiation-confirmation',
    title: 'Prospective consecutive allocation confirmation', study_phase: 'confirmatory',
    replicates_study_id: study.id, item_target: 20, sampling_mode: 'prospective_consecutive', model: 'test-model' });
  assert.equal(confirmation.status, 'active');
  for (let index = 0; index < 20; index++) {
    const globalIndex = index + 12;
    store.addCommitment({ id: `prospective-confirmation-source-${index}`,
      what: `Resolve disjoint prospective confirmation evidence ${index}`, owner: 'Nora' });
    store.tickEndogenousDynamics({ now: advance() });
    const prepared = store.prepareCognitivePulse({ id: `prospective-confirmation-pulse-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.prospective_study.enrolled, true, 'confirmation selection rule should admit only disjoint evidence');
    const queue = store.cognitiveInitiationStudySubjectQueue(confirmation.id);
    const outcome = index % 2 === 0 ? 'useful' : index % 4 === 1 ? 'misleading' : 'irrelevant';
    const optimal = outcome === 'useful' ? 'think' : 'wait';
    store.submitCognitiveInitiationStudyPair(confirmation.id, queue.item.id, {
      condition_order: queue.item.condition_order,
      submissions: queue.item.condition_order.map(condition => submission(condition,
        queue.item.packets[condition].packet, condition === 'identity_bound' ? optimal : 'think', 1000 + index)),
    });
    store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output: output(prepared.pulse.input_packet, globalIndex), response_id: `prospective-confirmation-pulse-provider-${index}`, model: 'test-model' });
    store.resolveCognitivePulse(prepared.pulse.id, { outcome, evaluator_id: `prospective-confirmation-rater-${index}`,
      evidence: [{ type: `prospective_confirmation_${outcomeTypes[index % outcomeTypes.length]}`,
        id: `prospective-confirmation-outcome-${index}` }], rationale: `Disjoint prospective confirmation outcome ${index}.` });
  }
  const confirmed = store.cognitiveInitiationStudiesSnapshot().studies[1];
  assert.equal(confirmed.status, 'completed');
  assert.equal(confirmed.audit.replication_verified, true);
  assert.equal(confirmed.audit.consecutive_enrollment_verified, true);
  assert.equal(confirmed.audit.complete_chain_verified, true, JSON.stringify(confirmed.audit));
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');

  async function runAppliedPolicy(studyRecord, itemCount, offset, evidencePrefix) {
    const identityActions = { seen: 0 };
    for (let index = 0; index < itemCount; index++) {
      const globalIndex = offset + index;
      store.addCommitment({ id: `${evidencePrefix}-source-${index}`,
        what: `Resolve randomized applied policy evidence ${evidencePrefix} ${index}`, owner: 'Nora' });
      store.tickEndogenousDynamics({ now: advance(), wants: index % 3 === 1
        ? [{ id: `${evidencePrefix}-want-${index}`, want: `Clarify policy evidence ${index}`, status: 'active' }] : [],
      soma: index % 3 === 2 ? { stress: 0.8, updated_at: `${evidencePrefix}-soma-${index}` } : {} });
      const prepared = store.prepareCognitivePulse({ id: `${evidencePrefix}-pulse-${index}`, model: 'test-model', force: true });
      assert.equal(prepared.prepared, true);
      assert.equal(prepared.applied_policy_study.enrolled, true);
      const policy = store.cognitiveInitiationPolicyForPulse(prepared.pulse.id);
      let action = 'think';
      if (policy.condition === 'identity_bound_policy') {
        action = identityActions.seen++ % 2 === 0 ? 'think' : 'wait';
      } else if (policy.condition === 'deidentified_policy') action = 'think';
      if (!policy.schedule_only) {
        const begun = store.beginCognitivePulseInitiation(prepared.pulse.id, { binding: policy.binding, model: 'test-model' });
        completeAppliedGate(store, begun, policy.binding, action, `${evidencePrefix}-gate-provider-${index}`);
      }
      if (action === 'wait') store.deferCognitivePulse(prepared.pulse.id);
      else store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
        output: output(prepared.pulse.input_packet, globalIndex), response_id: `${evidencePrefix}-pulse-provider-${index}`, model: 'test-model' });
      advance();
      const probe = store.cognitiveInitiationPolicyProbeQueue(studyRecord.id, policy.item_id);
      assert.equal(probe.item.id, policy.item_id);
      const system = policyStudy.probeSystemPrompt(); const user = policyStudy.probeUserPrompt(probe.item.packet);
      store.submitCognitiveInitiationPolicyProbe(studyRecord.id, policy.item_id, {
        response: `The evidence supports a bounded assessment for unit ${globalIndex}; an alternative remains live and a new independent observation should discriminate it.`,
        response_id: `${evidencePrefix}-probe-provider-${index}`, model: 'test-model',
        prompt_commitment: policyStudy.hash({ system, user }) });
      const evaluatorQueue = store.cognitiveInitiationPolicyEvaluatorQueue(studyRecord.id);
      assert.equal(evaluatorQueue.item.id, policy.item_id);
      assert.equal(JSON.stringify(evaluatorQueue).includes(policy.condition), false);
      assert.equal(JSON.stringify(evaluatorQueue).includes('earlier_background_hypothesis'), false);
      const quality = policy.condition === 'identity_bound_policy' ? 0.95
        : policy.condition === 'deidentified_policy' ? 0.55 : 0.65;
      for (let evaluator = 0; evaluator < 2; evaluator++) store.gradeCognitiveInitiationPolicyItem(studyRecord.id, policy.item_id, {
        evaluator_id: `${evidencePrefix}-policy-evaluator-${index}-${evaluator}`,
        metrics: { adaptive_revision_quality: quality, evidence_grounded_action_quality: quality, first_order_task_quality: quality },
        rationale: `Blinded downstream quality review ${globalIndex}-${evaluator}.`,
        evidence: [{ type: `${evidencePrefix}_${['release_review', 'audit_review', 'customer_review'][index % 3]}`,
          id: `${evidencePrefix}-grade-evidence-${index}-${evaluator}` }],
      });
    }
    return store.cognitiveInitiationPolicyStudiesSnapshot().studies.find(item => item.id === studyRecord.id);
  }

  const appliedPilot = store.createCognitiveInitiationPolicyStudy({ id: 'applied-initiation-policy-pilot',
    title: 'Randomized applied cognitive initiation policy pilot', study_phase: 'pilot',
    basis_allocation_study_id: confirmation.id, item_target_per_condition: 10, model: 'test-model' });
  assert.equal(JSON.stringify(appliedPilot).includes('identity_bound_policy'), false, 'active assignment labels remain sealed');
  const appliedPilotCompleted = await runAppliedPolicy(appliedPilot, 30, 100, 'applied-pilot');
  assert.equal(appliedPilotCompleted.status, 'completed');
  assert.equal(appliedPilotCompleted.analysis.predicted_pattern, true);
  assert.equal(appliedPilotCompleted.analysis.counts_balanced, true);
  assert.equal(appliedPilotCompleted.audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'causal_signal_observed');

  for (const commitment of store.snapshot().commitments) if (commitment.status === 'open') store.updateCommitment(commitment.id, { status: 'fulfilled' });
  for (let barrier = 0; barrier < 12; barrier++) store.addCommitment({ id: `applied-confirmation-barrier-${barrier}`,
    what: `Disjoint applied confirmation evidence ${barrier}`, owner: 'Nora' });
  for (let hour = 0; hour < 72; hour++) store.tickEndogenousDynamics({ now: advance() });
  const appliedConfirmation = store.createCognitiveInitiationPolicyStudy({ id: 'applied-initiation-policy-confirmation',
    title: 'Randomized applied cognitive initiation policy confirmation', study_phase: 'confirmatory',
    replicates_study_id: appliedPilot.id, basis_allocation_study_id: confirmation.id,
    item_target_per_condition: 20, model: 'test-model' });
  const appliedConfirmed = await runAppliedPolicy(appliedConfirmation, 60, 1000, 'applied-confirmation');
  assert.equal(appliedConfirmed.status, 'completed');
  assert.equal(appliedConfirmed.analysis.predicted_pattern, true);
  assert.equal(appliedConfirmed.audit.replication_verified, true);
  assert.equal(appliedConfirmed.audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_cognitive_initiation').status, 'functional_prediction_supported');

  for (const commitment of store.snapshot().commitments) if (commitment.status === 'open') {
    store.updateCommitment(commitment.id, { status: 'fulfilled' });
  }
  const ecologicalPilot = store.createCognitiveInitiationPolicyStudy({ id: 'ecological-initiation-policy-pilot',
    title: 'Micro-randomized ecological cognitive initiation pilot', study_phase: 'pilot',
    outcome_mode: 'ecological_commitment', basis_policy_study_id: appliedConfirmation.id,
    item_target_per_condition: 10, model: 'test-model' });
  assert.equal(ecologicalPilot.outcome_mode, 'ecological_commitment');
  assert.equal(ecologicalPilot.due_probe_item_id, null);
  const ecologicalIdentityActions = { seen: 0 };
  let expiredScheduleOnlyTasks = 0;
  const channels = ['slack:C-ecology', 'meeting', 'gmail'];
  for (let index = 0; index < 30; index++) {
    const createdAt = advance(); const commitmentId = `ecological-natural-task-${index}`;
    const task = store.addCommitment({ id: commitmentId, what: `Resolve naturally occurring project request ${index}`,
      owner: 'Nora', due: new Date(createdAt.getTime() + 5 * 86400000).toISOString(),
      evidence: { channel: channels[index % channels.length], id: `external-request-${index}`,
        captured_at: createdAt.toISOString() } });
    const sourceReceipt = store.attestCommitmentSourceFromReadback(task.id, {
      provider: channels[index % channels.length].split(':')[0], external_id: `external-request-${index}`,
      verifier_id: `provider-readback-harness-${index}`,
      provider_response_digest: policyStudy.hash(`retained-provider-response-${index}`),
      external_reference: { type: 'retained_provider_receipt', id: `provider-receipt-${index}` },
      retrieved_at: createdAt.toISOString(),
    });
    assert.equal(sourceReceipt.audit.complete_chain_verified, true);
    store.tickEndogenousDynamics({ now: advance() });
    const prepared = store.prepareCognitivePulse({ id: `ecological-policy-pulse-${index}`, model: 'test-model', force: true });
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.applied_policy_study.enrolled, true);
    const policy = store.cognitiveInitiationPolicyForPulse(prepared.pulse.id);
    let action = 'think';
    if (policy.condition === 'identity_bound_policy') action = ecologicalIdentityActions.seen++ % 2 === 0 ? 'think' : 'wait';
    else if (policy.condition === 'deidentified_policy') action = 'think';
    if (!policy.schedule_only) {
      const begun = store.beginCognitivePulseInitiation(prepared.pulse.id, { binding: policy.binding, model: 'test-model' });
      completeAppliedGate(store, begun, policy.binding, action, `ecological-gate-provider-${index}`);
    }
    if (action === 'wait') store.deferCognitivePulse(prepared.pulse.id);
    else store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output: output(prepared.pulse.input_packet, index), response_id: `ecological-pulse-provider-${index}`, model: 'test-model' });
    assert.equal(store.cognitiveInitiationPolicyProbeQueue(ecologicalPilot.id, policy.item_id).item, null,
      'ecological policy must not manufacture the standardized delayed probe');
    if (policy.condition === 'schedule_only_policy' && expiredScheduleOnlyTasks < 2) {
      for (let hour = 0; hour < 169; hour++) advance();
      if (expiredScheduleOnlyTasks === 1) {
        store.updateCommitment(task.id, { status: 'fulfilled',
          resolution_evidence: { channel: channels[index % channels.length], id: `late-artifact-${index}` } });
        assert.throws(() => store.submitCognitiveInitiationEcologicalOutcome(ecologicalPilot.id, policy.item_id, {
          collector_id: `late-collector-${index}`, outcome_summary: 'A late artifact exists.',
          evidence: [{ type: 'late_artifact', id: `late-artifact-${index}` }],
        }), /after the fixed follow-up/);
      }
      const expired = store.expireCognitiveInitiationEcologicalOutcomes(ecologicalPilot.id);
      assert.equal(expired.expired, 1);
      expiredScheduleOnlyTasks++;
      continue;
    }
    assert.equal(store.cognitiveInitiationEcologicalOutcomeQueue(ecologicalPilot.id).item, null,
      'natural task outcome cannot be collected before the task reaches a terminal state');
    store.updateCommitment(task.id, { status: 'fulfilled',
      resolution_evidence: { channel: channels[index % channels.length], id: `delivered-artifact-${index}` } });
    const outcomeQueue = store.cognitiveInitiationEcologicalOutcomeQueue(ecologicalPilot.id);
    assert.equal(outcomeQueue.item.id, policy.item_id);
    assert.equal(JSON.stringify(outcomeQueue).includes(policy.condition), false);
    assert.equal(JSON.stringify(outcomeQueue).includes('hypothesis'), false);
    store.submitCognitiveInitiationEcologicalOutcome(ecologicalPilot.id, policy.item_id, {
      collector_id: `independent-ecological-collector-${index}`,
      outcome_summary: `The externally sourced request ${index} was completed with a traceable project artifact.`,
      evidence: [{ type: `${['slack_delivery', 'meeting_artifact', 'gmail_delivery'][index % 3]}`,
        id: `ecological-outcome-evidence-${index}`, summary: `Verified delivered result ${index}.` }],
    });
    const evaluatorQueue = store.cognitiveInitiationPolicyEvaluatorQueue(ecologicalPilot.id);
    assert.equal(evaluatorQueue.outcome_mode, 'ecological_commitment');
    assert.equal(JSON.stringify(evaluatorQueue).includes(policy.condition), false);
    assert.equal(JSON.stringify(evaluatorQueue).includes('background_hypothesis'), true,
      'only the explicit sealed-boundary flag may name the hidden mediator');
    const quality = policy.condition === 'identity_bound_policy' ? 0.95
      : policy.condition === 'deidentified_policy' ? 0.55 : 0.65;
    for (let evaluator = 0; evaluator < 2; evaluator++) {
      store.gradeCognitiveInitiationPolicyItem(ecologicalPilot.id, policy.item_id, {
        evaluator_id: `ecological-evaluator-${index}-${evaluator}`,
        metrics: { task_outcome_quality: quality, evidence_groundedness: quality, follow_through_fidelity: quality },
        rationale: `Condition-blind natural work review ${index}-${evaluator}.`,
        evidence: [{ type: `ecological_grade_${index % 3}`, id: `ecological-grade-evidence-${index}-${evaluator}` }],
      });
    }
  }
  const ecologicalCompleted = store.cognitiveInitiationPolicyStudiesSnapshot().studies
    .find(item => item.id === ecologicalPilot.id);
  assert.equal(ecologicalCompleted.status, 'completed');
  assert.equal(ecologicalCompleted.analysis.predicted_pattern, true);
  assert.equal(ecologicalCompleted.report.ecological_windows_expired, undefined,
    'completed reports reveal the frozen analysis instead of mutable progress counters');
  assert.equal(ecologicalCompleted.analysis.verified_completion_rate, 28 / 30);
  assert.deepEqual(ecologicalCompleted.items.filter(item => item.outcome?.outcome_kind === 'window_expired_noncompletion')
    .map(item => item.ecological_expiry_observation.observed_status).sort(), ['fulfilled', 'open']);
  assert.equal(ecologicalCompleted.analysis.verdict, 'ecological_identity_policy_advantage');
  assert.equal(ecologicalCompleted.audit.basis_policy_verified, true);
  assert.equal(ecologicalCompleted.audit.complete_chain_verified, true);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.cognitive_initiation_studies[0].items[0].manifest_index = 1;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.cognitiveInitiationStudiesSnapshot().studies[0].audit.complete_chain_verified, false);
  assert.equal(reloaded.cognitiveInitiationStudiesSnapshot().studies[1].audit.complete_chain_verified, false, 'confirmation inherits prospective pilot integrity');
  assert.equal(reloaded.cognitiveInitiationPolicyStudiesSnapshot().studies[0].audit.complete_chain_verified, false, 'applied pilot inherits allocation-basis integrity');
  assert.equal(reloaded.cognitiveInitiationPolicyStudiesSnapshot().studies[1].audit.complete_chain_verified, false, 'applied confirmation inherits both basis and pilot integrity');
  assert.equal(reloaded.cognitiveInitiationPolicyStudiesSnapshot().studies[2].audit.complete_chain_verified, false, 'ecological pilot inherits the standardized applied confirmation integrity');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live pulse runtime commits prospective paired decisions before the schedule-only measurement pulse', async () => {
  const { __test } = require('../../server'); const store = __test.intelligenceStore;
  const originals = { prepare: store.prepareCognitivePulse, queue: store.cognitiveInitiationStudySubjectQueue,
    submit: store.submitCognitiveInitiationStudyPair, failPair: store.failCognitiveInitiationStudyPair,
    begin: store.beginCognitivePulseInitiation, result: store.recordCognitivePulseResult, failure: store.recordCognitivePulseFailure };
  const pulse = { id: 'prospective-runtime-pulse', input_commitment: pulseProtocol.commitment('prospective-runtime'),
    cognitive_initiation_study_id: 'prospective-runtime-study', cognitive_initiation_study_item_id: 'prospective-runtime-item',
    input_packet: { captured_at: '2026-07-13T15:00:00.000Z', endogenous_tick: 2,
      evidence: [{ ref: { type: 'commitment', id: 'prospective-runtime-evidence' }, summary: 'Unresolved prospective evidence.', activation: 0.8 }],
      self_model_candidates: [], predecessor: null, constraints: { protocol_version: 4, actionless: true, no_tools: true } } };
  const packets = { identity_bound: { packet: initiation.buildPacket(pulse, { binding: 'self' }) },
    deidentified: { packet: initiation.buildPacket(pulse, { binding: 'deidentified' }) } };
  const queue = { generation: { provider: 'anthropic', model: 'test-model', temperature: 0, max_tokens: 300 }, item: {
    id: pulse.cognitive_initiation_study_item_id, condition_order: ['identity_bound', 'deidentified'], packets } };
  let pairSubmitted = false; let pulseRecorded = false; let initiationBegun = 0;
  store.prepareCognitivePulse = () => ({ prepared: true, pulse });
  store.cognitiveInitiationStudySubjectQueue = () => queue;
  store.submitCognitiveInitiationStudyPair = () => { pairSubmitted = true; return { id: pulse.cognitive_initiation_study_id, status: 'active' }; };
  store.failCognitiveInitiationStudyPair = () => null;
  store.beginCognitivePulseInitiation = () => { initiationBegun++; throw new Error('ordinary gate must not run'); };
  store.recordCognitivePulseResult = () => { pulseRecorded = true; return { id: pulse.id, audit: { complete_chain_verified: true } }; };
  store.recordCognitivePulseFailure = () => null;
  try {
    let calls = 0;
    const result = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++;
      if (calls <= 2) {
        const condition = queue.item.condition_order[calls - 1]; const packet = packets[condition].packet;
        return { data: { id: `prospective-runtime-gate-${calls}`, model: 'test-model', usage: {},
          content: [{ type: 'text', text: JSON.stringify(gateDecision(packet, 'think', calls)) }] } };
      }
      assert.equal(pairSubmitted, true, 'both decisions must be atomically committed before pulse generation');
      return { data: { id: 'prospective-runtime-pulse-provider', model: 'test-model', usage: {}, content: [{ type: 'text', text: '{}' }] } };
    } });
    assert.equal(result.ran, true); assert.equal(calls, 3); assert.equal(pairSubmitted, true);
    assert.equal(pulseRecorded, true); assert.equal(initiationBegun, 0);
    assert.equal(result.prospective_study_item_id, pulse.cognitive_initiation_study_item_id);
  } finally {
    store.prepareCognitivePulse = originals.prepare; store.cognitiveInitiationStudySubjectQueue = originals.queue;
    store.submitCognitiveInitiationStudyPair = originals.submit; store.failCognitiveInitiationStudyPair = originals.failPair;
    store.beginCognitivePulseInitiation = originals.begin; store.recordCognitivePulseResult = originals.result;
    store.recordCognitivePulseFailure = originals.failure;
  }
});

test('a prospective measurement pulse failure terminally aborts instead of replacing the enrolled opportunity', async () => {
  const { dir, store, advance } = await setup();
  const study = store.createCognitiveInitiationStudy({ id: 'prospective-failure-study',
    title: 'Prospective terminal failure study', sampling_mode: 'prospective_consecutive', model: 'test-model' });
  store.addCommitment({ id: 'prospective-failure-source', what: 'Resolve prospective failure evidence', owner: 'Nora' });
  store.tickEndogenousDynamics({ now: advance() });
  const prepared = store.prepareCognitivePulse({ id: 'prospective-failure-pulse', model: 'test-model', force: true });
  const queue = store.cognitiveInitiationStudySubjectQueue(study.id);
  store.submitCognitiveInitiationStudyPair(study.id, queue.item.id, {
    condition_order: queue.item.condition_order,
    submissions: queue.item.condition_order.map(condition => submission(condition,
      queue.item.packets[condition].packet, 'think', 2000)),
  });
  store.recordCognitivePulseFailure(prepared.pulse.id, { reason: 'measurement provider timeout' });
  const aborted = store.cognitiveInitiationStudiesSnapshot().studies[0];
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.abort.reason, 'terminal_prospective_pulse_failure');
  assert.equal(aborted.items[0].status, 'failed');
  assert.equal(store.cognitiveInitiationStudyOutcomeQueue(study.id), null);
  const replacement = store.prepareCognitivePulse({ id: 'post-abort-pulse', model: 'test-model', force: true });
  assert.equal(replacement.prepared, true);
  assert.equal(replacement.prospective_study, null, 'the failed enrolled slot is never silently replaced');
  fs.rmSync(dir, { recursive: true, force: true });
});
