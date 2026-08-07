'use strict';

const { inferMemoryRetentionClass } = require('./memory-lifecycle');

const MEMORY_KINDS = new Set(['fact', 'inference', 'preference', 'commitment', 'opinion', 'learning', 'episode']);
const MEMORY_STATUSES = new Set(['active', 'superseded', 'disputed', 'expired']);
const EMOTIONAL_MEMORY_PATTERN = /\b(upset|angry|furious|frustrat|trust|relief|warmth|thank|thanks|appreciat|apolog|worried|concern|anxious|happy|excited|proud|hurt|disappoint|stress|overwhelm|urgent|crisis|escalat|missed|overdue|blocked)\b/i;
const SOCIAL_MEMORY_PATTERN = /\b(john|mallory|dawn|ali|andy|brandon|brande[e]?|elle|chelsea|teammate|client|prefers?|likes?|dislikes?|corrected|asked|told|said|wants?|needs?|relationship|communication|feedback|warmth|gift)\b/i;

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function inferMemoryKind(record = {}) {
  if (MEMORY_KINDS.has(record.kind)) return record.kind;
  if (record.source === 'opinion') return 'opinion';
  if (record.source === 'learning') return 'learning';
  if (/\b(prefers?|likes?|dislikes?|works best|communication style)\b/i.test(record.fact || '')) return 'preference';
  if (/\b(promised|committed|will follow up|owes?|agreed to)\b/i.test(record.fact || '')) return 'commitment';
  if (/\b(probably|likely|seems?|appears?|I think|may be)\b/i.test(record.fact || '')) return 'inference';
  return 'fact';
}

function normalizeSourceRef(sourceRef, fallback = {}) {
  const source = sourceRef && typeof sourceRef === 'object' ? sourceRef : {};
  const normalized = {
    channel: source.channel || fallback.channel || null,
    id: source.id || fallback.id || null,
    url: source.url || fallback.url || null,
    quote: source.quote ? String(source.quote).slice(0, 500) : null,
    captured_at: source.captured_at || fallback.captured_at || null,
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function inferEmotionalWeight(record = {}) {
  const fact = String(record.fact || '');
  const source = String(record.source || '').toLowerCase();
  const base = EMOTIONAL_MEMORY_PATTERN.test(fact) ? 0.55 : 0;
  if (/\b(furious|angry|crisis|urgent|escalat|overwhelmed|hurt|apolog)\b/i.test(fact)) return Math.max(base, 0.8);
  if (source === 'learning' || source === 'opinion') return Math.max(base, 0.35);
  return base;
}

function inferSocialWeight(record = {}) {
  const fact = String(record.fact || '');
  const source = String(record.source || '').toLowerCase();
  const sourceRef = normalizeSourceRef(record.source_ref);
  const channel = String(sourceRef?.channel || '').toLowerCase();
  let weight = SOCIAL_MEMORY_PATTERN.test(fact) ? 0.55 : 0;
  if (source === 'meeting' || channel.includes('meeting') || channel.includes('slack') || channel.includes('gmail')) weight = Math.max(weight, 0.45);
  if (/\b(prefers?|communication|corrected|feedback|relationship|trust|warmth|gift)\b/i.test(fact)) weight = Math.max(weight, 0.7);
  if (/\b(john|mallory|dawn|ali|andy|brandon|brande[e]?|elle|chelsea)\b/i.test(fact)) weight = Math.max(weight, 0.6);
  return weight;
}

function normalizeMemoryRecord(record, defaults = {}) {
  const kind = inferMemoryKind(record);
  const confidenceDefault = kind === 'inference' ? 0.6 : kind === 'preference' ? 0.75 : 0.85;
  const status = MEMORY_STATUSES.has(record.status) ? record.status : 'active';
  const sourceRef = normalizeSourceRef(record.source_ref, defaults.source_ref);
  return {
    ...record,
    kind,
    confidence: clamp(record.confidence ?? defaults.confidence ?? confidenceDefault),
    status,
    source_ref: sourceRef,
    valid_from: record.valid_from || defaults.valid_from || record.added || null,
    valid_until: record.valid_until || null,
    last_verified: record.last_verified || defaults.last_verified || null,
    verification_count: Math.max(0, Number(record.verification_count) || 0),
    supersedes: record.supersedes || null,
    contradicted_by: Array.isArray(record.contradicted_by) ? record.contradicted_by : [],
    sensitivity: record.sensitivity || 'normal',
    emotional_weight: clamp(record.emotional_weight ?? defaults.emotional_weight ?? inferEmotionalWeight({ ...record, source_ref: sourceRef })),
    social_weight: clamp(record.social_weight ?? defaults.social_weight ?? inferSocialWeight({ ...record, source_ref: sourceRef })),
    retention_class: inferMemoryRetentionClass({ ...record, kind }),
    pinned: record.pinned === true,
    expired_at: record.expired_at || null,
    expiration_reason: record.expiration_reason || null,
  };
}

function memoryIsActive(memory, now = new Date()) {
  if (!memory || (memory.status && memory.status !== 'active')) return false;
  if (memory.valid_until && new Date(memory.valid_until).getTime() < now.getTime()) return false;
  if (memory.valid_from && /^\d{4}-\d{2}-\d{2}T/.test(memory.valid_from) && new Date(memory.valid_from).getTime() > now.getTime()) return false;
  return true;
}

function memoryPromptLine(memory, now = new Date()) {
  const m = normalizeMemoryRecord(memory);
  const notes = [];
  if (m.kind === 'inference') notes.push('inference');
  if (m.kind === 'preference') notes.push('observed preference');
  if (m.confidence < 0.7) notes.push(`${Math.round(m.confidence * 100)}% confidence`);
  if (m.valid_until) notes.push(`valid until ${m.valid_until}`);
  if (m.status === 'disputed') notes.push('disputed—verify before using');
  if (m.social_weight >= 0.65) notes.push('socially weighted');
  if (m.emotional_weight >= 0.65) notes.push('emotionally weighted');
  if (m.last_verified) {
    const age = Math.floor((now.getTime() - new Date(m.last_verified).getTime()) / 86400000);
    if (age > 30) notes.push(`last verified ${age} days ago`);
  }
  return `- ${m.fact}${notes.length ? ` [${notes.join('; ')}]` : ''}`;
}

function normalizeCommitment(input = {}, now = new Date()) {
  const created = input.created || now.toISOString();
  return {
    id: input.id || `commit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    what: String(input.what || input.action || '').trim(),
    owner: String(input.owner || input.assignee || 'Nora').trim(),
    beneficiary: input.beneficiary ? String(input.beneficiary).trim() : null,
    due: input.due || null,
    project: input.project || null,
    status: ['open', 'fulfilled', 'renegotiated', 'dropped'].includes(input.status) ? input.status : 'open',
    created,
    updated: input.updated || created,
    evidence: normalizeSourceRef(input.evidence || input.source_ref),
    follow_up: input.follow_up !== false,
    next_check: input.next_check || input.due || null,
    last_checked: input.last_checked || null,
    fulfilled_at: input.fulfilled_at || null,
    resolution_evidence: normalizeSourceRef(input.resolution_evidence),
    notes: input.notes ? String(input.notes).slice(0, 1000) : '',
    task_id: input.task_id || null,
    episode_id: input.episode_id || null,
  };
}

module.exports = {
  MEMORY_KINDS,
  clamp,
  inferMemoryKind,
  inferEmotionalWeight,
  inferSocialWeight,
  memoryIsActive,
  memoryPromptLine,
  normalizeCommitment,
  normalizeMemoryRecord,
  normalizeSourceRef,
};
