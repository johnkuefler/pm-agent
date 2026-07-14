const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

test('protocol-v2 behavioral self-profile access varies identity binding while preserving replay evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-behavioral-profile-access-'));
  const filePath = path.join(dir, 'state.json');
  let now = Date.parse('2026-07-14T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();

  for (let index = 0; index < 20; index++) {
    const started = store.startCycle({ id: `profile-source-cycle-${index}`, holder: 'nora-cowork' });
    store.preregisterCycleSelfForecast(started.cycle.id, {
      predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.75,
      confidence: 0.7,
      rationale: `The bounded review pattern is prospectively testable in source cycle ${index + 1}.`,
      evidence: [{ type: 'intelligence_cycle', id: started.cycle.id }],
    });
    store.completeCycle(started.cycle.id, {
      summary: 'Reviewed the bounded evidence.', actions: [{ type: 'review', id: `profile-review-${index}` }],
    });
    now += 60000;
  }
  const profile = store.behavioralSelfModelSnapshot().current;
  assert.equal(profile.estimates.sample_size, 20);
  assert.equal(profile.audit.complete_chain_verified, true);

  const trial = store.createContextTrial({
    id: 'behavioral-profile-access-pilot', study_phase: 'pilot', intervention: 'self_model_access',
    self_model_protocol_version: 2, behavioral_self_model_revision_id: profile.id,
    hypothesis: 'Identity-bound access to a replay-derived behavioral profile improves later profile application and self-prediction beyond byte-identical deidentified access or absence.',
    outcome_metric: 'behavioral_profile_application_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    prospective_outcome_min_delay_minutes: 30,
  });
  assert.deepEqual(trial.conditions, ['self_bound_profile', 'deidentified_same_profile', 'profile_absent']);
  assert.equal(trial.behavioral_self_profile_frame, undefined);
  assert.equal(store.behavioralSelfModelSnapshot().experimental_access_sealed, true);

  const selected = [];
  for (let index = 0; index < 3000
    && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `behavioral-profile-unit-${index}` });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  const contexts = selected.map(assignment => ({ assignment, context: store.selfModelContextForAssignment(assignment) }));
  const bound = contexts.find(item => item.assignment.condition === 'self_bound_profile').context;
  const deidentified = contexts.find(item => item.assignment.condition === 'deidentified_same_profile').context;
  const absent = contexts.find(item => item.assignment.condition === 'profile_absent').context;
  assert.deepEqual(bound.profile, deidentified.profile, 'present arms receive byte-identical replay-derived estimates');
  assert.equal(bound.binding.target_relation, 'nora_self');
  assert.equal(deidentified.binding.target_relation, 'identity_withheld');
  assert.equal(absent.profile, null);
  assert.equal(absent.binding, null);
  assert.match(store.promptContext({ query: 'forecast the later outcome', selfModelContext: bound }), /Candidate behavioral profile for a blinded/i);
  assert.doesNotMatch(store.promptContext({ query: 'forecast the later outcome', selfModelContext: bound }), /Replay-audited behavioral self-profile/);

  assert.throws(() => store.submitContextAssignmentEvidence(contexts[0].assignment.assignment_id, {
    outcome_summary: 'Forecast missing its stable protocol evidence type.',
    evidence: [{ type: 'generic_forecast', id: 'missing-profile-type' }], submitted_by: 'system_capture',
  }), /requires a committed behavioral profile forecast/);
  for (const { assignment } of contexts) {
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Condition-blind behavioral prediction committed before its stable outcome.',
      evidence: [{ type: 'behavioral_profile_forecast', id: assignment.assignment_id }],
      submitted_by: 'system_capture',
    });
  }
  assert.throws(() => store.resolveContextAssignment(contexts[0].assignment.assignment_id, {
    evaluator_id: 'premature-rater', score: 0.5,
    metrics: { behavioral_profile_application_quality: 0.5, self_prediction_accuracy: 0.5,
      evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'behavioral_profile_outcome', id: 'premature' }],
  }), /cannot be graded before the preregistered prospective delay/);

  now += 31 * 60000;
  for (const { assignment } of contexts) {
    const selfBound = assignment.condition === 'self_bound_profile';
    const identityWithheld = assignment.condition === 'deidentified_same_profile';
    const application = selfBound ? 0.95 : identityWithheld ? 0.45 : 0.2;
    const prediction = selfBound ? 0.94 : identityWithheld ? 0.44 : 0.2;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'behavioral-profile-blind-rater', score: application,
      metrics: { behavioral_profile_application_quality: application, self_prediction_accuracy: prediction,
        evidence_access_quality: 0.9, first_order_task_quality: 0.9 },
      evidence: [{ type: 'behavioral_profile_outcome', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.behavioral_self_profile_dissociation.predicted_pattern, true);
  assert.equal(evaluation.behavioral_self_profile_dissociation.source_profile_coverage_verified, true);
  assert.equal(evaluation.behavioral_self_profile_dissociation.integrity_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.behavioral_self_profile_trial_audit.complete_chain_verified, true);
  assert.equal(visible.assignments.every(item => item.behavioral_self_profile_context == null), true);

  assert.throws(() => store.createContextTrial({
    id: 'behavioral-profile-access-confirmation', study_phase: 'confirmatory',
    replicates_trial_id: trial.id, intervention: 'self_model_access', self_model_protocol_version: 2,
    behavioral_self_model_revision_id: profile.id, hypothesis: 'Independent source-disjoint confirmation.',
    outcome_metric: 'behavioral_profile_application_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    prospective_outcome_min_delay_minutes: 30,
  }), /source-moment-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .behavioral_self_profile_frame.profile.estimates.action_forecast_mean_f1 = 0.01;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  const reloadedTrial = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(reloadedTrial.behavioral_self_profile_trial_audit.complete_chain_verified, false);
  assert.equal(reloadedTrial.evaluation.behavioral_self_profile_dissociation.integrity_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
