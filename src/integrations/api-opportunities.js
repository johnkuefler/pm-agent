'use strict';

const crypto = require('crypto');

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'proposal_first',
  allowed_methods: ['GET'],
  allowed_auth_models: ['none'],
  prohibited_actions: ['account_signup', 'terms_acceptance', 'write_requests', 'payments', 'credential_storage'],
  max_response_chars: 12000,
  request_timeout_ms: 8000,
});

const BLOCKED_HOST_RE = /(^|\.)((localhost)|(localdomain))$/i;
const PRIVATE_HOST_RE = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

function normalizeText(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function commitment(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
}

function emptyRegistry(policy = DEFAULT_POLICY) {
  return { version: 1, policy: { ...DEFAULT_POLICY, ...(policy || {}) }, proposals: [], usage: [] };
}

function normalizeRegistry(value = {}) {
  const registry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    policy: { ...DEFAULT_POLICY, ...(registry.policy || {}) },
    proposals: Array.isArray(registry.proposals) ? registry.proposals.map(normalizeProposalRecord).filter(Boolean).slice(-500) : [],
    usage: Array.isArray(registry.usage) ? registry.usage.map(normalizeUsageRecord).filter(Boolean).slice(-1000) : [],
  };
}

function publicPolicy(registry = emptyRegistry()) {
  const current = normalizeRegistry(registry);
  return {
    policy: current.policy,
    proposal_count: current.proposals.length,
    approved_count: current.proposals.filter(item => item.status === 'approved').length,
    usage_count: current.usage.length,
  };
}

function assertSafePublicUrl(value, { allowPath = true } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('url must be valid'); }
  if (url.protocol !== 'https:') throw new Error('url must use https');
  const host = url.hostname;
  if (!host || BLOCKED_HOST_RE.test(host) || PRIVATE_HOST_RE.test(host)) throw new Error('url host is not allowed');
  if (!allowPath && (url.pathname !== '/' || url.search || url.hash)) throw new Error('base_url must be an origin only');
  url.hash = '';
  return url;
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) {
    throw new Error('api proposals require one to eight evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    if (!type || (!id && !url)) throw new Error('each evidence reference requires type and id or url');
    return { type, ...(id ? { id } : {}), ...(url ? { url } : {}) };
  });
}

function normalizeAuthModel(value) {
  const model = normalizeText(value || 'none', 80).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return model || 'none';
}

function createProposal(input = {}, registry = emptyRegistry(), { now = new Date() } = {}) {
  const current = normalizeRegistry(registry);
  const name = normalizeText(input.name, 160);
  if (!name) throw new Error('name is required');
  const baseUrl = assertSafePublicUrl(input.base_url, { allowPath: false });
  const authModel = normalizeAuthModel(input.auth_model);
  const method = normalizeText(input.method || 'GET', 12).toUpperCase();
  const useCase = normalizeText(input.use_case, 1000);
  if (useCase.length < 30) throw new Error('use_case must explain the operational benefit');
  if (!current.policy.allowed_methods.includes(method)) throw new Error('only read-only GET APIs can be proposed for direct use');
  const requiresHumanSetup = authModel !== 'none';
  const id = input.id ? normalizeText(input.id, 120) : `api-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.proposals.some(item => item.id === id)) throw new Error('api proposal id already exists');
  const record = {
    id,
    status: 'proposed',
    name,
    provider: normalizeText(input.provider || name, 160),
    base_url: baseUrl.origin,
    sample_path: normalizeText(input.sample_path || '/', 500) || '/',
    method,
    auth_model: authModel,
    requires_human_setup: requiresHumanSetup,
    pricing: normalizeText(input.pricing || 'free_or_free_tier', 200),
    docs_url: input.docs_url ? assertSafePublicUrl(input.docs_url).toString() : null,
    terms_url: input.terms_url ? assertSafePublicUrl(input.terms_url).toString() : null,
    capability: normalizeText(input.capability || 'research', 120),
    data_classification: normalizeText(input.data_classification || 'public_only', 120),
    use_case: useCase,
    risk_notes: normalizeText(input.risk_notes || '', 1000),
    evidence: validateEvidence(input.evidence),
    proposed_by: normalizeText(input.proposed_by || 'Nora', 80),
    created_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  record.proposal_commitment = commitment({
    id: record.id, name: record.name, base_url: record.base_url, auth_model: record.auth_model,
    method: record.method, use_case: record.use_case, evidence: record.evidence,
  });
  current.proposals.push(record);
  return { registry: current, proposal: record, policy: publicPolicy(current) };
}

function normalizeProposalRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    status: normalizeText(record.status, 40) || 'proposed',
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function normalizeUsageRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return record;
}

function approveProposal(registry = emptyRegistry(), id, { approvedBy = 'John', now = new Date() } = {}) {
  const current = normalizeRegistry(registry);
  const proposal = current.proposals.find(item => item.id === id);
  if (!proposal) throw new Error('api proposal not found');
  if (!['proposed', 'approved'].includes(proposal.status)) throw new Error('only proposed APIs can be approved');
  proposal.status = 'approved';
  proposal.approved_by = normalizeText(approvedBy, 120) || 'John';
  proposal.approved_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  proposal.approval_commitment = commitment({ id, proposal_commitment: proposal.proposal_commitment, approved_by: proposal.approved_by });
  return { registry: current, proposal, policy: publicPolicy(current) };
}

function rejectProposal(registry = emptyRegistry(), id, { rejectedBy = 'John', note = '', now = new Date() } = {}) {
  const current = normalizeRegistry(registry);
  const proposal = current.proposals.find(item => item.id === id);
  if (!proposal) throw new Error('api proposal not found');
  proposal.status = 'rejected';
  proposal.rejected_by = normalizeText(rejectedBy, 120) || 'John';
  proposal.rejected_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  proposal.rejection_note = normalizeText(note, 500);
  return { registry: current, proposal, policy: publicPolicy(current) };
}

function buildExecutionUrl(proposal, { path = '', query = {} } = {}) {
  const base = assertSafePublicUrl(proposal.base_url, { allowPath: false });
  const rawPath = normalizeText(path || proposal.sample_path || '/', 1000);
  if (/^https?:\/\//i.test(rawPath)) {
    const candidate = assertSafePublicUrl(rawPath);
    if (candidate.origin !== base.origin) throw new Error('execution url must stay within the approved API origin');
    return candidate;
  }
  if (!rawPath.startsWith('/')) throw new Error('path must start with /');
  const url = new URL(rawPath, base.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(normalizeText(key, 80), normalizeText(value, 500));
  }
  return assertSafePublicUrl(url.toString());
}

async function executeApprovedGet(registry = emptyRegistry(), id, {
  path = '',
  query = {},
  requester = 'Nora',
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const current = normalizeRegistry(registry);
  const proposal = current.proposals.find(item => item.id === id);
  if (!proposal) throw new Error('api proposal not found');
  if (proposal.status !== 'approved') throw new Error('api proposal must be approved before use');
  if (proposal.auth_model !== 'none') throw new Error('this API requires human setup before direct use');
  if (proposal.method !== 'GET') throw new Error('only GET execution is supported');
  if (typeof fetchImpl !== 'function') throw new Error('API execution requires fetch');
  const url = buildExecutionUrl(proposal, { path, query });
  const started = Date.now();
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'Nora-PM-Agent/1.0' },
    signal: AbortSignal.timeout(Number(current.policy.request_timeout_ms) || 8000),
  });
  const contentType = response.headers.get('content-type') || '';
  const text = (await response.text()).slice(0, Number(current.policy.max_response_chars) || 12000);
  const usage = {
    id: `api-use-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    proposal_id: proposal.id,
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    content_type: contentType,
    response_chars: text.length,
    duration_ms: Date.now() - started,
    requester: normalizeText(requester, 80),
    used_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    usage_commitment: null,
  };
  usage.usage_commitment = commitment({ proposal_id: usage.proposal_id, url: usage.url, status: usage.status, response_chars: usage.response_chars });
  current.usage.push(usage);
  return {
    registry: current,
    usage,
    response: {
      status: response.status,
      ok: response.ok,
      content_type: contentType,
      body_text: text,
      truncated: text.length >= (Number(current.policy.max_response_chars) || 12000),
    },
  };
}

module.exports = {
  DEFAULT_POLICY,
  approveProposal,
  createProposal,
  emptyRegistry,
  executeApprovedGet,
  normalizeRegistry,
  publicPolicy,
  rejectProposal,
};
