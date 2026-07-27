'use strict';

// A repeated observation should not read like a first one.
//
// Nora reported the same coverage bug five times. The fifth report was, word for word, as calm and
// as easy to skim past as the first, so it sat. Meanwhile a checkpoint retried 8,376 times and a
// deploy queue backed up for four days. All three were visible the entire time. None of them got
// louder, because nothing in the system could tell the difference between noticing something once
// and noticing it for the fifth day running.
//
// This is the missing primitive: a finding is keyed, so repeats collapse onto one record and
// accumulate rather than scrolling past as fresh news. Past a threshold it escalates, and an
// escalated finding is surfaced back into her prompt so she leads with it and says how long it has
// been going on. The count is the point. "I have raised this five times" is a different sentence
// from "I noticed something", and it is the one that gets acted on.
//
// Deliberately not an alerting system. It changes what she says, not who gets paged.

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
// Twice is a coincidence worth noting quietly. Three times is a pattern she should lead with.
const ESCALATE_AFTER_OCCURRENCES = 3;
// A finding nobody has re-observed in a week has either been fixed or stopped mattering. Ageing it
// out keeps the escalated list short enough that being on it still means something.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 200;
const MAX_HISTORY_PER_FINDING = 20;

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 120);
}

function commitment(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function severityRank(severity) {
  return { blocker: 3, degraded: 2, annoyance: 1 }[String(severity || '').toLowerCase()] || 1;
}

// One observation. Repeats of the same key accumulate onto the existing record instead of creating
// a new one, which is the entire mechanism: the count cannot grow if every report is a fresh row.
function recordFinding(findings, input = {}, now = new Date()) {
  const key = normalizeKey(input.key);
  if (!key) throw new Error('a finding requires a stable key so repeats can accumulate');
  const summary = String(input.summary || '').trim().slice(0, 500);
  if (!summary) throw new Error('a finding requires a summary');
  const at = now.toISOString();
  const list = Array.isArray(findings) ? findings.slice() : [];
  const index = list.findIndex(item => item.key === key);

  if (index === -1) {
    const record = {
      protocol_version: PROTOCOL_VERSION,
      key,
      summary,
      severity: String(input.severity || 'annoyance').toLowerCase(),
      surface: String(input.surface || 'unknown').slice(0, 60),
      evidence: String(input.evidence || '').slice(0, 1000),
      occurrences: 1,
      first_seen: at,
      last_seen: at,
      status: 'open',
      escalated: false,
      acknowledged_at: null,
      resolved_at: null,
      history: [{ at, summary_commitment: commitment(summary) }],
    };
    list.push(record);
    return { findings: list.slice(-MAX_FINDINGS), record, escalated_now: false };
  }

  const existing = list[index];
  // A resolved finding that comes back is not a new problem, it is a regression, and the original
  // count travels with it. Losing that history is how a recurring fault reads as first-time news.
  const reopened = existing.status === 'resolved';
  const occurrences = existing.occurrences + 1;
  const escalated = occurrences >= ESCALATE_AFTER_OCCURRENCES;
  const record = {
    ...existing,
    summary,
    severity: severityRank(input.severity) > severityRank(existing.severity)
      ? String(input.severity).toLowerCase() : existing.severity,
    evidence: String(input.evidence || existing.evidence || '').slice(0, 1000),
    occurrences,
    last_seen: at,
    status: 'open',
    escalated,
    resolved_at: null,
    // Re-reporting after someone said they had it clears the acknowledgement. It plainly was not
    // handled, and a stale acknowledgement would keep her quiet about a live problem.
    acknowledged_at: reopened ? null : existing.acknowledged_at,
    reopened_at: reopened ? at : existing.reopened_at || null,
    history: [...(existing.history || []), { at, summary_commitment: commitment(summary) }]
      .slice(-MAX_HISTORY_PER_FINDING),
  };
  list[index] = record;
  return { findings: list, record, escalated_now: escalated && !existing.escalated };
}

function resolveFinding(findings, key, { at = new Date(), by = 'unknown', note = '' } = {}) {
  const normalized = normalizeKey(key);
  const list = Array.isArray(findings) ? findings.slice() : [];
  const index = list.findIndex(item => item.key === normalized);
  if (index === -1) return { findings: list, record: null };
  const record = { ...list[index], status: 'resolved', escalated: false,
    resolved_at: at.toISOString(), resolved_by: String(by).slice(0, 120),
    resolution_note: String(note).slice(0, 500) };
  list[index] = record;
  return { findings: list, record };
}

// Acknowledging is not resolving. It quiets a finding for one reporting cycle so she does not
// repeat herself at someone who has already heard it, but the count keeps climbing and it comes
// back loudly if the condition is still there next time.
function acknowledgeFinding(findings, key, { at = new Date(), by = 'unknown' } = {}) {
  const normalized = normalizeKey(key);
  const list = Array.isArray(findings) ? findings.slice() : [];
  const index = list.findIndex(item => item.key === normalized);
  if (index === -1) return { findings: list, record: null };
  const record = { ...list[index], acknowledged_at: at.toISOString(),
    acknowledged_by: String(by).slice(0, 120) };
  list[index] = record;
  return { findings: list, record };
}

function isStale(record, now) {
  return now.getTime() - new Date(record.last_seen).getTime() > STALE_AFTER_MS;
}

// What she should be leading with, most-repeated first. Acknowledged findings drop out until they
// are observed again, so acknowledging buys quiet for a cycle rather than forever.
function escalatedFindings(findings, now = new Date()) {
  return (Array.isArray(findings) ? findings : [])
    .filter(record => record.status === 'open' && record.escalated && !isStale(record, now))
    .filter(record => !record.acknowledged_at
      || new Date(record.last_seen) > new Date(record.acknowledged_at))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity)
      || b.occurrences - a.occurrences
      || String(a.first_seen).localeCompare(String(b.first_seen)));
}

function daysBetween(from, to) {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 86400000));
}

// The line that goes in her prompt. It states the count and the age, because those are the two
// facts that distinguish a standing problem from an observation, and they are exactly what was
// missing from five identical reports.
function findingPromptLine(record, now = new Date()) {
  const days = daysBetween(record.first_seen, now);
  const age = days === 0 ? 'today' : days === 1 ? 'since yesterday' : `over ${days} days`;
  return `- ${record.summary} (raised ${record.occurrences} times ${age}`
    + `${record.severity === 'blocker' ? ', blocking' : ''}; key ${record.key})`;
}

function findingsPromptBlock(findings, now = new Date(), limit = 5) {
  const escalated = escalatedFindings(findings, now).slice(0, limit);
  if (!escalated.length) return '';
  return '\n\n[Standing findings you have already raised more than once and that are still true. '
    + 'Lead with these rather than re-reporting them as if they were new, and say plainly how many '
    + 'times you have raised each one. If one has since been fixed, resolve it instead of repeating '
    + 'it.]\n' + escalated.map(record => findingPromptLine(record, now)).join('\n');
}

function findingsSnapshot(findings, now = new Date()) {
  const list = Array.isArray(findings) ? findings : [];
  const open = list.filter(record => record.status === 'open' && !isStale(record, now));
  return {
    protocol_version: PROTOCOL_VERSION,
    escalate_after_occurrences: ESCALATE_AFTER_OCCURRENCES,
    total: list.length,
    open: open.length,
    escalated: escalatedFindings(list, now).length,
    stale: list.filter(record => record.status === 'open' && isStale(record, now)).length,
    findings: list,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  ESCALATE_AFTER_OCCURRENCES,
  STALE_AFTER_MS,
  normalizeKey,
  recordFinding,
  resolveFinding,
  acknowledgeFinding,
  escalatedFindings,
  findingPromptLine,
  findingsPromptBlock,
  findingsSnapshot,
};
