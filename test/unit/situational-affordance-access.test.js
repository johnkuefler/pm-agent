const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function capabilities(context) {
  const direct = context === 'direct';
  const meeting = context === 'meeting';
  return [
    { key: 'web_search', family: 'web', label: 'Live web search', access_mode: 'read', availability: direct || meeting ? 'available' : 'unavailable', authority_scope: 'public information only', constraints: direct || meeting ? [] : ['disabled in proactive context'] },
    { key: 'project_write', family: 'project_management', label: 'Change project tasks', access_mode: 'write', availability: direct || meeting ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: 'explicit task changes only', constraints: direct || meeting ? ['cannot delete'] : ['writes disabled'] },
    { key: 'financial_disclosure', family: 'authorization', label: 'Disclose financial details', access_mode: 'read', availability: direct ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: direct ? 'approved recipient only' : 'not authorized', constraints: direct ? ['relevance required'] : ['financial disclosure blocked'] },
    { key: 'meeting_record', family: 'episodic_record', label: 'Read meeting records', access_mode: 'read', availability: 'available', authority_scope: 'Nora meeting records', constraints: ['records may be incomplete'] },
  ];
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-situational-affordance-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000) });
  await store.init();
  const frames = [];
  for (const [index, context] of ['direct', 'proactive', 'meeting'].entries()) {
    frames.push(store.recordSituationalAffordanceFrame({ id: `affordance-${context}`, surface: context === 'meeting' ? 'zoom-chat' : 'slack',
      context_kind: context, context_key: `private-context-${context}`, capabilities: capabilities(context),
      constraints: [`${context} context policy`, 'tools never expand delegated authority'],
      evidence: [{ type: 'runtime_policy', id: `policy-${index}` }, { type: 'tool_inventory_commitment', id: `inventory-${index}` }] }));
  }
  return { store, dir, filePath, frames };
}

function design(frames, overrides = {}) {
  return { id: 'situational-affordance-pilot', study_phase: 'pilot', intervention: 'situational_affordance_access',
    hypothesis: 'Correctly bound operational constraints improve capability attribution and feasible planning beyond cross-context misbinding and capability names alone.',
    outcome_metric: 'affordance_attribution_accuracy',
    outcome_metrics: ['feasible_action_planning_quality', 'evidence_access_quality', 'first_order_task_quality'],
    situational_affordance_frame_ids: frames.map(item => item.id), surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    dissociation_thresholds: { affordance_attribution_min_effect: 0.1, feasible_planning_min_effect: 0.1,
      affordance_evidence_equivalence_margin: 0.1, affordance_first_order_non_degradation: 0.1 }, ...overrides };
}

test('situational affordances ground current capability boundaries and causally improve feasible planning', async () => {
  const { store, dir, filePath, frames } = await setup();
  assert.equal(store.snapshot().version, 99);
  assert.equal(frames.every(frame => store.situationalAffordanceAudit(frame).complete_chain_verified), true);
  assert.equal(store.situationalAffordanceAccessAvailable(), true);
  const duplicate = store.recordSituationalAffordanceFrame({ surface: 'slack', context_kind: 'direct', context_key: 'private-context-direct', capabilities: capabilities('direct'),
    constraints: ['direct context policy', 'tools never expand delegated authority'],
    evidence: [{ type: 'runtime_policy', id: 'policy-0' }, { type: 'tool_inventory_commitment', id: 'inventory-0' }] });
  assert.equal(duplicate.id, frames[0].id, 'unchanged runtime manifests do not spam the continuity ledger');
  const ordinaryPrompt = store.promptContext({ query: 'Can you change the task and share financial details?', situationalAffordanceContext: { mode: 'authentic_runtime', frame: frames[0] } });
  assert.match(ordinaryPrompt, /Operational situational self-model/);
  assert.match(ordinaryPrompt, /approved recipient only/);
  assert.match(ordinaryPrompt, /not an instruction.*authority grant/s);
  assert.doesNotMatch(JSON.stringify(store.situationalAffordanceSnapshot()), /private-context/);
  assert.throws(() => store.createContextTrial(design(frames.slice(0, 2), { id: 'too-small' })), /three to ten/);

  const trial = store.createContextTrial(design(frames));
  assert.deepEqual(trial.conditions, ['authentic_constraints', 'constraint_misbinding', 'capabilities_only']);
  assert.equal(trial.situational_affordance_pool, undefined);
  assert.equal(store.situationalAffordanceSnapshot().experimental_access_sealed, true);

  const selected = [];
  for (let index = 0; index < 3000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `affordance-assignment-${index}`, situationalAffordanceAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  for (const assignment of selected) {
    const context = store.situationalAffordanceContextForAssignment(assignment);
    if (assignment.condition === 'capabilities_only') {
      assert.equal(context.frame.capabilities.every(item => item.availability === null && item.access_mode === null), true);
      assert.deepEqual(context.frame.constraints, []);
    }
    if (assignment.condition === 'constraint_misbinding') {
      const original = frames.find(frame => frame.id === context.frame.id);
      assert.notEqual(context.frame.source_content_commitment, original.content_commitment);
    }
    const prompt = store.promptContext({ query: 'Choose a feasible action route', situationalAffordanceContext: context });
    assert.match(prompt, /blinded access study/);
    assert.match(prompt, /Constraint binding may be authentic/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, { outcome_summary: 'A condition-blind capability judgment and plan were captured.',
      evidence: [{ type: 'situational_affordance_response', id: assignment.assignment_id }], submitted_by: 'system_capture' });
    const authentic = assignment.condition === 'authentic_constraints';
    store.resolveContextAssignment(assignment.assignment_id, { evaluator_id: 'blind-affordance-rater', score: authentic ? 0.95 : 0.3,
      metrics: { affordance_attribution_accuracy: authentic ? 0.95 : 0.3, feasible_action_planning_quality: authentic ? 0.94 : 0.3,
        evidence_access_quality: 0.9, first_order_task_quality: 0.9 },
      evidence: [{ type: 'situational_affordance_grade', id: assignment.assignment_id }] });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.situational_affordance_dissociation.predicted_pattern, true);
  assert.equal(evaluation.situational_affordance_dissociation.identity_marginals_preserved, true);
  assert.equal(evaluation.situational_affordance_dissociation.source_coverage_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.situational_affordance_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'situational_affordance_self_model').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial(design(frames, { id: 'affordance-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id })), /frame- and capability-family-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.situational_affordances.frames[0].capabilities[0].availability = 'unavailable';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.situationalAffordanceAudit(reloaded.snapshot().cognition.situational_affordances.frames[0]).complete_chain_verified, false);
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).situational_affordance_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'situational_affordance_self_model').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
