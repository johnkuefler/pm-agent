'use strict';

const crypto = require('crypto');
const selfAuthoredAimReflection = require('./self-authored-aim-reflection');
const selfAuthoredAimReappraisal = require('./self-authored-aim-reappraisal');
const aimProgressEvidence = require('./aim-progress-evidence');

const PROTOCOL_VERSION = 2;
const RECENT_PROGRESS_DAYS = 14;
const FORMING_GRACE_DAYS = 7;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sourceCommitment(want) {
  return commitment(JSON.parse(JSON.stringify(want)));
}

function time(value) {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function daysSince(value, now) {
  const parsed = time(value);
  return parsed == null ? null : Math.max(0, (now.getTime() - parsed) / 86400000);
}

function verifiedWant(want) {
  const base = Boolean(want?.id && want.status === 'active' && String(want.want || '').trim()
    && want.provenance?.origin === 'self_generated'
    && String(want.provenance?.formation_context || '').trim()
    && Array.isArray(want.provenance?.evidence) && want.provenance.evidence.length);
  if (!base) return false;
  if (want.provenance?.formation_protocol === selfAuthoredAimReflection.FORMATION_PROTOCOL) {
    return want.provenance?.epistemic_status === 'receipt_bound_subject_synthesis'
      && selfAuthoredAimReflection.auditReceipt(want.provenance.generation_receipt, { want })
        .complete_chain_verified;
  }
  if (selfAuthoredAimReappraisal.SUPPORTED_FORMATION_PROTOCOLS
    .includes(want.provenance?.formation_protocol)) {
    return want.provenance?.epistemic_status === 'receipt_bound_subject_synthesis'
      && selfAuthoredAimReappraisal.auditReceipt(want.provenance.generation_receipt, {
        want,
        priorWant: want.provenance.generation_receipt?.source_packet?.aims
          ?.find(item => item.id === want.provenance.supersedes_aim_id),
      }).complete_chain_verified;
  }
  return want.provenance?.epistemic_status === 'subject_attested';
}

function progressEvidenceRequired(want) {
  return [selfAuthoredAimReflection.FORMATION_PROTOCOL,
    ...selfAuthoredAimReappraisal.SUPPORTED_FORMATION_PROTOCOLS]
    .includes(want?.provenance?.formation_protocol)
    || (want?.provenance?.origin === 'self_generated'
      && want?.provenance?.epistemic_status === 'subject_attested');
}

function progressEligible(want, entry) {
  return !progressEvidenceRequired(want) || aimProgressEvidence.verifiedEntry(entry);
}

function aimState(want, now) {
  const progress = (Array.isArray(want.progress) ? want.progress : [])
    .filter(entry => progressEligible(want, entry))
    .map((entry, index) => ({
    index,
    at: entry?.at || entry?.date || null,
    note: String(entry?.note || '').trim().slice(0, 1200),
  })).filter(entry => entry.note && time(entry.at) != null).sort((a, b) => time(a.at) - time(b.at));
  const latest = progress.at(-1) || null;
  const formedAt = want.provenance.formed_at || want.added || null;
  const progressAge = latest ? daysSince(latest.at, now) : null;
  const formationAge = daysSince(formedAt, now);
  const status = latest && progressAge <= RECENT_PROGRESS_DAYS ? 'progressing'
    : !latest && formationAge != null && formationAge <= FORMING_GRACE_DAYS ? 'forming'
      : 'stalled';
  const referenceAge = progressAge ?? formationAge ?? RECENT_PROGRESS_DAYS;
  const salience = status === 'progressing' ? Math.max(0.35, 0.6 - referenceAge * 0.015)
    : status === 'forming' ? 0.45
      : Math.min(0.9, 0.58 + Math.max(0, referenceAge - RECENT_PROGRESS_DAYS) * 0.012);
  return {
    want_id: String(want.id),
    want: String(want.want).trim().slice(0, 1000),
    source_commitment: sourceCommitment(want),
    status,
    salience,
    formed_at: formedAt,
    last_progress_at: latest?.at || null,
    days_since_progress: progressAge,
    days_since_formation: formationAge,
    success_observation: String(want.evaluation?.success_observation || '').trim().slice(0, 700) || null,
    counterevidence: (Array.isArray(want.evaluation?.counterevidence)
      ? want.evaluation.counterevidence : []).map(item => String(item).trim().slice(0, 500)).filter(Boolean),
    horizon_days: Number.isInteger(want.evaluation?.horizon_days) ? want.evaluation.horizon_days : null,
    action_tendency: status === 'progressing' ? 'continue_when_relevant'
      : status === 'forming' ? 'observe_before_committing'
        : 'revisit_or_take_one_bounded_step',
    evidence: [
      { type: 'want', id: String(want.id) },
      ...(latest ? [{ type: 'want_progress', id: `${want.id}:${latest.at}:${latest.index}` }] : []),
    ],
  };
}

function snapshot(wants = [], nowValue = new Date()) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new Error('goal-affect snapshot requires a valid time');
  const active = (Array.isArray(wants) ? wants : []).filter(want => want?.status === 'active');
  const verifiedAims = active.filter(verifiedWant);
  const evidenceRequiredProgressEntries = verifiedAims.filter(progressEvidenceRequired)
    .flatMap(want => Array.isArray(want.progress) ? want.progress : []);
  const sourceBoundProgressEntries = evidenceRequiredProgressEntries
    .filter(entry => aimProgressEvidence.verifiedEntry(entry)).length;
  const aims = verifiedAims.map(want => aimState(want, now))
    .sort((a, b) => b.salience - a.salience || a.want_id.localeCompare(b.want_id));
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    observed_at: now.toISOString(),
    active_verified_aims: aims.length,
    excluded_unverified_aims: active.length - aims.length,
    progressing_aims: aims.filter(aim => aim.status === 'progressing').length,
    forming_aims: aims.filter(aim => aim.status === 'forming').length,
    stalled_aims: aims.filter(aim => aim.status === 'stalled').length,
    source_bound_progress_entries: sourceBoundProgressEntries,
    excluded_unbound_progress_entries: evidenceRequiredProgressEntries.length - sourceBoundProgressEntries,
    aims,
  };
  return { ...payload, content_commitment: commitment(payload) };
}

function verify(record) {
  if (!record || Number(record.protocol_version) !== PROTOCOL_VERSION || !Array.isArray(record.aims)) return false;
  const { content_commitment, ...payload } = record;
  return /^[a-f0-9]{64}$/.test(String(content_commitment || '')) && commitment(payload) === content_commitment;
}

module.exports = { PROTOCOL_VERSION, FORMING_GRACE_DAYS, RECENT_PROGRESS_DAYS, commitment, snapshot,
  sourceCommitment, verify, verifiedWant, progressEvidenceRequired, progressEligible };
