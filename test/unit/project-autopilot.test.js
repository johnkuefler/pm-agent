'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const projectControl = require('../../src/intelligence/project-control');
const autopilot = require('../../src/intelligence/project-autopilot');

const NOW = new Date('2026-08-08T14:00:00.000Z');
const EVIDENCE = [{ type: 'teamwork_task', ref: 'task-42', observed_at: NOW.toISOString() }];

function projectLedger() {
  return projectControl.upsertProject(projectControl.emptyLedger(), {
    key: 'tw-100', name: 'Client launch', teamwork_id: '100', client: 'Client Company',
    objective: 'Launch the approved client site without avoidable delivery risk.',
    phase: 'quality assurance', pm: 'Taylor', health: 'amber',
    health_reason: 'The approval path still contains overdue work.',
    next_milestone: 'Client approval', next_milestone_due: '2026-08-07T00:00:00.000Z',
    critical_path: ['Complete QA', 'Receive approval'], evidence: EVIDENCE,
    decision_state: { open_count: 1, candidates: [{ id: 'task-42', title: 'Approve launch',
      due_at: '2026-08-08T00:00:00.000Z', assignees: ['Taylor'], evidence_ref: 'task-42' }] },
    hydration: { source: 'teamwork_project_story', version: 1,
      source_signature: 'a'.repeat(64), hydrated_at: NOW.toISOString(), managed_fields: [],
      field_sources: {}, schedule: { open_tasks: 8, overdue_tasks: 2,
        unassigned_tasks: 1, open_milestones: 1 } },
  }, { now: NOW }).ledger;
}

function charter(ledger, mode = 'managed') {
  const drafted = autopilot.upsertCharter(ledger, 'tw-100', {
    mode, sponsor: 'John Kuefler', mandate: 'Own routine delivery coordination for this project.',
    success_criteria: ['Protect the approval milestone', 'Keep work owned and decisions explicit'],
    stakeholders: ['Taylor', 'Morgan'],
    authority: {
      schedule_internal_meetings: true, create_tasks: true, assign_tasks: true,
      update_routine_dates: true, routine_date_shift_limit_days: 2,
      request_updates: true, facilitate_meetings: true, record_decisions: true,
      update_project_plan: true, max_meetings_per_week: 2, meeting_cooldown_hours: 24,
    },
    pilot_note: 'John authorizes a bounded delivery pilot with the listed standing authorities.',
  }, { now: NOW, actor: 'John' });
  return autopilot.activateCharter(drafted.ledger, 'tw-100', { mode,
    pilot_note: 'John authorizes a bounded delivery pilot with the listed standing authorities.' },
  { now: NOW, actor: 'John' }).ledger;
}

test('charters preserve hard human gates and require a complete sponsored mandate', () => {
  const ledger = projectLedger();
  const drafted = autopilot.upsertCharter(ledger, 'tw-100', {
    mode: 'managed', sponsor: 'John Kuefler', mandate: 'Manage delivery coordination.',
    success_criteria: ['Protect the approval milestone'],
    authority: { schedule_internal_meetings: true, external_email: true },
  }, { now: NOW, actor: 'John' });
  assert.equal(drafted.charter.authority.schedule_internal_meetings, true);
  assert.equal(drafted.charter.authority.external_email, undefined);
  assert.match(drafted.charter.fixed_gates.external_email, /approval/);
  assert.throws(() => autopilot.activateCharter(drafted.ledger, 'tw-100', {
    mode: 'managed', pilot_note: 'short',
  }, { now: NOW, actor: 'John' }), /twenty characters/);

  const active = autopilot.activateCharter(drafted.ledger, 'tw-100', {
    mode: 'managed', pilot_note: 'A deliberate managed pilot with bounded internal authority.',
  }, { now: NOW, actor: 'John' });
  assert.equal(active.charter.status, 'active');
  assert.equal(active.charter.mode, 'managed');
  assert.match(active.charter.activation_commitment, /^[a-f0-9]{64}$/);
});

test('source changes create one event-driven action set and clear it without reminder loops', () => {
  let ledger = charter(projectLedger());
  const first = autopilot.reconcilePortfolio(ledger, { now: NOW, source: 'test' });
  ledger = first.ledger;
  assert.deepEqual(first.events.map(item => item.kind).sort(),
    ['checkpoint_overdue', 'decision_blocked', 'tasks_overdue', 'tasks_unassigned']);
  assert.equal(first.actions.length, 4);
  assert.ok(first.actions.every(item => item.state === 'proposed'));

  const repeated = autopilot.reconcilePortfolio(ledger, { now: NOW, source: 'test-repeat' });
  assert.equal(repeated.events.length, 0);
  assert.equal(repeated.actions.length, 0);

  const project = repeated.ledger.projects[0];
  project.next_milestone_due = '2026-08-12T00:00:00.000Z';
  project.decision_state = { status: 'none', open_count: 0, candidates: [] };
  project.hydration.schedule = { open_tasks: 8, overdue_tasks: 0,
    unassigned_tasks: 0, open_milestones: 1 };
  const cleared = autopilot.reconcilePortfolio(repeated.ledger, {
    now: new Date('2026-08-08T15:00:00.000Z'), source: 'condition-cleared',
  });
  assert.equal(cleared.resolved_events.length, 4);
  assert.ok(cleared.ledger.autopilot.actions.every(item => item.state === 'suppressed'));
});

test('managed authority never bypasses the shared human interruption rail', () => {
  let ledger = charter(projectLedger());
  const reconciled = autopilot.reconcilePortfolio(ledger, { now: NOW });
  ledger = reconciled.ledger;
  const action = ledger.autopilot.actions.find(item => item.type === 'request_update');
  assert.throws(() => autopilot.authorizeAction(ledger, action.id, {}, { now: NOW }),
    /authorized PM intervention/);

  const planned = projectControl.planIntervention(ledger, {
    project_key: 'tw-100', lane: 'consolidated_coordination', recipient: 'Taylor',
    subject_ref: action.subject_ref, description: action.description,
    intended_effect: action.expected_outcome, success_criteria: action.success_criteria,
    confidence: 0.9, actionability: 0.9, impact: 0.8, evidence: EVIDENCE,
    cognitive_context: { rationale: 'A verified delivery exception needs one bounded request.',
      uncertainty: 'The work may have moved outside Teamwork.', assumptions: ['Teamwork is current.'],
      self_limitations: ['I cannot see offline work.'] },
  }, { now: NOW, initiative: { remaining: 1 } });
  const authorizedIntervention = projectControl.authorizeIntervention(planned.ledger,
    planned.intervention.id, { initiative_reservation: { allowed: true,
      scope: 'cowork:proactive', day: '2026-08-08', spent: 1, remaining: 0 } },
  { now: NOW, initiative: { remaining: 1 } });
  const authorized = autopilot.authorizeAction(authorizedIntervention.ledger, action.id, {
    intervention_id: planned.intervention.id,
  }, { now: NOW, actor: 'Nora' });
  assert.equal(authorized.action.state, 'authorized');
  assert.equal(authorized.action.intervention_id, planned.intervention.id);
  assert.equal(authorized.action.authorization.kind, 'standing_charter');
});

test('copilot actions require operator approval and shadow actions can never execute', () => {
  let copilotLedger = charter(projectLedger(), 'copilot');
  copilotLedger = autopilot.reconcilePortfolio(copilotLedger, { now: NOW }).ledger;
  const ownership = copilotLedger.autopilot.actions.find(item => item.type === 'resolve_ownership');
  assert.equal(ownership.state, 'approval_required');
  assert.throws(() => autopilot.authorizeAction(copilotLedger, ownership.id,
    { resolution: 'Taylor owns the task.' }, { now: NOW }), /operator approval/);
  const approved = autopilot.authorizeAction(copilotLedger, ownership.id,
    { resolution: 'Taylor owns the task.' }, { now: NOW, operator: true, actor: 'John' });
  assert.equal(approved.action.authorization.kind, 'operator');

  let shadowLedger = charter(projectLedger(), 'shadow');
  shadowLedger = autopilot.reconcilePortfolio(shadowLedger, { now: NOW }).ledger;
  const shadow = shadowLedger.autopilot.actions[0];
  assert.equal(shadow.state, 'shadow');
  assert.throws(() => autopilot.authorizeAction(shadowLedger, shadow.id, {}, { now: NOW }),
    /state shadow/);
});

test('meeting lifecycle binds authorization, calendar, attendance, transcript, and Teamwork closure', () => {
  let ledger = charter(projectLedger());
  ledger = autopilot.reconcilePortfolio(ledger, { now: NOW }).ledger;
  const action = ledger.autopilot.actions.find(item => item.type === 'schedule_decision_meeting');
  ledger = autopilot.authorizeAction(ledger, action.id, {}, { now: NOW }).ledger;
  const planned = autopilot.planMeeting(ledger, {
    project_key: 'tw-100', action_id: action.id, title: 'Launch approval decision',
    objective: 'Close the launch approval decision.',
    agenda: ['Review verified readiness', 'Record the approval decision'],
    attendees: ['Taylor', 'Morgan'], expected_decisions: ['Approve launch or name the blocker'],
    duration_minutes: 30,
  }, { now: NOW });
  ledger = planned.ledger;
  assert.equal(planned.meeting.state, 'planned');
  ledger = autopilot.authorizeMeeting(ledger, planned.meeting.id, {}, { now: NOW }).ledger;
  ledger = autopilot.scheduleMeeting(ledger, planned.meeting.id, {
    calendar_event_ref: 'gcal:event-77', join_url: 'https://meet.google.com/abc-defg-hij',
    scheduled_for: '2026-08-10T15:00:00.000Z',
  }, { now: NOW }).ledger;
  ledger = autopilot.joinMeeting(ledger, planned.meeting.id,
    { bot_ref: 'recall:bot-88' }, { now: new Date('2026-08-10T15:00:00.000Z') }).ledger;
  ledger = autopilot.completeMeeting(ledger, planned.meeting.id, {
    transcript_ref: '/transcripts/bot-88', outcome_summary: 'Taylor approved the launch.',
    decisions: ['Launch is approved'], action_items: ['Morgan completes DNS cutover'],
  }, { now: new Date('2026-08-10T15:30:00.000Z') }).ledger;
  const reconciled = autopilot.reconcileMeeting(ledger, planned.meeting.id, {
    teamwork_refs: ['teamwork:task-90'], followup_ref: 'teamwork:comment-91',
    evidence: [{ type: 'teamwork_task', ref: 'task-90' }],
  }, { now: new Date('2026-08-10T15:40:00.000Z') });
  assert.equal(reconciled.meeting.state, 'reconciled');
  assert.equal(reconciled.meeting.calendar_event_ref, 'gcal:event-77');
  assert.equal(reconciled.meeting.bot_ref, 'recall:bot-88');
  assert.equal(reconciled.report.meetings.reconciled, 1);
});

test('external attendees retain operator approval even in managed mode', () => {
  let ledger = charter(projectLedger());
  const meeting = autopilot.planMeeting(ledger, {
    project_key: 'tw-100', request_ref: 'slack:request-1',
    objective: 'Review client approval feedback.', agenda: ['Review feedback'],
    attendees: ['Taylor', 'Client'], external_attendees: true,
  }, { now: NOW });
  ledger = meeting.ledger;
  assert.throws(() => autopilot.authorizeMeeting(ledger, meeting.meeting.id, {}, { now: NOW }),
    /external attendees/);
  const approved = autopilot.authorizeMeeting(ledger, meeting.meeting.id,
    { note: 'John approved the named external attendees.' },
  { now: NOW, operator: true, actor: 'John' });
  assert.equal(approved.meeting.state, 'authorized');
});

test('editing or pausing active authority fails closed around pending work and attendance', () => {
  let ledger = charter(projectLedger());
  ledger = autopilot.reconcilePortfolio(ledger, { now: NOW }).ledger;
  const action = ledger.autopilot.actions.find(item => item.type === 'schedule_decision_meeting');
  ledger = autopilot.authorizeAction(ledger, action.id, {}, { now: NOW }).ledger;
  const planned = autopilot.planMeeting(ledger, {
    project_key: 'tw-100', action_id: action.id, objective: 'Close launch approval.',
    agenda: ['Decide launch readiness'], attendees: ['Taylor'],
  }, { now: NOW });
  ledger = autopilot.authorizeMeeting(planned.ledger, planned.meeting.id, {}, { now: NOW }).ledger;
  ledger = autopilot.scheduleMeeting(ledger, planned.meeting.id, {
    calendar_event_ref: 'gcal:event-99', join_url: 'https://meet.google.com/abc-defg-hij',
    scheduled_for: '2026-08-10T15:00:00.000Z',
  }, { now: NOW }).ledger;

  const edited = autopilot.upsertCharter(ledger, 'tw-100', {
    mandate: 'Own delivery coordination with a newly narrowed mandate.',
  }, { now: new Date('2026-08-08T15:00:00.000Z'), actor: 'John' });
  assert.equal(edited.charter.status, 'draft');
  assert.equal(edited.ledger.autopilot.meetings[0].attendance_blocked, true);
  assert.equal(edited.ledger.autopilot.meetings[0].calendar_cancellation_required, true);
  assert.throws(() => autopilot.joinMeeting(edited.ledger, planned.meeting.id,
    { bot_ref: 'recall:bot-99' }, { now: new Date('2026-08-10T15:00:00.000Z') }),
  /charter is not active/);
});

test('observed actions turn confidence into replayable calibration evidence', () => {
  let ledger = charter(projectLedger(), 'copilot');
  ledger = autopilot.reconcilePortfolio(ledger, { now: NOW }).ledger;
  const action = ledger.autopilot.actions.find(item => item.type === 'resolve_ownership');
  ledger = autopilot.authorizeAction(ledger, action.id, { resolution: 'Taylor owns the task.' },
    { now: NOW, operator: true, actor: 'John' }).ledger;
  ledger = autopilot.executeAction(ledger, action.id,
    { execution_ref: 'teamwork:task-42:assigned' }, { now: NOW }).ledger;
  const observed = autopilot.observeAction(ledger, action.id, {
    outcome: 'helped', observed_effect: 'Taylor accepted ownership and started the task.',
    evidence: [{ type: 'teamwork_task', ref: 'task-42:in-progress' }],
    lesson: 'A named owner resolved the ambiguity.',
    behavior_change: 'Require a named owner before assignment actions.',
  }, { now: new Date('2026-08-08T16:00:00.000Z') });
  assert.equal(observed.action.state, 'observed');
  assert.equal(observed.observation.actual_value, 1);
  assert.ok(observed.observation.brier_score < 0.1);
  assert.equal(observed.report.learning.observed, 1);
  assert.match(autopilot.renderPromptContext(observed.ledger), /explicit project-scoped authority/);
  assert.match(autopilot.renderPromptContext(observed.ledger), /Require a named owner/);

  const project = observed.ledger.projects[0];
  project.hydration.schedule.unassigned_tasks = 0;
  ledger = autopilot.reconcilePortfolio(observed.ledger,
    { now: new Date('2026-08-08T17:00:00.000Z') }).ledger;
  project.hydration.schedule.unassigned_tasks = 1;
  const replay = autopilot.reconcilePortfolio(ledger,
    { now: new Date('2026-08-08T18:00:00.000Z') });
  const learnedAction = replay.actions.find(item => item.type === 'resolve_ownership');
  assert.equal(learnedAction.prediction.calibration_samples, 1);
  assert.ok(learnedAction.prediction.confidence > action.prediction.confidence);
  assert.deepEqual(learnedAction.prediction.behavior_guidance,
    ['Require a named owner before assignment actions.']);
});
