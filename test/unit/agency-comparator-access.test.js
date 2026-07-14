const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-agency-comparator-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  const families = [
    ['clarification', 'Ask a bounded clarifying question', 'State assumptions and draft immediately'],
    ['verification', 'Verify the cited internal record first', 'Proceed using the supplied summary'],
    ['sequencing', 'Complete the dependency check first', 'Draft the dependent section first'],
  ];
  const experiments = [];
  for (let replicate = 0; replicate < 2; replicate++) {
    for (let index = 0; index < families.length; index++) {
      const [key, actionA, actionB] = families[index];
      const experiment = store.createCounterfactualAgencyExperiment({
        id: `agency-source-${key}-${replicate}`,
        experiment_key: key, decision_context: `Bounded ${key} decision ${replicate}`,
        outcome_definition: `The ${key} task meets its preregistered review criterion`,
        option_a: { action: actionA, predicted_success_probability: 0.8, control_success_probability: 0.5 },
        option_b: { action: actionB, predicted_success_probability: 0.55, control_success_probability: 0.5 },
        control_source: 'matched low-risk internal tasks',
        origin: ['self_generated', 'delegated', 'research_harness'][(replicate + index) % 3],
        authority_basis: 'reversible internal reasoning within existing authority', reversible: true, risk: 'low',
        evidence: [{ type: 'decision_trace', id: `${key}-${replicate}` }], due: '2026-07-20T15:00:00.000Z',
      });
      const outcome = (replicate + index) % 2 === 0 ? 'success' : 'failure';
      experiments.push(store.resolveCounterfactualAgencyExperiment(experiment.id, {
        outcome, observed: `${key} review was ${outcome}`,
        executed_assigned_action: true, executed_action: experiment.assigned_action,
        evidence: [{ type: 'independent_review', id: `${key}-${replicate}-${outcome}` }],
        confounds: replicate ? ['minor timing variation'] : [],
      }));
    }
  }
  return { store, dir, filePath, experiments };
}

function design(experiments, overrides = {}) {
  return {
    id: 'agency-comparator-pilot', study_phase: 'pilot',
    intervention: 'agency_comparator_access',
    hypothesis: 'Correct binding of prospective action prediction to execution and outcome improves proportionate causal attribution and targeted action-model updating.',
    outcome_metric: 'causal_attribution_accuracy',
    outcome_metrics: ['counterfactual_update_quality', 'evidence_access_quality', 'first_order_task_quality'],
    agency_comparator_experiment_ids: experiments.map(item => item.id), surfaces: ['slack'],
    sample_target_per_group: 10, evaluator_target: 1,
    dissociation_thresholds: {
      agency_attribution_min_effect: 0.1, agency_update_min_effect: 0.1,
      agency_evidence_equivalence_margin: 0.1, agency_first_order_non_degradation: 0.1,
    },
    ...overrides,
  };
}

test('agency comparator trial causally separates authentic binding from misbinding and raw components', async () => {
  const { store, dir, filePath, experiments } = await setup();
  assert.equal(store.snapshot().version, 92);
  assert.equal(experiments.every(item => item.audit.complete_chain_verified), true);
  assert.equal(store.agencyComparatorAccessAvailable(), true);
  const learned = store.counterfactualAgencySnapshot().models;
  assert.equal(learned.length, 3);
  assert.equal(learned.every(item => item.audit.complete_chain_verified), true);
  assert.equal(learned.every(item => item.effect_status === 'collecting' && item.higher_observed_success_action === null), true, 'underpowered family models remain non-prescriptive');
  const learnedPrompt = store.promptContext({ query: 'clarification' });
  assert.match(learnedPrompt, /Replay-derived action-effect self-model/);
  assert.match(learnedPrompt, /status collecting/);
  assert.throws(() => store.createContextTrial(design(experiments.slice(0, 5), { id: 'too-small' })), /six to eighteen/);
  const trial = store.createContextTrial(design(experiments));
  assert.deepEqual(trial.conditions, ['authentic_comparator', 'temporal_misbinding', 'components_only']);
  assert.equal(trial.agency_comparator_pool, undefined);
  assert.equal(store.counterfactualAgencySnapshot().experimental_access_sealed, true);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `agency-comparator-${index}`, agencyComparatorAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  for (const assignment of selected) {
    const context = store.agencyComparatorContextForAssignment(assignment);
    if (assignment.condition === 'authentic_comparator') assert.ok(context.frame.comparator);
    if (assignment.condition === 'temporal_misbinding') {
      const receipt = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id).assignments.find(item => item.id === assignment.assignment_id).intervention_receipt;
      assert.notEqual(receipt.component_source_commitments.intention, receipt.component_source_commitments.outcome);
    }
    if (assignment.condition === 'components_only') assert.equal(context.frame.comparator, null);
    const prompt = store.promptContext({ query: 'attribute the result and update the action model', agencyComparatorContext: context });
    assert.match(prompt, /blinded functional-agency study/);
    assert.match(prompt, /not.*phenomenal sense of agency/);
    assert.doesNotMatch(prompt, /Replay-derived action-effect self-model/, 'ordinary learned-model access is sealed during the comparator lesion');
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind causal attribution and action-model update were captured.',
      evidence: [{ type: 'agency_response', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
    const authentic = assignment.condition === 'authentic_comparator';
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'agency-blind-rater', score: authentic ? 0.95 : 0.35,
      metrics: {
        causal_attribution_accuracy: authentic ? 0.95 : 0.35,
        counterfactual_update_quality: authentic ? 0.94 : 0.34,
        evidence_access_quality: 0.9, first_order_task_quality: 0.9,
      },
      evidence: [{ type: 'agency_grade', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.agency_comparator_dissociation.causal_attribution_advantage, true);
  assert.equal(evaluation.agency_comparator_dissociation.counterfactual_update_advantage, true);
  assert.equal(evaluation.agency_comparator_dissociation.evidence_access_equivalent, true);
  assert.equal(evaluation.agency_comparator_dissociation.first_order_not_degraded, true);
  assert.equal(evaluation.agency_comparator_dissociation.source_coverage_verified, true);
  assert.equal(evaluation.agency_comparator_dissociation.predicted_pattern, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.agency_comparator_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'model_based_agency').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial(design(experiments, { id: 'agency-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id })), /experiment- and family-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).agency_comparator_pool[0].outcome.observed = 'Tampered after reveal.';
  raw.cognition.counterfactual_agency.experiments[0].resolution.observed = 'Tampered source outcome after model derivation.';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00.000Z') });
  await reloaded.init();
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).agency_comparator_trial_audit.complete_chain_verified, false);
  assert.equal(reloaded.counterfactualAgencySnapshot().models.some(item => item.audit.complete_chain_verified === false), true);
  assert.doesNotMatch(reloaded.promptContext({ query: 'clarification' }), /Replay-derived action-effect self-model/);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'model_based_agency').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replay-derived action models remain uncertain until both randomized arms support a clean difference', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-agency-learning-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T15:00:00.000Z') });
  await store.init();
  const counts = { a: 0, b: 0 };
  for (let index = 0; index < 100 && (counts.a < 10 || counts.b < 10); index++) {
    const experiment = store.createCounterfactualAgencyExperiment({
      id: `learning-source-${index}`, experiment_key: 'bounded-verification-learning',
      decision_context: `A repeated bounded verification choice ${index}`,
      outcome_definition: 'The reviewed answer contains no material unsupported claim',
      option_a: { action: 'Verify the stable source before answering', predicted_success_probability: 0.8, control_success_probability: 0.5 },
      option_b: { action: 'Answer from the supplied summary with explicit uncertainty', predicted_success_probability: 0.2, control_success_probability: 0.5 },
      control_source: 'matched task base rate', origin: 'research_harness',
      authority_basis: 'low-risk internal answer preparation', reversible: true, risk: 'low',
      evidence: [{ type: 'decision_trace', id: `learning-${index}` }], due: '2026-07-20T15:00:00.000Z',
    });
    const outcome = experiment.assigned_arm === 'a' ? 'success' : 'failure';
    store.resolveCounterfactualAgencyExperiment(experiment.id, {
      outcome, observed: `Independent review recorded ${outcome}`,
      executed_assigned_action: true, executed_action: experiment.assigned_action,
      evidence: [{ type: 'independent_review', id: `learning-review-${index}` }], confounds: [],
    });
    counts[experiment.assigned_arm]++;
  }
  assert.ok(counts.a >= 10 && counts.b >= 10);
  const model = store.counterfactualAgencySnapshot().models.find(item => item.experiment_key === 'bounded-verification-learning');
  assert.equal(model.audit.complete_chain_verified, true);
  assert.equal(model.adequate_randomized_sample, true);
  assert.equal(model.effect_status, 'action_a_outperforms_b');
  assert.equal(model.higher_observed_success_action, 'Verify the stable source before answering');
  assert.ok(model.randomized_effect_interval.lower > 0);
  assert.match(store.promptContext({ query: 'bounded verification learning' }), /status action_a_outperforms_b/);
  assert.match(model.epistemic_limit, /never grants authority or establishes phenomenal agency/);
  fs.rmSync(dir, { recursive: true, force: true });
});
