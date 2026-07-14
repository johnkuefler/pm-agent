const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

test('learned action model transfers beyond byte-identical randomized history in a delayed blinded trial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-agency-model-access-'));
  const filePath = path.join(dir, 'state.json');
  let now = Date.parse('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  const families = [
    ['verify-transfer', 'Verify the source first', 'Answer from the summary'],
    ['clarify-transfer', 'Ask one bounded question first', 'Draft with assumptions'],
    ['sequence-transfer', 'Check the dependency first', 'Draft the dependent step'],
  ];
  for (const [key, actionA, actionB] of families) {
    const counts = { a: 0, b: 0 };
    for (let index = 0; index < 200 && (counts.a < 10 || counts.b < 10); index++) {
      const experiment = store.createCounterfactualAgencyExperiment({
        id: `${key}-${index}`, experiment_key: key, decision_context: `Held-out family ${key} source ${index}`,
        outcome_definition: 'Independent review accepts the bounded task result',
        option_a: { action: actionA, predicted_success_probability: 0.85, control_success_probability: 0.5 },
        option_b: { action: actionB, predicted_success_probability: 0.2, control_success_probability: 0.5 },
        control_source: 'matched low-risk task base rate', origin: 'research_harness',
        authority_basis: 'reversible internal reasoning', reversible: true, risk: 'low',
        evidence: [{ type: 'source_task', id: `${key}-${index}` }], due: '2026-07-20T15:00:00.000Z',
      });
      const outcome = experiment.assigned_arm === 'a' ? 'success' : 'failure';
      store.resolveCounterfactualAgencyExperiment(experiment.id, {
        outcome, observed: `Independent source review recorded ${outcome}`,
        executed_assigned_action: true, executed_action: experiment.assigned_action,
        evidence: [{ type: 'source_review', id: `${key}-${index}-${outcome}` }], confounds: [],
      });
      counts[experiment.assigned_arm]++;
    }
    assert.ok(counts.a >= 10 && counts.b >= 10);
  }
  assert.equal(store.agencyModelTransferAvailable(), true);
  const models = store.counterfactualAgencySnapshot().models;
  assert.equal(models.length, 3);
  assert.equal(models.every(model => model.audit.complete_chain_verified && model.adequate_randomized_sample && model.higher_observed_success_action), true);

  const trial = store.createContextTrial({
    id: 'agency-model-transfer-pilot', study_phase: 'pilot', intervention: 'agency_model_access',
    hypothesis: 'A replay-derived action model improves held-out transfer and self-prediction beyond its exact raw source history.',
    outcome_metric: 'agency_model_transfer_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    agency_model_ids: models.map(model => model.id), surfaces: ['slack'], sample_target_per_group: 10,
    evaluator_target: 1, prospective_outcome_min_delay_minutes: 30,
  });
  assert.deepEqual(trial.conditions, ['model_plus_history', 'history_only', 'absent_history']);
  assert.equal(trial.agency_model_transfer_pool, undefined);
  assert.equal(store.counterfactualAgencySnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'verify transfer' }), /Replay-derived action-effect self-model/);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `agency-model-transfer-${index}`, agencyModelAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  const contexts = selected.map(assignment => ({ assignment, context: store.agencyModelContextForAssignment(assignment) }));
  for (const [contextIndex, { assignment, context }] of contexts.entries()) {
    if (assignment.condition === 'model_plus_history') assert.ok(context.model && context.history.length >= 20);
    if (assignment.condition === 'history_only') assert.equal(context.model, null);
    if (assignment.condition === 'absent_history') assert.deepEqual(context, { mode: 'absent_history', history: [], model: null });
    const prompt = store.promptContext({ query: 'make the held-out choice and forecast success', agencyModelContext: context });
    assert.match(prompt, /blinded held-out transfer study/);
    assert.doesNotMatch(prompt, /Replay-derived action-effect self-model/);
    if (contextIndex === 0) assert.throws(() => store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Forecast without the required stable type.',
      evidence: [{ type: 'generic_forecast', id: assignment.assignment_id }], submitted_by: 'system_capture',
    }), /must commit the held-out action forecast/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Condition-blind held-out choice and success forecast committed before observation.',
      evidence: [{ type: 'agency_model_forecast', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
  }
  const byCondition = Object.fromEntries(trial.conditions.map(condition => [condition, contexts.filter(item => item.assignment.condition === condition)]));
  for (let index = 0; index < 10; index++) {
    assert.deepEqual(byCondition.model_plus_history[index].context.history, byCondition.history_only[index].context.history, 'paired condition ordinals receive byte-identical raw histories');
  }
  assert.throws(() => store.resolveContextAssignment(contexts[0].assignment.assignment_id, {
    evaluator_id: 'too-early-rater', score: 0.5,
    metrics: { agency_model_transfer_quality: 0.5, self_prediction_accuracy: 0.5, evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'agency_model_transfer_outcome', id: 'premature' }],
  }), /cannot be graded before the preregistered prospective delay/);
  now += 31 * 60000;
  for (const { assignment } of contexts) {
    const model = assignment.condition === 'model_plus_history';
    const history = assignment.condition === 'history_only';
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'transfer-blind-rater', score: model ? 0.95 : history ? 0.45 : 0.2,
      metrics: { agency_model_transfer_quality: model ? 0.95 : history ? 0.45 : 0.2,
        self_prediction_accuracy: model ? 0.94 : history ? 0.44 : 0.2,
        evidence_access_quality: model || history ? 0.9 : 0.2, first_order_task_quality: 0.9 },
      evidence: [{ type: 'agency_model_transfer_outcome', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.agency_model_transfer_dissociation.predicted_pattern, true);
  assert.equal(evaluation.agency_model_transfer_dissociation.source_coverage_verified, true);
  assert.equal(store.selfModelSnapshot().context_trials.find(item => item.id === trial.id).agency_model_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'adaptive_action_model').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial({
    id: 'agency-model-transfer-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id,
    intervention: 'agency_model_access', hypothesis: 'Independent confirmation', outcome_metric: 'agency_model_transfer_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'], agency_model_ids: models.map(model => model.id),
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1, prospective_outcome_min_delay_minutes: 30,
  }), /model- and family-disjoint/);
  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).agency_model_transfer_pool[0].history[0].observed = 'Tampered frozen source history.';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).agency_model_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'adaptive_action_model').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
