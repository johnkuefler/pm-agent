'use strict';

const crypto = require('crypto');

const LANES = Object.freeze([
  'silent_maintenance',
  'requested_action',
  'consolidated_coordination',
  'relationship',
  'escalation',
  'emergency',
]);
const RISK_STATUSES = Object.freeze(['open', 'monitoring', 'mitigated', 'resolved', 'accepted']);
const INTERVENTION_STATUSES = Object.freeze(['planned', 'authorized', 'executed', 'suppressed', 'observed']);
const OUTCOMES = Object.freeze(['helped', 'neutral', 'ignored', 'backfired', 'resolved']);
const HEALTHS = Object.freeze(['green', 'amber', 'red', 'unknown']);
const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const HUMAN_LANES = new Set(['consolidated_coordination', 'relationship', 'escalation', 'emergency']);

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

function emptyLedger() {
  return {
    version: 1,
    policy: {
      mode: 'bounded_autonomy',
      human_budget_scope: 'cowork:proactive',
      recipient_cooldown_hours: 48,
      subject_cooldown_hours: 48,
      emergency_budget_override: false,
      minimum_confidence: 0.65,
      minimum_actionability: 0.6,
    },
    projects: [],
    risks: [],
    decisions: [],
    interventions: [],
    outcomes: [],
    syncs: [],
    summary_evaluations: [],
  };
}

function normalizeList(value, maxItems = 20, maxText = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => clean(item, maxText)).filter(Boolean))].slice(0, maxItems);
}

function normalizeEvidence(value, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 20 || (required && value.length < 1)) {
    throw new Error(required ? 'one to twenty evidence references are required' : 'at most twenty evidence references are accepted');
  }
  return value.map(item => {
    const type = clean(item?.type, 80);
    const ref = clean(item?.ref || item?.id || item?.url, 1000);
    if (!type || !ref) throw new Error('each evidence reference requires type and ref');
    const observedAt = item?.observed_at ? timestamp(item.observed_at) : null;
    return { type, ref, ...(observedAt ? { observed_at: observedAt } : {}),
      ...(item?.note ? { note: clean(item.note, 400) } : {}) };
  });
}

function normalizeCognitiveContext(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    rationale: clean(source.rationale, 1200),
    uncertainty: clean(source.uncertainty, 800),
    assumptions: normalizeList(source.assumptions, 10, 500),
    self_limitations: normalizeList(source.self_limitations, 10, 500),
    teammate_preferences: normalizeList(source.teammate_preferences, 10, 500),
    lesson_refs: normalizeList(source.lesson_refs, 12, 240),
    workspace_frame_id: clean(source.workspace_frame_id, 160),
    professional_viewpoint_ref: clean(source.professional_viewpoint_ref, 160),
  };
}

function normalizeLedger(value = {}) {
  const base = emptyLedger();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    policy: { ...base.policy, ...(source.policy || {}) },
    projects: Array.isArray(source.projects) ? source.projects.filter(item => item?.key).slice(-1000) : [],
    risks: Array.isArray(source.risks) ? source.risks.filter(item => item?.id).slice(-5000) : [],
    decisions: Array.isArray(source.decisions) ? source.decisions.filter(item => item?.id).slice(-5000) : [],
    interventions: Array.isArray(source.interventions)
      ? source.interventions.filter(item => item?.id).slice(-10000) : [],
    outcomes: Array.isArray(source.outcomes) ? source.outcomes.filter(item => item?.id).slice(-10000) : [],
    syncs: Array.isArray(source.syncs) ? source.syncs.filter(item => item?.id).slice(-2000) : [],
    summary_evaluations: Array.isArray(source.summary_evaluations)
      ? source.summary_evaluations.filter(item => item?.id).slice(-5000) : [],
  };
}

function projectKey(input = {}) {
  const key = clean(input.key || input.teamwork_id || input.name, 240).toLowerCase();
  if (!key) throw new Error('project key, Teamwork id, or name is required');
  return key;
}

function upsertProject(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const key = projectKey(input);
  const existing = current.projects.find(item => item.key === key);
  const name = clean(input.name || existing?.name, 300);
  if (!name) throw new Error('project name is required');
  const health = clean(input.health || existing?.health || 'unknown', 20).toLowerCase();
  if (!HEALTHS.includes(health)) throw new Error(`health must be one of: ${HEALTHS.join(', ')}`);
  const updatedAt = timestamp(now);
  const project = {
    ...(existing || {}),
    key,
    name,
    teamwork_id: clean(input.teamwork_id || existing?.teamwork_id, 120),
    client: clean(input.client ?? existing?.client, 300),
    objective: clean(input.objective ?? existing?.objective, 1200),
    phase: clean(input.phase ?? existing?.phase, 200),
    pm: clean(input.pm ?? existing?.pm, 240),
    health,
    health_reason: clean(input.health_reason ?? existing?.health_reason, 900),
    next_milestone: clean(input.next_milestone ?? existing?.next_milestone, 600),
    next_milestone_due: input.next_milestone_due === null ? null
      : input.next_milestone_due ? timestamp(input.next_milestone_due) : existing?.next_milestone_due || null,
    critical_path: normalizeList(input.critical_path ?? existing?.critical_path, 20, 500),
    dependency_refs: normalizeList(input.dependency_refs ?? existing?.dependency_refs, 30, 240),
    decision_refs: normalizeList(input.decision_refs ?? existing?.decision_refs, 30, 240),
    evidence: input.evidence ? normalizeEvidence(input.evidence) : existing?.evidence || [],
    source_updated_at: input.source_updated_at ? timestamp(input.source_updated_at)
      : existing?.source_updated_at || null,
    updated_at: updatedAt,
    created_at: existing?.created_at || updatedAt,
  };
  project.completeness = projectCompleteness(project);
  project.control_commitment = commitment({ key: project.key, objective: project.objective,
    phase: project.phase, pm: project.pm, health: project.health, next_milestone: project.next_milestone,
    next_milestone_due: project.next_milestone_due, critical_path: project.critical_path,
    dependency_refs: project.dependency_refs, evidence: project.evidence, updated_at: project.updated_at });
  if (existing) Object.assign(existing, project);
  else current.projects.push(project);
  return { ledger: current, project, report: report(current, { now }) };
}

function projectCompleteness(project = {}) {
  const fields = ['objective', 'phase', 'pm', 'next_milestone', 'next_milestone_due'];
  const present = fields.filter(field => Boolean(project[field])).length;
  return { present, expected: fields.length, ratio: present / fields.length,
    missing: fields.filter(field => !project[field]) };
}

function createRisk(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const project = current.projects.find(item => item.key === projectKey({ key: input.project_key }));
  if (!project) throw new Error('project control record not found');
  const title = clean(input.title, 400);
  const description = clean(input.description, 1200);
  if (!title || !description) throw new Error('risk title and description are required');
  const severity = clean(input.severity || 'medium', 20).toLowerCase();
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const createdAt = timestamp(now);
  const signature = commitment({ project_key: project.key, title: title.toLowerCase(),
    subject_ref: clean(input.subject_ref, 300), evidence });
  const duplicate = current.risks.find(item => item.signature === signature && !['resolved', 'accepted'].includes(item.status));
  if (duplicate) return { ledger: current, risk: duplicate, idempotent: true, report: report(current, { now }) };
  const risk = {
    id: clean(input.id, 160) || id('pm-risk'),
    project_key: project.key,
    status: 'open',
    severity,
    urgency: clamp(input.urgency, severity === 'critical' ? 1 : 0.5),
    confidence: clamp(input.confidence, 0.5),
    title,
    description,
    impact: clean(input.impact, 900),
    owner: clean(input.owner, 240),
    subject_ref: clean(input.subject_ref, 300),
    due_at: input.due_at ? timestamp(input.due_at) : null,
    next_action: clean(input.next_action, 900),
    decision_needed: clean(input.decision_needed, 900),
    evidence,
    signature,
    created_at: createdAt,
    updated_at: createdAt,
  };
  current.risks.push(risk);
  return { ledger: current, risk, idempotent: false, report: report(current, { now }) };
}

function updateRisk(ledger = emptyLedger(), riskId, input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const risk = current.risks.find(item => item.id === riskId);
  if (!risk) throw new Error('project risk not found');
  const status = clean(input.status || risk.status, 30).toLowerCase();
  if (!RISK_STATUSES.includes(status)) throw new Error(`status must be one of: ${RISK_STATUSES.join(', ')}`);
  const evidence = input.evidence ? normalizeEvidence(input.evidence, { required: true }) : risk.evidence;
  Object.assign(risk, {
    status,
    severity: input.severity ? clean(input.severity, 20).toLowerCase() : risk.severity,
    urgency: input.urgency === undefined ? risk.urgency : clamp(input.urgency),
    confidence: input.confidence === undefined ? risk.confidence : clamp(input.confidence),
    owner: input.owner === undefined ? risk.owner : clean(input.owner, 240),
    due_at: input.due_at === undefined ? risk.due_at : input.due_at ? timestamp(input.due_at) : null,
    next_action: input.next_action === undefined ? risk.next_action : clean(input.next_action, 900),
    decision_needed: input.decision_needed === undefined ? risk.decision_needed : clean(input.decision_needed, 900),
    evidence,
    resolution_note: input.resolution_note === undefined ? risk.resolution_note || ''
      : clean(input.resolution_note, 900),
    updated_at: timestamp(now),
  });
  if (!SEVERITIES.includes(risk.severity)) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
  return { ledger: current, risk, report: report(current, { now }) };
}

function recordDecision(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const project = current.projects.find(item => item.key === projectKey({ key: input.project_key }));
  if (!project) throw new Error('project control record not found');
  const question = clean(input.question, 900);
  const decision = clean(input.decision, 1200);
  if (!question || !decision) throw new Error('decision question and decision are required');
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const recordedAt = timestamp(now);
  const entry = {
    id: clean(input.id, 160) || id('pm-decision'),
    project_key: project.key,
    question,
    decision,
    rationale: clean(input.rationale, 1200),
    decided_by: clean(input.decided_by || 'Nora', 240),
    authority: clean(input.authority || 'advisory', 120),
    risk_refs: normalizeList(input.risk_refs, 20, 160),
    evidence,
    cognitive_context: normalizeCognitiveContext(input.cognitive_context),
    recorded_at: recordedAt,
  };
  entry.decision_commitment = commitment(entry);
  current.decisions.push(entry);
  if (!project.decision_refs.includes(entry.id)) project.decision_refs.push(entry.id);
  return { ledger: current, decision: entry, report: report(current, { now }) };
}

function interventionThreshold(lane) {
  if (lane === 'emergency') return { confidence: 0.8, actionability: 0.75 };
  if (lane === 'escalation') return { confidence: 0.75, actionability: 0.7 };
  if (lane === 'relationship') return { confidence: 0.8, actionability: 0.7 };
  if (lane === 'consolidated_coordination') return { confidence: 0.65, actionability: 0.6 };
  return { confidence: 0, actionability: 0 };
}

function recentHumanInterventions(current, intervention, now) {
  const policy = current.policy;
  const nowMs = new Date(now).getTime();
  const recipientCutoff = nowMs - Math.max(1, Number(policy.recipient_cooldown_hours) || 48) * 3600000;
  const subjectCutoff = nowMs - Math.max(1, Number(policy.subject_cooldown_hours) || 48) * 3600000;
  const active = current.interventions.filter(item => HUMAN_LANES.has(item.lane)
    && ['executed', 'observed'].includes(item.status));
  return {
    recipient: active.filter(item => item.recipient && item.recipient === intervention.recipient
      && new Date(item.executed_at || item.created_at).getTime() >= recipientCutoff),
    subject: active.filter(item => item.subject_ref && item.subject_ref === intervention.subject_ref
      && new Date(item.executed_at || item.created_at).getTime() >= subjectCutoff),
  };
}

function recipientOutcomeStats(current, recipient) {
  const interventionIds = new Set(current.interventions.filter(item => item.recipient === recipient).map(item => item.id));
  const outcomes = current.outcomes.filter(item => interventionIds.has(item.intervention_id));
  const negative = outcomes.filter(item => ['ignored', 'backfired'].includes(item.outcome)).length;
  const positive = outcomes.filter(item => ['helped', 'resolved'].includes(item.outcome)).length;
  return { total: outcomes.length, negative, positive, negative_rate: outcomes.length ? negative / outcomes.length : 0 };
}

function evaluateIntervention(current, intervention, { initiative = null, now = new Date() } = {}) {
  const reasons = [];
  const humanFacing = HUMAN_LANES.has(intervention.lane);
  const threshold = interventionThreshold(intervention.lane);
  if (!intervention.evidence.length) reasons.push('No current evidence is attached.');
  if (!intervention.cognitive_context.rationale) reasons.push('No explicit reasoning is recorded.');
  if (intervention.confidence < Math.max(threshold.confidence, Number(current.policy.minimum_confidence) || 0)) {
    reasons.push('Confidence is below the lane threshold.');
  }
  if (intervention.actionability < Math.max(threshold.actionability, Number(current.policy.minimum_actionability) || 0)) {
    reasons.push(intervention.lane === 'relationship'
      ? 'The acknowledgment is not specific or proportionate enough to interrupt the recipient.'
      : 'The recipient does not have a concrete action or decision.');
  }
  if (intervention.lane === 'requested_action' && !intervention.request_ref) {
    reasons.push('Requested action requires an explicit request reference.');
  }
  const duplicate = current.interventions.find(item => item.id !== intervention.id
    && item.evidence_signature === intervention.evidence_signature
    && !['suppressed', 'observed'].includes(item.status));
  if (duplicate) reasons.push(`The same evidence is already represented by ${duplicate.id}.`);
  if (humanFacing) {
    if (!intervention.recipient) reasons.push('A human-facing intervention requires a recipient.');
    const recent = recentHumanInterventions(current, intervention, now);
    if (recent.recipient.length) reasons.push('The recipient is inside the interruption cooldown.');
    if (recent.subject.length) reasons.push('The subject is inside the interruption cooldown.');
    const history = recipientOutcomeStats(current, intervention.recipient);
    if (history.total >= 3 && history.negative_rate >= 0.5 && intervention.lane !== 'emergency') {
      reasons.push('Prior interventions for this recipient are too often ignored or harmful.');
    }
    const mayOverride = intervention.lane === 'emergency' && current.policy.emergency_budget_override;
    if (!mayOverride && (!initiative || initiative.remaining <= 0)) {
      reasons.push('The shared human interruption budget is unavailable.');
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    human_facing: humanFacing,
    uses_human_budget: humanFacing && !(intervention.lane === 'emergency'
      && current.policy.emergency_budget_override),
    recipient_history: recipientOutcomeStats(current, intervention.recipient),
  };
}

function planIntervention(ledger = emptyLedger(), input = {}, options = {}) {
  const current = normalizeLedger(ledger);
  const project = current.projects.find(item => item.key === projectKey({ key: input.project_key }));
  if (!project) throw new Error('project control record not found');
  const lane = clean(input.lane, 60).toLowerCase();
  if (!LANES.includes(lane)) throw new Error(`lane must be one of: ${LANES.join(', ')}`);
  const description = clean(input.description, 1200);
  if (!description) throw new Error('intervention description is required');
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const cognitiveContext = normalizeCognitiveContext(input.cognitive_context);
  const createdAt = timestamp(options.now || new Date());
  const intervention = {
    id: clean(input.id, 160) || id('pm-intervention'),
    project_key: project.key,
    lane,
    status: 'planned',
    description,
    intended_effect: clean(input.intended_effect, 900),
    success_criteria: clean(input.success_criteria, 900),
    recipient: clean(input.recipient, 240),
    target_ref: clean(input.target_ref, 500),
    subject_ref: clean(input.subject_ref || input.target_ref, 500),
    request_ref: clean(input.request_ref, 500),
    authority: clean(input.authority || (lane === 'requested_action' ? 'requested' : 'advisory'), 120),
    confidence: clamp(input.confidence, 0.5),
    actionability: clamp(input.actionability, 0.5),
    impact: clamp(input.impact, 0.5),
    risk_refs: normalizeList(input.risk_refs, 20, 160),
    decision_refs: normalizeList(input.decision_refs, 20, 160),
    evidence,
    cognitive_context: cognitiveContext,
    created_at: createdAt,
    created_by: clean(input.created_by || 'Nora', 120),
  };
  intervention.evidence_signature = commitment({ project_key: intervention.project_key,
    lane: intervention.lane, subject_ref: intervention.subject_ref, evidence: intervention.evidence });
  intervention.plan_commitment = commitment(intervention);
  intervention.evaluation = evaluateIntervention(current, intervention, options);
  if (!intervention.evaluation.allowed) {
    intervention.status = 'suppressed';
    intervention.suppressed_at = createdAt;
  }
  current.interventions.push(intervention);
  return { ledger: current, intervention, report: report(current, options) };
}

function authorizeIntervention(ledger = emptyLedger(), interventionId, input = {}, options = {}) {
  const current = normalizeLedger(ledger);
  const intervention = current.interventions.find(item => item.id === interventionId);
  if (!intervention) throw new Error('project intervention not found');
  if (intervention.status === 'authorized') {
    return { ledger: current, intervention, idempotent: true, report: report(current, options) };
  }
  if (intervention.status !== 'planned') throw new Error('only a planned intervention can be authorized');
  const evaluation = evaluateIntervention(current, intervention, options);
  const needsReservation = evaluation.uses_human_budget;
  const reservation = input.initiative_reservation || null;
  if (needsReservation && !reservation?.allowed) {
    evaluation.allowed = false;
    evaluation.reasons = [...evaluation.reasons, 'The shared human interruption slot was not reserved.'];
  }
  intervention.evaluation = evaluation;
  const decidedAt = timestamp(options.now || new Date());
  if (!evaluation.allowed) {
    intervention.status = 'suppressed';
    intervention.suppressed_at = decidedAt;
    return { ledger: current, intervention, idempotent: false, report: report(current, options) };
  }
  intervention.status = 'authorized';
  intervention.authorized_at = decidedAt;
  intervention.initiative_reservation = reservation ? {
    scope: clean(reservation.scope, 160),
    day: clean(reservation.day, 40),
    spent: Number(reservation.spent) || 0,
    remaining: Number(reservation.remaining) || 0,
  } : null;
  return { ledger: current, intervention, idempotent: false, report: report(current, options) };
}

function executeIntervention(ledger = emptyLedger(), interventionId, input = {}, options = {}) {
  const current = normalizeLedger(ledger);
  const intervention = current.interventions.find(item => item.id === interventionId);
  if (!intervention) throw new Error('project intervention not found');
  if (intervention.status === 'executed' || intervention.status === 'observed') {
    return { ledger: current, intervention, idempotent: true, report: report(current, options) };
  }
  if (intervention.status !== 'authorized') throw new Error('only an authorized intervention can execute');
  const executionRef = clean(input.execution_ref, 1000);
  if (!executionRef) throw new Error('execution_ref is required after the action succeeds');
  intervention.status = 'executed';
  intervention.execution_ref = executionRef;
  intervention.execution_note = clean(input.execution_note, 900);
  intervention.executed_at = timestamp(options.now || new Date());
  intervention.execution_commitment = commitment({ plan_commitment: intervention.plan_commitment,
    execution_ref: intervention.execution_ref, executed_at: intervention.executed_at });
  return { ledger: current, intervention, idempotent: false, report: report(current, options) };
}

function observeIntervention(ledger = emptyLedger(), interventionId, input = {}, options = {}) {
  const current = normalizeLedger(ledger);
  const intervention = current.interventions.find(item => item.id === interventionId);
  if (!intervention) throw new Error('project intervention not found');
  if (!['executed', 'observed'].includes(intervention.status)) {
    throw new Error('only an executed intervention can be observed');
  }
  const outcomeValue = clean(input.outcome, 30).toLowerCase();
  if (!OUTCOMES.includes(outcomeValue)) throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  const observedEffect = clean(input.observed_effect, 1200);
  if (!observedEffect) throw new Error('observed_effect is required');
  const evidence = normalizeEvidence(input.evidence, { required: true });
  const observedAt = timestamp(options.now || new Date());
  const outcome = {
    id: clean(input.id, 160) || id('pm-outcome'),
    intervention_id: intervention.id,
    outcome: outcomeValue,
    observed_effect: observedEffect,
    evidence,
    learning: clean(input.learning, 1000),
    behavior_change: clean(input.behavior_change, 1000),
    observed_at: observedAt,
    observed_by: clean(input.observed_by || 'Nora', 120),
  };
  outcome.outcome_commitment = commitment({ plan_commitment: intervention.plan_commitment,
    execution_commitment: intervention.execution_commitment, outcome: outcome.outcome,
    observed_effect: outcome.observed_effect, evidence: outcome.evidence, learning: outcome.learning });
  current.outcomes.push(outcome);
  intervention.status = 'observed';
  intervention.latest_outcome = outcome.outcome;
  intervention.latest_outcome_id = outcome.id;
  intervention.observed_at = observedAt;
  return { ledger: current, intervention, outcome, report: report(current, options) };
}

function recordSync(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const entry = { id: id('pm-sync'), source: clean(input.source || 'teamwork', 120),
    projects_seen: Math.max(0, Number(input.projects_seen) || 0),
    projects_updated: Math.max(0, Number(input.projects_updated) || 0),
    risks_opened: Math.max(0, Number(input.risks_opened) || 0),
    note: clean(input.note, 900), completed_at: timestamp(now) };
  current.syncs.push(entry);
  return { ledger: current, sync: entry, report: report(current, { now }) };
}

function ingestMeeting(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  let current = normalizeLedger(ledger);
  const projectName = clean(input.project, 300).toLowerCase();
  const project = current.projects.find(item => item.key === projectName
    || item.name.toLowerCase() === projectName
    || (item.teamwork_id && item.teamwork_id === clean(input.teamwork_id, 120)));
  if (!project) return { ledger: current, matched: false, decisions: [], risks: [] };
  const meetingRef = clean(input.meeting_ref || input.bot_id, 500);
  if (!meetingRef) throw new Error('meeting_ref is required');
  const evidence = [{ type: 'meeting_transcript', ref: meetingRef,
    observed_at: timestamp(input.ended || now) }];
  const decisions = [];
  for (const text of normalizeList(input.decisions, 30, 1200)) {
    const duplicate = current.decisions.find(item => item.project_key === project.key
      && item.decision === text && item.evidence?.some(ref => ref.ref === meetingRef));
    if (duplicate) {
      decisions.push(duplicate);
      continue;
    }
    const recorded = recordDecision(current, {
      project_key: project.key,
      question: `Meeting decision for ${project.name}`,
      decision: text,
      rationale: 'Recorded from the explicit meeting decision list.',
      decided_by: clean(input.decided_by || 'meeting participants', 240),
      authority: 'meeting_record',
      evidence,
    }, { now });
    current = recorded.ledger;
    decisions.push(recorded.decision);
  }
  const risks = [];
  for (const loop of (Array.isArray(input.open_loops) ? input.open_loops : []).slice(0, 30)) {
    const what = clean(loop?.what, 900);
    if (!what) continue;
    let dueAt = null;
    if (loop.due) {
      const candidate = new Date(loop.due);
      if (Number.isFinite(candidate.getTime())) dueAt = candidate.toISOString();
    }
    const created = createRisk(current, {
      project_key: project.key,
      title: `Open meeting loop: ${what}`.slice(0, 400),
      description: what,
      severity: dueAt ? 'medium' : 'low',
      urgency: dueAt ? 0.65 : 0.35,
      confidence: 0.85,
      owner: clean(loop.owner, 240),
      subject_ref: `meeting:${meetingRef}:${commitment(what).slice(0, 12)}`,
      due_at: dueAt,
      next_action: loop.owner ? `${clean(loop.owner, 240)} owns the next update.`
        : 'Identify an owner before this open loop affects delivery.',
      evidence,
    }, { now });
    current = created.ledger;
    risks.push(created.risk);
  }
  return { ledger: current, matched: true, project, decisions, risks };
}

function shadowEvaluation(ledger = emptyLedger()) {
  const current = normalizeLedger(ledger);
  const planned = current.interventions.length;
  const suppressed = current.interventions.filter(item => item.status === 'suppressed').length;
  const executed = current.interventions.filter(item => ['executed', 'observed'].includes(item.status)).length;
  const observed = current.outcomes.length;
  const helpful = current.outcomes.filter(item => ['helped', 'resolved'].includes(item.outcome)).length;
  const harmful = current.outcomes.filter(item => item.outcome === 'backfired').length;
  const ignored = current.outcomes.filter(item => item.outcome === 'ignored').length;
  const actionable = current.interventions.filter(item => item.actionability >= 0.6).length;
  return {
    planned,
    suppressed,
    executed,
    observed,
    helpful,
    harmful,
    ignored,
    suppression_rate: planned ? suppressed / planned : 0,
    execution_rate: planned ? executed / planned : 0,
    observation_rate: executed ? observed / executed : 0,
    helpful_rate: observed ? helpful / observed : 0,
    harmful_rate: observed ? harmful / observed : 0,
    actionable_rate: planned ? actionable / planned : 0,
  };
}

function qualityEvaluation(ledger = emptyLedger()) {
  const current = normalizeLedger(ledger);
  const shadow = shadowEvaluation(current);
  const average = values => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const projectCoverage = average(current.projects.map(item => item.completeness?.ratio || 0));
  const activeRisks = current.risks.filter(item => ['open', 'monitoring'].includes(item.status));
  const riskControl = average(activeRisks.map(item => [
    item.evidence?.length > 0,
    Boolean(item.owner),
    Boolean(item.next_action || item.decision_needed),
    item.confidence >= 0.5,
  ].filter(Boolean).length / 4));
  const decisionIntegrity = average(current.decisions.map(item => [
    item.evidence?.length > 0,
    Boolean(item.rationale),
    Boolean(item.authority),
  ].filter(Boolean).length / 3));
  const interventionQuality = average(current.interventions.map(item => [
    item.evidence?.length > 0,
    Boolean(item.cognitive_context?.rationale),
    item.actionability >= 0.6,
    Boolean(item.intended_effect),
    Boolean(item.success_criteria),
  ].filter(Boolean).length / 5));
  const humanByDay = new Map();
  for (const item of current.interventions.filter(entry => HUMAN_LANES.has(entry.lane)
    && ['executed', 'observed'].includes(entry.status))) {
    const day = clean(item.initiative_reservation?.day, 40)
      || String(item.executed_at || item.created_at).slice(0, 10);
    humanByDay.set(day, (humanByDay.get(day) || 0) + 1);
  }
  const noisyDays = [...humanByDay.values()].filter(count => count > 1).length;
  const antiAnnoyance = Math.max(0, 1 - shadow.harmful_rate
    - (shadow.ignored / Math.max(1, shadow.observed)) * 0.5
    - noisyDays / Math.max(1, humanByDay.size));
  const learningClosure = shadow.executed ? shadow.observation_rate : 0;
  const dimensions = {
    project_coverage: projectCoverage,
    risk_control: activeRisks.length ? riskControl : 1,
    decision_integrity: current.decisions.length ? decisionIntegrity : 1,
    intervention_quality: current.interventions.length ? interventionQuality : 0,
    learning_closure: learningClosure,
    anti_annoyance: antiAnnoyance,
  };
  const score = dimensions.project_coverage * 0.2
    + dimensions.risk_control * 0.2
    + dimensions.decision_integrity * 0.1
    + dimensions.intervention_quality * 0.2
    + dimensions.learning_closure * 0.15
    + dimensions.anti_annoyance * 0.15;
  const observedHuman = current.outcomes.filter(outcome => {
    const intervention = current.interventions.find(item => item.id === outcome.intervention_id);
    return intervention && HUMAN_LANES.has(intervention.lane);
  }).length;
  const rolloutStage = observedHuman < 10 ? 'shadow_calibration'
    : score < 0.75 ? 'assisted_operation'
      : observedHuman >= 30 && score >= 0.85 && shadow.harmful_rate <= 0.05
        ? 'bounded_autonomy_candidate' : 'bounded_pilot';
  return {
    score,
    dimensions,
    rollout_stage: rolloutStage,
    observed_human_interventions: observedHuman,
    minimum_human_samples_for_pilot: 10,
    minimum_human_samples_for_autonomy_candidate: 30,
    noisy_days: noisyDays,
    gates: {
      enough_pilot_evidence: observedHuman >= 10,
      enough_autonomy_evidence: observedHuman >= 30,
      quality_at_least_085: score >= 0.85,
      harmful_rate_at_most_005: shadow.harmful_rate <= 0.05,
      one_human_interruption_per_day: noisyDays === 0,
    },
  };
}

function report(ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const nowMs = new Date(now).getTime();
  const openRisks = current.risks.filter(item => ['open', 'monitoring'].includes(item.status));
  return {
    generated_at: timestamp(now),
    policy: current.policy,
    projects: {
      total: current.projects.length,
      red: current.projects.filter(item => item.health === 'red').length,
      amber: current.projects.filter(item => item.health === 'amber').length,
      incomplete: current.projects.filter(item => item.completeness?.ratio < 1).length,
      milestone_overdue: current.projects.filter(item => item.next_milestone_due
        && new Date(item.next_milestone_due).getTime() < nowMs).length,
    },
    risks: {
      open: openRisks.length,
      high: openRisks.filter(item => ['high', 'critical'].includes(item.severity)).length,
      overdue: openRisks.filter(item => item.due_at && new Date(item.due_at).getTime() < nowMs).length,
      unowned: openRisks.filter(item => !item.owner).length,
    },
    decisions: { total: current.decisions.length },
    interventions: shadowEvaluation(current),
    run_summaries: {
      evaluated: current.summary_evaluations.length,
      suppressed: current.summary_evaluations.filter(item => !item.allowed).length,
      allowed: current.summary_evaluations.filter(item => item.allowed).length,
      proactive_eligible: current.summary_evaluations.filter(item => item.uses_human_budget).length,
      private_signals: current.summary_evaluations.reduce(
        (sum, item) => sum + (Number(item.private_signal_count) || 0), 0),
    },
    latest_sync: current.syncs.at(-1) || null,
  };
}

function renderPromptContext(ledger = emptyLedger(), { query = '', projectHint = '', limit = 3 } = {}) {
  const current = normalizeLedger(ledger);
  const signal = `${clean(projectHint, 300)} ${clean(query, 6000)}`.toLowerCase();
  const words = new Set(signal.split(/[^a-z0-9]+/).filter(word => word.length >= 3));
  const scored = current.projects.map(project => {
    const name = project.name.toLowerCase();
    let score = signal.includes(name) ? 20 : 0;
    if (projectHint && name === clean(projectHint, 300).toLowerCase()) score += 30;
    for (const word of name.split(/[^a-z0-9]+/)) if (word.length >= 3 && words.has(word)) score += 2;
    const openRiskCount = current.risks.filter(risk => risk.project_key === project.key
      && ['open', 'monitoring'].includes(risk.status)).length;
    if (openRiskCount && score > 0) score += 1;
    return { project, score, openRiskCount };
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(5, Number(limit) || 3)));
  if (!scored.length) return '';
  const lines = ['[PM control, current durable operating picture]'];
  for (const { project, openRiskCount } of scored) {
    lines.push(`- ${project.name}: health ${project.health}; phase ${project.phase || 'unknown'}; PM ${project.pm || 'unknown'}; next milestone ${project.next_milestone || 'unknown'}${project.next_milestone_due ? ` due ${project.next_milestone_due}` : ''}; open risks ${openRiskCount}.`);
    for (const risk of current.risks.filter(item => item.project_key === project.key
      && ['open', 'monitoring'].includes(item.status))
      .sort((left, right) => (SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity)))
      .slice(0, 3)) {
      lines.push(`  Risk ${risk.severity}: ${risk.title}. Next: ${risk.next_action || risk.decision_needed || 'verify the next action'}. Confidence ${risk.confidence}.`);
    }
  }
  lines.push('Treat this as a compact control projection. Verify live Teamwork before claiming a changed status or taking action.');
  return lines.join('\n').slice(0, 5000);
}

function updatePolicy(ledger = emptyLedger(), input = {}) {
  const current = normalizeLedger(ledger);
  const allowed = ['mode', 'human_budget_scope', 'recipient_cooldown_hours', 'subject_cooldown_hours',
    'emergency_budget_override', 'minimum_confidence', 'minimum_actionability'];
  for (const key of allowed) {
    if (input[key] !== undefined) current.policy[key] = input[key];
  }
  current.policy.recipient_cooldown_hours = Math.max(1, Number(current.policy.recipient_cooldown_hours) || 48);
  current.policy.subject_cooldown_hours = Math.max(1, Number(current.policy.subject_cooldown_hours) || 48);
  current.policy.minimum_confidence = clamp(current.policy.minimum_confidence, 0.65);
  current.policy.minimum_actionability = clamp(current.policy.minimum_actionability, 0.6);
  current.policy.emergency_budget_override = Boolean(current.policy.emergency_budget_override);
  return { ledger: current, policy: current.policy };
}

module.exports = {
  LANES,
  RISK_STATUSES,
  INTERVENTION_STATUSES,
  OUTCOMES,
  emptyLedger,
  normalizeLedger,
  upsertProject,
  createRisk,
  updateRisk,
  recordDecision,
  planIntervention,
  authorizeIntervention,
  executeIntervention,
  observeIntervention,
  recordSync,
  ingestMeeting,
  shadowEvaluation,
  qualityEvaluation,
  report,
  renderPromptContext,
  updatePolicy,
  projectCompleteness,
  evaluateIntervention,
};
