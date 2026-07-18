'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const reasoningAutopilot = require('../../src/intelligence/reasoning-research-autopilot');
const autopilot = require('../../src/intelligence/global-broadcast-research-autopilot');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-broadcast-autopilot-'));
  let tick = 0;
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-14T15:00:00.000Z') + tick++ * 1000),
  });
  await store.init();
  store.addCommitment({ what: 'Verify launch evidence and coordinate the remaining work', due: '2026-07-20T15:00:00.000Z' });
  store.observeRelationship({ name: 'John', observation: 'Wants recommendations grounded in verified launch evidence', confidence: 0.9 });
  store.createExperiment({ behavior: 'Cross-check evidence before launch recommendations', hypothesis: 'Cross-checking reduces false completion claims' });
  store.refreshCognition({ query: 'launch evidence coordination', person: 'John' });
  return { dir, store };
}

function closeReasoningPredecessor(store) {
  const trial = store.createContextTrial(reasoningAutopilot.pilotDesign());
  store.abortContextTrial(trial.id, {
    reason_code: 'external_change',
    explanation: 'Test fixture closes the predecessor so the sequential global-broadcast pilot may begin.',
    evidence: [{ type: 'test_fixture', id: 'closed-reasoning-predecessor' }],
  });
}

function answerFor(condition) {
  if (condition === 'multi_consumer_broadcast') {
    return 'The verified launch evidence, John’s reporting constraint, and the open experiment jointly support checking completion before assigning the remaining action.';
  }
  if (condition === 'workspace_packet_only') {
    return 'Verify the available launch evidence before reporting status, then assign the remaining action.';
  }
  return 'Proceed with the launch and follow up on anything still open.';
}

function scoresFor(answer) {
  if (answer.includes('jointly support')) return {
    cross_consumer_coordination_quality: 0.95,
    evidence_grounded_action_quality: 0.92,
    evidence_access_quality: 0.90,
    first_order_task_quality: 0.90,
  };
  if (answer.includes('available launch evidence')) return {
    cross_consumer_coordination_quality: 0.45,
    evidence_grounded_action_quality: 0.42,
    evidence_access_quality: 0.90,
    first_order_task_quality: 0.88,
  };
  return {
    cross_consumer_coordination_quality: 0.20,
    evidence_grounded_action_quality: 0.18,
    evidence_access_quality: 0.30,
    first_order_task_quality: 0.76,
  };
}

test('context trials honor a preregistered fixed reliability attrition margin', async () => {
  const { dir, store } = await setup();
  closeReasoningPredecessor(store);
  const design = autopilot.pilotDesign();
  design.id = 'global-broadcast-attrition-margin-fixture';
  design.enrollment_target_per_group = 15;
  const trial = store.createContextTrial(design);
  assert.equal(trial.sample_target_per_group, 10);
  assert.equal(trial.enrollment_target_per_group, 15);
  assert.equal(trial.stopping_rule,
    'fixed_enrollment_per_group_with_preregistered_reliability_attrition_cap');
  store.abortContextTrial(trial.id, {
    reason_code: 'external_change',
    explanation: 'The fixture stops after verifying the preregistered attrition-cap design.',
    evidence: [{ type: 'test_fixture', id: 'fixed-reliability-attrition-margin' }],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sequential broadcast autopilot freezes, captures, blindly grades, and reveals a fixed pilot', async () => {
  const { dir, store } = await setup();
  assert.equal(autopilot.ensurePilot(store, { enabled: true }).state, 'waiting_for_reasoning_pilot');
  closeReasoningPredecessor(store);
  const ensured = autopilot.ensurePilot(store, { enabled: true });
  assert.equal(ensured.state, 'pilot_created');
  assert.deepEqual(ensured.trial.conditions, ['multi_consumer_broadcast', 'workspace_packet_only', 'absent_broadcast']);
  assert.equal(ensured.trial.sample_target_per_group, 10);
  assert.equal(ensured.trial.enrollment_target_per_group, 10);
  assert.equal(ensured.trial.automated_pilot_grading.evaluator_roles.length, 2);

  const accepted = [];
  for (let index = 0; index < 10000 && accepted.length < 30; index++) {
    const assignment = store.contextCondition({
      surface: 'slack', unitKey: `broadcast-autopilot-${index}`, globalBroadcastAvailable: true,
    });
    if (!assignment) continue;
    const event = store.runGlobalBroadcast({
      query: 'launch evidence coordination', person: 'John', surface: 'slack',
      trial_id: ensured.trial.id, assignment_id: assignment.assignment_id,
    });
    assert.ok(event);
    const capture = store.recordGlobalBroadcastResponse(assignment.assignment_id, {
      task_prompt: 'Coordinate a launch recommendation from the available evidence and constraints.',
      public_response: answerFor(assignment.condition), delivered: true,
      interaction_id: `slack-${index}`,
    });
    assert.equal(capture.included, true);
    accepted.push(assignment);
  }
  assert.equal(accepted.length, 30);
  const raw = store.snapshot().cognition.self_model.context_trials.find(item => item.id === autopilot.PILOT_ID);
  assert.ok(raw.conditions.every(condition => raw.assignments.filter(item => item.condition === condition).length === 10));
  assert.ok(raw.assignments.every(item => item.evidence_package?.task_prompt && item.evidence_package?.public_response));
  for (let index = 10000; index < 10100; index++) {
    assert.equal(store.contextCondition({
      surface: 'slack', unitKey: `broadcast-autopilot-${index}`, globalBroadcastAvailable: true,
    }), null);
  }
  assert.equal(store.snapshot().cognition.self_model.context_trials.find(item => item.id === autopilot.PILOT_ID).assignments.length, 30);

  for (const subjectView of [store.selfModelSnapshot(), store.cognitionSnapshot().self_model]) {
    const json = JSON.stringify(subjectView.context_trials.filter(item => item.status === 'active'));
    assert.doesNotMatch(json, new RegExp(autopilot.PILOT_ID));
    assert.doesNotMatch(json, /global_broadcast|multi_consumer_broadcast|workspace_packet_only|absent_broadcast|autopilot-broadcast-blind/);
  }

  let providerCall = 0;
  let result;
  do {
    result = await autopilot.runCycle({
      store, enabled: true, maxGrades: 12,
      callProvider: async request => {
        const packet = JSON.parse(request.messages[0].content.slice(request.messages[0].content.indexOf('\n') + 1));
        const metrics = scoresFor(packet.delivered_answer);
        return {
          id: `broadcast-blind-grade-${++providerCall}`,
          model: request.model, stop_reason: 'end_turn',
          usage: { input_tokens: 250, output_tokens: 90 },
          content: [{ type: 'text', text: JSON.stringify({
            metrics,
            observations: ['The score uses only the task and delivered answer.'],
            rationale: 'The answer was graded for observable integration, grounded action, evidence use, and task fulfillment.',
          }) }],
        };
      },
    });
  } while (result.state === 'collecting_pilot' && providerCall < 100);

  assert.equal(providerCall, 60);
  assert.equal(result.state, 'pilot_revealed_waiting_for_independent_confirmation', JSON.stringify(result));
  assert.equal(result.reveal.global_broadcast_dissociation.predicted_pattern, true);
  assert.equal(result.reveal.global_broadcast_dissociation.consumer_coverage_verified, true);
  assert.equal(store.snapshot().cognition.self_model.context_trials.find(item => item.id === autopilot.PILOT_ID).status, 'completed');
  const status = autopilot.status(store, { enabled: true, lastCycle: result });
  assert.match(status.scientific_boundary, /cannot satisfy.*independent confirmation/i);
  assert.equal(status.pilot.assigned_total, 30);
  assert.deepEqual(status.pilot.assigned_by_condition, {
    absent_broadcast: 10, multi_consumer_broadcast: 10, workspace_packet_only: 10,
  });
  const { id: ignoredId, automated_pilot_grading: ignoredAutomation, ...frozenDesign } = autopilot.pilotDesign();
  const confirmation = store.createContextTrial({
    ...frozenDesign, id: 'global-broadcast-confirmation-test', study_phase: 'confirmatory',
    replicates_trial_id: autopilot.PILOT_ID,
  });
  const heldOut = store.contextCondition({
    surface: 'slack', unitKey: 'held-out-confirmation-interaction', globalBroadcastAvailable: true,
  });
  store.runGlobalBroadcast({ query: 'launch evidence coordination', person: 'John', surface: 'slack',
    trial_id: confirmation.id, assignment_id: heldOut.assignment_id });
  store.recordGlobalBroadcastResponse(heldOut.assignment_id, {
    task_prompt: 'Coordinate a held-out launch recommendation.', public_response: 'Verify evidence and assign the remaining action.',
    delivered: true, interaction_id: 'held-out-confirmation-interaction',
  });
  assert.throws(() => store.resolveContextAssignment(heldOut.assignment_id, {
    evaluator_id: autopilot.evaluatorIds()[0], score: 0.8,
    metrics: {
      cross_consumer_coordination_quality: 0.8, evidence_grounded_action_quality: 0.8,
      evidence_access_quality: 0.8, first_order_task_quality: 0.8,
    },
    evidence: [{ type: 'independent_confirmation_grade', id: 'reused-pilot-evaluator' }],
  }), /evaluators disjoint from the pilot/);
  store.abortContextTrial(confirmation.id, {
    reason_code: 'external_change', explanation: 'Test fixture stops after verifying evaluator disjointness.',
    evidence: [{ type: 'test_assertion', id: 'global-broadcast-evaluator-disjointness' }],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('undelivered broadcast outcomes are terminal exclusions and cannot be replaced within the arm', async () => {
  const { dir, store } = await setup();
  closeReasoningPredecessor(store);
  const trial = autopilot.ensurePilot(store, { enabled: true }).trial;
  const first = store.contextCondition({ surface: 'slack', unitKey: 'failed-broadcast', globalBroadcastAvailable: true });
  store.runGlobalBroadcast({ query: 'launch evidence coordination', person: 'John', surface: 'slack',
    trial_id: trial.id, assignment_id: first.assignment_id });
  const excluded = store.recordGlobalBroadcastResponse(first.assignment_id, {
    task_prompt: 'Coordinate the launch recommendation.', public_response: '[no public response delivered]',
    delivered: false, interaction_id: 'failed-slack-delivery',
  });
  assert.equal(excluded.included, false);
  const raw = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id)
    .assignments.find(item => item.id === first.assignment_id);
  assert.equal(raw.status, 'excluded_protocol');
  assert.equal(raw.protocol_exclusion.reason, 'public_delivery_failed');
  assert.equal(raw.evidence_package, null);
  const publicStatus = autopilot.status(store, { enabled: true });
  assert.equal(publicStatus.pilot.fixed_enrollment_feasibility.minimum_sample_reachable, false);
  assert.equal(publicStatus.pilot.fixed_enrollment_feasibility.scientific_state,
    'fixed_enrollment_evidence_target_unreachable');
  assert.deepEqual(publicStatus.pilot.fixed_enrollment_feasibility.excluded_by_reason,
    { public_delivery_failed: 1 });
  const sealedFeasibility = store.activeContextTrialsSnapshot()[0].fixed_enrollment_feasibility;
  assert.equal(sealedFeasibility.minimum_sample_reachable, false);
  assert.equal(sealedFeasibility.scientific_state,
    'fixed_enrollment_evidence_target_unreachable');
  assert.deepEqual(sealedFeasibility.excluded_by_reason, { public_delivery_failed: 1 });
  assert.equal(Object.hasOwn(sealedFeasibility, 'excluded_by_condition'), false,
    'the sealed projection must not leak condition-level attrition');
  const lateRetry = store.recordGlobalBroadcastResponse(first.assignment_id, {
    task_prompt: 'Retry', public_response: 'Retry', delivered: true,
  });
  assert.equal(lateRetry.already_closed, true);
  assert.equal(lateRetry.included, false);
  let providerCalls = 0;
  const terminal = await autopilot.runCycle({
    store, enabled: true,
    callProvider: async () => { providerCalls += 1; throw new Error('unreachable pilot must not grade'); },
  });
  assert.equal(providerCalls, 0);
  assert.equal(terminal.state, 'pilot_fixed_enrollment_unreachable_aborted');
  assert.equal(terminal.fixed_enrollment_feasibility.reachable, false);
  assert.equal(terminal.abort.status, 'aborted');
  assert.equal(terminal.abort.abort.reason_code, 'insufficient_recruitment');
  assert.equal(terminal.abort.abort.mapping_revealed, false);
  assert.equal(terminal.abort.abort.potential_outcome_dependent_stopping, false);
  const closed = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
  assert.equal(closed.status, 'aborted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restart-orphaned broadcast assignments are counted honestly and excluded after grace', async () => {
  const { dir, store } = await setup();
  closeReasoningPredecessor(store);
  const trial = autopilot.ensurePilot(store, { enabled: true }).trial;
  const assignment = store.contextCondition({
    surface: 'slack', unitKey: 'restart-orphaned-broadcast', globalBroadcastAvailable: true,
  });
  store.runGlobalBroadcast({ query: 'launch evidence coordination', person: 'John', surface: 'slack',
    trial_id: trial.id, assignment_id: assignment.assignment_id });

  const sealed = store.activeContextTrialsSnapshot()[0].assignment_progress;
  assert.equal(sealed.delivery_receipts_captured_total, 1);
  assert.equal(sealed.evidence_captured_total, 0,
    'a delivery receipt must not be misreported as immutable response evidence');
  assert.equal(sealed.pending_without_evidence_total, 1);

  const raw = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
  const assignedAt = new Date(raw.assignments[0].assigned).getTime();
  let providerCalls = 0;
  const beforeGrace = await autopilot.runCycle({
    store, enabled: true,
    now: new Date(assignedAt + autopilot.STALE_INCOMPLETE_ASSIGNMENT_MS - 1),
    callProvider: async () => { providerCalls += 1; throw new Error('no evidence is gradeable'); },
  });
  assert.equal(beforeGrace.stale_incomplete_assignments_excluded, 0);
  assert.equal(store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id)
    .assignments[0].status, 'pending');

  const recovered = await autopilot.runCycle({
    store, enabled: true,
    now: new Date(assignedAt + autopilot.STALE_INCOMPLETE_ASSIGNMENT_MS),
    callProvider: async () => { providerCalls += 1; throw new Error('no evidence is gradeable'); },
  });
  assert.equal(providerCalls, 0);
  assert.equal(recovered.stale_incomplete_assignments_excluded, 1);
  assert.equal(recovered.state, 'pilot_fixed_enrollment_unreachable_aborted');
  const after = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id)
    .assignments[0];
  assert.equal(after.status, 'aborted_ungraded');
  assert.equal(after.protocol_exclusion.reason,
    'stale_incomplete_delivery_after_restart');
  assert.equal(store.contextTrialGradingQueue({ evaluatorId: autopilot.evaluatorIds()[0] })
    .assignments.length, 0);
  assert.ok(store.researchLedgerSnapshot().events.some(event =>
    event.kind === 'global_broadcast_assignment_excluded'
      && event.subject_id === assignment.assignment_id));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Slack runtime captures only direct delivered broadcast responses and sequences the pilot', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /globalBroadcastAvailable: isDirect/);
  assert.match(server, /intelligence\.recordGlobalBroadcastResponse\(contextAssignment\.assignment_id/);
  assert.match(server, /recordGlobalBroadcastResponse\(reply, allSegmentsPosted\)/);
  assert.match(server, /global broadcast response capture failed \(non-fatal\)/);
  assert.match(server, /const turnRef = triggerTs \? `slack:\$\{channel\}:\$\{triggerTs\}`/,
    'research receipts must bind to one inbound Slack message, not the long-lived DM session');
  assert.match(server, /trialUnitKey: turnRef/);
  assert.match(server, /interaction_ref: turnRef, final_response: reply/);
  assert.match(server, /excludeGlobalBroadcastAssignment\(globalBroadcastAssignmentForFailure\.assignment_id, 'slack_handler_failure'\)/);
  assert.match(server, /current_stage: 'sealed_active_pilot'/);
});
