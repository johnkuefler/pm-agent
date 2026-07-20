'use strict';

const crypto = require('crypto');

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'proposal_only',
  currency: 'USD',
  monthly_budget_cents: 10000,
  per_gift_limit_cents: 2500,
  requires_approval_over_cents: 1500,
  auto_send_enabled: false,
  recipient_scope: 'internal_team_first',
  allowed_reasons: ['thanks', 'congratulations', 'support', 'milestone', 'repair'],
  blocked_reasons: ['persuasion', 'pressure', 'romance_or_intimacy', 'hr_sensitive'],
  goody_environment: 'sandbox',
});

const GOODY_BASE_URLS = Object.freeze({
  production: 'https://api.ongoody.com',
  sandbox: 'https://api.sandbox.ongoody.com',
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function emptyLedger(policy = DEFAULT_POLICY) {
  return { version: 1, policy: { ...DEFAULT_POLICY, ...(policy || {}) }, intents: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    policy: { ...DEFAULT_POLICY, ...(ledger.policy || {}) },
    intents: Array.isArray(ledger.intents) ? ledger.intents.map(normalizeIntentRecord).filter(Boolean).slice(-500) : [],
  };
}

function normalizeText(value, max = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) {
    throw new Error('gift intents require one to eight evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    if (!type || (!id && !url)) throw new Error('each gift evidence reference requires type and id or url');
    return {
      type,
      ...(id ? { id } : {}),
      ...(url ? { url } : {}),
      ...(item?.note ? { note: normalizeText(item.note, 300) } : {}),
    };
  });
}

function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeReasonCategory(value) {
  return normalizeText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function policyReport(ledger = emptyLedger(), { now = new Date() } = {}) {
  const normalized = normalizeLedger(ledger);
  const key = monthKey(now);
  const spent = normalized.intents
    .filter(item => monthKey(item.created_at) === key && ['approved', 'sent'].includes(item.status))
    .reduce((sum, item) => sum + (Number(item.amount_cents) || 0), 0);
  return {
    policy: normalized.policy,
    month: key,
    approved_or_sent_cents: spent,
    remaining_cents: Math.max(0, Number(normalized.policy.monthly_budget_cents) - spent),
    proposal_only: normalized.policy.mode === 'proposal_only' || normalized.policy.auto_send_enabled !== true,
    goody_configured: Boolean(process.env.GOODY_API_KEY),
    goody_send_enabled: process.env.GOODY_SEND_ENABLED === 'true',
  };
}

function validateIntentInput(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const policy = current.policy;
  const recipientName = normalizeText(input.recipient_name, 120);
  if (!recipientName) throw new Error('recipient_name is required');
  const amountCents = Math.round(Number(input.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents < 100) throw new Error('amount_cents must be at least 100');
  if (amountCents > Number(policy.per_gift_limit_cents)) throw new Error('gift exceeds per-gift limit');
  const reasonCategory = normalizeReasonCategory(input.reason_category || input.reason);
  if (!policy.allowed_reasons.includes(reasonCategory)) throw new Error('gift reason_category is not allowed by policy');
  if (policy.blocked_reasons.includes(reasonCategory)) throw new Error('gift reason_category is blocked by policy');
  const reason = normalizeText(input.reason, 700);
  if (reason.length < 20) throw new Error('gift reason must be specific and evidence-grounded');
  const report = policyReport(current, { now });
  if (amountCents > report.remaining_cents) throw new Error('gift would exceed monthly budget');
  const evidence = normalizeEvidence(input.evidence);
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const body = {
    recipient_name: recipientName,
    ...(input.recipient_email ? { recipient_email: normalizeText(input.recipient_email, 240) } : {}),
    ...(input.recipient_slack_user_id ? { recipient_slack_user_id: normalizeText(input.recipient_slack_user_id, 80) } : {}),
    reason_category: reasonCategory,
    reason,
    amount_cents: amountCents,
    currency: policy.currency,
    suggested_gift: normalizeText(input.suggested_gift || 'Goody gift of choice', 200),
    card_message: normalizeText(input.card_message, 600),
    evidence,
    created_by: normalizeText(input.created_by || 'Nora', 80),
    created_at: createdAt,
  };
  if (!body.recipient_email && !body.recipient_slack_user_id) {
    body.delivery_contact_required = true;
  }
  return body;
}

function intentPayload(record) {
  return {
    id: record.id,
    recipient_name: record.recipient_name,
    recipient_email: record.recipient_email || null,
    recipient_slack_user_id: record.recipient_slack_user_id || null,
    reason_category: record.reason_category,
    reason: record.reason,
    amount_cents: record.amount_cents,
    currency: record.currency,
    suggested_gift: record.suggested_gift,
    card_message: record.card_message || '',
    evidence: record.evidence,
    created_by: record.created_by,
    created_at: record.created_at,
    status: record.status,
  };
}

function normalizeIntentRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    status: normalizeText(record.status, 40) || 'proposed',
    amount_cents: Math.round(Number(record.amount_cents) || 0),
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function createIntent(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const body = validateIntentInput(input, current, { now });
  const id = input.id ? normalizeText(input.id, 120) : `gift-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.intents.some(item => item.id === id)) throw new Error('gift intent id already exists');
  const requiresApproval = current.policy.mode === 'proposal_only'
    || current.policy.auto_send_enabled !== true
    || body.amount_cents > Number(current.policy.requires_approval_over_cents);
  const record = {
    id,
    ...body,
    status: 'proposed',
    requires_approval: requiresApproval,
    goody_send_enabled_at_creation: process.env.GOODY_SEND_ENABLED === 'true',
    request_commitment: null,
  };
  record.request_commitment = commitment(intentPayload(record));
  current.intents.push(record);
  current.intents = current.intents.slice(-500);
  return { ledger: current, intent: record, report: policyReport(current, { now }) };
}

function approveIntent(ledger = emptyLedger(), id, { approvedBy = 'John', now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (!['proposed', 'approved'].includes(intent.status)) throw new Error('only proposed gift intents can be approved');
  const alreadyApproved = intent.status === 'approved';
  const report = policyReport(current, { now });
  if (!alreadyApproved && intent.amount_cents > report.remaining_cents) throw new Error('approving this gift would exceed monthly budget');
  if (alreadyApproved) return { ledger: current, intent, report };
  intent.status = 'approved';
  intent.approved_by = normalizeText(approvedBy, 120) || 'John';
  intent.approved_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.approval_commitment = commitment({
    id: intent.id, request_commitment: intent.request_commitment,
    approved_by: intent.approved_by, approved_at: intent.approved_at,
  });
  return { ledger: current, intent, report: policyReport(current, { now }) };
}

function rejectIntent(ledger = emptyLedger(), id, { rejectedBy = 'John', note = '', now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (intent.status === 'sent') throw new Error('sent gift intents cannot be rejected');
  intent.status = 'rejected';
  intent.rejected_by = normalizeText(rejectedBy, 120) || 'John';
  intent.rejected_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.rejection_note = normalizeText(note, 500);
  return { ledger: current, intent, report: policyReport(current, { now }) };
}

function sendReadiness(ledger = emptyLedger(), id) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (intent.status !== 'approved') return { ready: false, reason: 'gift intent must be approved before send' };
  if (process.env.GOODY_SEND_ENABLED !== 'true') return { ready: false, reason: 'GOODY_SEND_ENABLED is not true' };
  if (!process.env.GOODY_API_KEY) return { ready: false, reason: 'GOODY_API_KEY is not configured' };
  return { ready: true, base_url: GOODY_BASE_URLS[current.policy.goody_environment] || GOODY_BASE_URLS.sandbox };
}

module.exports = {
  DEFAULT_POLICY,
  GOODY_BASE_URLS,
  approveIntent,
  commitment,
  createIntent,
  emptyLedger,
  normalizeLedger,
  policyReport,
  rejectIntent,
  sendReadiness,
  validateIntentInput,
};
