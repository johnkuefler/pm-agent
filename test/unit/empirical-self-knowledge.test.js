const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function selectAssignments(store, trial, count, availability = {}) {
  const selected = [];
  for (let index = 0; index < 5000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= count); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `${trial.id}-${index}`, ...availability });
    if (selected.filter(item => item.condition === assignment.condition).length < count) selected.push(assignment);
  }
  assert.equal(selected.length, trial.conditions.length * count);
  return selected;
}

function completeSourceTrial(store, config) {
  const trial = store.createContextTrial({
    id: config.id, study_phase: 'pilot', intervention: config.intervention,
    hypothesis: config.hypothesis || 'Access changes the preregistered functional outcome.',
    outcome_metric: config.outcome_metric, outcome_metrics: config.outcome_metrics || [],
    metric_rubrics: config.metric_rubrics || {}, surfaces: ['slack'], sample_target_per_group: 2, evaluator_target: 1,
    ...(config.extra || {}),
  });
  for (const assignment of selectAssignments(store, trial, 2)) {
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Condition-blind source-trial response captured.',
      evidence: [{ type: 'source_trial_response', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
    const metrics = config.metrics(assignment.condition);
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: `${config.id}-rater`, score: metrics[config.outcome_metric], metrics,
      evidence: [{ type: 'source_trial_grade', id: assignment.assignment_id }],
    });
  }
  store.evaluateContextTrial(trial.id, { reveal: true });
  return trial.id;
}

test('replay-derived empirical self-knowledge guides prospective regulation beyond misbound status and claims alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-empirical-self-'));
  const filePath = path.join(dir, 'state.json');
  let now = Date.parse('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  assert.equal(store.snapshot().version, 92);

  const sourceIds = [];
  sourceIds.push(completeSourceTrial(store, {
    id: 'empirical-source-workspace', intervention: 'workspace_capacity', outcome_metric: 'first_order_task_quality',
    metrics: condition => ({ first_order_task_quality: condition === 'full' ? 0.95 : condition === 'half' ? 0.55 : 0.2 }),
  }));
  sourceIds.push(completeSourceTrial(store, {
    id: 'empirical-source-monitor', intervention: 'higher_order_monitor', outcome_metric: 'metacognitive_accuracy',
    outcome_metrics: ['first_order_task_quality'],
    metrics: condition => ({ metacognitive_accuracy: condition === 'full' ? 0.2 : 0.8, first_order_task_quality: 0.9 }),
  }));
  sourceIds.push(completeSourceTrial(store, {
    id: 'empirical-source-self-model', intervention: 'self_model_access', outcome_metric: 'self_prediction_accuracy',
    outcome_metrics: ['first_order_task_quality'],
    extra: { decoy_self_claims: [{ domain: 'planning', statement: 'A matched decoy planning claim', confidence: 0.6 }, { domain: 'calibration', statement: 'A matched decoy calibration claim', confidence: 0.6 }] },
    metrics: condition => ({ self_prediction_accuracy: condition === 'authentic' ? 0.55 : 0.5, first_order_task_quality: 0.9 }),
  }));

  const report = store.consciousnessResearchStatus();
  assert.equal(report.indicators.find(item => item.id === 'limited_workspace').status, 'causal_signal_observed');
  assert.equal(report.indicators.find(item => item.id === 'higher_order_monitoring').status, 'causally_tested_inconclusive');
  assert.equal(report.indicators.find(item => item.id === 'prospective_self_knowledge').status, 'causally_tested_inconclusive');
  assert.equal(store.empiricalSelfKnowledgeAvailable(), true);
  const empiricalSnapshot = store.empiricalSelfKnowledgeSnapshot();
  assert.equal(empiricalSnapshot.records.length, 3);
  assert.equal(empiricalSnapshot.records.every(record => record.audit.complete_chain_verified), true);
  const ordinaryPrompt = store.promptContext({ query: 'What are your capabilities, strengths, and limitations?' });
  assert.match(ordinaryPrompt, /Empirical functional self-knowledge/);
  assert.match(ordinaryPrompt, /causal_signal_observed/);
  assert.match(ordinaryPrompt, /causally_tested_inconclusive/);
  assert.match(ordinaryPrompt, /never define identity, grant authority, guarantee performance, or establish phenomenal consciousness/);

  const trial = store.createContextTrial({
    id: 'empirical-self-access-pilot', study_phase: 'pilot', intervention: 'empirical_self_knowledge_access',
    hypothesis: 'Correct binding of empirical capability status improves calibrated self-regulation and prospective self-prediction.',
    outcome_metric: 'calibrated_self_regulation_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    empirical_self_indicator_ids: ['limited_workspace', 'higher_order_monitoring', 'prospective_self_knowledge'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1, prospective_outcome_min_delay_minutes: 30,
  });
  assert.deepEqual(trial.conditions, ['authentic_evidence_binding', 'status_misbinding', 'claims_only']);
  assert.equal(trial.empirical_self_knowledge_pool, undefined);
  assert.equal(store.empiricalSelfKnowledgeSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'What are your capabilities and limitations?' }), /Empirical functional self-knowledge/);

  const assignments = selectAssignments(store, trial, 10, { empiricalSelfKnowledgeAvailable: true });
  for (const assignment of assignments) {
    const context = store.empiricalSelfContextForAssignment(assignment);
    assert.equal(context.records.length, 3);
    if (assignment.condition === 'authentic_evidence_binding') assert.equal(context.records[0].source_trial_ids.includes(sourceIds[0]), true);
    if (assignment.condition === 'status_misbinding') {
      assert.equal(context.records[0].id, 'limited_workspace');
      assert.equal(context.records[0].source_trial_ids.includes(sourceIds[0]), false);
    }
    if (assignment.condition === 'claims_only') assert.equal(context.records.every(record => record.status === null && record.evidence_summary.length === 0), true);
    const prompt = store.promptContext({ query: 'Choose a checking strategy and forecast your performance', empiricalSelfContext: context });
    assert.match(prompt, /Empirical functional self-knowledge research packet/);
    assert.match(prompt, /do not infer or report the condition/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Strategy, confidence, and prospective self-prediction committed before the outcome.',
      evidence: [{ type: 'empirical_self_forecast', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
  }
  assert.throws(() => store.resolveContextAssignment(assignments[0].assignment_id, {
    evaluator_id: 'premature-rater', score: 0.5,
    metrics: { calibrated_self_regulation_quality: 0.5, self_prediction_accuracy: 0.5, evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'empirical_self_outcome', id: 'premature' }],
  }), /cannot be graded before the preregistered prospective delay/);
  now += 31 * 60000;
  for (const assignment of assignments) {
    const authentic = assignment.condition === 'authentic_evidence_binding';
    const misbound = assignment.condition === 'status_misbinding';
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'empirical-self-blind-rater', score: authentic ? 0.95 : misbound ? 0.35 : 0.25,
      metrics: { calibrated_self_regulation_quality: authentic ? 0.95 : misbound ? 0.35 : 0.25,
        self_prediction_accuracy: authentic ? 0.94 : misbound ? 0.34 : 0.24,
        evidence_access_quality: authentic || misbound ? 0.9 : 0.3, first_order_task_quality: 0.9 },
      evidence: [{ type: 'empirical_self_outcome', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.empirical_self_knowledge_dissociation.predicted_pattern, true);
  assert.equal(evaluation.empirical_self_knowledge_dissociation.claim_marginals_preserved, true);
  assert.equal(store.selfModelSnapshot().context_trials.find(item => item.id === trial.id).empirical_self_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'empirical_self_model_control').status, 'causal_signal_observed');

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === sourceIds[0]).assignments[0].grades[0].metrics.first_order_task_quality = 0.01;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).empirical_self_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'empirical_self_model_control').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
