'use strict';

const crypto = require('crypto');

const STANCES = Object.freeze(['observed', 'inferred', 'assumption', 'uncertain']);
const STATUSES = Object.freeze(['open', 'verified', 'contradicted', 'unclear', 'superseded', 'retired']);
const DOMAINS = Object.freeze(['project', 'person', 'deadline', 'client', 'connector', 'self_operation', 'general']);

function normalizeText(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
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
  return { version: 1, claims: [], resolutions: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    claims: Array.isArray(ledger.claims) ? ledger.claims.map(normalizeClaim).filter(Boolean).slice(-1000) : [],
    resolutions: Array.isArray(ledger.resolutions) ? ledger.resolutions.map(normalizeResolution).filter(Boolean).slice(-1000) : [],
  };
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 12) {
    throw new Error('epistemic claims require one to twelve evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    const note = normalizeText(item?.note, 300);
    if (!type || (!id && !url)) throw new Error('each evidence reference requires type and id or url');
    return { type, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(note ? { note } : {}) };
  });
}

function clampConfidence(value, stance) {
  const number = Number(value);
  const confidence = Number.isFinite(number) ? Math.min(0.99, Math.max(0.01, number)) : defaultConfidence(stance);
  if (stance === 'assumption' && confidence > 0.55) throw new Error('assumptions must stay at or below 0.55 confidence');
  if (stance === 'uncertain' && confidence > 0.65) throw new Error('uncertain claims must stay at or below 0.65 confidence');
  return Number(confidence.toFixed(3));
}

function defaultConfidence(stance) {
  if (stance === 'observed') return 0.8;
  if (stance === 'inferred') return 0.6;
  if (stance === 'assumption') return 0.45;
  return 0.5;
}

function normalizeStance(value) {
  const stance = normalizeText(value || 'uncertain', 40).toLowerCase();
  if (!STANCES.includes(stance)) throw new Error(`stance must be one of: ${STANCES.join(', ')}`);
  return stance;
}

function normalizeStatus(value) {
  const status = normalizeText(value || 'open', 40).toLowerCase();
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
  return status;
}

function normalizeDomain(value) {
  const domain = normalizeText(value || 'general', 80).toLowerCase();
  return DOMAINS.includes(domain) ? domain : 'general';
}

function normalizeClaim(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    status: normalizeStatus(record.status || 'open'),
    stance: STANCES.includes(record.stance) ? record.stance : 'uncertain',
    domain: normalizeDomain(record.domain),
    confidence: clampConfidence(record.confidence, STANCES.includes(record.stance) ? record.stance : 'uncertain'),
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function normalizeResolution(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.claim_id) return null;
  return { ...record, outcome: normalizeStatus(record.outcome || 'unclear') };
}

function createClaim(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const statement = normalizeText(input.statement, 1200);
  if (statement.length < 12) throw new Error('statement must be specific');
  const stance = normalizeStance(input.stance);
  const evidence = normalizeEvidence(input.evidence);
  const falsifier = normalizeText(input.falsifier, 700);
  if (!falsifier) throw new Error('falsifier is required');
  const id = input.id ? normalizeText(input.id, 120) : `ep-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.claims.some(item => item.id === id)) throw new Error('epistemic claim id already exists');
  const claim = {
    id,
    status: 'open',
    statement,
    stance,
    confidence: clampConfidence(input.confidence, stance),
    domain: normalizeDomain(input.domain),
    subject_ref: normalizeText(input.subject_ref, 300),
    rationale: normalizeText(input.rationale, 1000),
    falsifier,
    evidence,
    created_by: normalizeText(input.created_by || 'Nora', 80),
    created_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  claim.claim_commitment = commitment({
    id: claim.id,
    statement: claim.statement,
    stance: claim.stance,
    confidence: claim.confidence,
    evidence: claim.evidence,
    falsifier: claim.falsifier,
  });
  current.claims.push(claim);
  return { ledger: current, claim, report: report(current) };
}

function resolveClaim(ledger = emptyLedger(), id, input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const claim = current.claims.find(item => item.id === id);
  if (!claim) throw new Error('epistemic claim not found');
  const outcome = normalizeStatus(input.outcome || input.status);
  if (!['verified', 'contradicted', 'unclear', 'superseded', 'retired'].includes(outcome)) {
    throw new Error('resolution outcome must be verified, contradicted, unclear, superseded, or retired');
  }
  const evidence = normalizeEvidence(input.evidence);
  const resolution = {
    id: `ep-res-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    claim_id: claim.id,
    outcome,
    observed: normalizeText(input.observed, 1200),
    evidence,
    resolved_by: normalizeText(input.resolved_by || 'Nora', 80),
    resolved_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  if (!resolution.observed) throw new Error('observed resolution summary is required');
  resolution.resolution_commitment = commitment({
    claim_id: claim.id,
    claim_commitment: claim.claim_commitment,
    outcome,
    observed: resolution.observed,
    evidence,
  });
  claim.status = outcome;
  claim.resolved_at = resolution.resolved_at;
  claim.resolution_id = resolution.id;
  claim.resolution_commitment = resolution.resolution_commitment;
  if (outcome === 'verified') claim.confidence = Math.max(claim.confidence, 0.8);
  if (outcome === 'contradicted') claim.confidence = Math.min(claim.confidence, 0.2);
  current.resolutions.push(resolution);
  return { ledger: current, claim, resolution, report: report(current) };
}

function report(ledger = emptyLedger()) {
  const current = normalizeLedger(ledger);
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  for (const claim of current.claims) counts[claim.status] = (counts[claim.status] || 0) + 1;
  const open = current.claims.filter(item => item.status === 'open');
  return {
    total_claims: current.claims.length,
    total_resolutions: current.resolutions.length,
    counts,
    open_uncertain: open.filter(item => ['uncertain', 'assumption'].includes(item.stance)).length,
    open_high_confidence: open.filter(item => item.confidence >= 0.75).length,
  };
}

module.exports = {
  DOMAINS,
  STANCES,
  STATUSES,
  createClaim,
  emptyLedger,
  normalizeLedger,
  report,
  resolveClaim,
};
