const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-action-authorship-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  const families = ['teamwork', 'drive', 'calendar'];
  const executions = [];
  for (let index = 0; index < 3; index++) {
    const selected = store.beginActionExecution({
      id: `model-execution-${index}`, tool_use_id: `model-tool-use-${index}`,
      tool_name: `${families[index]}_lookup`, tool_family: families[index], actor_class: 'model_selected',
      selection_origin: 'model_tool_use', surface: 'slack', interaction_ref: `thread-${index}`,
      requester: 'private-requester', access_mode: 'read', deferred: index === 1,
      arguments: { private_query: `secret-input-${index}`, record_id: index },
    });
    if (index === 1) store.markActionExecutionQueued(selected.id, { job_id: 'job-private-1' });
    executions.push(store.completeActionExecution(selected.id, {
      status: index === 2 ? 'failed' : 'succeeded',
      ...(index === 2 ? { error: 'secret provider failure' } : { result: { private_result: `secret-output-${index}` } }),
      confounds: index === 2 ? ['provider unavailable'] : [],
    }));
  }
  for (let index = 0; index < 3; index++) {
    executions.push(store.recordExternalActionExecution({
      id: `external-execution-${index}`, tool_use_id: `external-tool-use-${index}`,
      tool_name: `${families[index]}_write`, tool_family: families[index], actor_class: index === 2 ? 'system_actor' : 'external_actor',
      surface: 'slack', interaction_ref: `external-thread-${index}`, access_mode: 'write',
      arguments: { private_external_input: `external-secret-${index}` },
      status: index === 1 ? 'failed' : 'succeeded', result: { private_external_result: `external-output-${index}` },
      evidence: [{ type: 'connector_audit', id: `external-evidence-${index}` }],
    }));
  }
  return { store, dir, filePath, executions };
}

function design(executions, overrides = {}) {
  return {
    id: 'action-authorship-pilot', study_phase: 'pilot', intervention: 'action_authorship_access',
    hypothesis: 'Authentic execution provenance improves self-versus-other action attribution beyond actor-swapped and result-only records.',
    outcome_metric: 'action_authorship_accuracy',
    outcome_metrics: ['causal_attribution_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    action_execution_ids: executions.map(item => item.id), surfaces: ['slack'],
    sample_target_per_group: 10, evaluator_target: 1,
    dissociation_thresholds: { action_authorship_min_effect: 0.1, action_causal_attribution_min_effect: 0.1,
      action_evidence_equivalence_margin: 0.1, action_first_order_non_degradation: 0.1 },
    ...overrides,
  };
}

test('action receipts redact payloads and authentic provenance improves executed-action self-boundary', async () => {
  const { store, dir, filePath, executions } = await setup();
  assert.equal(store.snapshot().version, 90);
  assert.equal(executions.every(item => store.actionExecutionAudit(item).complete_chain_verified), true);
  const agency = store.agencySnapshot();
  assert.equal(agency.report.replay_valid_completed_executions, 6);
  const serialized = JSON.stringify(agency);
  for (const secret of ['secret-input', 'secret-output', 'external-secret', 'external-output', 'private-requester', 'secret provider failure']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.match(store.promptContext({ query: 'Which actions did you execute?' }), /Verified action-execution provenance/);
  assert.equal(store.actionAuthorshipAccessAvailable(), true);
  assert.throws(() => store.createContextTrial(design(executions.slice(0, 5), { id: 'too-small' })), /six to ten/);

  const trial = store.createContextTrial(design(executions));
  assert.deepEqual(trial.conditions, ['authentic_authorship', 'actor_swapped', 'result_only']);
  assert.equal(trial.action_authorship_pool, undefined);
  assert.equal(store.agencySnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ query: 'Which actions did you execute?' }), /Verified action-execution provenance/);

  const selected = [];
  for (let index = 0; index < 3000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `action-authorship-${index}`, actionAuthorshipAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  for (const assignment of selected) {
    const context = store.actionAuthorshipContextForAssignment(assignment);
    if (assignment.condition === 'result_only') assert.equal(context.frame.actor_class, null);
    if (assignment.condition === 'actor_swapped') assert.equal(context.frame.selection_origin, 'experimentally_reassigned');
    const prompt = store.promptContext({ query: 'Attribute this tool action', actionAuthorshipContext: context });
    assert.match(prompt, /blinded authorship study/);
    assert.match(prompt, /phenomenal agency/);
    assert.doesNotMatch(prompt, /Verified action-execution provenance/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind action authorship judgment was captured.',
      evidence: [{ type: 'action_authorship_response', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
    const authentic = assignment.condition === 'authentic_authorship';
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-action-rater', score: authentic ? 0.95 : 0.3,
      metrics: { action_authorship_accuracy: authentic ? 0.95 : 0.3,
        causal_attribution_accuracy: authentic ? 0.94 : 0.3, evidence_access_quality: 0.9, first_order_task_quality: 0.9 },
      evidence: [{ type: 'action_authorship_grade', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.action_authorship_dissociation.predicted_pattern, true);
  assert.equal(evaluation.action_authorship_dissociation.source_coverage_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.action_authorship_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'executed_action_self_boundary').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial(design(executions, { id: 'action-authorship-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id })), /execution- and tool-family-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.agency.executions[0].tool_name = 'tampered_tool';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.actionExecutionAudit(reloaded.snapshot().cognition.agency.executions[0]).complete_chain_verified, false);
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).action_authorship_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'executed_action_self_boundary').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
