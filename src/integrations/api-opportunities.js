'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'proposal_first',
  allowed_methods: ['GET'],
  allowed_auth_models: ['none'],
  prohibited_actions: ['account_signup', 'terms_acceptance', 'write_requests', 'payments', 'credential_storage'],
  max_response_chars: 12000,
  request_timeout_ms: 8000,
  maximum_installed_tools: 8,
  suspend_after_consecutive_failures: 3,
  retire_after_reviewed_uses: 5,
  retire_unhelpful_rate: 0.7,
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
  return { version: 2, policy: { ...DEFAULT_POLICY, ...(policy || {}) }, proposals: [], usage: [], decisions: [] };
}

function normalizeRegistry(value = {}) {
  const registry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 2,
    policy: { ...DEFAULT_POLICY, ...(registry.policy || {}) },
    proposals: Array.isArray(registry.proposals) ? registry.proposals.map(normalizeProposalRecord).filter(Boolean).slice(-500) : [],
    usage: Array.isArray(registry.usage) ? registry.usage.map(normalizeUsageRecord).filter(Boolean).slice(-1000) : [],
    decisions: Array.isArray(registry.decisions) ? registry.decisions.filter(item => item && item.id).slice(-1000) : [],
  };
}

function publicPolicy(registry = emptyRegistry()) {
  const current = normalizeRegistry(registry);
  return {
    policy: current.policy,
    proposal_count: current.proposals.length,
    approved_count: current.proposals.filter(item => item.status === 'approved').length,
    suspended_count: current.proposals.filter(item => item.status === 'suspended').length,
    retired_count: current.proposals.filter(item => item.status === 'retired').length,
    usage_count: current.usage.length,
    reviewed_usage_count: current.usage.filter(item => item.outcome).length,
  };
}

function assertSafePublicUrl(value, { allowPath = true } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('url must be valid'); }
  if (url.protocol !== 'https:') throw new Error('url must use https');
  if (url.username || url.password) throw new Error('url credentials are not allowed');
  const host = url.hostname;
  if (!host || BLOCKED_HOST_RE.test(host) || PRIVATE_HOST_RE.test(host)) throw new Error('url host is not allowed');
  if (!allowPath && (url.pathname !== '/' || url.search || url.hash)) throw new Error('base_url must be an origin only');
  url.hash = '';
  return url;
}

function privateAddress(address) {
  if (!address) return true;
  const normalized = String(address).toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return privateAddress(normalized.slice(7));
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertResolvedPublicUrl(value, { resolveDns = dns.lookup } = {}) {
  const url = assertSafePublicUrl(value);
  if (net.isIP(url.hostname)) {
    if (privateAddress(url.hostname)) throw new Error('url resolved to a private network');
    return url;
  }
  const rows = await resolveDns(url.hostname, { all: true });
  if (!rows?.length || rows.some(item => privateAddress(item.address))) throw new Error('url resolved to a private network');
  return url;
}

function normalizeToolSpec(input = {}, record = {}) {
  const rawName = normalizeText(input.name || record.name || 'public_api', 80).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const parameters = Array.isArray(input.query_parameters) ? input.query_parameters.slice(0, 16).map(item => {
    const name = normalizeText(item?.name, 80).replace(/[^a-zA-Z0-9_-]/g, '_');
    const type = ['string', 'number', 'boolean'].includes(item?.type) ? item.type : 'string';
    if (!name) throw new Error('each API tool query parameter requires a name');
    return { name, type, description: normalizeText(item.description || name, 300), required: item.required === true };
  }) : [];
  if (new Set(parameters.map(item => item.name)).size !== parameters.length) throw new Error('API tool query parameter names must be unique');
  return {
    name: (rawName.startsWith('public_api_') ? rawName : `public_api_${rawName || 'lookup'}`).slice(0, 64),
    description: normalizeText(input.description || record.use_case || 'Read public information from an approved API.', 700),
    path: normalizeText(input.path || record.sample_path || '/', 500) || '/',
    query_parameters: parameters,
  };
}

function proposalHealth(registry, proposal) {
  const uses = registry.usage.filter(item => item.proposal_id === proposal.id);
  const reviewed = uses.filter(item => item.outcome);
  const successful = uses.filter(item => item.ok).length;
  const durations = uses.map(item => Number(item.duration_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  return {
    calls: uses.length, successful_calls: successful,
    success_rate: uses.length ? successful / uses.length : null,
    reviewed_calls: reviewed.length,
    helpful: reviewed.filter(item => item.outcome === 'helpful').length,
    unhelpful: reviewed.filter(item => item.outcome === 'unhelpful').length,
    unclear: reviewed.filter(item => item.outcome === 'unclear').length,
    p95_duration_ms: p95,
    last_used_at: uses.at(-1)?.used_at || null,
  };
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
  const dataClassification = normalizeText(input.data_classification || 'public_only', 120);
  if (useCase.length < 30) throw new Error('use_case must explain the operational benefit');
  if (!current.policy.allowed_methods.includes(method)) throw new Error('only read-only GET APIs can be proposed for direct use');
  if (dataClassification !== 'public_only') throw new Error('direct API tools must be public_only');
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
    data_classification: dataClassification,
    use_case: useCase,
    tool: null,
    risk_notes: normalizeText(input.risk_notes || '', 1000),
    evidence: validateEvidence(input.evidence),
    proposed_by: normalizeText(input.proposed_by || 'Nora', 80),
    created_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  record.tool = normalizeToolSpec(input.tool || {}, record);
  record.proposal_commitment = commitment({
    id: record.id, name: record.name, base_url: record.base_url, auth_model: record.auth_model,
    method: record.method, use_case: record.use_case, evidence: record.evidence, tool: record.tool,
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
    tool: normalizeToolSpec(record.tool || {}, record),
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
  if (!['proposed', 'approved', 'suspended', 'retired'].includes(proposal.status)) throw new Error('this API cannot be approved');
  const installed = current.proposals.filter(item => item.status === 'approved' && item.id !== id).length;
  if (installed >= Number(current.policy.maximum_installed_tools || 8)) throw new Error('maximum installed API tools reached');
  if (current.proposals.some(item => item.id !== id && item.status === 'approved'
    && item.tool?.name === proposal.tool?.name)) throw new Error('an installed API tool already uses this name');
  proposal.status = 'approved';
  proposal.approved_by = normalizeText(approvedBy, 120) || 'John';
  proposal.approved_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  proposal.approval_commitment = commitment({ id, proposal_commitment: proposal.proposal_commitment, approved_by: proposal.approved_by });
  proposal.installed_at = proposal.approved_at;
  proposal.suspension_reason = null;
  proposal.retirement_reason = null;
  current.decisions.push({ id: `api-decision-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    proposal_id: id, decision: 'approved_and_installed', by: proposal.approved_by, at: proposal.approved_at,
    evidence: [{ type: 'proposal_commitment', id: proposal.proposal_commitment }] });
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

function retireProposal(registry = emptyRegistry(), id, { retiredBy = 'John', note = '', now = new Date() } = {}) {
  const current = normalizeRegistry(registry);
  const proposal = current.proposals.find(item => item.id === id);
  if (!proposal) throw new Error('api proposal not found');
  proposal.status = 'retired';
  proposal.retired_by = normalizeText(retiredBy, 120) || 'John';
  proposal.retired_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  proposal.retirement_reason = normalizeText(note || 'operator_retired', 500);
  current.decisions.push({ id: `api-decision-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    proposal_id: id, decision: 'retired', by: proposal.retired_by, at: proposal.retired_at,
    evidence: [{ type: 'proposal_commitment', id: proposal.proposal_commitment }] });
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
  purpose = '',
  surface = 'api_opportunity',
  interactionRef = null,
  fetchImpl = globalThis.fetch,
  resolveDns = dns.lookup,
  now = new Date(),
} = {}) {
  const current = normalizeRegistry(registry);
  const proposal = current.proposals.find(item => item.id === id);
  if (!proposal) throw new Error('api proposal not found');
  if (proposal.status !== 'approved') throw new Error('api proposal must be approved before use');
  if (proposal.auth_model !== 'none') throw new Error('this API requires human setup before direct use');
  if (proposal.method !== 'GET') throw new Error('only GET execution is supported');
  if (typeof fetchImpl !== 'function') throw new Error('API execution requires fetch');
  const url = await assertResolvedPublicUrl(buildExecutionUrl(proposal, { path, query }), { resolveDns });
  const started = Date.now();
  let response; let contentType = ''; let text = ''; let executionError = null;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual',
      headers: { Accept: 'application/json, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'Nora-PM-Agent/1.0' },
      signal: AbortSignal.timeout(Number(current.policy.request_timeout_ms) || 8000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error('approved API redirects are refused; approve the final origin explicitly');
    contentType = response.headers.get('content-type') || '';
    text = (await response.text()).slice(0, Number(current.policy.max_response_chars) || 12000);
  } catch (error) { executionError = normalizeText(error.message || 'request failed', 500); }
  const usage = {
    id: `api-use-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    proposal_id: proposal.id,
    url: url.toString(),
    status: response?.status || 0,
    ok: response?.ok === true && !executionError,
    content_type: contentType,
    response_chars: text.length,
    duration_ms: Date.now() - started,
    requester: normalizeText(requester, 80),
    purpose: normalizeText(purpose, 500),
    surface: normalizeText(surface, 80),
    interaction_ref: interactionRef ? normalizeText(interactionRef, 300) : null,
    error: executionError,
    used_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    usage_commitment: null,
  };
  usage.usage_commitment = commitment({ proposal_id: usage.proposal_id, url: usage.url, status: usage.status, response_chars: usage.response_chars });
  current.usage.push(usage);
  const recent = current.usage.filter(item => item.proposal_id === proposal.id).slice(-Number(current.policy.suspend_after_consecutive_failures || 3));
  if (recent.length >= Number(current.policy.suspend_after_consecutive_failures || 3) && recent.every(item => !item.ok)) {
    proposal.status = 'suspended'; proposal.suspended_at = usage.used_at;
    proposal.suspension_reason = `${recent.length} consecutive execution failures`;
    current.decisions.push({ id: `api-decision-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      proposal_id: proposal.id, decision: 'auto_suspended', by: 'reliability_policy', at: usage.used_at,
      evidence: recent.map(item => ({ type: 'api_usage', id: item.id })) });
  }
  return {
    registry: current,
    usage,
    response: {
      status: response?.status || 0,
      ok: response?.ok === true && !executionError,
      content_type: contentType,
      body_text: text,
      truncated: text.length >= (Number(current.policy.max_response_chars) || 12000),
      ...(executionError ? { error: executionError } : {}),
    },
  };
}

function recordUsageOutcome(registry = emptyRegistry(), usageId, input = {}, { now = new Date() } = {}) {
  const current = normalizeRegistry(registry);
  const usage = current.usage.find(item => item.id === usageId);
  if (!usage) throw new Error('api usage record not found');
  if (usage.outcome) throw new Error('api usage outcome is already recorded');
  const outcome = normalizeText(input.outcome, 40);
  if (!['helpful', 'unhelpful', 'unclear'].includes(outcome)) throw new Error('outcome must be helpful, unhelpful, or unclear');
  usage.outcome = outcome;
  usage.outcome_note = normalizeText(input.note, 700);
  usage.outcome_evidence = validateEvidence(input.evidence);
  usage.reviewed_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const proposal = current.proposals.find(item => item.id === usage.proposal_id);
  if (proposal && proposal.status === 'approved') {
    const health = proposalHealth(current, proposal);
    const threshold = Number(current.policy.retire_after_reviewed_uses || 5);
    const unhelpfulRate = health.reviewed_calls ? health.unhelpful / health.reviewed_calls : 0;
    if (health.reviewed_calls >= threshold && unhelpfulRate >= Number(current.policy.retire_unhelpful_rate || 0.7)) {
      proposal.status = 'retired'; proposal.retired_at = usage.reviewed_at;
      proposal.retired_by = 'usefulness_policy';
      proposal.retirement_reason = `unhelpful in ${health.unhelpful}/${health.reviewed_calls} reviewed uses`;
      current.decisions.push({ id: `api-decision-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
        proposal_id: proposal.id, decision: 'auto_retired', by: 'usefulness_policy', at: usage.reviewed_at,
        evidence: current.usage.filter(item => item.proposal_id === proposal.id && item.outcome).map(item => ({ type: 'api_usage_outcome', id: item.id })) });
    }
  }
  return { registry: current, usage, proposal, health: proposal ? proposalHealth(current, proposal) : null };
}

function toolBindings(registry = emptyRegistry(), execute, { maximum = null } = {}) {
  const current = normalizeRegistry(registry);
  const cap = Math.min(Number(maximum || current.policy.maximum_installed_tools || 8), 8);
  const tools = []; const executors = {}; const inventory = [];
  for (const proposal of current.proposals.filter(item => item.status === 'approved' && item.auth_model === 'none').slice(0, cap)) {
    const properties = { purpose: { type: 'string', description: 'Why this lookup is relevant to the current work.' } };
    const required = ['purpose'];
    for (const param of proposal.tool.query_parameters || []) {
      properties[param.name] = { type: param.type, description: param.description };
      if (param.required) required.push(param.name);
    }
    const definition = { name: proposal.tool.name,
      description: `[Approved public API: ${proposal.name}] ${proposal.tool.description} Public data only; never send client, team, private, financial, or credential data.`,
      input_schema: { type: 'object', properties, required, additionalProperties: false } };
    tools.push(definition);
    executors[definition.name] = args => {
      if (normalizeText(args?.purpose, 500).length < 10) throw new Error('approved API use requires a concrete purpose');
      return execute(proposal, args || {});
    };
    inventory.push({ proposal_id: proposal.id, name: proposal.name, tool: definition.name,
      capability: proposal.capability, health: proposalHealth(current, proposal) });
  }
  return { tools, executors, inventory };
}

module.exports = {
  DEFAULT_POLICY,
  assertResolvedPublicUrl,
  approveProposal,
  createProposal,
  emptyRegistry,
  executeApprovedGet,
  normalizeToolSpec,
  normalizeRegistry,
  publicPolicy,
  proposalHealth,
  recordUsageOutcome,
  rejectProposal,
  retireProposal,
  toolBindings,
};
