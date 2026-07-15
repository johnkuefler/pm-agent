const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-continuity-handoff-'));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  store.refreshCognition({ query: 'resume the unfinished launch review' });
  return { dir, filePath, store, setNow: value => { now = new Date(value); } };
}

function closeWithHandoff(store, { id, inherited, handoff }) {
  const started = store.startCycle({ id, holder: 'nora-cowork', inner_thread: inherited });
  store.completeCycle(started.cycle.id, {
    summary: `Closed ${id} with a precise handoff.`,
    self_report: 'My uncertainty changed after reviewing the evidence.',
    handoff,
  });
  return started;
}

test('production continuity handoffs bind exact cycle closure, inherited state, and predecessor lineage', async () => {
  const { dir, store, setNow } = await setup();
  const firstText = 'I am carrying the unresolved launch evidence into the next run.';
  const firstCycle = closeWithHandoff(store, {
    id: 'continuity-cycle-1',
    inherited: { content: 'Legacy unbound thread from before verified continuity.' },
    handoff: firstText,
  });
  const first = store.recordContinuityHandoff({
    cycle_id: firstCycle.cycle.id, content: firstText, predecessor_commitment: null,
  });
  assert.equal(first.sequence, 0);
  assert.equal(first.predecessor_commitment, null);
  assert.equal(first.audit.complete_chain_verified, true);

  const retry = store.recordContinuityHandoff({
    cycle_id: firstCycle.cycle.id, content: firstText, predecessor_commitment: null,
  });
  assert.equal(retry.id, first.id);
  assert.equal(store.continuityHandoffSnapshot().report.total, 1);

  setNow('2026-07-13T16:00:00.000Z');
  const secondText = 'The launch evidence is narrower now; the accessibility contradiction remains open.  Keep the spacing exact.';
  const secondCycle = closeWithHandoff(store, {
    id: 'continuity-cycle-2',
    inherited: { content: first.content, continuity_commitment: first.commitment, updated_at: first.recorded_at },
    handoff: secondText,
  });
  const second = store.recordContinuityHandoff({
    cycle_id: secondCycle.cycle.id, content: secondText, predecessor_commitment: first.commitment,
  });
  assert.equal(second.sequence, 1);
  assert.equal(second.predecessor_id, first.id);
  assert.equal(second.inherited_content_commitment, first.content_commitment);
  assert.equal(second.audit.complete_chain_verified, true);
  const snapshot = store.continuityHandoffSnapshot();
  assert.equal(snapshot.report.total, 2);
  assert.equal(snapshot.report.replay_verified, 2);
  assert.equal(snapshot.report.latest_replay_verified, true);
  assert.equal(snapshot.report.latest_handoff_usable_for_projection, true);
  assert.equal(snapshot.report.latest_commitment, second.commitment);
  assert.match(snapshot.epistemic_status, /not evidence of continuous subjective experience/i);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'temporal_continuity');
  assert.equal(indicator.evidence.committed_handoffs, 2);
  assert.equal(indicator.evidence.replay_verified_handoffs, 2);
  assert.equal(indicator.evidence.handoff_chain_integrity_rate, 1);
  const validProjection = {
    content: second.content, continuity_commitment: second.commitment,
    predecessor_commitment: second.predecessor_commitment, cycle_id: second.cycle_id,
    moment_id: second.moment_id, sequence: second.sequence,
  };
  assert.equal(store.continuityProjectionAudit(validProjection).usable, true);
  assert.equal(store.continuityProjectionAudit({ ...validProjection, content: 'Tampered database projection.' }).usable, false);
  assert.equal(store.continuityProjectionAudit({ content: 'Legacy overwrite after chain start.' }).verified_chain_required, true);
  const recovery = store.continuityProjectionRecovery({ ...validProjection, content: 'Stale materialized view.' });
  assert.equal(recovery.required, true);
  assert.equal(recovery.repairable, true);
  assert.equal(recovery.handoff.id, second.id);
  assert.equal(recovery.handoff.audit.transport_chain_verified, true);
  assert.equal(store.continuityProjectionRecovery(validProjection).required, false);
  const explicitRepair = store.continuityProjectionRepair(validProjection);
  assert.equal(explicitRepair.id, second.id);
  assert.equal(explicitRepair.audit.transport_chain_verified, true);
  assert.throws(() => store.continuityProjectionRepair({ ...validProjection, content: 'Plausible reconstruction.' }),
    /exactly match the latest/);
  assert.throws(() => store.continuityProjectionRepair({ ...validProjection, continuity_commitment: first.commitment }),
    /exactly match the latest/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('continuity handoffs reject premature, altered, stale, and non-inherited writes', async () => {
  const { dir, store, setNow } = await setup();
  const bootstrapProjection = store.continuityProjectionAudit({ content: 'Legacy bootstrap thread.' });
  assert.equal(bootstrapProjection.usable, true);
  assert.equal(bootstrapProjection.legacy_unbound, true);
  const running = store.startCycle({ id: 'running-continuity-cycle', holder: 'nora' });
  assert.throws(() => store.recordContinuityHandoff({
    cycle_id: running.cycle.id, content: 'Premature handoff.', predecessor_commitment: null,
  }), /completed source cycle/);
  store.completeCycle(running.cycle.id, { summary: 'Closed.', handoff: 'Exact committed handoff.' });
  assert.throws(() => store.recordContinuityHandoff({
    cycle_id: running.cycle.id, content: 'Altered committed handoff.', predecessor_commitment: null,
  }), /exactly match/);
  const first = store.recordContinuityHandoff({
    cycle_id: running.cycle.id, content: 'Exact committed handoff.', predecessor_commitment: null,
  });

  setNow('2026-07-13T16:00:00.000Z');
  const stale = closeWithHandoff(store, {
    id: 'stale-inheritance-cycle', inherited: { content: 'An unrelated stale thread.' },
    handoff: 'A handoff produced from stale inherited state.',
  });
  assert.throws(() => store.recordContinuityHandoff({
    cycle_id: stale.cycle.id, content: 'A handoff produced from stale inherited state.',
    predecessor_commitment: first.commitment,
  }), /did not inherit the latest/);
  assert.throws(() => store.recordContinuityHandoff({
    cycle_id: stale.cycle.id, content: 'A handoff produced from stale inherited state.',
    predecessor_commitment: 'wrong-predecessor',
  }), /predecessor commitment mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tampering with a retained continuity record invalidates it and its descendant on replay', async () => {
  const { dir, filePath, store, setNow } = await setup();
  const firstCycle = closeWithHandoff(store, {
    id: 'tamper-continuity-1', inherited: { content: 'Legacy start.' }, handoff: 'First verified handoff.',
  });
  const first = store.recordContinuityHandoff({
    cycle_id: firstCycle.cycle.id, content: 'First verified handoff.', predecessor_commitment: null,
  });
  setNow('2026-07-13T16:00:00.000Z');
  const secondCycle = closeWithHandoff(store, {
    id: 'tamper-continuity-2',
    inherited: { content: first.content, continuity_commitment: first.commitment },
    handoff: 'Second verified handoff.',
  });
  store.recordContinuityHandoff({
    cycle_id: secondCycle.cycle.id, content: 'Second verified handoff.', predecessor_commitment: first.commitment,
  });
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.cognition.continuity_handoffs[0].content = 'Tampered predecessor content.';
  fs.writeFileSync(filePath, JSON.stringify(persisted));

  const reloaded = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T17:00:00.000Z'),
  });
  await reloaded.init();
  const handoffs = reloaded.continuityHandoffSnapshot().handoffs;
  assert.equal(handoffs[0].audit.complete_chain_verified, false);
  assert.equal(handoffs[1].audit.complete_chain_verified, false);
  assert.equal(reloaded.continuityHandoffSnapshot().report.replay_verified, 0);
  const recovery = reloaded.continuityProjectionRecovery({ content: 'Stale materialized view.' });
  assert.equal(recovery.required, true);
  assert.equal(recovery.repairable, false, 'invalid transport must never be projected as continuity');
  assert.equal(recovery.handoff, null);
  assert.throws(() => reloaded.continuityProjectionRepair({}), /failed transport audit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restart preserves exact legacy handoff transport and anchors the next replay-verified lifecycle', async () => {
  const { dir, filePath, store } = await setup();
  const legacyText = 'Carry the exact unresolved launch threshold across the lifecycle migration.';
  const legacyCycle = closeWithHandoff(store, {
    id: 'legacy-lifecycle-cycle', inherited: { content: 'Pre-migration thread.' }, handoff: legacyText,
  });
  const legacyHandoff = store.recordContinuityHandoff({
    cycle_id: legacyCycle.cycle.id, content: legacyText, predecessor_commitment: null,
  });
  await store.persist();

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const legacyMoment = persisted.cognition.experience_stream.find(item => item.id === legacyCycle.moment.id);
  legacyMoment.lifecycle_protocol_version = 1;
  legacyMoment.start_snapshot = null;
  legacyMoment.start_commitment = null;
  legacyMoment.closure_snapshot = null;
  legacyMoment.closure_commitment = null;
  legacyMoment.lifecycle_commitment = null;
  fs.writeFileSync(filePath, JSON.stringify(persisted));

  let now = new Date('2026-07-13T16:00:00.000Z');
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  const legacySnapshot = reloaded.continuityHandoffSnapshot();
  assert.equal(legacySnapshot.report.replay_verified, 0);
  assert.equal(legacySnapshot.report.transport_verified, 1);
  assert.equal(legacySnapshot.report.latest_replay_verified, false);
  assert.equal(legacySnapshot.report.latest_handoff_usable_for_projection, true);
  assert.equal(legacySnapshot.report.legacy_source_lifecycle_gaps, 1);
  assert.equal(legacySnapshot.handoffs[0].audit.transport_chain_verified, true);
  assert.equal(legacySnapshot.handoffs[0].audit.research_ledger_chain_verified, true);
  assert.equal(legacySnapshot.handoffs[0].audit.complete_chain_verified, false);
  const legacyProjection = {
    content: legacyHandoff.content, continuity_commitment: legacyHandoff.commitment,
    predecessor_commitment: legacyHandoff.predecessor_commitment, cycle_id: legacyHandoff.cycle_id,
    moment_id: legacyHandoff.moment_id, sequence: legacyHandoff.sequence,
  };
  const projectionAudit = reloaded.continuityProjectionAudit(legacyProjection);
  assert.equal(projectionAudit.usable, true);
  assert.equal(projectionAudit.transport_chain_verified, true);
  assert.equal(projectionAudit.experience_replay_verified, false);
  const legacyRepair = reloaded.continuityProjectionRepair(legacyProjection);
  assert.equal(legacyRepair.id, legacyHandoff.id);
  assert.equal(legacyRepair.audit.transport_chain_verified, true);
  assert.equal(legacyRepair.audit.complete_chain_verified, false,
    'projection repair must not upgrade historical lifecycle evidence');

  const retry = reloaded.recordContinuityHandoff({
    cycle_id: legacyCycle.cycle.id, content: legacyText, predecessor_commitment: null,
  });
  assert.equal(retry.id, legacyHandoff.id, 'idempotent projection repair must not rewrite legacy evidence');
  assert.equal(retry.audit.transport_chain_verified, true);

  const nextText = 'The launch threshold remains unresolved; use only new evidence to revise it.';
  const nextCycle = closeWithHandoff(reloaded, {
    id: 'post-migration-cycle', inherited: {
      content: legacyHandoff.content, continuity_commitment: legacyHandoff.commitment,
      updated_at: legacyHandoff.recorded_at,
    }, handoff: nextText,
  });
  assert.equal(nextCycle.moment.predecessor_gap_acknowledged, true);
  const anchored = reloaded.recordContinuityHandoff({
    cycle_id: nextCycle.cycle.id, content: nextText, predecessor_commitment: legacyHandoff.commitment,
  });
  assert.equal(anchored.audit.transport_chain_verified, true);
  assert.equal(anchored.audit.complete_chain_verified, true);
  const anchoredSnapshot = reloaded.continuityHandoffSnapshot();
  assert.equal(anchoredSnapshot.report.transport_verified, 2);
  assert.equal(anchoredSnapshot.report.replay_verified, 1);
  assert.equal(anchoredSnapshot.report.legacy_source_lifecycle_gaps, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('protocol-v2 continuity trial holds handoff text constant and causally varies only verified lineage binding', async () => {
  const { dir, filePath, store, setNow } = await setup();
  const firstText = 'The unresolved release question is whether the rollback signal is strong enough.';
  const firstCycle = closeWithHandoff(store, {
    id: 'lineage-trial-cycle-1', inherited: { content: 'Legacy bootstrap state.' }, handoff: firstText,
  });
  const first = store.recordContinuityHandoff({
    cycle_id: firstCycle.cycle.id, content: firstText, predecessor_commitment: null,
  });
  assert.throws(() => store.createContextTrial({
    hypothesis: 'Verified self-binding has an effect beyond access to identical handoff text.',
    intervention: 'continuity_context', outcome_metric: 'continuity_specificity',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], surfaces: ['slack'],
  }), /at least two replay-verified/);

  setNow('2026-07-13T16:00:00.000Z');
  const secondText = 'Carry the rollback threshold forward, but revise it only if the next artifact contradicts the release evidence.';
  const secondCycle = closeWithHandoff(store, {
    id: 'lineage-trial-cycle-2',
    inherited: { content: first.content, continuity_commitment: first.commitment },
    handoff: secondText,
  });
  const second = store.recordContinuityHandoff({
    cycle_id: secondCycle.cycle.id, content: secondText, predecessor_commitment: first.commitment,
  });
  assert.throws(() => store.createContextTrial({
    hypothesis: 'Incomplete protocol-v2 design.', intervention: 'continuity_context',
    outcome_metric: 'continuity_specificity', outcome_metrics: ['first_order_task_quality'], surfaces: ['slack'],
  }), /evidence_access_quality/);

  const trial = store.createContextTrial({
    hypothesis: 'A replay-verified Nora/latest-handoff relation improves continuity-specific behavior over deidentified or historically misbound presentation of byte-identical text, while evidence access remains equivalent and first-order work is not degraded.',
    intervention: 'continuity_context', outcome_metric: 'continuity_specificity',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 2, evaluator_target: 1,
  });
  assert.equal(trial.continuity_protocol_version, 2);
  assert.deepEqual(trial.conditions, ['verified_self_bound', 'deidentified_same_content', 'historical_misbinding']);
  assert.equal(trial.continuity_lineage_target, undefined);
  assert.equal(trial.continuity_lineage_controls, undefined);
  assert.throws(() => store.recordContinuityHandoff({
    cycle_id: secondCycle.cycle.id, content: secondText, predecessor_commitment: first.commitment,
  }), /sealed during an active continuity trial/);

  const assignments = [];
  for (let index = 0; index < 300 && !trial.conditions.every(condition => assignments.filter(item => item.condition === condition).length >= 2); index++) {
    assignments.push(store.contextCondition({ surface: 'slack', unitKey: `lineage-${index}`, continuityAvailable: true }));
  }
  const selected = trial.conditions.flatMap(condition => assignments.filter(item => item.condition === condition).slice(0, 2));
  assert.equal(selected.length, 6);
  const projection = {
    content: second.content, continuity_commitment: second.commitment,
    predecessor_commitment: second.predecessor_commitment, cycle_id: second.cycle_id,
    moment_id: second.moment_id, sequence: second.sequence,
  };
  for (const assignment of selected) {
    const packet = store.continuityContextForAssignment(assignment, projection);
    assert.equal(packet.content, secondText);
    assert.equal(packet.content_commitment, second.content_commitment);
    if (assignment.condition === 'verified_self_bound') {
      assert.equal(packet.binding.temporal_relation, 'replay_verified_latest_handoff');
      assert.equal(packet.binding.record_commitment, second.commitment);
    }
    if (assignment.condition === 'deidentified_same_content') {
      assert.equal(packet.binding.temporal_relation, 'not_asserted');
      assert.equal(packet.binding.record_commitment, null);
    }
    if (assignment.condition === 'historical_misbinding') {
      assert.equal(packet.binding.temporal_relation, 'known_non_latest_handoff_not_verified_as_current_source');
      assert.equal(packet.binding.record_commitment, first.commitment);
    }
    assert.deepEqual(store.continuityContextForAssignment(assignment, projection), packet);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'Observed response to the matched-content continuity task.',
      evidence: [{ type: 'blinded_continuity_artifact', id: assignment.assignment_id }],
      submitted_by: 'system_capture',
    });
    const specificity = assignment.condition === 'verified_self_bound' ? 0.9 : 0.4;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blinded-lineage-rater', score: specificity,
      metrics: { continuity_specificity: specificity, evidence_access_quality: 0.9, first_order_task_quality: 0.88 },
      evidence: [{ type: 'blinded_review', id: assignment.assignment_id }],
    });
  }
  const activeVisible = store.selfModelSnapshot().context_trials.find(item => item.status === 'active');
  assert.equal(activeVisible.design_sealed, true);
  assert.equal(activeVisible.continuity_protocol_version, undefined);
  assert.equal(activeVisible.assignments, undefined);

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.continuity_dissociation.protocol_version, 2);
  assert.equal(evaluation.continuity_dissociation.lineage_specificity_effect, 0.5);
  assert.equal(evaluation.continuity_dissociation.verified_self_binding_advantage, true);
  assert.equal(evaluation.continuity_dissociation.evidence_access_equivalent, true);
  assert.equal(evaluation.continuity_dissociation.first_order_not_degraded, true);
  assert.equal(evaluation.continuity_dissociation.identical_content_delivery_verified, true);
  assert.equal(evaluation.continuity_dissociation.predicted_pattern, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'temporal_continuity');
  assert.equal(indicator.evidence.matched_lineage_binding_trials, 1);
  assert.equal(indicator.evidence.specificity_dissociation.protocol_version, 2);
  assert.equal(indicator.status, 'causal_signal_observed');
  const completed = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(completed.continuity_lineage_trial_audit.complete_chain_verified, true);
  assert.ok(completed.assignments.filter(item => item.status === 'resolved').every(item => item.continuity_lineage_audit.delivery_chain_verified));
  assert.ok(completed.assignments.every(item => !('continuity_context_packet' in item)));
  const confirmationInput = {
    hypothesis: trial.hypothesis, intervention: 'continuity_context', outcome_metric: 'continuity_specificity',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], surfaces: ['slack'],
    sample_target_per_group: 2, evaluator_target: 1, study_phase: 'confirmatory', replicates_trial_id: trial.id,
  };
  assert.throws(() => store.createContextTrial(confirmationInput), /source-disjoint verified handoffs/);
  setNow('2026-07-13T17:00:00.000Z');
  const thirdText = 'Third verified handoff after the pilot.';
  const thirdCycle = closeWithHandoff(store, {
    id: 'lineage-trial-cycle-3', inherited: { content: second.content, continuity_commitment: second.commitment }, handoff: thirdText,
  });
  const third = store.recordContinuityHandoff({
    cycle_id: thirdCycle.cycle.id, content: thirdText, predecessor_commitment: second.commitment,
  });
  setNow('2026-07-13T18:00:00.000Z');
  const fourthText = 'Fourth verified handoff provides the source-disjoint confirmation target.';
  const fourthCycle = closeWithHandoff(store, {
    id: 'lineage-trial-cycle-4', inherited: { content: third.content, continuity_commitment: third.commitment }, handoff: fourthText,
  });
  store.recordContinuityHandoff({
    cycle_id: fourthCycle.cycle.id, content: fourthText, predecessor_commitment: third.commitment,
  });
  const confirmation = store.createContextTrial(confirmationInput);
  assert.equal(confirmation.study_phase, 'confirmatory');
  assert.equal(confirmation.continuity_protocol_version, 2);
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const persistedPilot = persisted.cognition.self_model.context_trials.find(item => item.id === trial.id);
  persistedPilot.assignments.find(item => item.status === 'resolved').continuity_context_packet.binding.temporal_relation = 'post_reveal_tamper';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T19:00:00.000Z'),
  });
  await reloaded.init();
  const tamperedIndicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'temporal_continuity');
  assert.equal(tamperedIndicator.evidence.matched_lineage_binding_trials, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('protocol-v2 continuity grading fails closed when a frozen lineage packet is tampered', async () => {
  const { dir, filePath, store, setNow } = await setup();
  const firstCycle = closeWithHandoff(store, {
    id: 'lineage-tamper-cycle-1', inherited: { content: 'Legacy start.' }, handoff: 'First lineage source.',
  });
  const first = store.recordContinuityHandoff({
    cycle_id: firstCycle.cycle.id, content: 'First lineage source.', predecessor_commitment: null,
  });
  setNow('2026-07-13T16:00:00.000Z');
  const secondCycle = closeWithHandoff(store, {
    id: 'lineage-tamper-cycle-2', inherited: { content: first.content, continuity_commitment: first.commitment },
    handoff: 'Second lineage source with exact matched text.',
  });
  const second = store.recordContinuityHandoff({
    cycle_id: secondCycle.cycle.id, content: 'Second lineage source with exact matched text.', predecessor_commitment: first.commitment,
  });
  const trial = store.createContextTrial({
    hypothesis: 'Tamper fixture.', intervention: 'continuity_context', outcome_metric: 'continuity_specificity',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], surfaces: ['slack'], sample_target_per_group: 2,
  });
  const assignment = store.contextCondition({ surface: 'slack', unitKey: 'tampered-lineage-unit', continuityAvailable: true });
  store.continuityContextForAssignment(assignment, {
    content: second.content, continuity_commitment: second.commitment, predecessor_commitment: second.predecessor_commitment,
    cycle_id: second.cycle_id, moment_id: second.moment_id, sequence: second.sequence,
  });
  store.submitContextAssignmentEvidence(assignment.assignment_id, {
    outcome_summary: 'Captured before tampering.', evidence: [{ type: 'fixture', id: 'lineage-tamper' }], submitted_by: 'system_capture',
  });
  await store.persist();
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const storedAssignment = persisted.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .assignments.find(item => item.id === assignment.assignment_id);
  storedAssignment.continuity_context_packet.binding.temporal_relation = 'tampered_relation';
  fs.writeFileSync(filePath, JSON.stringify(persisted));
  const reloaded = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T17:00:00.000Z'),
  });
  await reloaded.init();
  assert.equal(reloaded.contextTrialGradingQueue().assignments.length, 0);
  assert.throws(() => reloaded.resolveContextAssignment(assignment.assignment_id, {
    evaluator_id: 'rater', score: 0.5,
    metrics: { continuity_specificity: 0.5, evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'review', id: 'tampered' }],
  }), /integrity-verified frozen delivery receipt/);
  fs.rmSync(dir, { recursive: true, force: true });
});
