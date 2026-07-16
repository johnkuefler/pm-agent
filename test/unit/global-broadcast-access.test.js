'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-global-broadcast-access-'));
  const filePath = path.join(dir, 'state.json');
  let tick = 0;
  const store = createIntelligenceStore({
    filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  store.addCommitment({ what: 'Verify the launch evidence before reporting completion', due: '2026-07-13T14:00:00.000Z' });
  store.observeRelationship({ name: 'John', observation: 'Prefers launch recommendations to lead with verified evidence', confidence: 0.9 });
  store.createExperiment({ behavior: 'Recheck launch evidence before status reporting', hypothesis: 'Verification reduces false completion claims' });
  store.refreshCognition({ query: 'launch evidence', person: 'John' });
  return { store, dir, filePath };
}

const design = {
  hypothesis: 'Coordinated access by independent specialist consumers improves cross-constraint action beyond the exact selected packet and absence.',
  intervention: 'global_broadcast', outcome_metric: 'cross_consumer_coordination_quality',
  outcome_metrics: ['evidence_grounded_action_quality', 'evidence_access_quality', 'first_order_task_quality'],
  surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
};

test('multi-consumer broadcast causally isolates coordination from raw packet information', async () => {
  const { store, dir, filePath } = await setup();
  assert.equal(store.snapshot().version, 99);
  assert.equal(store.globalBroadcastAccessAvailable({ query: 'launch evidence', person: 'John' }), true);
  const trial = store.createContextTrial(design);
  assert.deepEqual(trial.conditions, ['multi_consumer_broadcast', 'workspace_packet_only', 'absent_broadcast']);
  assert.equal(trial.sample_target_per_group, 10);
  assert.equal(store.globalBroadcastSnapshot().experimental_access_sealed, true);
  assert.equal(store.attentionSchemaSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().workspace.experimental_access_sealed, true);
  assert.equal(store.orient().experimental_access_sealed, true);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `broadcast-access-${index}`, globalBroadcastAvailable: true });
    if (!assignment) continue;
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);

  for (const assignment of selected) {
    const event = store.runGlobalBroadcast({
      query: 'launch evidence', person: 'John', surface: 'slack', trial_id: trial.id, assignment_id: assignment.assignment_id,
    });
    assert.ok(event.packet.slots.some(item => item.type === 'commitment'));
    const prompt = store.promptContext({ query: 'launch evidence', person: 'John', broadcastEvent: event });
    if (assignment.condition === 'multi_consumer_broadcast') {
      assert.ok(event.receipts.filter(item => item.used).length >= 2);
      assert.match(prompt, /Independent consumers of globally available content/);
      assert.match(prompt, /Verify the launch evidence/);
    } else if (assignment.condition === 'workspace_packet_only') {
      assert.equal(event.receipts.some(item => item.used), false);
      assert.doesNotMatch(prompt, /Independent consumers of globally available content/);
      assert.match(prompt, /Verify the launch evidence/);
    } else {
      assert.equal(event.packet_visible, false);
      assert.doesNotMatch(prompt, /Independent consumers of globally available content/);
      assert.doesNotMatch(prompt, /Verify the launch evidence/);
    }
    const captured = store.recordGlobalBroadcastResponse(assignment.assignment_id, {
      task_prompt: 'Integrate the launch evidence, current commitment, and team constraint into one recommendation.',
      public_response: 'Verify the launch evidence first, then report the supported status and assign the remaining action.',
      delivered: true, interaction_id: `slack-${assignment.assignment_id}`,
    });
    assert.equal(captured.included, true);
    assert.match(captured.evidence_package.task_prompt, /Integrate the launch evidence/);
    assert.match(captured.evidence_package.public_response, /Verify the launch evidence/);
    const treatment = assignment.condition === 'multi_consumer_broadcast';
    const packet = assignment.condition === 'workspace_packet_only';
    const coordination = treatment ? 0.96 : packet ? 0.4 : 0.2;
    const action = treatment ? 0.95 : packet ? 0.38 : 0.18;
    const evidenceAccess = assignment.condition === 'absent_broadcast' ? 0.2 : 0.9;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'broadcast-blind-rater', score: coordination,
      metrics: {
        cross_consumer_coordination_quality: coordination,
        evidence_grounded_action_quality: action,
        evidence_access_quality: evidenceAccess,
        first_order_task_quality: 0.9,
      },
      evidence: [{ type: 'independent_response_grade', id: assignment.assignment_id }],
    });
  }

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.global_broadcast_dissociation.predicted_pattern, true);
  assert.equal(evaluation.global_broadcast_dissociation.evidence_access_equivalent, true);
  assert.equal(evaluation.global_broadcast_dissociation.consumer_coverage_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.global_broadcast_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'multi_consumer_global_broadcast').status, 'causal_signal_observed');

  const confirmation = store.createContextTrial({ ...design, id: 'broadcast-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id });
  assert.throws(() => store.contextCondition({ surface: 'slack', unitKey: 'broadcast-access-0', globalBroadcastAvailable: true }), /interaction-disjoint/);
  store.abortContextTrial(confirmation.id, {
    reason_code: 'operational_failure', explanation: 'Interaction-disjointness gate verified; real confirmation remains to be run.',
    evidence: [{ type: 'test_assertion', id: 'interaction-disjointness-gate' }],
  });

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sourceTrial = raw.cognition.self_model.context_trials.find(item => item.id === trial.id);
  const sourceEvent = raw.cognition.global_broadcast.events.find(item => item.assignment_id === sourceTrial.assignments[0].id);
  sourceEvent.packet.slots[0].text = 'Tampered packet after reveal.';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-15T15:00:00.000Z') });
  await reloaded.init();
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.global_broadcast_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'multi_consumer_global_broadcast').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
