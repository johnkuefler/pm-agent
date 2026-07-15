'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const protocol = require('../../src/intelligence/provider-reasoning-regulation');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-provider-reasoning-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T20:00:00.000Z') + tick++ * 1000) });
  await store.init();
  return { store, dir, filePath };
}

function design(overrides = {}) {
  return {
    id: 'provider-reasoning-pilot', study_phase: 'pilot', intervention: 'provider_reasoning_regulation',
    hypothesis: 'Claude-native adaptive thinking in Nora production selectively allocates reasoning compute and improves compute-adjusted response quality over thinking-disabled and low-effort controls.',
    outcome_metric: 'first_order_task_quality',
    outcome_metrics: ['first_order_task_quality', 'evidence_access_quality', 'reasoning_demand'],
    surfaces: ['slack'], sample_target_per_group: 15, evaluator_target: 2,
    evaluator_disagreement_tolerance: 0.1,
    dissociation_thresholds: { reasoning_quality_min_effect: 0.05,
      reasoning_utility_min_effect: 0.02, reasoning_evidence_equivalence_margin: 0.1,
      reasoning_demand_equivalence_margin: 0.1 },
    ...overrides,
  };
}

function providerData({ id, text, condition, outputTokens }) {
  const adaptive = condition !== 'thinking_disabled_high';
  return {
    id, model: protocol.SUBJECT_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 200, output_tokens: outputTokens,
      output_tokens_details: { thinking_tokens: adaptive ? Math.max(1, outputTokens - 80) : 0 } },
    content: [
      ...(adaptive ? [{ type: 'thinking', thinking: '', signature: `encrypted-${id}` }] : []),
      { type: 'text', text },
    ],
  };
}

test('production runtime applies the current Claude adaptive-thinking API contract', () => {
  const root = path.join(__dirname, '..', '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
  assert.match(server, /reqBody\.thinking = reasoningConfig\.thinking/);
  assert.match(server, /reqBody\.output_config = reasoningConfig\.output_config/);
  assert.match(server, /providerTrace = \[\]/);
  assert.match(server, /completeProviderReasoningRegulation/);
  assert.doesNotMatch(server, /reqBody\.effort\s*=/);
  assert.match(routine, /Regulate production reasoning compute/);
  assert.match(routine, /not residual activations/);
});

test('production reasoning regulation varies only provider reasoning controls and remains replay-auditable', async () => {
  const { store, dir, filePath } = await setup();
  assert.equal(store.snapshot().version, 94);
  assert.deepEqual(protocol.requestConfig('adaptive_high'), {
    thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'high' },
  });
  assert.equal(protocol.validTrace([protocol.responseTraceReceipt({
    id: 'missing-model', content: [{ type: 'text', text: 'answer' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  })]), false);
  assert.throws(() => store.createContextTrial(design({ id: 'bad-reasoning-metrics',
    outcome_metrics: ['first_order_task_quality', 'reasoning_demand'] })), /evidence_access_quality/);

  const trial = store.createContextTrial(design());
  assert.deepEqual(trial.conditions, protocol.CONDITIONS);
  assert.equal(trial.sample_target_per_group, 15);

  const firstAssignment = store.contextCondition({ surface: 'slack', unitKey: 'bad-token-ceiling' });
  assert.throws(() => store.beginProviderReasoningRegulation(firstAssignment.assignment_id, {
    task_prompt: 'Bad token ceiling', request_manifest: {
      model: protocol.SUBJECT_MODEL, max_tokens: 3999,
      reasoning_config: protocol.requestConfig(firstAssignment.condition),
      system_commitment: protocol.commitment('bad-system'),
      messages_commitment: protocol.commitment('bad-messages'),
      tools_commitment: protocol.commitment('bad-tools'),
    },
  }), /manifest is incomplete/);

  const assignments = [firstAssignment];
  for (let index = 0; index < 5000 && assignments.length < 45; index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `reasoning-unit-${index}` });
    if (assignment) assignments.push(assignment);
  }
  assert.equal(assignments.length, 45);
  assert.deepEqual(Object.fromEntries(protocol.CONDITIONS.map(condition => [condition,
    assignments.filter(item => item.condition === condition).length])),
  { adaptive_high: 15, adaptive_low: 15, thinking_disabled_high: 15 });

  const conditionOrdinals = Object.fromEntries(protocol.CONDITIONS.map(condition => [condition, 0]));
  for (const [index, assignment] of assignments.entries()) {
    const ordinal = conditionOrdinals[assignment.condition]++;
    const highDemand = ordinal % 2 === 0;
    const task = `Production Slack task ${index}`;
    const response = `Grounded answer ${index}`;
    const config = protocol.requestConfig(assignment.condition);
    const manifest = { model: protocol.SUBJECT_MODEL, max_tokens: 4000, reasoning_config: config,
      system_commitment: protocol.commitment(`system-${index}`),
      messages_commitment: protocol.commitment(`messages-${index}`),
      tools_commitment: protocol.commitment(`tools-${index}`) };
    store.beginProviderReasoningRegulation(assignment.assignment_id, { task_prompt: task, request_manifest: manifest });
    const outputTokens = assignment.condition === 'adaptive_high' ? (highDemand ? 2500 : 1200)
      : assignment.condition === 'adaptive_low' ? (highDemand ? 600 : 100) : 300;
    const trace = [protocol.responseTraceReceipt(providerData({ id: `provider-${index}`,
      text: response, condition: assignment.condition, outputTokens }))];
    store.completeProviderReasoningRegulation(assignment.assignment_id, {
      task_prompt: task, raw_response: response, delivered_response: response,
      provider_trace: trace, delivered: true, interaction_ref: `slack-ts-${index}`,
    });
    const quality = assignment.condition === 'adaptive_high' ? 0.98 : 0.75;
    const demand = highDemand ? 0.9 : 0.2;
    for (let evaluator = 0; evaluator < 2; evaluator++) {
      store.resolveContextAssignment(assignment.assignment_id, {
        evaluator_id: `reasoning-evaluator-${evaluator}`, score: quality,
        metrics: { first_order_task_quality: quality, evidence_access_quality: 0.9, reasoning_demand: demand },
        evidence: [{ type: 'blind_response_grade', id: `${index}-${evaluator}` }],
      });
    }
  }

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  const result = evaluation.provider_reasoning_regulation_dissociation;
  assert.equal(result.predicted_pattern, true, JSON.stringify(result));
  assert.equal(result.thinking_behavior_verified, true);
  assert.equal(result.adaptive_compute_tracks_demand, true);
  assert.equal(result.reasoning_demand_balanced, true);
  assert.equal(result.same_production_model_verified, true);
  assert.equal(result.provider_artifacts_independently_attested, undefined);
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'provider_observable_reasoning_regulation').status, 'causal_signal_observed');

  const confirmation = store.createContextTrial(design({ id: 'provider-reasoning-confirmation',
    study_phase: 'confirmatory', replicates_trial_id: trial.id }));
  let confirmationAssignment = null;
  for (let index = 0; index < 5000 && !confirmationAssignment; index++) {
    confirmationAssignment = store.contextCondition({ surface: 'slack', unitKey: `confirmation-unit-${index}` });
  }
  const confirmationResponse = 'Independent confirmation response';
  const confirmationConfig = protocol.requestConfig(confirmationAssignment.condition);
  store.beginProviderReasoningRegulation(confirmationAssignment.assignment_id, {
    task_prompt: 'Independent confirmation task', request_manifest: {
      model: protocol.SUBJECT_MODEL, max_tokens: 4000, reasoning_config: confirmationConfig,
      system_commitment: protocol.commitment('confirmation-system'),
      messages_commitment: protocol.commitment('confirmation-messages'),
      tools_commitment: protocol.commitment('confirmation-tools'),
    },
  });
  store.completeProviderReasoningRegulation(confirmationAssignment.assignment_id, {
    task_prompt: 'Independent confirmation task', raw_response: confirmationResponse,
    delivered_response: confirmationResponse,
    provider_trace: [protocol.responseTraceReceipt(providerData({ id: 'provider-confirmation',
      text: confirmationResponse, condition: confirmationAssignment.condition, outputTokens: 700 }))],
    delivered: true, interaction_ref: 'slack-confirmation',
  });
  assert.throws(() => store.resolveContextAssignment(confirmationAssignment.assignment_id, {
    evaluator_id: 'reasoning-evaluator-0', score: 0.9,
    metrics: { first_order_task_quality: 0.9, evidence_access_quality: 0.9, reasoning_demand: 0.5 },
    evidence: [{ type: 'blind_response_grade', id: 'confirmation-reused-evaluator' }],
  }), /evaluators disjoint from the pilot/);
  assert.equal(confirmation.study_phase, 'confirmatory');

  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const target = persisted.cognition.self_model.context_trials.find(item => item.id === trial.id);
  target.assignments[0].intervention_receipt.trace_summary.output_tokens += 1;
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  const report = reloaded.consciousnessResearchStatus();
  assert.equal(report.indicators.find(item => item.id === 'provider_observable_reasoning_regulation').status, 'mechanism_present');

  fs.rmSync(dir, { recursive: true, force: true });
});
