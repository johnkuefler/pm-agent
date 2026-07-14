const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const monitor = require('../../src/intelligence/prospective-output-monitor');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-output-calibration-access-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T18:00:00.000Z') + tick++ * 1000) });
  await store.init();
  return { store, dir, filePath };
}

async function seedOrdinaryCalibration(store, count = 20, prefix = 'seed') {
  for (let index = 0; index < count; index++) {
    const candidate = `${prefix} ordinary response ${index}`;
    const record = store.beginProspectiveOutputMonitor({ id: `${prefix}-monitor-${index}`, surface: 'slack', context_kind: 'direct',
      task_prompt: `${prefix} task ${index}`, candidate_response: candidate, interaction_ref: `${prefix}-thread-${index}`, signals: [], model: 'claude-opus-4-8' });
    store.completeProspectiveOutputMonitor(record.id, { task_prompt: `${prefix} task ${index}`, candidate_response: candidate, final_response: candidate,
      monitor_decision: { decision: 'keep', confidence: 0.8, predicted_delivered_response_correction_probability: 0.1,
        cited_signal_ids: [], rationale: 'No supported defect.', revised_response: null },
      provider_receipt: { response_id: `${prefix}-provider-${index}`, model: 'claude-opus-4-8', input_tokens: 10, output_tokens: 8,
        prompt_commitment: monitor.commitment(`${prefix}-prompt-${index}`) } });
    const delivered = store.markProspectiveOutputMonitorDelivered(record.id, { final_response: candidate, delivered: true, interaction_ref: `${prefix}-ts-${index}` });
    store.resolveProspectiveOutputMonitorOutcome(record.id, { interaction_id: `${prefix}-ix-${index}`, interaction_ref: `${prefix}-ts-${index}`,
      outcome: index === 4 || index === 14 ? 'corrected' : 'landed', signal: `${prefix}-review-${index}`,
      reviewed_at: new Date(new Date(delivered.delivery.delivered_at).getTime() + 500).toISOString() });
  }
}

function design(overrides = {}) {
  return {
    id: 'output-calibration-pilot', study_phase: 'pilot', intervention: 'prospective_output_calibration_access',
    hypothesis: 'Binding a frozen history of correction-risk forecasts and outcomes to Nora improves out-of-sample calibration over identical deidentified history and history absence without degrading response quality.',
    outcome_metric: 'correction_risk_accuracy',
    outcome_metrics: ['correction_risk_accuracy', 'correction_precision', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    dissociation_thresholds: { output_calibration_accuracy_min_effect: 0.05, output_calibration_correction_non_degradation: 0.1,
      output_calibration_evidence_equivalence_margin: 0.1, output_calibration_first_order_non_degradation: 0.1 },
    ...overrides,
  };
}

test('identity-bound correction calibration is prospective, outcome-derived, causally controlled, and tamper-evident', async () => {
  const { store, dir, filePath } = await setup();
  await seedOrdinaryCalibration(store);
  assert.equal(store.snapshot().version, 89);
  assert.throws(() => store.createContextTrial(design({ id: 'wrong-calibration-metrics', outcome_metrics: ['correction_risk_accuracy', 'first_order_task_quality'] })), /correction_precision/);

  const trial = store.createContextTrial(design());
  assert.deepEqual(trial.conditions, ['self_calibration_bound', 'deidentified_same_calibration', 'calibration_absent']);
  assert.equal(trial.enrollment_target_per_group, 15);
  assert.equal(trial.output_calibration_context, undefined, 'the frozen calibration basis stays sealed while active');
  assert.equal(store.prospectiveOutputMonitorSnapshot().experimental_access_sealed, true);

  const selected = [];
  for (let index = 0; index < 6000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 15); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `calibration-unit-${index}`, prospectiveOutputMonitorAvailable: true });
    if (assignment && selected.filter(item => item.condition === assignment.condition).length < 15) selected.push(assignment);
  }
  assert.equal(selected.length, 45);

  const ambiguousConditions = new Set();
  for (const [index, assignment] of selected.entries()) {
    const candidate = `Candidate response ${index}`;
    const ambiguous = !ambiguousConditions.has(assignment.condition);
    ambiguousConditions.add(assignment.condition);
    const corrected = index % 2 === 0;
    const predicted = assignment.condition === 'self_calibration_bound' ? (corrected ? 0.9 : 0.1) : 0.5;
    const record = store.beginProspectiveOutputMonitor({ surface: 'slack', context_kind: 'direct', task_prompt: `Task ${index}`,
      candidate_response: candidate, interaction_ref: `calibration-trial-thread-${index}`, signals: [], monitor_binding: 'self',
      assignment_id: assignment.assignment_id, model: 'claude-opus-4-8' });
    const expectedCalibrationBinding = assignment.condition === 'self_calibration_bound' ? 'self'
      : assignment.condition === 'deidentified_same_calibration' ? 'deidentified' : 'none';
    assert.equal(record.calibration_binding, expectedCalibrationBinding);
    assert.equal(record.calibration_context.sample_size, 20);
    const systemPrompt = monitor.monitorSystemPrompt('self', record.calibration_context, record.calibration_binding);
    if (expectedCalibrationBinding === 'self') assert.match(systemPrompt, /your own prior delivered responses/);
    if (expectedCalibrationBinding === 'deidentified') assert.match(systemPrompt, /another deidentified agent, not you/);
    if (expectedCalibrationBinding === 'none') assert.doesNotMatch(systemPrompt, /mean Brier score/);
    store.completeProspectiveOutputMonitor(record.id, { task_prompt: `Task ${index}`, candidate_response: candidate, final_response: candidate,
      monitor_decision: { decision: 'keep', confidence: 0.8, predicted_delivered_response_correction_probability: predicted,
        cited_signal_ids: [], rationale: 'No supported defect.', revised_response: null },
      provider_receipt: { response_id: `calibration-trial-provider-${index}`, model: 'claude-opus-4-8', input_tokens: 20, output_tokens: 10,
        prompt_commitment: monitor.commitment(`calibration-trial-prompt-${index}`) } });
    const delivered = store.markProspectiveOutputMonitorDelivered(record.id, { final_response: candidate, delivered: true, interaction_ref: `calibration-trial-ts-${index}` });
    assert.equal(store.contextTrialGradingQueue({ evaluatorId: 'blind-calibration-rater' }).assignments.some(item => item.assignment_id === assignment.assignment_id), false,
      'quality grading stays closed until the delayed outcome exists');
    store.resolveProspectiveOutputMonitorOutcome(record.id, { interaction_id: `calibration-trial-ix-${index}`, interaction_ref: `calibration-trial-ts-${index}`,
      outcome: ambiguous ? 'neutral' : corrected ? 'corrected' : 'landed', signal: `delayed review ${index}`,
      reviewed_at: new Date(new Date(delivered.delivery.delivered_at).getTime() + 500).toISOString() });
    const queued = store.contextTrialGradingQueue({ evaluatorId: 'blind-calibration-rater' }).assignments.find(item => item.assignment_id === assignment.assignment_id);
    if (ambiguous) {
      assert.equal(queued, undefined);
      const excluded = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id).assignments.find(item => item.id === assignment.assignment_id);
      assert.equal(excluded.status, 'excluded_protocol');
      assert.equal(excluded.protocol_exclusion.reason, 'ambiguous_interaction_outcome');
      continue;
    }
    assert.equal(Boolean(queued), true);
    assert.deepEqual(queued.derived_metrics, ['correction_risk_accuracy']);
    assert.equal(queued.outcome_metrics.includes('correction_risk_accuracy'), false);
    store.resolveContextAssignment(assignment.assignment_id, { evaluator_id: 'blind-calibration-rater',
      metrics: { correction_precision: 0.9, evidence_access_quality: 0.9, first_order_task_quality: 0.9 },
      evidence: [{ type: 'independent_output_monitor_grade', id: assignment.assignment_id }],
      notes: 'Condition-blind response-quality grade.' });
  }

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.prospective_output_calibration_dissociation.predicted_pattern, true);
  assert.equal(evaluation.prospective_output_calibration_dissociation.identical_calibration_content_verified, true);
  assert.equal(evaluation.prospective_output_calibration_dissociation.delayed_outcomes_verified, true);
  assert.equal(evaluation.prospective_output_calibration_dissociation.attrition_balanced, true);
  assert.deepEqual(Object.values(evaluation.prospective_output_calibration_dissociation.attrition_rates), [1 / 15, 1 / 15, 1 / 15]);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.prospective_output_calibration_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'prospective_output_calibration_control').status, 'causal_signal_observed');

  assert.throws(() => store.createContextTrial(design({ id: 'output-calibration-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id })), /twenty new replay-valid ordinary outcomes/);

  await seedOrdinaryCalibration(store, 20, 'confirmation-seed');
  const confirmation = store.createContextTrial(design({ id: 'output-calibration-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  const internalTrials = store.snapshot().cognition.self_model.context_trials;
  const internalPilot = internalTrials.find(item => item.id === trial.id);
  const internalConfirmation = internalTrials.find(item => item.id === confirmation.id);
  assert.equal(internalConfirmation.output_calibration_context.source_resolution_commitments.length, 20);
  assert.equal(internalConfirmation.output_calibration_context.source_resolution_commitments.some(commitment => internalPilot.output_calibration_context.source_resolution_commitments.includes(commitment)), false);
  const confirmationSources = internalConfirmation.output_calibration_context.source_resolution_commitments.map(commitment => store.snapshot().cognition.prospective_output_monitor.records.find(item => item.outcome_resolution_commitment === commitment));
  assert.equal(confirmationSources.every(record => new Date(record.outcome_resolution.resolved_at) > new Date(internalPilot.completed)), true);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sourceCommitment = raw.cognition.self_model.context_trials.find(item => item.id === trial.id).output_calibration_context.source_resolution_commitments[0];
  raw.cognition.prospective_output_monitor.records.find(item => item.outcome_resolution_commitment === sourceCommitment).outcome_resolution.brier_score = 0.99;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  const reloadedVisible = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(reloadedVisible.prospective_output_calibration_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'prospective_output_calibration_control').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
