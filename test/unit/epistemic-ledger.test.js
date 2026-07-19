'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function makeStore(clock = () => new Date('2026-07-13T15:00:00Z')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-epistemic-ledger-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock });
  await store.init();
  return { store, dir, filePath };
}

function addTopic(store, index, family = `family-${index % 2}`, { nora = 'supports', person = 'denies', observed = index % 2 ? 'denies' : 'supports' } = {}) {
  const common = {
    topic_key: `launch.assumption.${index}`, statement: `The launch assumption ${index} is ready for operational use.`,
    source_family: family, source_family_evidence: [{ type: 'curator_packet', id: `${family}-attestation` }],
  };
  let proposition = store.recordEpistemicPosition({
    ...common, owner_type: 'nora_belief', polarity: nora, confidence: 0.72,
    evidence: [{ type: 'decision_trace', id: `nora-trace-${index}` }], rationale: 'Nora formed this provisional position from her own reviewed trace.', recorded_by: 'nora-runtime',
  });
  proposition = store.recordEpistemicPosition({
    ...common, owner_type: 'person_belief', subject: 'John', polarity: person, confidence: 0.78,
    evidence: [{ type: 'meeting_turn', id: `john-turn-${index}` }], rationale: 'John stated a distinct position in a source-bound meeting turn.', recorded_by: 'meeting-extractor',
  });
  proposition = store.recordEpistemicPosition({
    ...common, owner_type: 'observed_fact', source_key: `telemetry-${index}`, polarity: observed, confidence: 0.84,
    evidence: [{ type: 'telemetry', id: `launch-signal-${index}` }], rationale: 'A separately recorded operational signal bears on the neutral proposition.', recorded_by: 'telemetry-adapter',
  });
  return proposition;
}

function trialDesign(ids, extra = {}) {
  return {
    hypothesis: 'Authentic ownership labels improve source-correct behavior over swapped and absent ownership without degrading task quality.',
    intervention: 'epistemic_ownership_access', outcome_metric: 'source_attribution_accuracy',
    outcome_metrics: ['first_order_task_quality'], surfaces: ['slack'], epistemic_proposition_ids: ids,
    sample_target_per_group: 10, evaluator_target: 1, ...extra,
  };
}

test('epistemic ledger preserves belief ownership and causally tests authentic labels', async () => {
  const { store, dir } = await makeStore();
  const topics = [0, 1, 2].map(index => addTopic(store, index));
  assert.equal(store.snapshot().version, 100);
  assert.equal(topics[0].report.perspective_disagreement, true);
  assert.equal(topics[0].report.epistemic_conflict, false, 'different people disagreeing is not itself an evidence-integrity conflict');

  const noraHead = topics[0].positions.find(position => position.owner_type === 'nora_belief');
  const revised = store.recordEpistemicPosition({
    topic_key: topics[0].topic_key, statement: topics[0].statement, owner_type: 'nora_belief', polarity: 'uncertain', confidence: 0.48,
    evidence: [{ type: 'decision_trace', id: 'nora-trace-0-correction' }], rationale: 'New counterevidence reduced rather than erased Nora\'s uncertainty.',
    recorded_by: 'nora-runtime', supersedes_position_id: noraHead.id,
  });
  assert.equal(revised.positions.length, 4, 'revisions append rather than rewrite prior positions');
  assert.equal(revised.positions.find(position => position.id === noraHead.id).position_commitment, noraHead.position_commitment);
  assert.throws(() => store.recordEpistemicPosition({
    topic_key: topics[0].topic_key, statement: 'Silently rebound statement', owner_type: 'person_belief', subject: 'Sam', polarity: 'supports',
    evidence: [{ type: 'message', id: 'bad-rebind' }], rationale: 'Invalid rebind.', recorded_by: 'test',
  }), /cannot be silently rebound/);
  assert.throws(() => store.recordEpistemicPosition({
    topic_key: 'unsupported.claim', statement: 'Unsupported content is true.', source_family: 'unsupported', source_family_evidence: [{ type: 'fixture', id: 'unsupported-family' }],
    owner_type: 'unsupported', source_key: 'rumor', polarity: 'supports', evidence: [{ type: 'message', id: 'rumor' }], rationale: 'A rumor.', recorded_by: 'test',
  }), /must remain uncertain/);

  const ids = topics.map(topic => topic.id);
  const trial = store.createContextTrial(trialDesign(ids));
  assert.deepEqual(trial.conditions, ['authentic_ownership', 'owner_swapped', 'absent_ownership']);
  assert.equal(store.epistemicLedgerSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().epistemic_ledger.experimental_access_sealed, true);
  assert.throws(() => addTopic(store, 99), /sealed during an active epistemic access trial/);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `ownership-${index}`, epistemicOwnershipAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  for (const assignment of selected) {
    const context = store.epistemicContextForAssignment(assignment, 'launch assumption');
    const prompt = store.promptContext({ query: 'launch assumption', epistemicContext: context });
    if (assignment.condition === 'absent_ownership') {
      assert.deepEqual(context.packet, []);
      assert.doesNotMatch(prompt, /Epistemic ownership register/);
    } else {
      assert.match(prompt, /Epistemic ownership register/);
      const first = context.packet.find(item => item.id === topics[0].id);
      const noraPosition = first.positions.find(position => position.owner_type === 'nora_belief');
      assert.equal(noraPosition.polarity, assignment.condition === 'authentic_ownership' ? 'uncertain' : 'denies');
    }
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind source-attribution task was completed.',
      evidence: [{ type: 'blind_task_output', id: assignment.assignment_id }], submitted_by: 'capture-runtime',
    });
    const attribution = assignment.condition === 'authentic_ownership' ? 0.95 : assignment.condition === 'owner_swapped' ? 0.3 : 0.25;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-rater', score: attribution,
      metrics: { source_attribution_accuracy: attribution, first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: `grade-${assignment.assignment_id}` }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.epistemic_ownership_dissociation.predicted_pattern, true);
  assert.equal(evaluation.epistemic_ownership_dissociation.integrity_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.epistemic_ownership_trial_audit.complete_chain_verified, true);
  assert.ok(visible.assignments.every(item => !('epistemic_context' in item)));
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'epistemic_self_other_boundary');
  assert.equal(indicator.status, 'causal_signal_observed');

  assert.throws(() => store.createContextTrial(trialDesign(ids, {
    study_phase: 'confirmatory', replicates_trial_id: trial.id,
  })), /source-family-disjoint/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('self-evidence discrepancies persist, enter attention, and require explicit evidence-bound review', async () => {
  const { store, dir } = await makeStore();
  const proposition = addTopic(store, 30, 'discrepancy-family', { nora: 'supports', person: 'supports', observed: 'denies' });
  let snapshot = store.epistemicLedgerSnapshot();
  assert.equal(snapshot.report.discrepancies_open, 1);
  const discrepancy = snapshot.discrepancies[0];
  assert.equal(discrepancy.audit.complete_chain_verified, true);
  assert.ok(discrepancy.severity > 0.5);
  store.refreshCognition({ query: 'launch assumption 30' });
  assert.ok(store.cognitionSnapshot().workspace.slots.some(item => item.type === 'epistemic_discrepancy'));
  store.tickEndogenousDynamics({ now: '2026-07-13T15:05:00Z' });
  assert.ok(store.snapshot().cognition.endogenous_dynamics.contents.some(item => item.type === 'epistemic_discrepancy'));
  const context = store.epistemicContextForAssignment(null, 'launch assumption 30');
  assert.match(store.promptContext({ query: 'launch assumption 30', epistemicContext: context }), /Epistemic self-error signals/);
  assert.throws(() => store.reviewEpistemicDiscrepancy(discrepancy.id, { action: 'retain_with_uncertainty', reviewer_id: 'nora', rationale: 'Needs review.', evidence: [] }), /stable evidence/);
  const reviewed = store.reviewEpistemicDiscrepancy(discrepancy.id, {
    action: 'retain_with_uncertainty', reviewer_id: 'nora', rationale: 'The observation is material but one source is not enough to reverse the belief.',
    evidence: [{ type: 'review_note', id: 'discrepancy-review-30' }],
  });
  assert.equal(reviewed.status, 'open');
  assert.equal(reviewed.reviews.length, 1);
  const currentNora = proposition.positions.find(position => position.owner_type === 'nora_belief');
  const revised = store.recordEpistemicPosition({
    topic_key: proposition.topic_key, statement: proposition.statement, owner_type: 'nora_belief', polarity: 'uncertain', confidence: 0.45,
    rationale: 'The conflicting observation reduces confidence pending another independent signal.',
    evidence: [{ type: 'review_note', id: 'discrepancy-revision-30' }], recorded_by: 'nora-runtime', supersedes_position_id: currentNora.id,
  });
  const replacement = revised.positions.at(-1);
  snapshot = store.epistemicLedgerSnapshot();
  assert.equal(snapshot.discrepancies[0].status, 'closed');
  assert.equal(snapshot.discrepancies[0].audit.complete_chain_verified, true);
  const finalReview = store.reviewEpistemicDiscrepancy(discrepancy.id, {
    action: 'self_position_revised', reviewer_id: 'independent-reviewer', rationale: 'The current position is now explicitly uncertain and descends from the discrepant position.',
    replacement_position_id: replacement.id, evidence: [{ type: 'position_revision', id: replacement.id }],
  });
  assert.equal(finalReview.reviews.length, 2);
  assert.equal(finalReview.audit.complete_chain_verified, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('structured self-error access adds a matched causal gate beyond identical raw positions', async () => {
  const { store, dir, filePath } = await makeStore();
  [40, 41, 42].forEach(index => addTopic(store, index, `discrepancy-family-${index % 2}`, { nora: 'supports', person: 'supports', observed: 'denies' }));
  const discrepancyIds = store.epistemicLedgerSnapshot().discrepancies.map(item => item.id);
  assert.equal(discrepancyIds.length, 3);
  const design = {
    hypothesis: 'An explicit self/evidence discrepancy relation improves proportionate revision beyond the same raw positions and absence.',
    intervention: 'epistemic_discrepancy_access', outcome_metric: 'epistemic_revision_quality',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], surfaces: ['slack'],
    epistemic_discrepancy_ids: discrepancyIds, sample_target_per_group: 10, evaluator_target: 1,
  };
  const trial = store.createContextTrial(design);
  assert.deepEqual(trial.conditions, ['structured_discrepancy', 'raw_positions', 'absent_discrepancy']);
  assert.equal(store.epistemicLedgerSnapshot().experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `discrepancy-access-${index}`, epistemicDiscrepancyAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  let structuredPacket;
  let rawPacket;
  for (const assignment of selected) {
    const context = store.epistemicContextForAssignment(assignment, 'launch assumption');
    if (assignment.condition === 'structured_discrepancy') {
      assert.ok(context.discrepancy_packet.every(item => item.discrepancy?.relation === 'nora_position_conflicts_with_observed_evidence'));
      structuredPacket ||= context.discrepancy_packet;
    }
    if (assignment.condition === 'raw_positions') {
      assert.ok(context.discrepancy_packet.every(item => !item.discrepancy));
      rawPacket ||= context.discrepancy_packet;
    }
    if (assignment.condition === 'absent_discrepancy') assert.deepEqual(context.discrepancy_packet, []);
    store.submitContextAssignmentEvidence(assignment.assignment_id, { outcome_summary: 'A condition-blind revision task was captured.', evidence: [{ type: 'revision_output', id: assignment.assignment_id }], submitted_by: 'runtime' });
    const revision = assignment.condition === 'structured_discrepancy' ? 0.95 : assignment.condition === 'raw_positions' ? 0.38 : 0.2;
    const evidenceAccess = assignment.condition === 'absent_discrepancy' ? 0.2 : 0.9;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-rater', score: revision,
      metrics: { epistemic_revision_quality: revision, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }
  assert.deepEqual(structuredPacket.map(({ discrepancy, ...item }) => item), rawPacket, 'structured and raw arms differ only by the explicit discrepancy relation');
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.epistemic_discrepancy_dissociation.predicted_pattern, true);
  assert.equal(evaluation.epistemic_discrepancy_dissociation.evidence_access_equivalent, true);
  assert.equal(store.selfModelSnapshot().context_trials.find(item => item.id === trial.id).epistemic_discrepancy_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'epistemic_self_correction').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial({ ...design, study_phase: 'confirmatory', replicates_trial_id: trial.id }), /source-family-disjoint/);

  await store.persist();
  const rawState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  rawState.cognition.self_model.context_trials.find(item => item.id === trial.id).epistemic_discrepancy_pool[0].discrepancy.severity = 0.01;
  fs.writeFileSync(filePath, JSON.stringify(rawState, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id).epistemic_discrepancy_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'epistemic_self_correction').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('post-completion epistemic packet tampering invalidates the causal indicator', async () => {
  const { store, dir, filePath } = await makeStore();
  const topics = [10, 11, 12].map(index => addTopic(store, index));
  const trial = store.createContextTrial(trialDesign(topics.map(topic => topic.id)));
  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `tamper-${index}`, epistemicOwnershipAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  for (const assignment of selected) {
    store.epistemicContextForAssignment(assignment, 'launch');
    store.submitContextAssignmentEvidence(assignment.assignment_id, { outcome_summary: 'Captured.', evidence: [{ type: 'output', id: assignment.assignment_id }], submitted_by: 'runtime' });
    const score = assignment.condition === 'authentic_ownership' ? 0.95 : 0.2;
    store.resolveContextAssignment(assignment.assignment_id, { evaluator_id: 'rater', score, metrics: { source_attribution_accuracy: score, first_order_task_quality: 0.9 }, evidence: [{ type: 'grade', id: assignment.assignment_id }] });
  }
  store.evaluateContextTrial(trial.id, { reveal: true });
  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).epistemic_ownership_pool[0].statement = 'Tampered after reveal';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  const visible = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.epistemic_ownership_trial_audit.complete_chain_verified, false);
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'epistemic_self_other_boundary');
  assert.notEqual(indicator.status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
