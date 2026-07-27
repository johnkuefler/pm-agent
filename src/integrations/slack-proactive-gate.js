'use strict';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'being', 'but',
  'can', 'could', 'did', 'does', 'for', 'from', 'have', 'here', 'how', 'into', 'its',
  'just', 'like', 'more', 'need', 'our', 'please', 'should', 'that', 'the', 'their',
  'there', 'they', 'this', 'those', 'through', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would', 'you', 'your',
]);
const LOW_SIGNAL_WORDS = new Set([
  'blocker', 'deadline', 'due', 'issue', 'meeting', 'milestone', 'project', 'status',
  'task', 'team', 'update', 'work',
]);
const PROACTIVE_CUE = /(?:\?|^\s*(?:can|could|do|does|did|has|have|how|is|should|what|when|where|which|who|why|will|would)\b|\b(?:blocked|blocker|deadline|decision|due|incident|launch|overdue|risk|ship|slip|wrong)\b)/i;

function clamp01(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function tokens(value) {
  return [...new Set(String(value || '').toLowerCase()
    .replace(/<@[a-z0-9]+>/gi, ' ')
    .match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])]
    .filter(token => !STOP_WORDS.has(token));
}

function sourceRecords(memories = [], projects = []) {
  const records = [];
  for (const memory of Array.isArray(memories) ? memories : []) {
    const summary = String(memory?.fact || '').replace(/\s+/g, ' ').trim();
    if (!summary) continue;
    records.push({
      kind: 'memory',
      id: String(memory.id || memory.source_external_id || memory.source_bot_id || '').slice(0, 160)
        || `memory-${records.length + 1}`,
      project: String(memory.project || '').trim().slice(0, 160),
      summary: summary.slice(0, 320),
      date: memory.added || memory.created || null,
    });
  }
  for (const project of Array.isArray(projects) ? projects : []) {
    const name = String(project?.name || '').replace(/\s+/g, ' ').trim();
    const details = String(project?.details || '').replace(/\s+/g, ' ').trim();
    if (!name && !details) continue;
    records.push({
      kind: 'project',
      id: name.slice(0, 160) || `project-${records.length + 1}`,
      project: name.slice(0, 160),
      summary: `${name}${name && details ? ': ' : ''}${details}`.slice(0, 320),
      date: project.last_activity || project.created || null,
    });
  }
  return records;
}

function evidenceScore(messageTokens, messageText, record) {
  const recordTokens = new Set(tokens(`${record.project} ${record.summary}`));
  let score = 0;
  let distinctiveOverlap = 0;
  for (const token of messageTokens) {
    if (!recordTokens.has(token)) continue;
    if (LOW_SIGNAL_WORDS.has(token)) score += 0.25;
    else {
      distinctiveOverlap += 1;
      score += token.length >= 7 ? 2 : token.length >= 5 ? 1.5 : 1;
    }
  }
  const project = String(record.project || '').toLowerCase();
  if (project.length >= 3 && String(messageText || '').toLowerCase().includes(project)) {
    score += 5;
    distinctiveOverlap += 1;
  }
  const dated = /\b(?:20\d{2}-\d{2}-\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}:\d{2}|\d+(?:\.\d+)?%)\b/i
    .test(record.summary);
  const operational = /\b(?:approved|assigned|blocked|completed|deadline|decided|due|launch|owner|scheduled|status)\b/i
    .test(record.summary);
  if (dated) score += 0.5;
  if (operational) score += 0.35;
  return { score, distinctiveOverlap, dated, operational };
}

function selectProactiveEvidence(message, {
  memories = [], projects = [], limit = 6,
} = {}) {
  const text = String(message || '').trim();
  if (!text || !PROACTIVE_CUE.test(text)) return [];
  const messageTokens = tokens(text);
  if (!messageTokens.length) return [];
  return sourceRecords(memories, projects)
    .map(record => ({ ...record, ...evidenceScore(messageTokens, text, record) }))
    .filter(record => record.score >= 1.5
      && (record.distinctiveOverlap > 0
        || (record.dated && record.operational && record.score >= 2)))
    .sort((left, right) => right.score - left.score
      || String(right.date || '').localeCompare(String(left.date || ''))
      || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 6)))
    .map((record, index) => ({
      index: index + 1,
      kind: record.kind,
      id: record.id,
      project: record.project || null,
      summary: record.summary,
      score: Number(record.score.toFixed(2)),
    }));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
}

function normalizeProactiveDecision(raw, evidence = []) {
  const parsed = parseJsonObject(raw);
  const rejected = reason => ({
    engage: false,
    confidence: 0,
    value: 0,
    urgency: 0,
    interruption_cost: 1,
    evidence_indexes: [],
    evidence_refs: [],
    reason,
  });
  if (!parsed) return rejected('invalid_gate_response');
  const indexes = [...new Set((Array.isArray(parsed.evidence_indexes)
    ? parsed.evidence_indexes : []).map(Number).filter(Number.isInteger))];
  const byIndex = new Map(evidence.map(item => [item.index, item]));
  if (!indexes.length || indexes.some(index => !byIndex.has(index))) {
    return rejected('uncited_or_invalid_evidence');
  }
  const confidence = clamp01(parsed.confidence, 0);
  const value = clamp01(parsed.value, 0);
  const urgency = clamp01(parsed.urgency, 0.35);
  const interruptionCost = clamp01(parsed.interruption_cost, 0.6);
  const engage = parsed.engage === true && confidence >= 0.65 && value >= 0.5;
  return {
    engage,
    confidence,
    value,
    urgency,
    interruption_cost: interruptionCost,
    evidence_indexes: engage ? indexes : [],
    evidence_refs: engage ? indexes.map(index => {
      const item = byIndex.get(index);
      return { type: item.kind, id: item.id };
    }) : [],
    reason: String(parsed.reason || (engage ? 'evidence_backed_interjection' : 'gate_declined'))
      .replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

module.exports = {
  PROACTIVE_CUE,
  normalizeProactiveDecision,
  selectProactiveEvidence,
  tokens,
};
