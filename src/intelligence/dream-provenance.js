'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const ARCHIVE_PROTOCOL_VERSION = 1;
const MAX_TEXT = 1600;
const MAX_NARRATIVE = 12000;
const MAX_ARRAY_ITEMS = 100;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanText(value, max = MAX_TEXT) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedInteger(value, { min = 0, max = 1000000, fallback = 0 } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function textList(value, { maxItems = MAX_ARRAY_ITEMS, maxText = MAX_TEXT } = {}) {
  return Array.isArray(value)
    ? value.map(item => cleanText(item, maxText)).filter(Boolean).slice(0, maxItems)
    : [];
}

function validIso(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function validDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(new Date(`${text}T00:00:00.000Z`).getTime())
    ? text : null;
}

function normalizeConsolidation(value = {}) {
  return {
    memories_before: boundedInteger(value.memories_before),
    memories_after: boundedInteger(value.memories_after),
    duplicates_removed: boundedInteger(value.duplicates_removed),
    fragments_merged: boundedInteger(value.fragments_merged),
    stale_pruned: boundedInteger(value.stale_pruned),
    contradictions_resolved: boundedInteger(value.contradictions_resolved),
    examples: textList(value.examples, { maxItems: 20 }),
  };
}

function normalizeReflection(value = {}) {
  return {
    takes_added: textList(value.takes_added, { maxItems: 30 }),
    takes_retired: textList(value.takes_retired, { maxItems: 30 }),
    ideas: textList(value.ideas, { maxItems: 30 }),
    behavior_changes: textList(value.behavior_changes, { maxItems: 30 }),
  };
}

function normalizeReview(value = {}) {
  const outcomes = value.outcomes || {};
  return {
    interactions_reviewed: boundedInteger(value.interactions_reviewed),
    outcomes: {
      appreciated: boundedInteger(outcomes.appreciated),
      landed: boundedInteger(outcomes.landed),
      neutral: boundedInteger(outcomes.neutral),
      ignored: boundedInteger(outcomes.ignored),
      corrected: boundedInteger(outcomes.corrected),
    },
    learnings_added: textList(value.learnings_added, { maxItems: 30 }),
    learnings_retired: textList(value.learnings_retired, { maxItems: 30 }),
  };
}

function normalizeDreamInput(input = {}, {
  id, now = new Date(), autonomous = false, lifecycle = null,
} = {}) {
  const recordedAt = new Date(now).toISOString();
  const lifecycleStarted = validIso(lifecycle?.cycle_started_at || lifecycle?.moment_started_at);
  const reportedStarted = validIso(input.started);
  const reportedFinished = validIso(input.finished);
  const started = autonomous ? (lifecycleStarted || recordedAt) : (reportedStarted || recordedAt);
  const finished = autonomous ? recordedAt : (reportedFinished || recordedAt);
  if (new Date(finished).getTime() < new Date(started).getTime()) {
    throw new Error('dream finished timestamp cannot precede its started timestamp');
  }
  const date = autonomous
    ? recordedAt.slice(0, 10)
    : (validDate(input.date) || finished.slice(0, 10));
  return {
    id,
    date,
    started,
    finished,
    consolidation: normalizeConsolidation(input.consolidation),
    reflection: normalizeReflection(input.reflection),
    review: normalizeReview(input.review),
    narrative: cleanText(input.narrative, MAX_NARRATIVE),
  };
}

// Only caller-authored fields are committed here. Background reflection helpers append their
// own receipt-bound fields under `reflection` after ingestion; those additions must not invalidate
// the original ingress receipt, while edits to the submitted ideas/learnings still must.
function submissionSnapshot(dream = {}) {
  return {
    id: dream.id,
    date: dream.date,
    started: dream.started,
    finished: dream.finished,
    consolidation: normalizeConsolidation(dream.consolidation),
    reflection: normalizeReflection(dream.reflection),
    review: normalizeReview(dream.review),
    narrative: cleanText(dream.narrative, MAX_NARRATIVE),
  };
}

function receiptPayload(provenance) {
  const payload = {
    protocol_version: provenance?.protocol_version,
    origin: provenance?.origin,
    recorded_at: provenance?.recorded_at,
    submission_commitment: provenance?.submission_commitment,
  };
  if (provenance?.origin === 'autonomous_nightly_cycle') payload.lifecycle = provenance.lifecycle;
  if (provenance?.origin === 'authorized_manual_import') payload.authority = provenance.authority;
  return payload;
}

function stampAutonomous(dream, lifecycle, now = new Date()) {
  const requiredText = ['cycle_id', 'moment_id', 'holder', 'start_commitment',
    'self_forecast_commitment'];
  if (!lifecycle || requiredText.some(key => !cleanText(lifecycle[key], 500))
    || lifecycle.lifecycle_projection_integrity_verified !== true
    || lifecycle.lifecycle_stage !== 'operational_cycle_active') {
    throw new Error('autonomous dreams require a verified operational run lifecycle receipt');
  }
  const recordedAt = new Date(now).toISOString();
  const provenance = {
    protocol_version: PROTOCOL_VERSION,
    origin: 'autonomous_nightly_cycle',
    recorded_at: recordedAt,
    submission_commitment: commitment(submissionSnapshot(dream)),
    lifecycle: {
      cycle_id: cleanText(lifecycle.cycle_id, 500),
      moment_id: cleanText(lifecycle.moment_id, 500),
      holder: cleanText(lifecycle.holder, 180),
      cycle_started_at: validIso(lifecycle.cycle_started_at),
      moment_started_at: validIso(lifecycle.moment_started_at),
      start_commitment: cleanText(lifecycle.start_commitment, 128),
      self_forecast_commitment: cleanText(lifecycle.self_forecast_commitment, 128),
      lifecycle_stage: 'operational_cycle_active',
      lifecycle_projection_integrity_verified: true,
    },
  };
  provenance.receipt_commitment = commitment(receiptPayload(provenance));
  dream.provenance = provenance;
  return provenance;
}

function stampAuthorizedImport(dream, authority, now = new Date()) {
  if (!authority || !['operator', 'research'].includes(authority.kind)) {
    throw new Error('manual dream imports require signed operator or research authority');
  }
  const recordedAt = new Date(now).toISOString();
  const provenance = {
    protocol_version: PROTOCOL_VERSION,
    origin: 'authorized_manual_import',
    recorded_at: recordedAt,
    submission_commitment: commitment(submissionSnapshot(dream)),
    authority: {
      kind: authority.kind,
      id: cleanText(authority.id || `${authority.kind}-authority`, 180),
      verified_at_ingress: true,
    },
  };
  provenance.receipt_commitment = commitment(receiptPayload(provenance));
  dream.provenance = provenance;
  return provenance;
}

function audit(dream) {
  const provenance = dream?.provenance;
  const submissionVerified = Boolean(provenance?.submission_commitment
    && provenance.submission_commitment === commitment(submissionSnapshot(dream)));
  const receiptVerified = Boolean(provenance?.receipt_commitment
    && provenance.receipt_commitment === commitment(receiptPayload(provenance)));
  const autonomous = provenance?.origin === 'autonomous_nightly_cycle';
  const manual = provenance?.origin === 'authorized_manual_import';
  const lifecycle = provenance?.lifecycle;
  const lifecycleVerified = Boolean(autonomous
    && lifecycle?.cycle_id && lifecycle?.moment_id && lifecycle?.holder
    && lifecycle?.start_commitment && lifecycle?.self_forecast_commitment
    && lifecycle?.lifecycle_stage === 'operational_cycle_active'
    && lifecycle?.lifecycle_projection_integrity_verified === true);
  const authorityVerified = Boolean(manual
    && ['operator', 'research'].includes(provenance?.authority?.kind)
    && provenance?.authority?.id
    && provenance?.authority?.verified_at_ingress === true);
  const archived = isArchived(dream);
  const complete = Number(provenance?.protocol_version) === PROTOCOL_VERSION
    && submissionVerified && receiptVerified
    && ((autonomous && lifecycleVerified) || (manual && authorityVerified));
  return {
    protocol_version: Number(provenance?.protocol_version) || null,
    origin: provenance?.origin || 'legacy_unverified',
    submission_commitment_verified: submissionVerified,
    receipt_commitment_verified: receiptVerified,
    autonomous_lifecycle_verified: lifecycleVerified,
    authorized_import_verified: authorityVerified,
    complete_chain_verified: complete,
    archived,
    self_improvement_eligible: complete && !archived,
  };
}

function isArchived(dream) {
  return Boolean(dream?.archive?.status === 'archived');
}

function archiveRecordSnapshot(dream = {}) {
  const { archive: _archive, archive_history: _history, ...record } = dream;
  return record;
}

function archiveEventPayload(event) {
  const { event_commitment: _commitment, ...payload } = event;
  return payload;
}

function appendArchiveEvent(dream, {
  action, reason, actor, now = new Date(),
} = {}) {
  const normalizedReason = cleanText(reason, 1200);
  if (normalizedReason.length < 10) throw new Error('a concrete archival reason of at least 10 characters is required');
  if (!['archived', 'restored'].includes(action)) throw new Error('unsupported dream archive action');
  if (action === 'archived' && isArchived(dream)) throw new Error('dream is already archived');
  if (action === 'restored' && !isArchived(dream)) throw new Error('dream is not archived');
  const history = Array.isArray(dream.archive_history) ? dream.archive_history.slice() : [];
  const at = new Date(now).toISOString();
  const event = {
    protocol_version: ARCHIVE_PROTOCOL_VERSION,
    action,
    at,
    actor: cleanText(actor || 'signed-operator', 180),
    reason: normalizedReason,
    record_commitment: commitment(archiveRecordSnapshot(dream)),
    prior_event_commitment: history.at(-1)?.event_commitment || null,
  };
  event.event_commitment = commitment(archiveEventPayload(event));
  history.push(event);
  dream.archive_history = history;
  dream.archive = action === 'archived'
    ? {
      status: 'archived',
      archived_at: at,
      archived_by: event.actor,
      reason: normalizedReason,
      event_commitment: event.event_commitment,
    }
    : null;
  return event;
}

function archive(dream, options) {
  return appendArchiveEvent(dream, { ...options, action: 'archived' });
}

function restore(dream, options) {
  return appendArchiveEvent(dream, { ...options, action: 'restored' });
}

function archiveHistoryAudit(dream) {
  const history = Array.isArray(dream?.archive_history) ? dream.archive_history : [];
  let prior = null;
  let valid = true;
  for (const event of history) {
    valid = valid && Number(event?.protocol_version) === ARCHIVE_PROTOCOL_VERSION
      && event?.prior_event_commitment === prior
      && event?.event_commitment === commitment(archiveEventPayload(event));
    prior = event?.event_commitment || null;
  }
  const expectedAction = isArchived(dream) ? 'archived' : history.length ? 'restored' : null;
  const recordCommitmentVerified = !history.length
    || history.at(-1)?.record_commitment === commitment(archiveRecordSnapshot(dream));
  valid = valid && (expectedAction == null || history.at(-1)?.action === expectedAction)
    && (!isArchived(dream) || dream.archive?.event_commitment === prior)
    && recordCommitmentVerified;
  return {
    event_count: history.length,
    record_commitment_verified: recordCommitmentVerified,
    chain_verified: valid,
  };
}

module.exports = {
  ARCHIVE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  archive,
  archiveHistoryAudit,
  audit,
  canonicalJson,
  commitment,
  isArchived,
  normalizeDreamInput,
  restore,
  stampAuthorizedImport,
  stampAutonomous,
  submissionSnapshot,
};
