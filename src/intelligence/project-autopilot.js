'use strict';

const crypto = require('crypto');

const MODES = Object.freeze(['shadow', 'copilot', 'managed']);
const CHARTER_STATUSES = Object.freeze(['draft', 'active', 'paused', 'retired']);
const ACTION_STATES = Object.freeze([
  'shadow', 'proposed', 'approval_required', 'authorized', 'executed', 'observed',
  'suppressed', 'failed',
]);
const MEETING_STATES = Object.freeze([
  'shadow', 'planned', 'authorized', 'scheduled', 'joined', 'completed', 'reconciled',
  'cancelled',
]);
const OUTCOMES = Object.freeze(['helped', 'neutral', 'ignored', 'backfired', 'resolved']);
const OUTCOME_VALUES = Object.freeze({ helped: 1, resolved: 1, neutral: 0.5, ignored: 0, backfired: 0 });
const FIXED_GATES = Object.freeze({
  external_email: 'per-draft Slack approval from John remains required',
  client_commitment: 'human sponsor approval remains required',
  scope_change: 'human sponsor approval remains required',
  budget_change: 'human sponsor approval remains required',
  major_deadline_change: 'human sponsor approval remains required',
  financial_disclosure: 'existing recipient policy remains required',
});
const AUTHORITY_KEYS = Object.freeze([
  'schedule_internal_meetings',
  'create_tasks',
  'assign_tasks',
  'update_routine_dates',
  'request_updates',
  'facilitate_meetings',
  'record_decisions',
  'update_project_plan',
]);
const ACTION_AUTHORITY = Object.freeze({
  maintain_project_story: 'update_project_plan',
  request_update: 'request_updates',
  resolve_ownership: 'assign_tasks',
  schedule_decision_meeting: 'schedule_internal_meetings',
  escalate_risk: 'request_updates',
  create_task: 'create_tasks',
  assign_task: 'assign_tasks',
  update_routine_date: 'update_routine_dates',
  record_decision: 'record_decisions',
  update_project_plan: 'update_project_plan',
});
const HUMAN_FACING_ACTIONS = new Set(['request_update', 'escalate_risk']);
const NEVER_AUTONOMOUS_ACTIONS = new Set([
  'external_email', 'client_commitment', 'scope_change', 'budget_change',
  'major_deadline_change', 'financial_disclosure',
]);

function clean(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function clamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('time must be an ISO-compatible date');
  return date.toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizeList(value, maxItems = 30, maxText = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => clean(item, maxText)).filter(Boolean))].slice(0, maxItems);
}

function normalizeEvidence(value, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 20 || (required && value.length < 1)) {
    throw new Error(required ? 'one to twenty evidence references are required'
      : 'at most twenty evidence references are accepted');
  }
  return value.map(item => {
    const type = clean(item?.type, 80);
    const ref = clean(item?.ref || item?.id || item?.url, 1000);
    if (!type || !ref) throw new Error('each evidence reference requires type and ref');
    return { type, ref,
      ...(item?.observed_at ? { observed_at: timestamp(item.observed_at) } : {}),
      ...(item?.note ? { note: clean(item.note, 400) } : {}) };
  });
}

function emptyState() {
  return {
    version: 1,
    charters: [],
    events: [],
    actions: [],
    meetings: [],
    observations: [],
    reconciliations: [],
  };
}

function normalizeState(value = {}) {
  const base = emptyState();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    charters: Array.isArray(source.charters)
      ? source.charters.filter(item => item?.id && item?.project_key).slice(-1000) : base.charters,
    events: Array.isArray(source.events)
      ? source.events.filter(item => item?.id && item?.project_key).slice(-10000) : base.events,
    actions: Array.isArray(source.actions)
      ? source.actions.filter(item => item?.id && item?.project_key).slice(-10000) : base.actions,
    meetings: Array.isArray(source.meetings)
      ? source.meetings.filter(item => item?.id && item?.project_key).slice(-5000) : base.meetings,
    observations: Array.isArray(source.observations)
      ? source.observations.filter(item => item?.id && item?.action_id).slice(-10000) : base.observations,
    reconciliations: Array.isArray(source.reconciliations)
      ? source.reconciliations.filter(item => item?.id).slice(-5000) : base.reconciliations,
  };
}

function stateFor(ledger) {
  ledger.autopilot = normalizeState(ledger.autopilot);
  return ledger.autopilot;
}

function findProject(ledger, projectKey) {
  const key = clean(projectKey, 240).toLowerCase();
  const project = ledger.projects.find(item => item.key === key);
  if (!project) throw new Error('project control record not found');
  return project;
}

function findCharter(ledger, projectKey, { active = false } = {}) {
  const key = clean(projectKey, 240).toLowerCase();
  const charter = stateFor(ledger).charters.find(item => item.project_key === key);
  if (!charter) throw new Error('project autopilot charter not found');
  if (active && charter.status !== 'active') throw new Error('project autopilot charter is not active');
  return charter;
}

function normalizeAuthority(input = {}, existing = {}) {
  const authority = {};
  for (const key of AUTHORITY_KEYS) authority[key] = Boolean(input[key] ?? existing[key]);
  authority.routine_date_shift_limit_days = Math.max(0,
    Math.min(14, Number(input.routine_date_shift_limit_days
      ?? existing.routine_date_shift_limit_days) || 0));
  authority.max_meetings_per_week = Math.max(1,
    Math.min(5, Number(input.max_meetings_per_week ?? existing.max_meetings_per_week) || 2));
  authority.meeting_cooldown_hours = Math.max(4,
    Math.min(168, Number(input.meeting_cooldown_hours ?? existing.meeting_cooldown_hours) || 24));
  return authority;
}

function charterCommitment(charter) {
  return commitment({ project_key: charter.project_key, mode: charter.mode,
    sponsor: charter.sponsor, mandate: charter.mandate, success_criteria: charter.success_criteria,
    stakeholders: charter.stakeholders, authority: charter.authority, fixed_gates: charter.fixed_gates,
    quiet_policy: charter.quiet_policy });
}

function upsertCharter(ledger, projectKey, input = {}, { now = new Date(), actor = 'operator' } = {}) {
  const project = findProject(ledger, projectKey);
  const state = stateFor(ledger);
  const existing = state.charters.find(item => item.project_key === project.key);
  const mode = clean(input.mode || existing?.mode || 'shadow', 30).toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  const status = existing?.status || 'draft';
  const previousCommitment = existing?.charter_commitment || null;
  const updatedAt = timestamp(now);
  const charter = {
    ...(existing || {}),
    id: existing?.id || `autopilot-charter:${project.key}`,
    project_key: project.key,
    project_name: project.name,
    status,
    mode,
    sponsor: clean(input.sponsor ?? existing?.sponsor, 240),
    mandate: clean(input.mandate ?? existing?.mandate, 1200),
    success_criteria: normalizeList(input.success_criteria ?? existing?.success_criteria, 20, 500),
    stakeholders: normalizeList(input.stakeholders ?? existing?.stakeholders, 40, 240),
    authority: normalizeAuthority(input.authority || {}, existing?.authority || {}),
    fixed_gates: { ...FIXED_GATES },
    quiet_policy: {
      event_driven_only: true,
      no_quiet_status_messages: true,
      one_human_interruption_budget: true,
      consolidate_related_exceptions: true,
    },
    pilot_note: clean(input.pilot_note ?? existing?.pilot_note, 1200),
    updated_by: clean(actor, 240),
    updated_at: updatedAt,
    created_at: existing?.created_at || updatedAt,
  };
  charter.charter_commitment = charterCommitment(charter);
  const activeCharterChanged = existing?.status === 'active'
    && previousCommitment !== charter.charter_commitment;
  if (activeCharterChanged) {
    charter.status = 'draft';
    charter.reactivation_reason = 'charter authority or mandate changed';
    const state = stateFor(ledger);
    for (const action of state.actions.filter(item => item.project_key === project.key
      && ['proposed', 'approval_required', 'authorized'].includes(item.state))) {
      action.state = 'suppressed';
      action.suppression_reason = 'project autopilot charter changed and requires reactivation';
      action.updated_at = updatedAt;
    }
    for (const meeting of state.meetings.filter(item => item.project_key === project.key
      && ['planned', 'authorized'].includes(item.state))) {
      meeting.state = 'cancelled';
      meeting.cancellation_reason = 'project autopilot charter changed before scheduling';
      meeting.updated_at = updatedAt;
    }
    for (const meeting of state.meetings.filter(item => item.project_key === project.key
      && meetingIsScheduledAndOpen(item))) {
      meeting.attendance_blocked = true;
      meeting.calendar_cancellation_required = true;
      meeting.blocked_reason = 'project autopilot charter changed after calendar scheduling';
      meeting.updated_at = updatedAt;
    }
  }
  if (existing) Object.assign(existing, charter);
  else state.charters.push(charter);
  return { ledger, charter, report: report(ledger, { now }) };
}

function activateCharter(ledger, projectKey, input = {}, { now = new Date(), actor = 'operator' } = {}) {
  const project = findProject(ledger, projectKey);
  const charter = findCharter(ledger, project.key);
  const mode = clean(input.mode || charter.mode, 30).toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  if (!charter.sponsor) throw new Error('an accountable human sponsor is required');
  if (!charter.mandate) throw new Error('a bounded project mandate is required');
  if (!charter.success_criteria.length) throw new Error('at least one success criterion is required');
  if (project.completeness?.ratio !== 1) {
    throw new Error('the project operating picture must be complete before autopilot activation');
  }
  const note = clean(input.pilot_note || charter.pilot_note, 1200);
  if (mode === 'managed' && note.length < 20) {
    throw new Error('managed mode requires an explicit pilot note of at least twenty characters');
  }
  Object.assign(charter, {
    mode,
    status: 'active',
    pilot_note: note,
    activated_by: clean(actor, 240),
    activated_at: timestamp(now),
    updated_by: clean(actor, 240),
    updated_at: timestamp(now),
  });
  charter.charter_commitment = charterCommitment(charter);
  charter.activation_commitment = commitment({ id: charter.id, mode: charter.mode,
    sponsor: charter.sponsor, authority: charter.authority, pilot_note: charter.pilot_note,
    activated_by: charter.activated_by, activated_at: charter.activated_at });
  return { ledger, charter, report: report(ledger, { now }) };
}

function pauseCharter(ledger, projectKey, input = {}, { now = new Date(), actor = 'operator' } = {}) {
  const charter = findCharter(ledger, projectKey);
  const reason = clean(input.reason, 900);
  if (!reason) throw new Error('a pause reason is required');
  Object.assign(charter, { status: 'paused', pause_reason: reason, paused_by: clean(actor, 240),
    paused_at: timestamp(now), updated_at: timestamp(now) });
  const state = stateFor(ledger);
  for (const action of state.actions.filter(item => item.project_key === charter.project_key
    && ['proposed', 'approval_required', 'authorized'].includes(item.state))) {
    action.state = 'suppressed';
    action.suppression_reason = 'project autopilot charter paused';
    action.updated_at = timestamp(now);
  }
  for (const meeting of state.meetings.filter(item => item.project_key === charter.project_key
    && ['planned', 'authorized'].includes(item.state))) {
    meeting.state = 'cancelled';
    meeting.cancellation_reason = 'project autopilot charter paused before scheduling';
    meeting.updated_at = timestamp(now);
  }
  for (const meeting of state.meetings.filter(item => item.project_key === charter.project_key
    && meetingIsScheduledAndOpen(item))) {
    meeting.attendance_blocked = true;
    meeting.calendar_cancellation_required = true;
    meeting.blocked_reason = 'project autopilot charter paused after calendar scheduling';
    meeting.updated_at = timestamp(now);
  }
  return { ledger, charter, report: report(ledger, { now }) };
}

function meetingIsScheduledAndOpen(meeting) {
  return ['scheduled', 'joined'].includes(meeting.state);
}

function utcStartOfDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function signalEvidence(project, note) {
  return [{ type: 'project_control', ref: project.control_commitment || `project:${project.key}`,
    observed_at: project.updated_at || null, note }].map(item => {
    if (!item.observed_at) delete item.observed_at;
    return item;
  });
}

function projectSignals(ledger, project, { now = new Date() } = {}) {
  const schedule = project.hydration?.schedule || {};
  const risks = ledger.risks.filter(item => item.project_key === project.key
    && ['open', 'monitoring'].includes(item.status));
  const signals = [];
  const dueAt = project.next_milestone_due ? new Date(project.next_milestone_due).getTime() : null;
  if (dueAt !== null && Number.isFinite(dueAt) && dueAt < utcStartOfDay(now)) {
    signals.push({ kind: 'checkpoint_overdue', severity: 'high', subject_ref: `milestone:${project.next_milestone}`,
      title: `${project.next_milestone || 'Project checkpoint'} is past due`,
      action_type: 'request_update', authority_key: 'request_updates', human_facing: true,
      evidence: signalEvidence(project, 'The current project checkpoint date is in the past.') });
  }
  const overdueTasks = Math.max(0, Number(schedule.overdue_tasks) || 0);
  if (overdueTasks) signals.push({ kind: 'tasks_overdue', severity: overdueTasks > 3 ? 'high' : 'medium',
    subject_ref: `project:${project.key}:overdue-tasks`, title: `${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'}`,
    action_type: 'request_update', authority_key: 'request_updates', human_facing: true,
    evidence: signalEvidence(project, 'Teamwork reports overdue project tasks.') });
  const unassignedTasks = Math.max(0, Number(schedule.unassigned_tasks) || 0);
  if (unassignedTasks) signals.push({ kind: 'tasks_unassigned', severity: 'medium',
    subject_ref: `project:${project.key}:unassigned-tasks`, title: `${unassignedTasks} task${unassignedTasks === 1 ? '' : 's'} need ownership`,
    action_type: 'resolve_ownership', authority_key: 'assign_tasks', human_facing: false,
    required_input: 'named owner', evidence: signalEvidence(project, 'Teamwork reports unassigned project tasks.') });
  const decisions = Math.max(0, Number(project.decision_state?.open_count) || 0);
  if (decisions) signals.push({ kind: 'decision_blocked', severity: 'medium',
    subject_ref: `project:${project.key}:decision-candidates`, title: `${decisions} decision candidate${decisions === 1 ? '' : 's'} need closure`,
    action_type: 'schedule_decision_meeting', authority_key: 'schedule_internal_meetings',
    human_facing: false, evidence: signalEvidence(project, 'Teamwork contains approval or sign-off candidates.') });
  for (const risk of risks.filter(item => ['high', 'critical'].includes(item.severity))) {
    signals.push({ kind: 'material_risk', severity: risk.severity, subject_ref: `risk:${risk.id}`,
      title: risk.title, action_type: 'escalate_risk', authority_key: 'request_updates', human_facing: true,
      risk_ref: risk.id, evidence: risk.evidence?.length ? risk.evidence
        : signalEvidence(project, 'The project control ledger contains a material open risk.') });
  }
  if (project.completeness?.ratio < 1) signals.push({ kind: 'story_incomplete', severity: 'low',
    subject_ref: `project:${project.key}:story`, title: 'Project operating picture is incomplete',
    action_type: 'maintain_project_story', authority_key: 'update_project_plan', human_facing: false,
    evidence: signalEvidence(project, 'The durable project picture is missing required fields.') });
  return signals;
}

function actionCopy(signal, project) {
  const copies = {
    checkpoint_overdue: {
      description: `Secure a current recovery date and owner for ${project.next_milestone || 'the overdue checkpoint'}.`,
      expected_outcome: 'A verified owner and recovery date are recorded in Teamwork.',
      success_criteria: 'The checkpoint has a current date, owner, and evidence-backed recovery plan.',
    },
    tasks_overdue: {
      description: 'Consolidate the overdue work into one ownership and recovery request.',
      expected_outcome: 'Owners confirm what will finish, move, or block the milestone.',
      success_criteria: 'Each material overdue task has a current owner and disposition.',
    },
    tasks_unassigned: {
      description: 'Resolve ownership for the unassigned project work.',
      expected_outcome: 'Every critical unassigned task receives a named owner.',
      success_criteria: 'No critical-path work remains unassigned.',
    },
    decision_blocked: {
      description: 'Prepare a bounded decision meeting only if asynchronous closure is insufficient.',
      expected_outcome: 'The open approval or sign-off candidates receive explicit decisions.',
      success_criteria: 'Each candidate is decided, assigned for follow-up, or given a named decision owner.',
    },
    material_risk: {
      description: `Escalate the verified ${signal.severity} risk with one concrete decision request.`,
      expected_outcome: 'The risk receives ownership, a mitigation, and a decision date.',
      success_criteria: 'The project risk has a named owner and observable next action.',
    },
    story_incomplete: {
      description: 'Fill only source-verifiable gaps in the durable project story.',
      expected_outcome: 'The project operating picture becomes complete without contacting a teammate.',
      success_criteria: 'Objective, phase, PM, checkpoint, and checkpoint date are source-grounded.',
    },
  };
  return copies[signal.kind];
}

function calibratedPrediction(state, type, baseConfidence) {
  const relevant = state.observations.map(observation => ({
    observation,
    action: state.actions.find(action => action.id === observation.action_id),
  })).filter(item => item.action?.type === type);
  const weight = 3;
  const actualTotal = relevant.reduce((sum, item) => sum
    + clamp(item.observation.actual_value, OUTCOME_VALUES[item.observation.outcome] ?? 0), 0);
  const confidence = clamp((baseConfidence * weight + actualTotal) / (weight + relevant.length),
    baseConfidence);
  const latestGuidance = relevant.map(item => clean(item.observation.behavior_change, 1200))
    .filter(Boolean).slice(-3);
  return {
    confidence: Number(confidence.toFixed(4)),
    calibration_samples: relevant.length,
    calibration_basis: relevant.length ? 'prior blended with observed outcomes' : 'severity prior',
    behavior_guidance: latestGuidance,
    falsifier: 'The source condition clears without this action or the action does not produce the stated success criterion.',
    passive_control: 'Continue source monitoring without contacting or changing the project.',
  };
}

function buildAction(state, charter, project, event, signal, now) {
  const copy = actionCopy(signal, project);
  const actionState = charter.mode === 'shadow' ? 'shadow'
    : charter.mode === 'copilot' ? 'approval_required' : 'proposed';
  const baseConfidence = signal.severity === 'critical' ? 0.85 : signal.severity === 'high' ? 0.78 : 0.7;
  const action = {
    id: id('autopilot-action'),
    charter_id: charter.id,
    project_key: project.key,
    event_id: event.id,
    type: signal.action_type,
    state: actionState,
    charter_activation_commitment: charter.activation_commitment || null,
    authority_key: signal.authority_key,
    human_facing: signal.human_facing,
    subject_ref: signal.subject_ref,
    risk_ref: signal.risk_ref || null,
    required_input: signal.required_input || null,
    description: copy.description,
    expected_outcome: copy.expected_outcome,
    success_criteria: copy.success_criteria,
    prediction: calibratedPrediction(state, signal.action_type, baseConfidence),
    evidence: normalizeEvidence(signal.evidence, { required: true }),
    created_at: timestamp(now),
    updated_at: timestamp(now),
  };
  action.action_commitment = commitment({ charter_id: action.charter_id, project_key: action.project_key,
    event_id: action.event_id, type: action.type, authority_key: action.authority_key,
    subject_ref: action.subject_ref, expected_outcome: action.expected_outcome,
    prediction: action.prediction, evidence: action.evidence, created_at: action.created_at });
  return action;
}

function reconcilePortfolio(ledger, { project_key: projectKey = '', now = new Date(), source = 'project_control_change' } = {}) {
  const state = stateFor(ledger);
  const activeCharters = state.charters.filter(item => item.status === 'active'
    && (!projectKey || item.project_key === clean(projectKey, 240).toLowerCase()));
  const generated = { events: [], actions: [], resolved_events: [] };
  for (const charter of activeCharters) {
    const project = findProject(ledger, charter.project_key);
    const signals = projectSignals(ledger, project, { now });
    const activeSignatures = new Set(signals.map(signal => commitment({ project_key: project.key,
      kind: signal.kind, subject_ref: signal.subject_ref })));
    for (const event of state.events.filter(item => item.project_key === project.key && item.status === 'open')) {
      if (!activeSignatures.has(event.condition_signature)) {
        event.status = 'resolved';
        event.resolved_at = timestamp(now);
        event.resolution_reason = 'source condition no longer present';
        generated.resolved_events.push(event);
        for (const action of state.actions.filter(item => item.event_id === event.id
          && ['shadow', 'proposed', 'approval_required', 'authorized'].includes(item.state))) {
          action.state = 'suppressed';
          action.suppression_reason = 'source condition cleared before execution';
          action.updated_at = timestamp(now);
        }
      }
    }
    for (const signal of signals) {
      const conditionSignature = commitment({ project_key: project.key, kind: signal.kind,
        subject_ref: signal.subject_ref });
      let event = state.events.find(item => item.project_key === project.key
        && item.condition_signature === conditionSignature && item.status === 'open');
      if (!event) {
        event = {
          id: id('autopilot-event'), charter_id: charter.id, project_key: project.key,
          kind: signal.kind, severity: signal.severity, status: 'open', title: signal.title,
          subject_ref: signal.subject_ref, source, condition_signature: conditionSignature,
          evidence: normalizeEvidence(signal.evidence, { required: true }), opened_at: timestamp(now),
          last_seen_at: timestamp(now),
        };
        state.events.push(event);
        generated.events.push(event);
      } else {
        event.last_seen_at = timestamp(now);
        event.severity = signal.severity;
        event.evidence = normalizeEvidence(signal.evidence, { required: true });
      }
      const existingAction = state.actions.find(item => item.event_id === event.id
        && item.charter_activation_commitment === charter.activation_commitment);
      if (!existingAction) {
        const action = buildAction(state, charter, project, event, signal, now);
        state.actions.push(action);
        generated.actions.push(action);
      }
    }
  }
  const reconciliation = {
    id: id('autopilot-reconcile'), source: clean(source, 120), project_key: clean(projectKey, 240),
    active_charters: activeCharters.length, events_created: generated.events.length,
    actions_created: generated.actions.length, events_resolved: generated.resolved_events.length,
    reconciled_at: timestamp(now),
  };
  state.reconciliations.push(reconciliation);
  return { ledger, ...generated, reconciliation, report: report(ledger, { now }) };
}

function activeIntervention(ledger, action, ref) {
  const intervention = ledger.interventions.find(item => item.id === clean(ref, 200));
  return intervention && intervention.project_key === action.project_key
    && ['authorized', 'executed', 'observed'].includes(intervention.status) ? intervention : null;
}

function recentScheduledMeetings(state, projectKey, now, hours) {
  const cutoff = new Date(now).getTime() - hours * 3600000;
  return state.meetings.filter(item => item.project_key === projectKey
    && ['authorized', 'scheduled', 'joined', 'completed', 'reconciled'].includes(item.state)
    && new Date(item.authorized_at || item.scheduled_at || item.created_at).getTime() >= cutoff);
}

function authorizeAction(ledger, actionId, input = {}, { now = new Date(), operator = false,
  actor = 'Nora' } = {}) {
  const state = stateFor(ledger);
  const action = state.actions.find(item => item.id === actionId);
  if (!action) throw new Error('project autopilot action not found');
  if (action.state === 'authorized') return { ledger, action, idempotent: true, report: report(ledger, { now }) };
  if (!['proposed', 'approval_required'].includes(action.state)) {
    throw new Error(`action cannot be authorized from state ${action.state}`);
  }
  if (NEVER_AUTONOMOUS_ACTIONS.has(action.type)) throw new Error('this action is permanently human-gated');
  const charter = findCharter(ledger, action.project_key, { active: true });
  if (charter.mode === 'shadow') throw new Error('shadow mode cannot authorize actions');
  const authorityKey = ACTION_AUTHORITY[action.type] || action.authority_key;
  const hasStandingAuthority = Boolean(charter.authority[authorityKey]);
  if (charter.mode === 'copilot' && !operator) throw new Error('copilot mode requires operator approval');
  if (!hasStandingAuthority && !operator) throw new Error(`charter does not grant ${authorityKey}`);
  if (!hasStandingAuthority && operator && clean(input.override_note, 900).length < 20) {
    throw new Error('an operator override requires a note of at least twenty characters');
  }
  if (action.required_input && !clean(input.resolution, 500)) {
    throw new Error(`action requires ${action.required_input} before authorization`);
  }
  if (HUMAN_FACING_ACTIONS.has(action.type)) {
    const intervention = activeIntervention(ledger, action, input.intervention_id);
    if (!intervention) {
      throw new Error('human-facing autopilot action requires an authorized PM intervention');
    }
    action.intervention_id = intervention.id;
  }
  if (action.type === 'schedule_decision_meeting') {
    const recent = recentScheduledMeetings(state, action.project_key, now,
      charter.authority.meeting_cooldown_hours);
    if (recent.length) throw new Error('project meeting cooldown is active');
    const weekAgo = new Date(now).getTime() - 7 * 86400000;
    const weekly = state.meetings.filter(item => item.project_key === action.project_key
      && !['cancelled', 'shadow'].includes(item.state)
      && new Date(item.created_at).getTime() >= weekAgo);
    if (weekly.length >= charter.authority.max_meetings_per_week) {
      throw new Error('project meeting budget is exhausted for this week');
    }
  }
  Object.assign(action, {
    state: 'authorized',
    resolution: clean(input.resolution, 500),
    authorization: {
      kind: operator ? 'operator' : 'standing_charter', actor: clean(actor, 240),
      override_note: clean(input.override_note, 900), charter_commitment: charter.charter_commitment,
    },
    authorized_at: timestamp(now), updated_at: timestamp(now),
  });
  action.authorization_commitment = commitment({ action_id: action.id,
    authorization: action.authorization, authorized_at: action.authorized_at });
  return { ledger, action, idempotent: false, report: report(ledger, { now }) };
}

function executeAction(ledger, actionId, input = {}, { now = new Date() } = {}) {
  const action = stateFor(ledger).actions.find(item => item.id === actionId);
  if (!action) throw new Error('project autopilot action not found');
  if (['executed', 'observed'].includes(action.state)) {
    return { ledger, action, idempotent: true, report: report(ledger, { now }) };
  }
  if (action.state !== 'authorized') throw new Error('only an authorized autopilot action may execute');
  const executionRef = clean(input.execution_ref, 1000);
  if (!executionRef) throw new Error('a stable execution reference is required');
  Object.assign(action, { state: 'executed', execution_ref: executionRef,
    execution_note: clean(input.note, 900), executed_at: timestamp(now), updated_at: timestamp(now) });
  action.execution_commitment = commitment({ action_id: action.id, execution_ref: action.execution_ref,
    executed_at: action.executed_at });
  return { ledger, action, idempotent: false, report: report(ledger, { now }) };
}

function observeAction(ledger, actionId, input = {}, { now = new Date() } = {}) {
  const state = stateFor(ledger);
  const action = state.actions.find(item => item.id === actionId);
  if (!action) throw new Error('project autopilot action not found');
  const existing = state.observations.find(item => item.action_id === action.id);
  if (existing) return { ledger, action, observation: existing, idempotent: true,
    report: report(ledger, { now }) };
  if (action.state !== 'executed') throw new Error('only an executed autopilot action may be observed');
  const outcome = clean(input.outcome, 30).toLowerCase();
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const actual = OUTCOME_VALUES[outcome];
  const predicted = clamp(action.prediction?.confidence, 0.5);
  const observation = {
    id: id('autopilot-observation'), action_id: action.id, project_key: action.project_key,
    outcome, observed_effect: clean(input.observed_effect, 1200), evidence,
    predicted_probability: predicted, actual_value: actual,
    brier_score: Number(((predicted - actual) ** 2).toFixed(6)),
    lesson: clean(input.lesson, 1200), behavior_change: clean(input.behavior_change, 1200),
    observed_at: timestamp(now),
  };
  if (!observation.observed_effect) throw new Error('an observed effect is required');
  observation.observation_commitment = commitment(observation);
  state.observations.push(observation);
  Object.assign(action, { state: 'observed', observation_id: observation.id,
    observed_at: observation.observed_at, updated_at: observation.observed_at });
  return { ledger, action, observation, idempotent: false, report: report(ledger, { now }) };
}

function planMeeting(ledger, input = {}, { now = new Date() } = {}) {
  const project = findProject(ledger, input.project_key);
  const charter = findCharter(ledger, project.key, { active: true });
  const state = stateFor(ledger);
  const action = input.action_id ? state.actions.find(item => item.id === input.action_id) : null;
  const requestRef = clean(input.request_ref, 500);
  if (!action && !requestRef) throw new Error('meeting requires an autopilot action or explicit request reference');
  if (action && action.project_key !== project.key) throw new Error('meeting action belongs to another project');
  const duplicate = state.meetings.find(item => item.project_key === project.key
    && !['cancelled', 'reconciled'].includes(item.state)
    && ((action && item.action_id === action.id) || (requestRef && item.request_ref === requestRef)));
  if (duplicate) return { ledger, meeting: duplicate, idempotent: true, report: report(ledger, { now }) };
  const objective = clean(input.objective, 900);
  const agenda = normalizeList(input.agenda, 12, 500);
  if (!objective || !agenda.length) throw new Error('meeting objective and agenda are required');
  const meeting = {
    id: id('autopilot-meeting'), charter_id: charter.id, project_key: project.key,
    action_id: action?.id || null, request_ref: requestRef || null,
    state: charter.mode === 'shadow' ? 'shadow' : 'planned',
    title: clean(input.title || `${project.name}: decision meeting`, 400), objective, agenda,
    attendees: normalizeList(input.attendees, 40, 240),
    external_attendees: Boolean(input.external_attendees),
    expected_decisions: normalizeList(input.expected_decisions, 20, 600),
    duration_minutes: Math.max(15, Math.min(90, Number(input.duration_minutes) || 30)),
    preferred_window_start: input.preferred_window_start ? timestamp(input.preferred_window_start) : null,
    preferred_window_end: input.preferred_window_end ? timestamp(input.preferred_window_end) : null,
    created_at: timestamp(now), updated_at: timestamp(now),
  };
  meeting.meeting_commitment = commitment({ charter_id: meeting.charter_id,
    project_key: meeting.project_key, action_id: meeting.action_id, request_ref: meeting.request_ref,
    objective: meeting.objective, agenda: meeting.agenda, attendees: meeting.attendees,
    expected_decisions: meeting.expected_decisions, created_at: meeting.created_at });
  state.meetings.push(meeting);
  return { ledger, meeting, report: report(ledger, { now }) };
}

function authorizeMeeting(ledger, meetingId, input = {}, { now = new Date(), operator = false,
  actor = 'Nora' } = {}) {
  const state = stateFor(ledger);
  const meeting = state.meetings.find(item => item.id === meetingId);
  if (!meeting) throw new Error('project autopilot meeting not found');
  if (meeting.state === 'authorized') return { ledger, meeting, idempotent: true,
    report: report(ledger, { now }) };
  if (meeting.state !== 'planned') throw new Error(`meeting cannot be authorized from state ${meeting.state}`);
  const charter = findCharter(ledger, meeting.project_key, { active: true });
  if (charter.mode === 'shadow') throw new Error('shadow mode cannot authorize meetings');
  if (!charter.authority.schedule_internal_meetings && !operator) {
    throw new Error('charter does not grant meeting scheduling authority');
  }
  if ((charter.mode === 'copilot' || meeting.external_attendees) && !operator) {
    throw new Error(meeting.external_attendees
      ? 'meetings with external attendees require operator approval'
      : 'copilot mode requires operator approval');
  }
  if (meeting.action_id) {
    const action = state.actions.find(item => item.id === meeting.action_id);
    if (!action || action.state !== 'authorized') throw new Error('linked autopilot action is not authorized');
  }
  const recent = recentScheduledMeetings(state, meeting.project_key, now,
    charter.authority.meeting_cooldown_hours).filter(item => item.id !== meeting.id);
  if (recent.length) throw new Error('project meeting cooldown is active');
  const weekAgo = new Date(now).getTime() - 7 * 86400000;
  const weekly = state.meetings.filter(item => item.id !== meeting.id
    && item.project_key === meeting.project_key && !['cancelled', 'shadow'].includes(item.state)
    && new Date(item.created_at).getTime() >= weekAgo);
  if (weekly.length >= charter.authority.max_meetings_per_week && !operator) {
    throw new Error('project meeting budget is exhausted for this week');
  }
  Object.assign(meeting, { state: 'authorized', authorized_at: timestamp(now), updated_at: timestamp(now),
    authorization: { kind: operator ? 'operator' : 'standing_charter', actor: clean(actor, 240),
      note: clean(input.note, 900), charter_commitment: charter.charter_commitment } });
  return { ledger, meeting, idempotent: false, report: report(ledger, { now }) };
}

function scheduleMeeting(ledger, meetingId, input = {}, { now = new Date() } = {}) {
  const meeting = stateFor(ledger).meetings.find(item => item.id === meetingId);
  if (!meeting) throw new Error('project autopilot meeting not found');
  if (['scheduled', 'joined', 'completed', 'reconciled'].includes(meeting.state)) {
    return { ledger, meeting, idempotent: true, report: report(ledger, { now }) };
  }
  if (meeting.state !== 'authorized') throw new Error('only an authorized meeting may be scheduled');
  findCharter(ledger, meeting.project_key, { active: true });
  const calendarEventRef = clean(input.calendar_event_ref, 1000);
  const joinUrl = clean(input.join_url, 1000);
  if (!calendarEventRef || !joinUrl || !/^https:\/\//i.test(joinUrl) || !input.scheduled_for) {
    throw new Error('calendar event reference, HTTPS meeting URL, and scheduled time are required');
  }
  Object.assign(meeting, { state: 'scheduled', calendar_event_ref: calendarEventRef, join_url: joinUrl,
    scheduled_for: timestamp(input.scheduled_for), scheduled_at: timestamp(now), updated_at: timestamp(now) });
  return { ledger, meeting, idempotent: false, report: report(ledger, { now }) };
}

function joinMeeting(ledger, meetingId, input = {}, { now = new Date() } = {}) {
  const meeting = stateFor(ledger).meetings.find(item => item.id === meetingId);
  if (!meeting) throw new Error('project autopilot meeting not found');
  if (['joined', 'completed', 'reconciled'].includes(meeting.state)) {
    return { ledger, meeting, idempotent: true, report: report(ledger, { now }) };
  }
  if (meeting.state !== 'scheduled') throw new Error('only a scheduled meeting may be joined');
  findCharter(ledger, meeting.project_key, { active: true });
  if (meeting.attendance_blocked) throw new Error('meeting attendance is blocked pending operator review');
  const botRef = clean(input.bot_ref, 1000);
  if (!botRef) throw new Error('a stable meeting bot reference is required');
  Object.assign(meeting, { state: 'joined', bot_ref: botRef, joined_at: timestamp(now),
    updated_at: timestamp(now) });
  return { ledger, meeting, idempotent: false, report: report(ledger, { now }) };
}

function completeMeeting(ledger, meetingId, input = {}, { now = new Date() } = {}) {
  const meeting = stateFor(ledger).meetings.find(item => item.id === meetingId);
  if (!meeting) throw new Error('project autopilot meeting not found');
  if (['completed', 'reconciled'].includes(meeting.state)) {
    return { ledger, meeting, idempotent: true, report: report(ledger, { now }) };
  }
  if (!['scheduled', 'joined'].includes(meeting.state)) {
    throw new Error('meeting must be scheduled or joined before completion');
  }
  const transcriptRef = clean(input.transcript_ref, 1000);
  const outcomeSummary = clean(input.outcome_summary, 1600);
  if (!transcriptRef) throw new Error('a stable transcript reference is required');
  if (!outcomeSummary) throw new Error('a meeting outcome summary is required');
  Object.assign(meeting, { state: 'completed', transcript_ref: transcriptRef,
    outcome_summary: outcomeSummary,
    decisions: normalizeList(input.decisions, 30, 800),
    action_items: normalizeList(input.action_items, 50, 800),
    unresolved: normalizeList(input.unresolved, 30, 800),
    completed_at: timestamp(now), updated_at: timestamp(now) });
  return { ledger, meeting, idempotent: false, report: report(ledger, { now }) };
}

function reconcileMeeting(ledger, meetingId, input = {}, { now = new Date() } = {}) {
  const meeting = stateFor(ledger).meetings.find(item => item.id === meetingId);
  if (!meeting) throw new Error('project autopilot meeting not found');
  if (meeting.state === 'reconciled') return { ledger, meeting, idempotent: true,
    report: report(ledger, { now }) };
  if (meeting.state !== 'completed') throw new Error('only a completed meeting may be reconciled');
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const teamworkRefs = normalizeList(input.teamwork_refs, 50, 1000);
  if (meeting.action_items.length && !teamworkRefs.length) {
    throw new Error('meeting action items require Teamwork reconciliation references');
  }
  Object.assign(meeting, { state: 'reconciled', reconciliation_evidence: evidence,
    teamwork_refs: teamworkRefs,
    followup_ref: clean(input.followup_ref, 1000),
    reconciled_at: timestamp(now), updated_at: timestamp(now) });
  return { ledger, meeting, idempotent: false, report: report(ledger, { now }) };
}

function ingestMeetingEvidence(ledger, input = {}, { now = new Date() } = {}) {
  const projectName = clean(input.project?.name || input.project?.project_name || input.project, 300).toLowerCase();
  if (!projectName || !input.meeting_ref) return { ledger, matched: false };
  const project = ledger.projects.find(item => item.name.toLowerCase() === projectName || item.key === projectName);
  if (!project) return { ledger, matched: false };
  const state = stateFor(ledger);
  const meeting = [...state.meetings].reverse().find(item => item.project_key === project.key
    && ['scheduled', 'joined'].includes(item.state));
  if (!meeting) return { ledger, matched: false };
  return { ...completeMeeting(ledger, meeting.id, {
    transcript_ref: input.meeting_ref,
    outcome_summary: clean(input.summary || input.outcome_summary || 'Meeting transcript captured.', 1600),
    decisions: input.decisions || [], action_items: input.action_items || input.tasks || [],
    unresolved: input.unresolved || [],
  }, { now }), matched: true };
}

function calibration(state) {
  const observations = state.observations;
  const helpful = observations.filter(item => ['helped', 'resolved'].includes(item.outcome)).length;
  const harmful = observations.filter(item => item.outcome === 'backfired').length;
  const ignored = observations.filter(item => item.outcome === 'ignored').length;
  const meanBrier = observations.length
    ? observations.reduce((sum, item) => sum + Number(item.brier_score || 0), 0) / observations.length : null;
  return {
    observed: observations.length,
    helpful,
    harmful,
    ignored,
    helpful_rate: observations.length ? helpful / observations.length : 0,
    harmful_rate: observations.length ? harmful / observations.length : 0,
    mean_brier_score: meanBrier,
    gates: {
      enough_managed_evidence: observations.length >= 10,
      helpful_rate_at_least_080: observations.length >= 10 && helpful / observations.length >= 0.8,
      harmful_rate_at_most_005: observations.length >= 10 && harmful / observations.length <= 0.05,
      calibration_at_most_025: observations.length >= 10 && meanBrier <= 0.25,
    },
  };
}

function report(ledger, { now = new Date() } = {}) {
  const state = normalizeState(ledger.autopilot);
  const active = state.charters.filter(item => item.status === 'active');
  const pendingActionStates = new Set(['proposed', 'approval_required', 'authorized']);
  const openMeetingStates = new Set(['planned', 'authorized', 'scheduled', 'joined', 'completed']);
  const learning = calibration(state);
  return {
    generated_at: timestamp(now),
    charters: {
      total: state.charters.length,
      active: active.length,
      shadow: active.filter(item => item.mode === 'shadow').length,
      copilot: active.filter(item => item.mode === 'copilot').length,
      managed: active.filter(item => item.mode === 'managed').length,
      paused: state.charters.filter(item => item.status === 'paused').length,
    },
    events: {
      open: state.events.filter(item => item.status === 'open').length,
      resolved: state.events.filter(item => item.status === 'resolved').length,
    },
    actions: {
      total: state.actions.length,
      pending: state.actions.filter(item => pendingActionStates.has(item.state)).length,
      approval_required: state.actions.filter(item => item.state === 'approval_required').length,
      authorized: state.actions.filter(item => item.state === 'authorized').length,
      executed: state.actions.filter(item => ['executed', 'observed'].includes(item.state)).length,
      shadow: state.actions.filter(item => item.state === 'shadow').length,
      suppressed: state.actions.filter(item => item.state === 'suppressed').length,
    },
    meetings: {
      total: state.meetings.length,
      open: state.meetings.filter(item => openMeetingStates.has(item.state)).length,
      scheduled: state.meetings.filter(item => item.state === 'scheduled').length,
      joined: state.meetings.filter(item => item.state === 'joined').length,
      completed: state.meetings.filter(item => ['completed', 'reconciled'].includes(item.state)).length,
      reconciled: state.meetings.filter(item => item.state === 'reconciled').length,
    },
    learning,
    fixed_gates: { ...FIXED_GATES },
  };
}

function projectView(ledger, projectKey) {
  const key = clean(projectKey, 240).toLowerCase();
  const state = normalizeState(ledger.autopilot);
  const observations = state.observations.filter(item => item.project_key === key).slice(-100);
  return {
    charter: state.charters.find(item => item.project_key === key) || null,
    events: state.events.filter(item => item.project_key === key).slice(-100),
    actions: state.actions.filter(item => item.project_key === key).slice(-100),
    meetings: state.meetings.filter(item => item.project_key === key).slice(-50),
    observations,
    learning: calibration({ ...state, observations }),
  };
}

function renderPromptContext(ledger, { project_key: projectKey = '', limit = 5 } = {}) {
  const state = normalizeState(ledger.autopilot);
  const charters = state.charters.filter(item => item.status === 'active'
    && (!projectKey || item.project_key === clean(projectKey, 240).toLowerCase())).slice(0, limit);
  if (!charters.length) return '';
  const lines = ['[Project Autopilot, explicit project-scoped authority]'];
  for (const charter of charters) {
    const pending = state.actions.filter(item => item.project_key === charter.project_key
      && ['proposed', 'approval_required', 'authorized'].includes(item.state));
    const meetings = state.meetings.filter(item => item.project_key === charter.project_key
      && ['planned', 'authorized', 'scheduled', 'joined', 'completed'].includes(item.state));
    const learnedChanges = state.observations.filter(item => item.project_key === charter.project_key)
      .map(item => clean(item.behavior_change, 500)).filter(Boolean).slice(-3);
    const granted = AUTHORITY_KEYS.filter(key => charter.authority[key]);
    lines.push(`- ${charter.project_name}: ${charter.mode} mode, sponsor ${charter.sponsor}; granted ${granted.join(', ') || 'no standing writes'}; pending actions ${pending.length}; open meeting cycles ${meetings.length}.`);
    if (learnedChanges.length) lines.push(`  Outcome-learned behavior: ${learnedChanges.join(' | ')}`);
  }
  lines.push('This charter is project-scoped. Fixed human gates, connector permissions, evidence requirements, and the shared interruption budget still apply. Shadow means observe only. Copilot requires operator approval. Managed permits only the listed standing authorities.');
  return lines.join('\n').slice(0, 5000);
}

module.exports = {
  MODES,
  CHARTER_STATUSES,
  ACTION_STATES,
  MEETING_STATES,
  OUTCOMES,
  FIXED_GATES,
  AUTHORITY_KEYS,
  ACTION_AUTHORITY,
  emptyState,
  normalizeState,
  upsertCharter,
  activateCharter,
  pauseCharter,
  projectSignals,
  reconcilePortfolio,
  authorizeAction,
  executeAction,
  observeAction,
  planMeeting,
  authorizeMeeting,
  scheduleMeeting,
  joinMeeting,
  completeMeeting,
  reconcileMeeting,
  ingestMeetingEvidence,
  report,
  projectView,
  renderPromptContext,
};
