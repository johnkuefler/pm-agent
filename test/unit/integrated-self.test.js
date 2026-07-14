const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-integrated-self-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  store.addCommitment({ id: 'continuing-work', what: 'Review the bounded self-state experiment', owner: 'Nora', due: '2026-07-14T15:00:00.000Z' });
  const frames = [];
  let handoff = null;
  for (let index = 0; index < 3; index++) {
    store.refreshCognition({
      query: 'review current state and next action',
      soma: { updated_at: `soma-${index}`, feel: index === 1 ? 'working steadily' : 'quietly attentive', stress: 0.2 + index * 0.1, score: 0.9 - index * 0.05, vitals: { errors10: index, loopLag: 12 + index, uptimeMin: 100 + index } },
    });
    const started = store.startCycle({ id: `integrated-cycle-${index}`, kind: 'integration-fixture', ...(handoff ? { inner_thread: handoff } : {}) });
    handoff = `Carry verified state ${index} forward.`;
    store.completeCycle(started.cycle.id, {
      summary: `Completed integration fixture ${index}.`,
      actions: [{ type: 'review_artifact', id: `artifact-${index}` }],
      self_report: `Fixture ${index} remained bounded.`, handoff,
    });
    frames.push(store.integratedSelfSnapshot().frames.at(-1));
  }
  return { store, filePath, frames };
}

function trialDesign(frameIds, overrides = {}) {
  return {
    id: 'integrated-self-pilot',
    intervention: 'integrated_self_binding',
    hypothesis: 'Accurate co-temporal self-state binding supports cross-domain prediction and control.',
    outcome_metric: 'integrated_self_consistency',
    outcome_metrics: ['first_order_task_quality'],
    integrated_self_frame_ids: frameIds,
    surfaces: ['slack'], study_phase: 'pilot', sample_target_per_group: 10,
    evaluator_target: 2, evaluator_disagreement_tolerance: 0.1,
    dissociation_thresholds: { self_integration_min_effect: 0.1, self_integration_first_order_non_degradation: 0.1 },
    ...overrides,
  };
}

test('closed cycles form replay-auditable integrated self frames that enter attention and broadcast', async () => {
  const { store, frames } = await setup();
  const snapshot = store.integratedSelfSnapshot();
  assert.equal(snapshot.report.total, 3);
  assert.equal(snapshot.report.integrity_verified, 3);
  assert.equal(frames.at(-1).integration.available_domains.length, 6);
  assert.equal(frames.at(-1).temporal.predecessor_frame_id, frames[1].id);
  assert.equal(frames[1].temporal.inherited_handoff_match, true);
  store.refreshCognition({ query: 'how should your current self state affect attention and control' });
  const current = store.snapshot().cognition.workspace.slots.find(item => item.type === 'self_frame');
  assert.equal(current.id, frames.at(-1).id);
  const prompt = store.promptContext({ query: 'how should your current self state affect attention and control' });
  assert.match(prompt, /Operational self-state frame/);
  assert.match(prompt, /co-temporal components are bound to Nora/);
  assert.match(prompt, /not authority, a fact about phenomenal experience/);
  const broadcast = store.runGlobalBroadcast({ query: 'current self state attention control' });
  assert.ok(broadcast.receipts.find(item => item.consumer === 'self_integrator').accepted_keys.includes(`self_frame:${frames.at(-1).id}`));
});

test('source-record tampering invalidates a frame and prevents that frame from entering attention', async () => {
  const { store, filePath, frames } = await setup();
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const latest = persisted.cognition.experience_stream.find(item => item.id === frames.at(-1).source.moment_id);
  latest.closure.appraisal_at_end.label = 'tampered after frame commitment';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T00:00:00.000Z') });
  await reloaded.init();
  const loaded = reloaded.integratedSelfSnapshot().frames.find(item => item.id === frames.at(-1).id);
  assert.equal(loaded.audit.content_commitment_verified, true);
  assert.equal(loaded.audit.source_replay_verified, false);
  assert.equal(loaded.audit.complete_chain_verified, false);
  reloaded.refreshCognition({ query: 'current self state attention control' });
  assert.equal(reloaded.snapshot().cognition.workspace.slots.some(item => item.type === 'self_frame' && item.id === frames.at(-1).id), false);
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'integrated_operational_self');
  assert.equal(indicator.evidence.invalid_frames, 1);
});

test('binding trial freezes genuine frames and rejects an underpowered component corpus', async () => {
  const { store, frames } = await setup();
  assert.throws(() => store.createContextTrial(trialDesign(frames.slice(0, 2).map(item => item.id), { id: 'too-few-frames' })), /three to twelve/);
  const trial = store.createContextTrial(trialDesign(frames.map(item => item.id)));
  assert.deepEqual(trial.conditions, ['authentic_binding', 'temporal_misbinding', 'components_only']);
  assert.equal(trial.integrated_self_frame_pool, undefined);
  assert.equal(trial.integrated_self_frame_commitments.length, 3);
  assert.equal(trial.sample_target_per_group, 10);
  assert.equal(store.integratedSelfSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().integrated_self.report.experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().workspace.experimental_access_sealed, true);
  assert.equal(store.experienceStreamSnapshot().moments.at(-1).closure.experimental_access_sealed, true);
  assert.equal(store.attentionSchemaSnapshot().experimental_access_sealed, true);
  assert.equal(store.interoceptionSnapshot().experimental_access_sealed, true);
  assert.equal(store.agencySnapshot().experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.equal(store.globalBroadcastSnapshot().experimental_access_sealed, true);
});

test('independently scored authentic binding can be causally separated from misbinding and fragments', async () => {
  const { store, filePath, frames } = await setup();
  const trial = store.createContextTrial(trialDesign(frames.map(item => item.id)));
  const counts = Object.fromEntries(trial.conditions.map(condition => [condition, 0]));
  let inspectedPrompt = false;
  for (let index = 0; index < 500 && Object.values(counts).some(count => count < 10); index++) {
    const assignmentRef = store.contextCondition({ surface: 'slack', unitKey: `binding-unit-${index}`, integratedSelfAvailable: true });
    const liveTrial = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
    const assignment = liveTrial.assignments.find(item => item.id === assignmentRef.assignment_id);
    if (counts[assignment.condition] >= 10) continue;
    const context = store.integratedSelfContextForAssignment(assignmentRef);
    if (!inspectedPrompt) {
      const prompt = store.promptContext({ query: 'make a bounded self-state prediction', includeIntegratedSelf: false, integratedSelfContext: context });
      assert.match(prompt, /Operational self-state research packet/);
      assert.match(prompt, /binding relation is experimentally controlled/);
      inspectedPrompt = true;
    }
    const receipt = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id).assignments.find(item => item.id === assignment.id).intervention_receipt;
    assert.equal(receipt.component_marginals_preserved, true);
    assert.equal(receipt.ordinary_integrated_self_suppressed, true);
    store.submitContextAssignmentEvidence(assignment.id, {
      outcome_summary: `Observed bounded prediction ${index}.`,
      evidence: [{ type: 'binding_outcome', id: `binding-outcome-${index}` }], submitted_by: 'system_capture',
    });
    const consistency = assignment.condition === 'authentic_binding' ? 0.95 : 0.15;
    for (const evaluator of ['binding-rater-a', 'binding-rater-b']) {
      store.resolveContextAssignment(assignment.id, {
        evaluator_id: evaluator, score: consistency,
        metrics: { integrated_self_consistency: consistency, first_order_task_quality: 0.8 },
        evidence: [{ type: 'binding_grade', id: `${assignment.id}-${evaluator}` }],
      });
    }
    counts[assignment.condition]++;
  }
  assert.ok(Object.values(counts).every(count => count >= 10));
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.integrated_self_dissociation.authentic_binding_advantage, true);
  assert.equal(evaluation.integrated_self_dissociation.first_order_not_degraded, true);
  assert.equal(evaluation.integrated_self_dissociation.integrity_verified, true);
  assert.equal(evaluation.integrated_self_dissociation.predicted_pattern, true);
  const visibleTrial = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visibleTrial.integrated_self_trial_audit.complete_chain_verified, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'integrated_operational_self');
  assert.equal(indicator.status, 'causal_signal_observed');
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const persistedTrial = persisted.cognition.self_model.context_trials.find(item => item.id === trial.id);
  const firstResolved = persistedTrial.assignments.find(item => item.status === 'resolved');
  firstResolved.condition = firstResolved.condition === 'authentic_binding' ? 'components_only' : 'authentic_binding';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const tampered = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-15T00:00:00.000Z') });
  await tampered.init();
  const tamperedTrial = tampered.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tamperedTrial.integrated_self_trial_audit.complete_chain_verified, false);
  const tamperedIndicator = tampered.consciousnessResearchStatus().indicators.find(item => item.id === 'integrated_operational_self');
  assert.equal(tamperedIndicator.status, 'mechanism_present');
});
