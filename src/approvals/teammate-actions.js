'use strict';

const { canonicalJson, hash } = require('../runtime/source-attestation');

const STATE_KEY = 'teammate_action_approvals_v1';
const OPEN_STATES = new Set(['proposed', 'approved', 'executing']);
const TERMINAL_STATES = new Set(['verified_closed', 'rejected', 'deferred', 'invalidated',
  'execution_uncertain', 'delivery_failed']);
const BEFORE_FIELDS = new Set(['name', 'due_date', 'priority', 'progress', 'status']);
const CHANGE_FIELDS = new Set(['name', 'due_date', 'priority', 'progress']);
const DECISION_WORDS = /\b(approve|approved|go ahead|looks good|do it|reject|decline|defer|hold off)\b/i;
const PROPOSAL_ID = /\b(ta-[a-f0-9]{10}-v\d+)\b/i;

function text(value, max = 1000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function iso(value, fallback = null) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function emptyStats() {
  return { created: 0, duplicate_suppressed: 0, superseded: 0, delivered: 0,
    delivery_failed: 0, approvals: 0, rejections: 0, deferrals: 0,
    executions_verified: 0, invalidated: 0, execution_uncertain: 0, reminders_sent: 0 };
}

function emptyState() {
  return { protocol_version: 1, proposals: [], stats: emptyStats(), updated_at: null };
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { protocol_version: 1,
    proposals: Array.isArray(source.proposals) ? source.proposals.map(item => JSON.parse(JSON.stringify(item))) : [],
    stats: { ...emptyStats(), ...(source.stats || {}), reminders_sent: 0 },
    updated_at: iso(source.updated_at) };
}

function dateValue(value, field) {
  const compact = text(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compact)) throw new Error(`${field} must be YYYY-MM-DD`);
  return compact;
}

function fieldValue(field, value, before = false) {
  if (value === null && before) return null;
  if (field === 'due_date') return dateValue(value, field);
  if (field === 'progress') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error('progress must be an integer from 0 to 100');
    return number;
  }
  if (field === 'priority') {
    const priority = text(value, 20).toLowerCase();
    if (!['low', 'medium', 'high'].includes(priority)) throw new Error('priority must be low, medium, or high');
    return priority;
  }
  if (field === 'status') {
    const status = text(value, 40).toLowerCase();
    if (!status) throw new Error('status cannot be blank');
    return status;
  }
  const normalized = text(value, field === 'name' ? 500 : 200);
  if (!normalized) throw new Error(`${field} cannot be blank`);
  return normalized;
}

function fields(value, allowed, label, before = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
    output[key] = fieldValue(key, raw, before);
  }
  return output;
}

function normalizeAction(value, index) {
  if (!value || typeof value !== 'object' || value.type !== 'update_task') {
    throw new Error(`actions[${index}] must be an update_task action`);
  }
  const taskId = text(value.task_id, 100);
  const taskName = text(value.task_name, 500);
  if (!taskId || !taskName) throw new Error(`actions[${index}] requires task_id and task_name`);
  const expectedBefore = fields(value.expected_before, BEFORE_FIELDS, `actions[${index}].expected_before`, true);
  const changes = fields(value.changes, CHANGE_FIELDS, `actions[${index}].changes`);
  const changeKeys = Object.keys(changes);
  if (!changeKeys.length) throw new Error(`actions[${index}] requires at least one change`);
  for (const key of changeKeys) {
    if (!Object.prototype.hasOwnProperty.call(expectedBefore, key)) {
      throw new Error(`actions[${index}].expected_before must include changed field ${key}`);
    }
    if (canonicalJson(expectedBefore[key]) === canonicalJson(changes[key])) {
      throw new Error(`actions[${index}].${key} does not change the current value`);
    }
  }
  const reason = text(value.reason, 1200);
  return { type: 'update_task', task_id: taskId, task_name: taskName,
    expected_before: expectedBefore, changes, ...(reason ? { reason } : {}) };
}

function proposalCore(input) {
  return {
    dedupe_key: input.dedupe_key,
    project_key: input.project_key,
    issue_summary: input.issue_summary,
    evidence_summary: input.evidence_summary,
    recommendation: input.recommendation,
    approver: input.approver,
    actions: input.actions,
    case_id: input.case_id || null,
    source_ref: input.source_ref || null,
  };
}

function normalizeInput(input = {}) {
  const approver = input.approver || {};
  const actions = Array.isArray(input.actions) ? input.actions.map(normalizeAction) : [];
  if (!actions.length || actions.length > 10) throw new Error('proposal requires 1 to 10 exact actions');
  const normalized = {
    dedupe_key: text(input.dedupe_key, 300).toLowerCase(),
    project_key: text(input.project_key, 300),
    issue_summary: text(input.issue_summary, 1000),
    evidence_summary: text(input.evidence_summary, 2000),
    recommendation: text(input.recommendation, 2000),
    approver: { name: text(approver.name, 200), slack_user_id: text(approver.slack_user_id, 120),
      basis: text(approver.basis, 500) },
    actions,
    case_id: text(input.case_id, 200) || null,
    source_ref: text(input.source_ref, 500) || null,
  };
  for (const key of ['dedupe_key', 'project_key', 'issue_summary', 'evidence_summary', 'recommendation']) {
    if (!normalized[key]) throw new Error(`${key} is required`);
  }
  if (!normalized.approver.name || !/^U[A-Z0-9]+$/.test(normalized.approver.slack_user_id)
    || !normalized.approver.basis) throw new Error('approver name, Slack user id, and accountability basis are required');
  return normalized;
}

function integrity(proposal) {
  return proposal?.input_commitment === hash(proposalCore(proposal))
    && proposal?.proposal_commitment === hash({ id: proposal.id, version: proposal.version,
      input_commitment: proposal.input_commitment, created_at: proposal.created_at,
      expires_at: proposal.expires_at });
}

function createProposal(stateValue, input, { now = new Date(), ttlHours = 48 } = {}) {
  const state = normalizeState(stateValue);
  const normalized = normalizeInput(input);
  const inputCommitment = hash(proposalCore(normalized));
  let open = state.proposals.find(item => item.dedupe_key === normalized.dedupe_key && OPEN_STATES.has(item.status));
  if (open && new Date(open.expires_at).getTime() < new Date(now).getTime()) {
    open.status = 'invalidated'; open.invalidated_at = iso(now);
    open.invalidation_reason = 'The teammate approval window expired.';
    open.updated_at = iso(now); state.stats.invalidated += 1; open = null;
  }
  if (open && open.input_commitment === inputCommitment && integrity(open)) {
    state.stats.duplicate_suppressed += 1;
    state.updated_at = iso(now);
    return { state, proposal: open, created: false, duplicate: true, superseded: null };
  }
  let version = 1;
  let superseded = null;
  for (const item of state.proposals.filter(entry => entry.dedupe_key === normalized.dedupe_key)) {
    version = Math.max(version, Number(item.version || 0) + 1);
  }
  if (open) {
    open.status = 'invalidated'; open.invalidated_at = iso(now);
    open.invalidation_reason = 'Superseded by a materially revised proposal.';
    open.updated_at = iso(now); superseded = open.id; state.stats.superseded += 1;
  }
  const createdAt = iso(now);
  const expiresAt = new Date(new Date(createdAt).getTime() + Math.max(1, Math.min(168, Number(ttlHours) || 48)) * 3600000).toISOString();
  const id = `ta-${hash(normalized.dedupe_key).slice(0, 10)}-v${version}`;
  const proposal = { ...normalized, id, version, input_commitment: inputCommitment,
    proposal_commitment: hash({ id, version, input_commitment: inputCommitment,
      created_at: createdAt, expires_at: expiresAt }), status: 'proposed',
    created_at: createdAt, updated_at: createdAt, expires_at: expiresAt,
    delivery: null, decision: null, execution: null };
  state.proposals.push(proposal); state.stats.created += 1; state.updated_at = createdAt;
  return { state, proposal, created: true, duplicate: false, superseded };
}

function proposalById(state, id) {
  const proposal = state.proposals.find(item => item.id === String(id || '').toLowerCase());
  if (!proposal) throw new Error('teammate proposal not found');
  if (!integrity(proposal)) throw new Error('teammate proposal integrity check failed');
  return proposal;
}

function markDelivered(stateValue, id, delivery, { now = new Date() } = {}) {
  const state = normalizeState(stateValue); const proposal = proposalById(state, id);
  if (proposal.delivery?.ts) return { state, proposal, idempotent: true };
  if (proposal.status !== 'proposed') throw new Error('only an open proposal can be delivered');
  proposal.delivery = { channel: text(delivery.channel, 120), ts: text(delivery.ts, 120),
    sent_at: iso(now), attempts: Math.max(1, Number(delivery.attempts) || 1) };
  if (!proposal.delivery.channel || !proposal.delivery.ts) throw new Error('Slack delivery receipt is incomplete');
  proposal.updated_at = iso(now); state.stats.delivered += 1; state.updated_at = iso(now);
  return { state, proposal, idempotent: false };
}

function markDeliveryFailed(stateValue, id, reason, { now = new Date() } = {}) {
  const state = normalizeState(stateValue); const proposal = proposalById(state, id);
  proposal.status = 'delivery_failed'; proposal.delivery_error = text(reason, 1000);
  proposal.updated_at = iso(now); state.stats.delivery_failed += 1; state.updated_at = iso(now);
  return { state, proposal };
}

function parseDecision(textValue) {
  const value = text(textValue, 2000); const word = value.match(DECISION_WORDS)?.[1]?.toLowerCase();
  if (!word) return null;
  const decision = ['reject', 'decline'].includes(word) ? 'reject'
    : ['defer', 'hold off'].includes(word) ? 'defer' : 'approve';
  return { decision, proposal_id: value.match(PROPOSAL_ID)?.[1]?.toLowerCase() || null, text: value };
}

function decisionCandidate(stateValue, { user, channel, text: decisionText } = {}) {
  const state = normalizeState(stateValue); const parsed = parseDecision(decisionText);
  if (!parsed) return { parsed: null, proposal: null, ambiguous: false };
  const eligible = state.proposals.filter(item => item.status === 'proposed' && item.delivery?.channel === channel
    && item.approver?.slack_user_id === user);
  if (parsed.proposal_id) {
    return { parsed, proposal: eligible.find(item => item.id === parsed.proposal_id) || null, ambiguous: false };
  }
  return { parsed, proposal: eligible.length === 1 ? eligible[0] : null, ambiguous: eligible.length > 1 };
}

function verifiedSlackDecision(attestation, proposal, user, channel, rawText) {
  const event = attestation?.source_snapshot?.event;
  return attestation?.provider === 'slack' && attestation?.status === 'provider_verified'
    && attestation?.receipt?.cryptographically_verified_at_ingress === true
    && event?.user === user && event?.channel === channel
    && event?.text_sha256 === hash(String(rawText == null ? '' : rawText))
    && proposal.delivery?.channel === channel;
}

function recordDecision(stateValue, id, input, { now = new Date() } = {}) {
  const state = normalizeState(stateValue); const proposal = proposalById(state, id);
  if (proposal.status !== 'proposed' || !proposal.delivery?.ts) throw new Error('proposal is not awaiting approval');
  if (new Date(proposal.expires_at).getTime() < new Date(now).getTime()) throw new Error('proposal approval window expired');
  if (proposal.approver.slack_user_id !== input.user
    || !verifiedSlackDecision(input.attestation, proposal, input.user, input.channel, input.raw_text)) {
    throw new Error('approval must come from the named teammate through verified Slack ingress');
  }
  const decision = input.decision;
  if (!['approve', 'reject', 'defer'].includes(decision)) throw new Error('unsupported teammate decision');
  const at = iso(now);
  proposal.decision = { decision, decided_by: input.user, decided_by_name: text(input.user_name, 200),
    decided_at: at, slack_channel: input.channel, slack_ts: text(input.event_ts, 120),
    text_sha256: hash(text(input.text, 2000)), proposal_commitment: proposal.proposal_commitment,
    ingress_receipt_commitment: input.attestation.receipt_commitment || hash(input.attestation.receipt) };
  proposal.decision.decision_commitment = hash(proposal.decision);
  proposal.status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'deferred';
  proposal.updated_at = at; state.stats[decision === 'approve' ? 'approvals' : decision === 'reject' ? 'rejections' : 'deferrals'] += 1;
  state.updated_at = at;
  return { state, proposal };
}

function transition(stateValue, id, status, detail = {}, { now = new Date() } = {}) {
  const state = normalizeState(stateValue); const proposal = proposalById(state, id); const at = iso(now);
  if (status === 'executing' && proposal.status !== 'approved') throw new Error('only an approved proposal can execute');
  proposal.status = status; proposal.updated_at = at;
  if (status === 'executing') proposal.execution = { started_at: at, actions: [] };
  if (status === 'verified_closed') {
    proposal.execution = { ...(proposal.execution || {}), ...detail, verified_at: at };
    state.stats.executions_verified += 1;
  }
  if (status === 'invalidated') {
    proposal.invalidated_at = at; proposal.invalidation_reason = text(detail.reason, 1000);
    state.stats.invalidated += 1;
  }
  if (status === 'execution_uncertain') {
    proposal.execution = { ...(proposal.execution || {}), ...detail, failed_at: at };
    state.stats.execution_uncertain += 1;
  }
  state.updated_at = at;
  return { state, proposal };
}

function publicSnapshot(stateValue) {
  const state = normalizeState(stateValue);
  const open = state.proposals.filter(item => OPEN_STATES.has(item.status)).length;
  return { state, report: { total: state.proposals.length, open,
    awaiting_approval: state.proposals.filter(item => item.status === 'proposed').length,
    verified_closed: state.proposals.filter(item => item.status === 'verified_closed').length,
    terminal: state.proposals.filter(item => TERMINAL_STATES.has(item.status)).length,
    anti_noise: { reminders_sent: 0, duplicate_suppressed: state.stats.duplicate_suppressed } } };
}

module.exports = { STATE_KEY, OPEN_STATES, TERMINAL_STATES, emptyState, normalizeState,
  normalizeInput, integrity, createProposal, markDelivered, markDeliveryFailed, parseDecision,
  decisionCandidate, recordDecision, transition, publicSnapshot };
