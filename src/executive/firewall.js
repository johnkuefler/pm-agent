'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const STATE_KEY = 'executive_firewall_v1';
const CASE_STATES = Object.freeze([
  'triaged', 'resolving', 'decision_ready', 'escalated', 'executing',
  'verified_closed', 'dismissed',
]);
const DECISIONS = Object.freeze(['approve', 'override', 'reject', 'defer']);
const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const CLOSED_STATES = new Set(['verified_closed', 'dismissed']);
const EXECUTIVE_GATES = new Set([
  'budget', 'scope', 'major_deadline', 'client_commitment', 'personnel',
  'legal', 'security', 'external_relationship',
]);
const AUTHORITY_CLASSES = new Set([
  'coordination', 'scheduling_internal', 'task_management', 'status_followup',
  'project_plan', 'meeting_followthrough', 'fleet_recovery', 'routine_communication',
]);
const MAX_CASES = 2000;
const MAX_EVENTS = 8000;
const MAX_FEEDBACK = 2000;

function clean(value, max = 1000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
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

function normalizeList(value, maxItems = 20, maxText = 500) {
  if (!Array.isArray(value)) return [];
  return value.map(item => clean(item, maxText)).filter(Boolean).slice(0, maxItems);
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map(item => ({
    type: clean(item?.type || 'source', 80),
    ref: clean(item?.ref || item?.id || item?.url, 1000),
    ...(item?.note ? { note: clean(item.note, 500) } : {}),
    ...(item?.observed_at ? { observed_at: timestamp(item.observed_at) } : {}),
  })).filter(item => item.ref);
}

function emptyState(now = new Date()) {
  return {
    protocol_version: PROTOCOL_VERSION,
    mode: 'executive_firewall',
    policy: {
      executive_name: 'John',
      team_pm_role_preserved: true,
      executive_budget_scope: 'executive:john',
      daily_brief_is_pull_only: true,
      unchanged_cases_are_silent: true,
      verified_recovery_is_silent: true,
      resolution_sla_hours: { low: 72, medium: 24, high: 8, critical: 2 },
      executive_gates: [...EXECUTIVE_GATES],
      standing_authority: [...AUTHORITY_CLASSES],
      emergency_budget_override_categories: ['security', 'legal'],
    },
    cases: [],
    events: [],
    feedback: [],
    baseline_at: null,
    quiet: {
      intakes: 0,
      baseline_suppressions: 0,
      duplicates_absorbed: 0,
      unchanged_absorbed: 0,
      notifications_sent: 0,
      budget_suppressions: 0,
      silent_closures: 0,
      last_notification_at: null,
      last_notification_case_ids: [],
    },
    last_reconciled_at: null,
    updated_at: now.toISOString(),
  };
}

function normalizeState(input, now = new Date()) {
  const base = emptyState(now);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  return {
    ...base,
    ...input,
    protocol_version: PROTOCOL_VERSION,
    mode: 'executive_firewall',
    policy: { ...base.policy, ...(input.policy || {}),
      resolution_sla_hours: { ...base.policy.resolution_sla_hours,
        ...(input.policy?.resolution_sla_hours || {}) } },
    quiet: { ...base.quiet, ...(input.quiet || {}) },
    cases: Array.isArray(input.cases) ? input.cases.filter(item => item?.id).slice(-MAX_CASES) : [],
    events: Array.isArray(input.events) ? input.events.filter(item => item?.id).slice(-MAX_EVENTS) : [],
    feedback: Array.isArray(input.feedback)
      ? input.feedback.filter(item => item?.id).slice(-MAX_FEEDBACK) : [],
  };
}

function event(state, caseItem, type, detail, at = new Date(), metadata = {}) {
  const entry = {
    id: id('ef-event'),
    case_id: caseItem?.id || null,
    type: clean(type, 80),
    detail: clean(detail, 1200),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    at: timestamp(at),
  };
  state.events.push(entry);
  state.events = state.events.slice(-MAX_EVENTS);
  state.updated_at = entry.at;
  return entry;
}

function sourceKey(input = {}) {
  const source = clean(input.source, 100).toLowerCase();
  const ref = clean(input.source_ref, 500).toLowerCase();
  if (!source || !ref) throw new Error('source and source_ref are required');
  return `${source}:${ref}`;
}

function severity(value) {
  const normalized = clean(value || 'medium', 20).toLowerCase();
  if (!SEVERITIES.includes(normalized)) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
  return normalized;
}

function gateFromText(value = '') {
  const text = clean(value, 5000).toLowerCase();
  if (/security|breach|credential|data exposure/.test(text)) return 'security';
  if (/legal|contract|liability|compliance/.test(text)) return 'legal';
  if (/budget|spend|cost|price|margin|\$/.test(text)) return 'budget';
  if (/scope change|out of scope|change order/.test(text)) return 'scope';
  if (/major deadline|launch date|go-live|client deadline/.test(text)) return 'major_deadline';
  if (/hire|fire|termination|compensation|performance plan/.test(text)) return 'personnel';
  if (/client commitment|promise to client|external commitment/.test(text)) return 'client_commitment';
  return null;
}

function deadlineFor(state, severityValue, at) {
  const hours = Number(state.policy.resolution_sla_hours?.[severityValue]) || 24;
  return new Date(new Date(at).getTime() + hours * 3600000).toISOString();
}

function intakeCase(input = {}, { state: original, now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const key = sourceKey(input);
  const at = timestamp(now);
  const evidence = normalizeEvidence(input.evidence);
  const summary = clean(input.summary || input.title, 1200);
  if (!summary) throw new Error('case summary is required');
  const category = clean(input.category || 'coordination', 80).toLowerCase();
  const gate = clean(input.executive_gate || gateFromText(`${summary} ${input.detail || ''}`), 80).toLowerCase() || null;
  const requiresExecutive = Boolean(input.requires_executive || (gate && EXECUTIVE_GATES.has(gate)));
  const materialCommitment = commitment({ summary, detail: clean(input.detail, 2400),
    severity: severity(input.severity), owner: clean(input.owner, 240), gate, evidence });
  const existing = state.cases.find(item => item.source_key === key && !CLOSED_STATES.has(item.state));
  state.quiet.intakes += 1;
  if (existing) {
    state.quiet.duplicates_absorbed += 1;
    if (existing.material_commitment === materialCommitment) {
      existing.last_seen_at = at;
      existing.seen_count = Math.max(1, Number(existing.seen_count) || 1) + 1;
      state.quiet.unchanged_absorbed += 1;
      state.updated_at = at;
      return { state, case: existing, created: false, material_change: false };
    }
    Object.assign(existing, {
      summary,
      detail: clean(input.detail, 2400),
      severity: severity(input.severity),
      owner: clean(input.owner, 240),
      project_key: clean(input.project_key, 240).toLowerCase(),
      authority_class: clean(input.authority_class || existing.authority_class || category, 80).toLowerCase(),
      executive_gate: gate,
      requires_executive: requiresExecutive,
      evidence,
      material_commitment: materialCommitment,
      material_revision: Math.max(1, Number(existing.material_revision) || 1) + 1,
      last_seen_at: at,
      seen_count: Math.max(1, Number(existing.seen_count) || 1) + 1,
      updated_at: at,
    });
    if (requiresExecutive && existing.decision_packet) existing.state = 'decision_ready';
    event(state, existing, 'material_change', 'The underlying case changed materially.', now);
    return { state, case: existing, created: false, material_change: true };
  }
  const caseItem = {
    id: clean(input.id, 160) || id('ef-case'),
    source: clean(input.source, 100).toLowerCase(),
    source_ref: clean(input.source_ref, 500),
    source_key: key,
    category,
    state: 'resolving',
    summary,
    detail: clean(input.detail, 2400),
    severity: severity(input.severity),
    owner: clean(input.owner, 240),
    project_key: clean(input.project_key, 240).toLowerCase(),
    authority_class: clean(input.authority_class || category, 80).toLowerCase(),
    executive_gate: gate,
    requires_executive: requiresExecutive,
    resolution_plan: clean(input.resolution_plan, 1800),
    next_action: clean(input.next_action, 1200),
    evidence,
    attempts: [],
    decision_packet: null,
    executive_involved: false,
    handled_without_executive: null,
    material_commitment: materialCommitment,
    material_revision: 1,
    notified_revision: 0,
    seen_count: 1,
    created_at: at,
    updated_at: at,
    last_seen_at: at,
    resolution_due_at: input.resolution_due_at
      ? timestamp(input.resolution_due_at) : deadlineFor(state, severity(input.severity), at),
  };
  state.cases.push(caseItem);
  state.cases = state.cases.slice(-MAX_CASES);
  event(state, caseItem, 'intake', 'Nora accepted responsibility for this matter.', now,
    { source: caseItem.source, category: caseItem.category });
  if (requiresExecutive && input.decision_packet) {
    const prepared = prepareDecision(state, caseItem.id, input.decision_packet, { now });
    return { state: prepared.state, case: prepared.case, created: true, material_change: true };
  }
  return { state, case: caseItem, created: true, material_change: true };
}

function findOpenCase(state, caseId) {
  const item = state.cases.find(entry => entry.id === caseId);
  if (!item) throw new Error('executive firewall case not found');
  return item;
}

function recordAttempt(original, caseId, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  if (CLOSED_STATES.has(item.state)) throw new Error('closed cases cannot accept resolution attempts');
  const action = clean(input.action, 1200);
  const result = clean(input.result, 1600);
  if (!action || !result) throw new Error('attempt action and result are required');
  const attempt = {
    id: id('ef-attempt'),
    action,
    result,
    actor: clean(input.actor || 'Nora', 240),
    target: clean(input.target, 240),
    channel: clean(input.channel, 80),
    evidence: normalizeEvidence(input.evidence),
    at: timestamp(now),
  };
  item.attempts = [...(Array.isArray(item.attempts) ? item.attempts : []), attempt].slice(-50);
  item.next_action = clean(input.next_action ?? item.next_action, 1200);
  item.next_check_at = input.next_check_at ? timestamp(input.next_check_at) : item.next_check_at || null;
  item.updated_at = attempt.at;
  if (input.executive_required === true) item.requires_executive = true;
  if (input.executive_gate) item.executive_gate = clean(input.executive_gate, 80).toLowerCase();
  if (!['decision_ready', 'escalated', 'executing'].includes(item.state)) item.state = 'resolving';
  event(state, item, 'resolution_attempt', action, now, { attempt_id: attempt.id });
  return { state, case: item, attempt };
}

function normalizeDecisionPacket(input = {}, caseItem) {
  const recommendation = clean(input.recommendation, 1200);
  const question = clean(input.question || input.decision, 1200);
  const consequence = clean(input.consequence, 1600);
  const options = normalizeList(input.options, 5, 1000);
  const evidence = normalizeEvidence(input.evidence?.length ? input.evidence : caseItem.evidence);
  if (!question || !recommendation || !consequence || !options.length || !evidence.length) {
    throw new Error('decision packet requires question, recommendation, consequence, options, and evidence');
  }
  return {
    question,
    recommendation,
    options,
    consequence,
    deadline: input.deadline ? timestamp(input.deadline) : caseItem.resolution_due_at,
    evidence,
    prepared_at: timestamp(input.prepared_at || new Date()),
  };
}

function prepareDecision(original, caseId, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  if (CLOSED_STATES.has(item.state)) throw new Error('closed cases cannot become decision ready');
  const packet = normalizeDecisionPacket({ ...input, prepared_at: timestamp(now) }, item);
  item.decision_packet = packet;
  item.resolution_due_at = packet.deadline;
  item.requires_executive = true;
  item.executive_gate = clean(input.executive_gate || item.executive_gate || 'executive_judgment', 80).toLowerCase();
  item.state = 'decision_ready';
  item.updated_at = timestamp(now);
  item.material_revision = Math.max(1, Number(item.material_revision) || 1) + 1;
  item.decision_commitment = commitment({ case_id: item.id, packet });
  event(state, item, 'decision_ready', 'Nora prepared a decision-ready executive packet.', now,
    { decision_commitment: item.decision_commitment });
  return { state, case: item };
}

function markNotified(original, caseIds, { now = new Date(), delivery_ref: deliveryRef = '' } = {}) {
  const state = normalizeState(original, now);
  const at = timestamp(now);
  const marked = [];
  for (const caseId of caseIds) {
    const item = findOpenCase(state, caseId);
    if (!item.decision_packet || !['decision_ready', 'escalated'].includes(item.state)) continue;
    item.state = 'escalated';
    item.executive_involved = true;
    item.notified_revision = item.material_revision;
    item.notified_at = at;
    item.notification_count = Math.max(0, Number(item.notification_count) || 0) + 1;
    item.delivery_ref = clean(deliveryRef, 1000);
    item.updated_at = at;
    event(state, item, 'executive_interruption', 'The decision packet was delivered to the executive.', now);
    marked.push(item);
  }
  if (marked.length) {
    state.quiet.notifications_sent += 1;
    state.quiet.last_notification_at = at;
    state.quiet.last_notification_case_ids = marked.map(item => item.id);
  }
  return { state, cases: marked };
}

function recordDecision(original, caseId, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  if (!item.decision_packet || !['decision_ready', 'escalated'].includes(item.state)) {
    throw new Error('case is not awaiting an executive decision');
  }
  const decision = clean(input.decision, 40).toLowerCase();
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`);
  const at = timestamp(now);
  item.executive_involved = true;
  item.executive_decision = {
    decision,
    instruction: clean(input.instruction, 1600),
    decided_by: clean(input.decided_by || state.policy.executive_name, 240),
    decided_at: at,
  };
  item.state = decision === 'defer' ? 'decision_ready' : 'executing';
  item.next_action = decision === 'defer'
    ? clean(input.instruction || 'Return at the requested time with updated evidence.', 1200)
    : clean(input.next_action || 'Execute the approved direction and verify closure.', 1200);
  item.updated_at = at;
  event(state, item, 'executive_decision', `Executive decision recorded: ${decision}.`, now,
    { decision });
  return { state, case: item, idempotent: false };
}

function verifyClosure(original, caseId, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  if (item.state === 'verified_closed') return { state, case: item, idempotent: true };
  if (item.state === 'dismissed') throw new Error('dismissed cases cannot be verified closed');
  const outcome = clean(input.outcome, 1600);
  const evidence = normalizeEvidence(input.evidence);
  if (!outcome || !evidence.length) throw new Error('verified closure requires outcome and evidence');
  const at = timestamp(now);
  item.state = 'verified_closed';
  item.verified_outcome = outcome;
  item.closure_evidence = evidence;
  item.closed_at = at;
  item.updated_at = at;
  item.handled_without_executive = !item.executive_involved;
  item.closure_commitment = commitment({ case_id: item.id, outcome, evidence, closed_at: at });
  if (item.handled_without_executive) state.quiet.silent_closures += 1;
  event(state, item, 'verified_closure', 'The matter reached evidence-backed closure.', now,
    { handled_without_executive: item.handled_without_executive });
  return { state, case: item, idempotent: false };
}

function dismissCase(original, caseId, input = {}, { now = new Date(), operator = false } = {}) {
  if (!operator) throw new Error('operator authority is required to dismiss a case');
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  const reason = clean(input.reason, 1200);
  if (!reason) throw new Error('dismissal reason is required');
  item.state = 'dismissed';
  item.dismissed_at = timestamp(now);
  item.dismissal_reason = reason;
  item.updated_at = item.dismissed_at;
  item.handled_without_executive = !item.executive_involved;
  event(state, item, 'dismissed', reason, now);
  return { state, case: item };
}

function recordFeedback(original, caseId, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const item = findOpenCase(state, caseId);
  const rating = clean(input.rating, 40).toLowerCase();
  if (!['helpful', 'neutral', 'unnecessary', 'harmful'].includes(rating)) {
    throw new Error('rating must be helpful, neutral, unnecessary, or harmful');
  }
  const feedback = {
    id: id('ef-feedback'),
    case_id: item.id,
    rating,
    note: clean(input.note, 1200),
    behavior_change: clean(input.behavior_change, 1200),
    at: timestamp(now),
  };
  state.feedback.push(feedback);
  state.feedback = state.feedback.slice(-MAX_FEEDBACK);
  item.latest_feedback = rating;
  if (feedback.behavior_change) item.learned_behavior = feedback.behavior_change;
  event(state, item, 'executive_feedback', `Executive feedback recorded: ${rating}.`, now,
    { feedback_id: feedback.id });
  return { state, case: item, feedback };
}

function notificationCandidates(original) {
  const state = normalizeState(original);
  return state.cases.filter(item => ['decision_ready', 'escalated'].includes(item.state)
    && item.decision_packet
    && Number(item.notified_revision || 0) < Number(item.material_revision || 1))
    .sort((left, right) => {
      const severityDelta = SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity);
      if (severityDelta) return severityDelta;
      return new Date(left.decision_packet.deadline).getTime()
        - new Date(right.decision_packet.deadline).getTime();
    });
}

function metrics(original, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  const closed = state.cases.filter(item => item.state === 'verified_closed');
  const handled = closed.filter(item => item.handled_without_executive).length;
  const notifiedCases = state.events.filter(item => item.type === 'executive_interruption').length;
  const interruptions = Math.max(0, Number(state.quiet.notifications_sent) || 0);
  const unnecessary = state.feedback.filter(item => item.rating === 'unnecessary').length;
  const harmful = state.feedback.filter(item => item.rating === 'harmful').length;
  const active = state.cases.filter(item => !CLOSED_STATES.has(item.state));
  const overdue = active.filter(item => item.resolution_due_at
    && new Date(item.resolution_due_at).getTime() < new Date(now).getTime());
  return {
    generated_at: timestamp(now),
    total_cases: state.cases.length,
    active: active.length,
    resolving: active.filter(item => item.state === 'resolving').length,
    decisions_ready: active.filter(item => ['decision_ready', 'escalated'].includes(item.state)).length,
    executing: active.filter(item => item.state === 'executing').length,
    overdue: overdue.length,
    verified_closed: closed.length,
    handled_without_executive: handled,
    handled_without_executive_rate: closed.length ? handled / closed.length : 0,
    executive_interruptions: interruptions,
    decision_packets_delivered: notifiedCases,
    unnecessary_escalations: unnecessary,
    harmful_escalations: harmful,
    interruption_precision: notifiedCases
      ? Math.max(0, (notifiedCases - unnecessary - harmful) / notifiedCases) : 1,
    duplicate_noise_absorbed: state.quiet.duplicates_absorbed,
    silent_closures: state.quiet.silent_closures,
  };
}

function dailyBrief(original, { now = new Date(), hours = 24 } = {}) {
  const state = normalizeState(original, now);
  const cutoff = new Date(now).getTime() - Math.max(1, Number(hours) || 24) * 3600000;
  const recentClosed = state.cases.filter(item => item.state === 'verified_closed'
    && new Date(item.closed_at).getTime() >= cutoff);
  return {
    generated_at: timestamp(now),
    period_hours: Math.max(1, Number(hours) || 24),
    decisions: notificationCandidates(state),
    handled_without_executive: recentClosed.filter(item => item.handled_without_executive),
    closed_after_decision: recentClosed.filter(item => !item.handled_without_executive),
    active_high_priority: state.cases.filter(item => !CLOSED_STATES.has(item.state)
      && ['high', 'critical'].includes(item.severity)),
    metrics: metrics(state, { now }),
  };
}

function updatePolicy(original, input = {}, { now = new Date() } = {}) {
  const state = normalizeState(original, now);
  if (input.executive_name !== undefined) state.policy.executive_name = clean(input.executive_name, 240);
  if (input.daily_brief_is_pull_only !== undefined) {
    state.policy.daily_brief_is_pull_only = Boolean(input.daily_brief_is_pull_only);
  }
  if (input.resolution_sla_hours && typeof input.resolution_sla_hours === 'object') {
    for (const level of SEVERITIES) {
      if (input.resolution_sla_hours[level] !== undefined) {
        state.policy.resolution_sla_hours[level] = Math.max(1,
          Math.min(720, Number(input.resolution_sla_hours[level]) || 24));
      }
    }
  }
  state.updated_at = timestamp(now);
  return { state, policy: state.policy };
}

function promptContext(original, { limit = 12 } = {}) {
  const state = normalizeState(original);
  const active = state.cases.filter(item => !CLOSED_STATES.has(item.state))
    .sort((left, right) => SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 12)));
  const summary = metrics(state);
  const lines = [
    '[Executive Firewall, durable accountability ledger]',
    'You remain the project manager for the whole LimeLight team. This firewall adds executive protection; it does not turn you into a private assistant or let you bypass project owners and teammates.',
    `You own ${summary.active} active matter(s). ${summary.decisions_ready} are decision ready; ${summary.resolving} remain yours to resolve without executive involvement.`,
    'Your job is to absorb, resolve, and verify closure. Do not report observations, idle status, unchanged evidence, or work in progress to John.',
    'Contact owners and PMs before John. Use standing authority for coordination, internal scheduling, task management, routine follow-up, project-plan maintenance, meeting follow-through, and Fleet recovery.',
    'John is the final gate only for budget, scope, major deadlines, client commitments, personnel, legal, security, external relationships, or genuinely exhausted delegated resolution.',
    'Never message John directly about a firewall case. Prepare a complete decision packet and let the firewall dispatcher enforce deduplication, grouping, and the shared interruption budget.',
    'After a decision, execute it, update the systems and people involved, and attach evidence before verified closure.',
  ];
  for (const item of active) {
    lines.push(`- ${item.id} [${item.severity}/${item.state}] ${item.summary}; owner ${item.owner || 'Nora'}; next ${item.next_action || item.resolution_plan || 'establish the next resolving action'}; due ${item.resolution_due_at}.`);
    if (item.learned_behavior) lines.push(`  Learned from John: ${item.learned_behavior}`);
  }
  if (!active.length) lines.push('- No active firewall cases. Stay quiet unless new evidence creates work.');
  return lines.join('\n').slice(0, 8000);
}

function decisionMessage(cases) {
  const list = Array.isArray(cases) ? cases : [];
  const intro = list.length === 1
    ? 'I need one decision from you. I have handled the coordination around it.'
    : `I need ${list.length} decisions from you. I grouped them into one interruption.`;
  const blocks = list.map(item => {
    const packet = item.decision_packet;
    return [
      `${item.id}: ${packet.question}`,
      `My recommendation: ${packet.recommendation}`,
      `Why it matters: ${packet.consequence}`,
      `Options: ${packet.options.join(' | ')}`,
      `Needed by: ${packet.deadline}`,
    ].join('\n');
  });
  return `${intro}\n\n${blocks.join('\n\n')}\n\nReply with the case ID and approve, override, reject, or defer. I will carry the decision through to verified closure.`;
}

module.exports = {
  PROTOCOL_VERSION,
  STATE_KEY,
  CASE_STATES,
  DECISIONS,
  SEVERITIES,
  EXECUTIVE_GATES,
  AUTHORITY_CLASSES,
  emptyState,
  normalizeState,
  gateFromText,
  intakeCase,
  recordAttempt,
  prepareDecision,
  markNotified,
  recordDecision,
  verifyClosure,
  dismissCase,
  recordFeedback,
  notificationCandidates,
  metrics,
  dailyBrief,
  updatePolicy,
  promptContext,
  decisionMessage,
};
