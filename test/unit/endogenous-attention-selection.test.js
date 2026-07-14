'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const endogenousAttention = require('../../src/intelligence/endogenous-attention');

const now = () => new Date('2026-07-13T18:00:00Z');

function design() {
  return {
    id: 'endogenous-attention-pilot', hypothesis: 'Authentic self-schema-guided target selection improves bounded attention control beyond misbound schema selection and no selection',
    intervention: 'endogenous_attention_selection', study_phase: 'pilot', surfaces: ['slack'],
    outcome_metric: 'attention_target_quality',
    outcome_metrics: ['attention_control_quality', 'first_order_task_quality'],
    sample_target_per_group: 10, evaluator_target: 1,
  };
}

test('endogenous attention selection is prospective, self-schema-specific, and tamper-evident', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-endogenous-attention-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: now });
  await store.init();
  assert.equal(store.snapshot().version, 93);

  const packet = endogenousAttention.selectionPacket({ capacity: 2, candidate_manifest: [
    { type: 'commitment', id: 'a', text: 'alpha', score: 3 },
    { type: 'commitment', id: 'b', text: 'beta', score: 2 },
    { type: 'commitment', id: 'c', text: 'gamma', score: 1 },
  ] }, { condition: 'schema_misbound_selection', seed: 'seed' });
  assert.deepEqual(packet.candidates.map(item => item.summary), ['alpha', 'beta', 'gamma']);
  assert.notDeepEqual(packet.candidates.map(item => item.access_status), ['currently_accessible', 'currently_accessible', 'currently_suppressed']);
  assert.throws(() => endogenousAttention.parseSelection('{"target_key":"commitment:missing","confidence":0.8,"predicted_effect":"help","evidence":"packet"}', packet), /supplied candidate/);

  for (let index = 0; index < 12; index++) store.addCommitment({ what: `Preserve evidence item ${index} for the attention experiment`, owner: 'Nora' });
  assert.equal(store.endogenousAttentionSelectionAvailable({ surface: 'slack', query: 'attention experiment' }), true);
  assert.throws(() => store.createContextTrial({ ...design(), id: 'wrong-metrics', outcome_metrics: ['first_order_task_quality'] }), /attention_control_quality/);
  const trial = store.createContextTrial(design());
  assert.deepEqual(trial.conditions, ['self_schema_selection', 'schema_misbound_selection', 'no_selection']);
  assert.equal(store.endogenousAttentionSnapshot().experimental_access_sealed, true);

  const chosen = [];
  for (let index = 0; index < 3000 && !trial.conditions.every(condition => chosen.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `attention-unit-${index}`, endogenousAttentionAvailable: true });
    if (assignment && chosen.filter(item => item.condition === assignment.condition).length < 10) chosen.push(assignment);
  }
  assert.equal(chosen.length, 30);

  for (const [index, assignment] of chosen.entries()) {
    const task = `Use the most relevant currently at-risk evidence for attention task ${index}`;
    const record = store.beginEndogenousAttentionSelection(assignment, { surface: 'slack', task_prompt: task, query: task, model: 'claude-opus-4-8' });
    assert.equal(record.status, 'pending');
    let completed;
    if (assignment.condition === 'no_selection') {
      completed = store.completeEndogenousAttentionSelection(record.id, { task_prompt: task });
    } else {
      const target = record.selection_packet.candidates.find(item => item.access_status === 'currently_suppressed') || record.selection_packet.candidates[0];
      const selection = { target_key: target.key, confidence: 0.9, predicted_effect: 'The target should remain available for the requested answer.', evidence: 'Its supplied access status marks it as currently suppressed.' };
      completed = store.completeEndogenousAttentionSelection(record.id, { task_prompt: task, selection,
        provider_receipt: { response_id: `attention-provider-${index}`, model: 'claude-opus-4-8', input_tokens: 20, output_tokens: 15, prompt_commitment: endogenousAttention.commitment(`prompt-${index}`) } });
    }
    assert.equal(completed.audit.complete_chain_verified, false, 'prompt application is a separate prospective receipt');
    const attentionContext = store.endogenousAttentionContextForAssignment(assignment);
    const prompt = store.promptContext({ query: task, channel: 'slack', capacity: 3, includeCognitivePulses: false,
      attentionDirectivesOverride: attentionContext.directives, returnWorkspaceReceipt: true });
    const applied = store.markEndogenousAttentionSelectionApplied(assignment, prompt.workspace);
    assert.equal(applied.audit.complete_chain_verified, true);
    store.recordEndogenousAttentionResponse(assignment.assignment_id, { task_prompt: task,
      public_response: `Response grounded in the selected evidence for item ${index}.`, delivered: true, interaction_id: `slack-${index}` });
    const queue = store.contextTrialGradingQueue({ evaluatorId: 'blind-attention-rater' });
    const queued = queue.assignments.find(item => item.assignment_id === assignment.assignment_id);
    assert.equal(Boolean(queued), true);
    assert.equal(Array.isArray(queued.evidence_package.evaluation_target.candidates), true);
    assert.equal(Object.hasOwn(queued.evidence_package.evaluation_target, 'selected_target'), true);
    const self = assignment.condition === 'self_schema_selection';
    const score = self ? 0.95 : assignment.condition === 'schema_misbound_selection' ? 0.3 : 0.2;
    store.resolveContextAssignment(assignment.assignment_id, { evaluator_id: 'blind-attention-rater', score,
      metrics: { attention_target_quality: score, attention_control_quality: self ? 0.94 : score, first_order_task_quality: 0.9 },
      evidence: [{ type: 'independent_attention_grade', id: assignment.assignment_id }] });
  }

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.endogenous_attention_selection_dissociation.predicted_pattern, true);
  assert.equal(evaluation.endogenous_attention_selection_dissociation.same_model_control_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.endogenous_attention_selection_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_attention_allocation').status, 'causal_signal_observed');

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.endogenous_attention.selections[0].selection_packet.candidates[0].access_status = 'tampered';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: now });
  await reloaded.init();
  const invalid = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(invalid.endogenous_attention_selection_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'endogenous_attention_allocation').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
