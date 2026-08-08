'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const projectControl = require('../../src/intelligence/project-control');

const NOW = new Date('2026-08-08T14:00:00.000Z');
const EVIDENCE = [{ type: 'teamwork_task', ref: 'task-42', observed_at: '2026-08-08T13:55:00.000Z' }];

function withProject() {
  return projectControl.upsertProject(projectControl.emptyLedger(), {
    key: 'tw-100',
    name: 'Client launch',
    teamwork_id: '100',
    objective: 'Launch the approved client site without avoidable schedule risk.',
    phase: 'quality assurance',
    pm: 'Taylor',
    health: 'amber',
    health_reason: 'A launch dependency is not yet owned.',
    next_milestone: 'Client quality assurance approval',
    next_milestone_due: '2026-08-11T22:00:00.000Z',
    critical_path: ['Complete browser quality assurance', 'Receive client approval'],
    evidence: EVIDENCE,
  }, { now: NOW }).ledger;
}

function cognitiveContext() {
  return {
    rationale: 'The verified dependency can still be resolved before it moves the launch date.',
    uncertainty: 'The owner may have handled it outside Teamwork.',
    assumptions: ['Teamwork is current as of the attached observation.'],
    self_limitations: ['I cannot infer work completed outside connected systems.'],
    teammate_preferences: ['Taylor prefers one consolidated question with a clear decision.'],
    lesson_refs: ['cr-action-1:cr-observation-1'],
    workspace_frame_id: 'frame-22',
  };
}

test('project control records preserve the minimum operating picture and completeness', () => {
  const ledger = withProject();
  assert.equal(ledger.projects[0].completeness.ratio, 1);
  assert.equal(ledger.projects[0].health, 'amber');
  assert.equal(ledger.projects[0].critical_path.length, 2);
  assert.match(ledger.projects[0].control_commitment, /^[a-f0-9]{64}$/);

  const sparse = projectControl.upsertProject(ledger, { key: 'tw-101', name: 'Sparse project' }, { now: NOW });
  assert.deepEqual(sparse.project.completeness.missing,
    ['objective', 'phase', 'pm', 'next_milestone', 'next_milestone_due']);
  assert.equal(sparse.report.projects.incomplete, 1);
});

test('risks are evidence-bound, idempotent, and independently resolvable', () => {
  let ledger = withProject();
  const input = {
    project_key: 'tw-100',
    title: 'Quality assurance has no owner',
    description: 'The critical-path QA task is unassigned three days before approval.',
    severity: 'high',
    urgency: 0.85,
    confidence: 0.9,
    subject_ref: 'teamwork:task-42',
    due_at: '2026-08-09T22:00:00.000Z',
    next_action: 'Name an owner and confirm the QA completion time.',
    evidence: EVIDENCE,
  };
  const created = projectControl.createRisk(ledger, input, { now: NOW });
  ledger = created.ledger;
  assert.equal(created.idempotent, false);
  const repeated = projectControl.createRisk(ledger, input, { now: NOW });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.ledger.risks.length, 1);

  const resolved = projectControl.updateRisk(ledger, created.risk.id, {
    status: 'resolved',
    resolution_note: 'Taylor assigned the task and confirmed completion for Monday.',
    evidence: [{ type: 'teamwork_comment', ref: 'comment-77' }],
  }, { now: new Date('2026-08-08T15:00:00.000Z') });
  assert.equal(resolved.risk.status, 'resolved');
  assert.equal(resolved.report.risks.open, 0);
});

test('silent maintenance and requested work do not consume a human interruption slot', () => {
  let ledger = withProject();
  const silent = projectControl.planIntervention(ledger, {
    project_key: 'tw-100',
    lane: 'silent_maintenance',
    description: 'Refresh the local critical path from current Teamwork state.',
    intended_effect: 'Keep project state current without interrupting a teammate.',
    success_criteria: 'The control record matches source evidence.',
    confidence: 0.95,
    actionability: 1,
    evidence: EVIDENCE,
    cognitive_context: cognitiveContext(),
  }, { now: NOW, initiative: { remaining: 0 } });
  ledger = silent.ledger;
  assert.equal(silent.intervention.status, 'planned');
  assert.equal(silent.intervention.evaluation.uses_human_budget, false);
  const silentAuthorized = projectControl.authorizeIntervention(ledger, silent.intervention.id, {}, {
    now: NOW, initiative: { remaining: 0 },
  });
  assert.equal(silentAuthorized.intervention.status, 'authorized');

  const requested = projectControl.planIntervention(silentAuthorized.ledger, {
    project_key: 'tw-100',
    lane: 'requested_action',
    request_ref: 'slack:1711.22',
    description: 'Update the requested Teamwork task owner.',
    intended_effect: 'Carry out the explicit assignment request.',
    success_criteria: 'The task has the requested owner.',
    confidence: 0.95,
    actionability: 1,
    evidence: EVIDENCE,
    cognitive_context: cognitiveContext(),
  }, { now: NOW, initiative: { remaining: 0 } });
  assert.equal(requested.intervention.status, 'planned');
  assert.equal(requested.intervention.evaluation.uses_human_budget, false);
});

test('human-facing interventions require quality, cognitive grounding, and a reservation', () => {
  let ledger = withProject();
  const planned = projectControl.planIntervention(ledger, {
    project_key: 'tw-100',
    lane: 'consolidated_coordination',
    recipient: 'Taylor',
    target_ref: 'teamwork:task-42',
    description: 'Ask once who owns QA and whether Monday completion still holds.',
    intended_effect: 'Close the ownership gap before it moves the approval milestone.',
    success_criteria: 'An owner and completion time are recorded.',
    confidence: 0.9,
    actionability: 0.95,
    impact: 0.8,
    evidence: EVIDENCE,
    cognitive_context: cognitiveContext(),
  }, { now: NOW, initiative: { remaining: 1 } });
  ledger = planned.ledger;
  assert.equal(planned.intervention.status, 'planned');
  assert.equal(planned.intervention.evaluation.allowed, true);
  assert.equal(planned.intervention.evaluation.uses_human_budget, true);

  const missingReservation = projectControl.authorizeIntervention(ledger, planned.intervention.id, {}, {
    now: NOW, initiative: { remaining: 1 },
  });
  assert.equal(missingReservation.intervention.status, 'suppressed');
  assert.match(missingReservation.intervention.evaluation.reasons.join(' '), /not reserved/);

  const fresh = projectControl.planIntervention(withProject(), {
    project_key: 'tw-100', lane: 'escalation', recipient: 'Taylor', target_ref: 'teamwork:task-42',
    description: 'Escalate the unowned critical-path QA dependency.',
    intended_effect: 'Secure ownership before the launch date is exposed.',
    success_criteria: 'An owner and recovery date are recorded.',
    confidence: 0.9, actionability: 0.95, impact: 0.9, evidence: EVIDENCE,
    cognitive_context: cognitiveContext(),
  }, { now: NOW, initiative: { remaining: 1 } });
  const authorized = projectControl.authorizeIntervention(fresh.ledger, fresh.intervention.id, {
    initiative_reservation: { allowed: true, scope: 'cowork:proactive', day: '2026-08-08', spent: 1, remaining: 0 },
  }, { now: NOW, initiative: { remaining: 1 } });
  assert.equal(authorized.intervention.status, 'authorized');
  assert.equal(authorized.intervention.initiative_reservation.scope, 'cowork:proactive');
});

test('duplicate evidence and cooldowns suppress repeated reminders across surfaces', () => {
  let ledger = withProject();
  const common = {
    project_key: 'tw-100', lane: 'consolidated_coordination', recipient: 'Taylor',
    target_ref: 'teamwork:task-42', subject_ref: 'teamwork:task-42',
    description: 'Ask who owns QA and whether Monday completion still holds.',
    intended_effect: 'Close the ownership gap.', success_criteria: 'Ownership is recorded.',
    confidence: 0.9, actionability: 0.95, impact: 0.8, evidence: EVIDENCE,
    cognitive_context: cognitiveContext(),
  };
  const first = projectControl.planIntervention(ledger, common, { now: NOW, initiative: { remaining: 1 } });
  const authorized = projectControl.authorizeIntervention(first.ledger, first.intervention.id, {
    initiative_reservation: { allowed: true, scope: 'cowork:proactive', day: '2026-08-08', spent: 1, remaining: 0 },
  }, { now: NOW, initiative: { remaining: 1 } });
  const executed = projectControl.executeIntervention(authorized.ledger, first.intervention.id, {
    execution_ref: 'teamwork:comment-88',
  }, { now: NOW });
  assert.equal(executed.intervention.status, 'executed');

  const repeat = projectControl.planIntervention(executed.ledger, {
    ...common,
    evidence: [{ type: 'slack_message', ref: 'slack:1712.33', observed_at: '2026-08-08T14:10:00.000Z' }],
  }, { now: new Date('2026-08-08T14:15:00.000Z'), initiative: { remaining: 1 } });
  assert.equal(repeat.intervention.status, 'suppressed');
  assert.match(repeat.intervention.evaluation.reasons.join(' '), /recipient is inside|subject is inside/);
});

test('observed consequences produce replayable learning and PM quality metrics', () => {
  const planned = projectControl.planIntervention(withProject(), {
    project_key: 'tw-100', lane: 'requested_action', request_ref: 'slack:1711.22',
    description: 'Update the requested Teamwork owner.', intended_effect: 'Complete the request.',
    success_criteria: 'The correct owner is recorded.', confidence: 0.95, actionability: 1,
    evidence: EVIDENCE, cognitive_context: cognitiveContext(),
  }, { now: NOW, initiative: { remaining: 0 } });
  const authorized = projectControl.authorizeIntervention(planned.ledger, planned.intervention.id, {}, {
    now: NOW, initiative: { remaining: 0 },
  });
  const executed = projectControl.executeIntervention(authorized.ledger, planned.intervention.id, {
    execution_ref: 'teamwork:task-42:assignee-updated',
  }, { now: NOW });
  const observed = projectControl.observeIntervention(executed.ledger, planned.intervention.id, {
    outcome: 'helped',
    observed_effect: 'Taylor confirmed the assignment and QA started.',
    evidence: [{ type: 'teamwork_task', ref: 'task-42:active' }],
    learning: 'Explicit requests with a precise target can be executed quietly and verified later.',
    behavior_change: 'Keep requested actions outside the proactive interruption budget.',
  }, { now: new Date('2026-08-08T16:00:00.000Z') });
  assert.equal(observed.intervention.status, 'observed');
  assert.match(observed.outcome.outcome_commitment, /^[a-f0-9]{64}$/);
  assert.deepEqual(projectControl.shadowEvaluation(observed.ledger), {
    planned: 1, suppressed: 0, executed: 1, observed: 1, helpful: 1, harmful: 0, ignored: 0,
    suppression_rate: 0, execution_rate: 1, observation_rate: 1, helpful_rate: 1,
    harmful_rate: 0, actionable_rate: 1,
  });
  const quality = projectControl.qualityEvaluation(observed.ledger);
  assert.equal(quality.rollout_stage, 'shadow_calibration');
  assert.equal(quality.gates.enough_pilot_evidence, false);
  assert.equal(quality.gates.one_human_interruption_per_day, true);
  assert.ok(quality.score >= 0.8);
});

test('operator policy changes remain bounded and normalized', () => {
  const updated = projectControl.updatePolicy(projectControl.emptyLedger(), {
    recipient_cooldown_hours: 72,
    subject_cooldown_hours: 24,
    minimum_confidence: 2,
    minimum_actionability: -1,
    emergency_budget_override: false,
    unknown_setting: 'ignored',
  });
  assert.equal(updated.policy.recipient_cooldown_hours, 72);
  assert.equal(updated.policy.minimum_confidence, 1);
  assert.equal(updated.policy.minimum_actionability, 0);
  assert.equal(updated.policy.unknown_setting, undefined);
});

test('live prompts receive only the relevant compact project control picture', () => {
  let ledger = withProject();
  ledger = projectControl.createRisk(ledger, {
    project_key: 'tw-100', title: 'Quality assurance has no owner',
    description: 'The critical path task remains unassigned.', severity: 'high', confidence: 0.9,
    next_action: 'Name an owner and completion time.', evidence: EVIDENCE,
  }, { now: NOW }).ledger;
  ledger = projectControl.upsertProject(ledger, {
    key: 'unrelated', name: 'Unrelated account', health: 'green',
  }, { now: NOW }).ledger;
  const context = projectControl.renderPromptContext(ledger, {
    query: 'What is putting the Client launch date at risk?',
  });
  assert.match(context, /Client launch: health amber/);
  assert.match(context, /Risk high: Quality assurance has no owner/);
  assert.doesNotMatch(context, /Unrelated account/);
  assert.equal(projectControl.renderPromptContext(ledger, { query: 'How are you today?' }), '');
});

test('meeting decisions and open loops join the matching project story idempotently', () => {
  const input = {
    project: 'Client launch',
    meeting_ref: 'recall:bot-55',
    ended: '2026-08-08T15:00:00.000Z',
    decisions: ['Launch remains Tuesday if browser QA clears Monday.'],
    open_loops: [{ what: 'Confirm the browser QA owner.', owner: 'Taylor', due: '2026-08-10T17:00:00.000Z' }],
  };
  const ingested = projectControl.ingestMeeting(withProject(), input, { now: NOW });
  assert.equal(ingested.matched, true);
  assert.equal(ingested.decisions.length, 1);
  assert.equal(ingested.risks.length, 1);
  assert.equal(ingested.risks[0].owner, 'Taylor');
  const repeated = projectControl.ingestMeeting(ingested.ledger, input, { now: NOW });
  assert.equal(repeated.ledger.decisions.length, 1);
  assert.equal(repeated.ledger.risks.length, 1);
  assert.equal(projectControl.ingestMeeting(withProject(), {
    ...input, project: 'Unknown account',
  }, { now: NOW }).matched, false);
});
