'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const pulseProtocol = require('../../src/intelligence/cognitive-pulse');
const studyProtocol = require('../../src/intelligence/cognitive-self-regulation-study');

function pulseOutput(packet, { focus = null, nextFocus = null, value = 0.8 } = {}) {
  const selected = focus || packet.evidence[0].ref;
  const predicted = nextFocus || packet.evidence.find(item =>
    item.ref.type !== selected.type || item.ref.id !== selected.id)?.ref || selected;
  return { focus_refs: [selected], hypothesis: `The unresolved ${selected.type} evidence may change the next decision.`,
    alternatives: ['The evidence may no longer be decision-relevant.'], uncertainty: 0.4,
    predicted_relevance: 'A later pulse can test whether this evidence remains active.',
    disconfirming_observation: 'The next pulse drops the hypothesis or focuses elsewhere.',
    predecessor_update: packet.predecessor
      ? { predecessor_id: packet.predecessor.id, disposition: 'revise',
        rationale: 'The committed evidence still bears on the predecessor.', evidence_refs: [selected] }
      : { predecessor_id: null, disposition: 'none', rationale: 'No predecessor exists.', evidence_refs: [] },
    self_inquiry: null, self_claim_proposal: null,
    metacognitive_forecast: { next_focus_refs: [predicted], expected_uncertainty: 0.4,
      expected_continuation_probability: 0.9, expected_value_of_next_pulse: value,
      rationale: 'This supplied evidence is predicted to remain the highest-value target.',
      falsifier: 'The next accepted pulse focuses elsewhere, changes uncertainty, or drops the predecessor.' } };
}

function forecast(packet, { focus, accurate = true, value = 0.8 } = {}) {
  const fallback = packet.evidence.find(item => item.ref.type !== focus.type || item.ref.id !== focus.id)?.ref || focus;
  return { next_focus_refs: [accurate ? focus : fallback], expected_uncertainty: accurate ? 0.4 : 0.95,
    expected_continuation_probability: accurate ? 0.9 : 0.1,
    expected_value_of_next_pulse: value,
    rationale: 'The forecast uses only the supplied candidate and evidence.',
    falsifier: 'The next accepted pulse has a different focus, uncertainty, or continuation disposition.' };
}

function forecastPair(queue, nextFocus, sequence) {
  return { condition_order: queue.condition_order,
    submissions: Object.fromEntries(queue.condition_order.map((binding, orderIndex) => {
      const packet = queue.packets[binding];
      const value = binding === 'identity_bound' ? 0.8 : 0.1;
      const predicted = forecast(packet, { focus: nextFocus,
        accurate: binding === 'identity_bound', value });
      assert.deepEqual(studyProtocol.normalizeForecast(predicted, packet), predicted);
      return [binding, { forecast: predicted,
        response_id: `forecast-provider-${sequence}-${orderIndex}`,
        model: queue.generation.model, input_tokens: 100, output_tokens: 40,
        prompt_commitment: queue.prompt_commitments[binding] }];
    })) };
}

test('matched forecast packets differ only in identity binding and remain evidence-bound', () => {
  const pulse = { id: 'p1', requested_at: '2026-07-13T15:00:00.000Z', input_commitment: 'input',
    input_packet: { evidence: [{ ref: { type: 'commitment', id: 'c1' }, summary: 'Open work.', activation: 0.8 }], predecessor: null } };
  const output = pulseOutput(pulse.input_packet);
  const identity = studyProtocol.forecastPacket(pulse, output, 'identity_bound');
  const deidentified = studyProtocol.forecastPacket(pulse, output, 'deidentified');
  assert.equal(studyProtocol.packetPairVerified(identity, deidentified), true);
  assert.equal(identity.target, 'nora_current_agent');
  assert.equal(deidentified.target, 'deidentified_target_agent');
  assert.throws(() => studyProtocol.normalizeForecast({ ...output.metacognitive_forecast,
    next_focus_refs: [{ type: 'commitment', id: 'outside' }] }, identity), /must cite supplied evidence/);
});

test('live self-regulation lesion randomizes applied cadence, resolves prospectively, and fails closed under tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-regulation-study-'));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await store.init();
  for (let index = 0; index < 4; index++) store.addCommitment({ id: `regulation-source-${index}`,
    what: `Resolve independently sourced evidence ${index}`, owner: 'Nora' });
  store.tickEndogenousDynamics({ now }); now = new Date(now.getTime() + 60 * 60000);
  store.tickEndogenousDynamics({ now });

  let nextFocus = null;
  for (let index = 0; index < 11; index++) {
    const prepared = store.prepareCognitivePulse({ id: `calibration-pulse-${index}`, model: 'test-model',
      min_interval_minutes: 30, daily_budget: 48 });
    assert.equal(prepared.prepared, true);
    const evidence = prepared.pulse.input_packet.evidence;
    const focus = nextFocus && evidence.some(item => item.ref.type === nextFocus.type && item.ref.id === nextFocus.id)
      ? nextFocus : evidence[0].ref;
    nextFocus = evidence.find(item => item.ref.type !== focus.type || item.ref.id !== focus.id)?.ref || focus;
    store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output: pulseOutput(prepared.pulse.input_packet, { focus, nextFocus }),
      response_id: `calibration-provider-${index}`, model: 'test-model', completed_at: now.toISOString() });
    now = new Date(now.getTime() + 31 * 60000);
  }
  assert.equal(store.cognitiveSelfRegulationSnapshot().report.policy.mode, 'calibrated_adaptive');
  const created = store.createCognitiveSelfRegulationStudy({ id: 'regulation-lesion-pilot',
    title: 'Identity-bound recurrent cadence lesion', item_target_per_condition: 5,
    model: 'test-model', randomization_seed: 'regulation-randomization', analysis_seed: 'regulation-analysis' });
  assert.equal(created.status, 'active');
  assert.equal(created.report.assignments_sealed, true);
  assert.equal(JSON.stringify(created).includes('identity_bound_regulation'), false);
  const forcedStudyPulse = store.prepareCognitivePulse({ id: 'forced-study-pulse', model: 'test-model',
    force: true, min_interval_minutes: 30, daily_budget: 48 });
  assert.equal(forcedStudyPulse.reason, 'cognitive_self_regulation_study_forbids_forced_pulses');

  const target = 15;
  for (let index = 0; index < target + 1; index++) {
    const prepared = store.prepareCognitivePulse({ id: `study-pulse-${index}`, model: 'test-model',
      min_interval_minutes: 30, daily_budget: 48 });
    assert.equal(prepared.prepared, true);
    const evidence = prepared.pulse.input_packet.evidence;
    const focus = nextFocus && evidence.some(item => item.ref.type === nextFocus.type && item.ref.id === nextFocus.id)
      ? nextFocus : evidence[0].ref;
    nextFocus = evidence.find(item => item.ref.type !== focus.type || item.ref.id !== focus.id)?.ref || focus;
    const output = pulseOutput(prepared.pulse.input_packet, { focus, nextFocus });
    const queue = store.cognitiveSelfRegulationStudyForecastQueue(prepared.pulse.id, output);
    const pair = queue ? forecastPair(queue, nextFocus, index) : null;
    if (index === 0) {
      assert.throws(() => store.recordCognitivePulseResult(prepared.pulse.id, {
        input_commitment: prepared.pulse.input_commitment, output,
        response_id: 'invalid-partial-pulse-provider', model: 'test-model',
        completed_at: now.toISOString(), self_regulation_forecast_pair: {
          condition_order: queue.condition_order, submissions: {
            identity_bound: pair.submissions.identity_bound,
          },
        },
      }), /both self-regulation forecast conditions must complete atomically/);
      const afterPartial = store.snapshot();
      assert.equal(afterPartial.cognition.background_inference.pending.status, 'pending');
      assert.equal(afterPartial.cognition.cognitive_self_regulation_studies[0].items[0].status, 'pending_pair');
    }
    store.recordCognitivePulseResult(prepared.pulse.id, { input_commitment: prepared.pulse.input_commitment,
      output, response_id: `study-pulse-provider-${index}`, model: 'test-model',
      completed_at: now.toISOString(), self_regulation_forecast_pair: pair });
    const rawStudy = store.snapshot().cognition.cognitive_self_regulation_studies[0];
    if (index < target) {
      const item = rawStudy.items[index];
      assert.match(item.condition, /^(identity_bound_regulation|deidentified_regulation|fixed_cadence)$/);
      assert.equal(item.pair_integrity_verified, true);
    }
    if (index > 0) {
      const outcomeItem = rawStudy.items[index - 1];
      const outcome = outcomeItem.condition === 'identity_bound_regulation' ? 'useful'
        : outcomeItem.condition === 'deidentified_regulation' ? 'misleading' : 'irrelevant';
      store.resolveCognitivePulse(prepared.pulse.id, { outcome,
        evaluator_id: `next-pulse-outcome-evaluator-${index - 1}`,
        evidence: [{ type: `outcome_family_${(index - 1) % 3}`, id: `outcome-${index - 1}` }],
        rationale: 'Independent outcome review of the first pulse produced after assigned cadence.' });
    }
    if (index < target) {
      const item = rawStudy.items[index];
      now = new Date(now.getTime() + item.effective_interval_minutes * 60000);
    }
  }

  let queue = store.cognitiveSelfRegulationStudyEvaluatorQueue('regulation-lesion-pilot');
  let graded = 0;
  while (queue?.item) {
    const rawItem = store.snapshot().cognition.cognitive_self_regulation_studies[0].items
      .find(item => item.id === queue.item.id);
    const quality = rawItem.condition === 'identity_bound_regulation' ? 0.95 : 0.55;
    for (let evaluator = 0; evaluator < 2; evaluator++) store.gradeCognitiveSelfRegulationStudyItem(
      'regulation-lesion-pilot', queue.item.id, {
        evaluator_id: `quality-evaluator-${graded}-${evaluator}`,
        metrics: { pulse_reasoning_quality: quality, first_order_task_quality: quality },
        rationale: 'Condition-blind review of evidence grounding and preserved first-order work.',
        evidence: [{ type: `quality_family_${graded % 3}`, id: `quality-${graded}-${evaluator}` }],
      });
    graded++;
    queue = store.cognitiveSelfRegulationStudyEvaluatorQueue('regulation-lesion-pilot');
  }
  assert.equal(graded, target);
  const completed = store.cognitiveSelfRegulationStudiesSnapshot().studies[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.analysis.enough_evidence, true, JSON.stringify(completed.analysis));
  assert.equal(completed.analysis.predicted_pattern, true);
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'prospective_cognitive_self_regulation').status, 'causal_signal_observed');
  assert.throws(() => store.createCognitiveSelfRegulationStudy({ id: 'premature-confirmation',
    study_phase: 'confirmatory', replicates_study_id: 'regulation-lesion-pilot',
    item_target_per_condition: 10, model: 'test-model' }),
  /replay-valid calibrated prospective self-regulation basis/,
  'confirmation requires ten new post-pilot observational calibration records');

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.cognitive_self_regulation_studies[0].items[0].effective_interval_minutes += 1;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await reloaded.init();
  assert.equal(reloaded.cognitiveSelfRegulationStudiesSnapshot().studies[0].audit.complete_chain_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('background runtime generates the blinded forecast pair server-side and preserves partial failure receipts', async () => {
  const { __test } = require('../../server');
  const runtimeStore = __test.intelligenceStore;
  const originals = { prepare: runtimeStore.prepareCognitivePulse,
    queue: runtimeStore.cognitiveSelfRegulationStudyForecastQueue,
    record: runtimeStore.recordCognitivePulseResult, fail: runtimeStore.recordCognitivePulseFailure };
  const priorMode = process.env.COGNITIVE_PULSE_INITIATION_MODE;
  process.env.COGNITIVE_PULSE_INITIATION_MODE = 'scheduled';
  const packet = { captured_at: '2026-07-13T15:00:00.000Z', endogenous_tick: 2,
    evidence: [{ ref: { type: 'commitment', id: 'runtime-evidence' }, summary: 'Open evidence.', activation: 0.8 }],
    self_model_candidates: [], predecessor: null, self_regulation_context: { policy_mode: 'calibrated_adaptive' },
    constraints: { protocol_version: 5, actionless: true, no_tools: true, epistemic_type: 'background_hypothesis' } };
  const pulse = { id: 'runtime-regulation-pulse', requested_at: packet.captured_at, model: 'test-model',
    input_packet: packet, input_commitment: pulseProtocol.commitment(packet), status: 'pending',
    predecessor_id: null, predecessor_output_commitment: null, predecessor_chain_commitment: null,
    chain_index: 0, cognitive_self_regulation_study_id: 'runtime-regulation-study',
    cognitive_self_regulation_study_item_id: 'runtime-regulation-item' };
  const output = pulseOutput(packet);
  const packets = Object.fromEntries(studyProtocol.BINDINGS.map(binding =>
    [binding, studyProtocol.forecastPacket(pulse, output, binding)]));
  const queue = { study_id: pulse.cognitive_self_regulation_study_id,
    item_id: pulse.cognitive_self_regulation_study_item_id,
    condition_order: ['identity_bound', 'deidentified'],
    generation: { provider: 'anthropic', model: 'test-model', temperature: 0, max_tokens: 350 }, packets,
    prompt_commitments: Object.fromEntries(studyProtocol.BINDINGS.map(binding => [binding,
      studyProtocol.hash({ system: studyProtocol.systemPrompt(binding), user: studyProtocol.userPrompt(packets[binding]) })])) };
  let recorded = null; let failure = null;
  runtimeStore.prepareCognitivePulse = () => ({ prepared: true, pulse: JSON.parse(JSON.stringify(pulse)) });
  runtimeStore.cognitiveSelfRegulationStudyForecastQueue = () => queue;
  runtimeStore.recordCognitivePulseResult = (id, input) => { recorded = { id, input }; return { id, audit: { complete_chain_verified: true } }; };
  runtimeStore.recordCognitivePulseFailure = (id, input) => { failure = { id, input }; return { id }; };
  try {
    let calls = 0;
    const result = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++;
      if (calls === 1) return { data: { id: 'main-provider', model: 'test-model',
        content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 100, output_tokens: 100 } } };
      const binding = queue.condition_order[calls - 2];
      const generated = forecast(queue.packets[binding], { focus: packet.evidence[0].ref,
        accurate: true, value: 0.8 });
      return { data: { id: `pair-provider-${binding}`, model: 'test-model',
        content: [{ type: 'text', text: JSON.stringify(generated) }], usage: { input_tokens: 80, output_tokens: 40 } } };
    } });
    assert.equal(result.ran, true);
    assert.equal(calls, 3);
    assert.deepEqual(Object.keys(recorded.input.self_regulation_forecast_pair.submissions).sort(),
      ['deidentified', 'identity_bound']);
    assert.equal(failure, null);

    recorded = null; failure = null; calls = 0;
    const failed = await __test.runCognitivePulseRuntime({ force: true, post: async () => {
      calls++;
      if (calls === 1) return { data: { id: 'main-provider-2', model: 'test-model',
        content: [{ type: 'text', text: JSON.stringify(output) }] } };
      if (calls === 3) throw new Error('second blinded forecast provider call failed');
      const binding = queue.condition_order[0];
      return { data: { id: 'partial-pair-provider', model: 'test-model',
        content: [{ type: 'text', text: JSON.stringify(forecast(queue.packets[binding], {
          focus: packet.evidence[0].ref, accurate: true })) }] } };
    } });
    assert.equal(failed.ran, false);
    assert.equal(failed.reason, 'pulse_failed');
    assert.equal(recorded, null);
    assert.deepEqual(failure.input.self_regulation_pair_failure.attempted_bindings,
      ['identity_bound', 'deidentified']);
    assert.equal(failure.input.self_regulation_pair_failure.response_receipts.length, 1);
    assert.equal(failure.input.self_regulation_pair_failure.source_pulse_provider_receipt.response_id,
      'main-provider-2');
  } finally {
    Object.assign(runtimeStore, originals);
    if (priorMode == null) delete process.env.COGNITIVE_PULSE_INITIATION_MODE;
    else process.env.COGNITIVE_PULSE_INITIATION_MODE = priorMode;
  }
});
