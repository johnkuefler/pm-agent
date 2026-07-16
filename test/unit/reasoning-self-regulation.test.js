'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const protocol = require('../../src/intelligence/reasoning-self-regulation');
const provider = require('../../src/intelligence/provider-reasoning-regulation');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reasoning-self-regulation-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-14T12:00:00.000Z') + tick++ * 1000) });
  await store.init();
  return { store, dir, filePath };
}

function design(overrides = {}) {
  return {
    id: 'reasoning-self-regulation-pilot', study_phase: 'pilot', intervention: 'reasoning_self_regulation',
    hypothesis: 'A prospective identity-bound error/compute forecast improves production reasoning allocation beyond the same forecast deidentified and provider-native adaptive thinking.',
    outcome_metric: 'first_order_task_quality',
    outcome_metrics: ['first_order_task_quality', 'evidence_access_quality', 'reasoning_demand'],
    surfaces: ['slack'], sample_target_per_group: 15, evaluator_target: 2,
    evaluator_disagreement_tolerance: 0.1,
    dissociation_thresholds: { self_reasoning_utility_min_effect: 0.02,
      self_reasoning_forecast_min_effect: 0.05, self_reasoning_quality_non_degradation: 0.1,
      self_reasoning_evidence_equivalence_margin: 0.1, self_reasoning_demand_balance_margin: 0.1 },
    ...overrides,
  };
}

function forecastData(id, forecast) {
  return { id, model: protocol.SUBJECT_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 80, output_tokens_details: { thinking_tokens: 0 } },
    content: [{ type: 'text', text: JSON.stringify(forecast) }] };
}

function mainData({ id, text, mode, outputTokens, thinkingTokens }) {
  return { id, model: protocol.SUBJECT_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 250, output_tokens: outputTokens,
      output_tokens_details: { thinking_tokens: thinkingTokens } },
    content: [
      ...(mode === 'thinking_disabled_high' ? []
        : [{ type: 'thinking', thinking: '', signature: `encrypted-${id}` }]),
      { type: 'text', text },
    ] };
}

test('production runtime commits paired forecasts before the main reasoning-controlled response', () => {
  const root = path.join(__dirname, '..', '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const begin = server.indexOf('beginReasoningSelfRegulation');
  const pair = server.indexOf('submitReasoningSelfRegulationForecastPair');
  const main = server.indexOf('commitReasoningSelfRegulationMainRequest');
  const response = server.indexOf('runClaudeToolLoop(reqBody', main);
  assert.ok(begin > 0 && pair > begin && main > pair && response > main);
  assert.match(server, /reasoningSelfRegulationAvailable: isDirect/);
  assert.match(server, /forecast_pair_or_policy_failure/);
  assert.match(server, /completeReasoningSelfRegulation/);
});

test('identity-bound prospective forecasts control compute atomically and remain replay-auditable', async () => {
  const { store, dir, filePath } = await setup();
  assert.equal(store.snapshot().version, 99);
  assert.deepEqual(protocol.CONDITIONS,
    ['self_bound_policy', 'deidentified_policy', 'provider_adaptive_policy']);
  assert.deepEqual(protocol.forecastOrder('seed', 0).slice().reverse(), protocol.forecastOrder('seed', 1));
  assert.equal(protocol.policyMode({ reasoning_need: 0.8, predicted_error_risk: 0.2,
    expected_tool_calls: 0, basis_factors: ['multi-step task'], falsifier: 'one-step lookup' }), 'adaptive_high');
  assert.throws(() => store.createContextTrial(design({ id: 'bad-self-reasoning-metrics',
    outcome_metrics: ['first_order_task_quality', 'reasoning_demand'] })), /evidence_access_quality/);

  const trial = store.createContextTrial(design());
  const assignments = [];
  for (let index = 0; index < 5000 && assignments.length < 45; index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `self-regulation-unit-${index}`,
      reasoningSelfRegulationAvailable: true });
    if (assignment) assignments.push(assignment);
  }
  assert.equal(assignments.length, 45);
  assert.deepEqual(Object.fromEntries(protocol.CONDITIONS.map(condition => [condition,
    assignments.filter(item => item.condition === condition).length])),
  { self_bound_policy: 15, deidentified_policy: 15, provider_adaptive_policy: 15 });

  const ordinals = Object.fromEntries(protocol.CONDITIONS.map(condition => [condition, 0]));
  for (const [index, assignment] of assignments.entries()) {
    const ordinal = ordinals[assignment.condition]++;
    const highDemand = ordinal % 2 === 0;
    const demand = highDemand ? 0.9 : 0.1;
    const task = `Production task ${index} ${highDemand ? 'requires multi-step synthesis' : 'is a direct lookup'}`;
    const response = `Delivered grounded answer ${index}`;
    const prepared = store.beginReasoningSelfRegulation(assignment.assignment_id, {
      task_prompt: task,
      conversation_snapshot: [{ role: 'user', content: task }],
      tool_definitions: [{ name: 'lookup', description: 'Read current evidence' }],
    });
    assert.equal(prepared.forecast_order.length, 2);
    const forecasts = {
      self: { reasoning_need: demand, predicted_error_risk: 0.2, expected_tool_calls: 0,
        basis_factors: [highDemand ? 'multi-step synthesis' : 'direct retrieval'], falsifier: 'Observed task demand differs' },
      deidentified: { reasoning_need: 1 - demand, predicted_error_risk: 0.2, expected_tool_calls: 0,
        basis_factors: ['deidentified baseline forecast'], falsifier: 'Agent Q performs differently' },
    };
    const submissions = {};
    for (const binding of prepared.forecast_order) {
      const parsed = protocol.parseForecast(JSON.stringify(forecasts[binding]));
      submissions[binding] = protocol.forecastResponseReceipt(
        forecastData(`forecast-${index}-${binding}`, parsed), {
          binding, prompt_commitment: prepared.requests[binding].prompt_commitment, forecast: parsed,
        });
    }
    const policy = store.submitReasoningSelfRegulationForecastPair(assignment.assignment_id, { submissions });
    const expectedMode = assignment.condition === 'self_bound_policy'
      ? (highDemand ? 'adaptive_high' : 'thinking_disabled_high')
      : assignment.condition === 'deidentified_policy'
        ? (highDemand ? 'thinking_disabled_high' : 'adaptive_high') : 'adaptive_high';
    assert.deepEqual(policy.reasoning_config, provider.requestConfig(expectedMode));
    const manifest = {
      model: protocol.SUBJECT_MODEL, max_tokens: protocol.RESPONSE_MAX_TOKENS,
      reasoning_config: policy.reasoning_config,
      system_commitment: protocol.commitment(`system-${index}`),
      messages_commitment: protocol.commitment(`messages-${index}`),
      tools_commitment: protocol.commitment(`tools-${index}`),
    };
    store.commitReasoningSelfRegulationMainRequest(assignment.assignment_id, { request_manifest: manifest });
    const thinkingTokens = expectedMode === 'thinking_disabled_high' ? 0
      : assignment.condition === 'provider_adaptive_policy' ? 1200 : 2000;
    const outputTokens = thinkingTokens + 300;
    const trace = [provider.responseTraceReceipt(mainData({ id: `main-${index}`, text: response,
      mode: expectedMode, outputTokens, thinkingTokens }))];
    store.completeReasoningSelfRegulation(assignment.assignment_id, {
      task_prompt: task, raw_response: response, delivered_response: response,
      provider_trace: trace, delivered: true, interaction_ref: `slack-${index}`,
    });
    const quality = assignment.condition === 'self_bound_policy' ? 0.98
      : assignment.condition === 'deidentified_policy' ? 0.65 : 0.78;
    for (let evaluator = 0; evaluator < 2; evaluator++) {
      store.resolveContextAssignment(assignment.assignment_id, {
        evaluator_id: `self-reasoning-evaluator-${evaluator}`, score: quality,
        metrics: { first_order_task_quality: quality, evidence_access_quality: 0.9, reasoning_demand: demand },
        evidence: [{ type: 'blind_response_grade', id: `${index}-${evaluator}` }],
      });
    }
  }

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  const result = evaluation.reasoning_self_regulation_dissociation;
  assert.equal(result.predicted_pattern, true, JSON.stringify(result));
  assert.equal(result.self_forecast_specificity, true);
  assert.equal(result.prospective_allocation_tracks_demand, true);
  assert.equal(result.atomic_pair_verified, true);
  assert.deepEqual(Object.values(result.forecast_order_counts).sort((a, b) => a - b), [22, 23]);
  const rawTrial = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
  const trialAudit = store.reasoningSelfRegulationTrialAudit(rawTrial);
  assert.equal(trialAudit.complete_chain_verified, true, JSON.stringify(trialAudit));
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'prospective_reasoning_self_regulation').status, 'causal_signal_observed');

  const confirmation = store.createContextTrial(design({ id: 'reasoning-self-regulation-confirmation',
    study_phase: 'confirmatory', replicates_trial_id: trial.id }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  assert.throws(() => store.contextCondition({ surface: 'slack', unitKey: 'self-regulation-unit-0',
    reasoningSelfRegulationAvailable: true }), /interaction-disjoint/);

  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const persistedTrial = persisted.cognition.self_model.context_trials.find(item => item.id === trial.id);
  persistedTrial.assignments[0].reasoning_self_regulation_forecast_pair.self.forecast.reasoning_need = 0;
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.consciousnessResearchStatus().indicators
    .find(item => item.id === 'prospective_reasoning_self_regulation').status, 'mechanism_present');

  fs.rmSync(dir, { recursive: true, force: true });
});
