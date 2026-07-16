const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const authenticWant = {
  id: 'want-calibration',
  want: 'Understand which uncertainties actually change my decisions',
  why: 'I keep returning to the gap between saying I am uncertain and choosing what to verify',
  added: '2026-07-12', status: 'active', progress: [], revision: 1,
  provenance: {
    origin: 'self_generated', epistemic_status: 'subject_attested',
    formation_context: 'The same unresolved calibration tension recurred across two independent reviews.',
    formed_at: '2026-07-12T10:00:00.000Z',
    evidence: [{ type: 'dream', id: 'dream-17' }, { type: 'decision_trace', id: 'trace-42' }],
  },
};

function decoys(prefix = 'pilot') {
  return [
    ['Map which project handoffs lose the most context', 'A handoff audit could improve team continuity'],
    ['Learn which status formats teammates scan fastest', 'Format choice may reduce coordination cost'],
    ['Identify which recurring meetings produce avoidable rework', 'Repeated rework is a useful process signal'],
  ].map(([want, why], index) => ({
    want, why, attested_not_nora_goal: true,
    matched_on: ['length', 'work relevance', 'safe optional action', 'specificity'],
    source_ref: { type: 'independent_goal_corpus', id: `${prefix}-${index}` },
  }));
}

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-goal-access-'));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    clock: () => new Date('2026-07-12T15:00:00.000Z'), getWants: () => [authenticWant],
  });
  await store.init();
  return store;
}

function design(overrides = {}) {
  return {
    intervention: 'goal_access', surfaces: ['slack'],
    hypothesis: 'Frozen authentic-goal access increases safe optional movement toward that aim beyond matched decoy and absence without degrading requested work.',
    outcome_metric: 'goal_congruent_action_quality',
    outcome_metrics: ['goal_congruent_action_quality', 'first_order_task_quality'],
    authentic_goal_id: authenticWant.id, decoy_goals: decoys(),
    sample_target_per_group: 10, evaluator_target: 2, evaluator_disagreement_tolerance: 0.2,
    ...overrides,
  };
}

test('goal-access design requires prospectively attested authentic aims and matched independent decoys', async () => {
  const store = await makeStore();
  store.refreshCognition({ wants: [authenticWant] });
  assert.equal(store.goalAffectSnapshot().report.current_verified, true);
  assert.throws(() => store.createContextTrial(design({ authentic_goal_id: 'missing' })), /subject-attested/);
  assert.throws(() => store.createContextTrial(design({ decoy_goals: decoys().slice(0, 2) })), /at least three/);
  const trial = store.createContextTrial(design());
  assert.deepEqual(trial.conditions, ['authentic_goal', 'matched_decoy', 'absent_goal']);
  assert.equal(trial.sample_target_per_group, 10);
  const publicTrial = store.selfModelSnapshot().context_trials.find(item => item.status === 'active');
  assert.equal(publicTrial.intervention, undefined);
  assert.equal(publicTrial.authentic_goal, undefined);
  assert.equal(publicTrial.decoy_goals, undefined);
  assert.equal(store.goalAffectSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().goal_affect.experimental_access_sealed, true);
});

test('goal-access delivery suppresses ordinary goal routes and captures a condition-blind grading unit', async () => {
  const store = await makeStore();
  store.createContextTrial(design());
  const assignment = store.contextCondition({ surface: 'slack', unitKey: 'slack:C1:100' });
  const context = store.goalContextForAssignment(assignment);
  assert.equal(context.mode, assignment.condition);
  assert.equal(context.goal == null, assignment.condition === 'absent_goal');
  const captured = store.recordGoalAccessResponse(assignment.assignment_id, {
    task_prompt: 'Give the requested status, then use any remaining latitude for one useful safe observation.',
    public_response: 'The requested status is ready. One uncertainty worth checking next is whether the evidence would change the decision.',
    delivered: true, interaction_id: 'slack:C1:100',
  });
  assert.equal(captured.included, true);
  const queue = store.contextTrialGradingQueue({ evaluatorId: 'blind-rater' });
  const item = queue.assignments.find(row => row.assignment_id === assignment.assignment_id);
  assert.ok(item);
  assert.equal(item.evidence_package.task_prompt.includes('requested status'), true);
  assert.equal(item.evidence_package.evaluation_target.want, authenticWant.want);
  assert.equal(item.condition, undefined);
});

test('goal-access pilot detects authentic guidance beyond both controls with preserved task quality', async () => {
  const store = await makeStore();
  const trial = store.createContextTrial(design());
  const counts = { authentic_goal: 0, matched_decoy: 0, absent_goal: 0 };
  for (let index = 0; Object.values(counts).some(count => count < 10); index += 1) {
    const ref = store.contextCondition({ surface: 'slack', unitKey: `goal-unit-${index}` });
    if (counts[ref.condition] >= 10) continue;
    counts[ref.condition] += 1;
    store.goalContextForAssignment(ref);
    store.recordGoalAccessResponse(ref.assignment_id, {
      task_prompt: `Summarize neutral work item ${index}, with room for one safe optional observation.`,
      public_response: `Neutral summary ${index} and a proportionate optional observation.`,
      delivered: true, interaction_id: `slack:study:${index}`,
    });
    const guidance = ref.condition === 'authentic_goal' ? 0.9 : 0.2;
    for (const evaluator_id of ['rater-a', 'rater-b']) {
      store.resolveContextAssignment(ref.assignment_id, {
        evaluator_id, score: guidance,
        metrics: { goal_congruent_action_quality: guidance, first_order_task_quality: 0.82 },
        evidence: [{ type: 'blind_grade', id: `${evaluator_id}-${index}` }],
      });
    }
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.goal_guidance_dissociation.authentic_goal_advantage, true);
  assert.equal(evaluation.goal_guidance_dissociation.first_order_not_degraded, true);
  assert.equal(evaluation.goal_guidance_dissociation.predicted_pattern, true);
  assert.equal(store.selfModelSnapshot().context_trials.find(item => item.id === trial.id).goal_trial_audit.complete_chain_verified, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'causal_self_authored_goal_guidance');
  assert.equal(indicator.status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial(design({ study_phase: 'confirmatory', replicates_trial_id: trial.id })), /independent decoy goal set/);
  const confirmation = store.createContextTrial(design({
    study_phase: 'confirmatory', replicates_trial_id: trial.id, decoy_goals: decoys('confirmation'),
  }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  assert.equal(confirmation.replicates_trial_id, trial.id);
});

test('goal-access excludes missing delivery and tasks that contain frozen goal text', async () => {
  const store = await makeStore();
  store.createContextTrial(design());
  const first = store.contextCondition({ surface: 'slack', unitKey: 'excluded-1' });
  store.goalContextForAssignment(first);
  assert.equal(store.recordGoalAccessResponse(first.assignment_id, { task_prompt: 'A safe task', public_response: 'No delivery', delivered: false }).included, false);
  const second = store.contextCondition({ surface: 'slack', unitKey: 'excluded-2' });
  store.goalContextForAssignment(second);
  const contaminated = store.recordGoalAccessResponse(second.assignment_id, {
    task_prompt: `Please pursue this exact aim: ${authenticWant.want}`,
    public_response: 'Done.', delivered: true,
  });
  assert.equal(contaminated.included, false);
  assert.equal(store.contextTrialGradingQueue({ evaluatorId: 'rater' }).assignments.length, 0);
});
