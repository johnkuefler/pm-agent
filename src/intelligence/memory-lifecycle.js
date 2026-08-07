'use strict';

const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CLASSES = new Set(['durable', 'snapshot', 'episodic']);
const DURABLE_KINDS = new Set(['preference', 'commitment', 'learning', 'opinion']);
const AUTONOMOUS_SOURCES = new Set(['research', 'idle-research', 'autonomous-research']);
const SNAPSHOT_PATTERN = /\b(as of|currently|today|this week|this month|status|blocked|on track|in progress|pending|scheduled|due|deadline|launch(?:es|ed|ing)?|forecast|remaining|hours?|percent|phase|milestone)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d+(?:\.\d+)?%\b/i;
const EXPLICIT_MEMORY_PATTERN = /\b(remember(?: that)?|do not forget|don't forget|keep in mind)\b/i;

const DEFAULT_MEMORY_POLICY = Object.freeze({
  working_days: 30,
  snapshot_expiry_days: 30,
  autonomous_daily_limit: 15,
  digest_max_items: 36,
  digest_max_chars: 6000,
  digest_per_project: 3,
  digest_general_items: 6,
  long_term_fallback_min_working_matches: 3,
  semantic_relevance_distance: 0.52,
  protected_salience: 0.75,
  protected_recall_count: 3,
});

function cleanDay(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function dayKey(now = new Date(), timeZone = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).format(now);
}

function memoryTimestamp(memory = {}) {
  for (const value of [memory.valid_from, memory.source_ref?.captured_at, memory.added]) {
    if (!value) continue;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

function memoryAgeDays(memory, now = new Date()) {
  const observed = memoryTimestamp(memory);
  if (!observed) return null;
  return Math.max(0, Math.floor((now.getTime() - observed.getTime()) / DAY_MS));
}

function inferMemoryRetentionClass(memory = {}) {
  if (RETENTION_CLASSES.has(memory.retention_class)) return memory.retention_class;
  if (memory.pinned === true || DURABLE_KINDS.has(memory.kind)) return 'durable';
  if (EXPLICIT_MEMORY_PATTERN.test(memory.source_ref?.quote || '')) return 'durable';
  if (memory.valid_until || memory.kind === 'inference') return 'snapshot';
  if (SNAPSHOT_PATTERN.test(memory.fact || '')) return 'snapshot';
  if (memory.kind === 'episode') return 'episodic';
  return 'durable';
}

function memoryIsProtected(memory = {}, policy = DEFAULT_MEMORY_POLICY) {
  if (memory.pinned === true || inferMemoryRetentionClass(memory) === 'durable') return true;
  if (Number(memory.verification_count) > 0 || memory.expectation_surprise) return true;
  if (Number(memory.salience) >= policy.protected_salience) return true;
  if (Number(memory.recall_count) >= policy.protected_recall_count) return true;
  if (Number(memory.social_weight) >= 0.7 || Number(memory.emotional_weight) >= 0.7) return true;
  return false;
}

function classifyMemoryTier(memory = {}, now = new Date(), policy = DEFAULT_MEMORY_POLICY) {
  if (memory.status && memory.status !== 'active') return 'archive';
  if (memory.valid_until && new Date(memory.valid_until).getTime() < now.getTime()) return 'archive';
  const age = memoryAgeDays(memory, now);
  return age === null || age <= policy.working_days ? 'working' : 'long_term';
}

function partitionMemory(memories = [], now = new Date(), policy = DEFAULT_MEMORY_POLICY) {
  const result = { working: [], long_term: [], archive: [] };
  for (const memory of memories) {
    const tier = classifyMemoryTier(memory, now, policy);
    result[tier].push({ ...memory, memory_tier: tier,
      retention_class: inferMemoryRetentionClass(memory) });
  }
  return result;
}

function planMemoryRetention(memories = [], now = new Date(), policy = DEFAULT_MEMORY_POLICY) {
  const updates = [];
  for (const memory of memories) {
    if (!memory?.id || (memory.status && memory.status !== 'active')) continue;
    const age = memoryAgeDays(memory, now);
    if (age === null || age <= policy.snapshot_expiry_days) continue;
    if (inferMemoryRetentionClass(memory) !== 'snapshot') continue;
    if (memoryIsProtected(memory, policy)) continue;
    updates.push({
      id: memory.id,
      status: 'expired',
      expired_at: now.toISOString(),
      retention_class: 'snapshot',
      expiration_reason: `point-in-time snapshot exceeded ${policy.snapshot_expiry_days} days`,
    });
  }
  return { updates, examined: memories.length };
}

function autonomousMemoryAdmission(memories = [], candidate = {}, now = new Date(),
  policy = DEFAULT_MEMORY_POLICY) {
  const source = String(candidate.source || '').trim().toLowerCase();
  if (!AUTONOMOUS_SOURCES.has(source)) return { allowed: true, used: 0,
    limit: policy.autonomous_daily_limit };
  const today = dayKey(now);
  const used = memories.filter(memory => AUTONOMOUS_SOURCES.has(
    String(memory.source || '').trim().toLowerCase()) && cleanDay(memory.added) === today).length;
  return { allowed: used < policy.autonomous_daily_limit, used,
    limit: policy.autonomous_daily_limit, retry_after: `${today}T23:59:59` };
}

function digestScore(memory, now, policy) {
  const age = memoryAgeDays(memory, now);
  const recency = age === null ? 0 : Math.max(0, policy.working_days - age);
  return recency + Number(memory.salience || 0) * 20
    + Math.min(Number(memory.recall_count) || 0, 10) * 2
    + Math.min(Number(memory.verification_count) || 0, 5) * 3
    + Number(memory.social_weight || 0) * 5
    + Number(memory.emotional_weight || 0) * 5
    + (inferMemoryRetentionClass(memory) === 'durable' ? 8 : 0);
}

function digestLine(memory) {
  const project = String(memory.project || '').trim();
  return { id: memory.id, project, fact: String(memory.fact || '').replace(/\s+/g, ' ').trim(),
    tier: memory.memory_tier, retention_class: inferMemoryRetentionClass(memory) };
}

function buildMemoryDigest(memories = [], now = new Date(), policy = DEFAULT_MEMORY_POLICY) {
  const partition = partitionMemory(memories, now, policy);
  const active = [...partition.working, ...partition.long_term]
    .filter(memory => memory.fact)
    .sort((left, right) => digestScore(right, now, policy) - digestScore(left, now, policy)
      || String(right.added || '').localeCompare(String(left.added || '')));
  const selected = [];
  const projectCounts = new Map();
  let generalCount = 0;
  for (const memory of active) {
    const project = String(memory.project || '').trim();
    if (!project) {
      if (generalCount >= policy.digest_general_items) continue;
      generalCount += 1;
    } else {
      const count = projectCounts.get(project) || 0;
      if (count >= policy.digest_per_project) continue;
      projectCounts.set(project, count + 1);
    }
    selected.push(digestLine(memory));
    if (selected.length >= policy.digest_max_items) break;
  }
  const grouped = new Map();
  for (const item of selected) {
    const heading = item.project || 'General';
    if (!grouped.has(heading)) grouped.set(heading, []);
    grouped.get(heading).push(item);
  }
  const sections = [];
  for (const [heading, items] of grouped) {
    sections.push(`## ${heading}\n${items.map(item => `- ${item.fact}`).join('\n')}`);
  }
  const generatedFor = dayKey(now);
  const heading = `[Daily memory digest for ${generatedFor}]\nRecent working memory is preferred. Older durable memory remains searchable when recent memory is insufficient.`;
  let text = [heading, ...sections].join('\n\n');
  if (text.length > policy.digest_max_chars) text = `${text.slice(0, policy.digest_max_chars - 4)}\n...`;
  const sourceIds = selected.map(item => item.id).filter(Boolean);
  return {
    version: 1,
    generated_for: generatedFor,
    generated_at: now.toISOString(),
    policy: { working_days: policy.working_days,
      snapshot_expiry_days: policy.snapshot_expiry_days,
      autonomous_daily_limit: policy.autonomous_daily_limit },
    counts: { total: memories.length, working: partition.working.length,
      long_term: partition.long_term.length, archive: partition.archive.length,
      selected: selected.length },
    source_ids: sourceIds,
    content_commitment: crypto.createHash('sha256').update(JSON.stringify(sourceIds)).digest('hex'),
    text,
  };
}

function selectTieredRecall(working = [], longTerm = [], limit = 8,
  policy = DEFAULT_MEMORY_POLICY) {
  const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 8));
  const relevantWorking = working.filter(item => Number.isFinite(Number(item.distance))
    ? Number(item.distance) <= policy.semantic_relevance_distance
    : Number(item._matched_terms) >= 2 || Number(item._score) >= 4);
  const useLongTerm = relevantWorking.length < policy.long_term_fallback_min_working_matches;
  const combined = useLongTerm ? [...working, ...longTerm.map(item => ({ ...item,
    _recall_mode: 'long_term_fallback' }))] : working;
  const seen = new Set();
  return combined.filter(item => {
    const key = item.id || item.fact;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => Number(right._score || 0) - Number(left._score || 0))
    .slice(0, boundedLimit);
}

function scoreMemoryRecallRows(rows = [], retrieval = {}) {
  return rows.map(memory => ({ ...memory,
    _score: (1 - (memory.distance ?? 1))
      + Number(memory.salience || 0) * Number(retrieval.salience_weight || 0)
      + Number(memory.emotional_weight || 0) * Number(retrieval.emotional_weight || 0)
      + Number(memory.social_weight || 0) * Number(retrieval.social_weight || 0)
      + Math.min(Number(memory.recall_count) || 0, Number(retrieval.recall_cap) || 0)
        * Number(retrieval.recall_weight || 0),
  })).sort((left, right) => right._score - left._score);
}

module.exports = {
  AUTONOMOUS_SOURCES,
  DEFAULT_MEMORY_POLICY,
  autonomousMemoryAdmission,
  buildMemoryDigest,
  classifyMemoryTier,
  dayKey,
  inferMemoryRetentionClass,
  memoryAgeDays,
  memoryIsProtected,
  partitionMemory,
  planMemoryRetention,
  scoreMemoryRecallRows,
  selectTieredRecall,
};
