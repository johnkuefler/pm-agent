const crypto = require('crypto');

const STATUSES = new Set(['active', 'completed', 'retired']);
const ORIGINS = new Set(['self_generated', 'user_suggested', 'system_seed', 'unknown']);
const RECEIPT_BOUND_FORMATION_PROTOCOL = 'server_direct_subject_aim_reflection_v1';
const RECEIPT_BOUND_REAPPRAISAL_PROTOCOL = 'server_direct_subject_aim_reappraisal_v1';
const HISTORY_PROTOCOL_VERSION = 2;
const HASH_PROTOCOL = 'canonical_json_sha256_v2';
const LEGACY_ARCHIVE_PROTOCOL = 'legacy_wants_history_archive_v1';

function cleanText(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return text;
}

function cleanEvidence(value) {
  if (!Array.isArray(value)) throw new Error('provenance.evidence must be an array');
  return value.slice(0, 12).map((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`provenance.evidence[${index}] must be an object`);
    const type = cleanText(ref.type, `provenance.evidence[${index}].type`, 40, true);
    const id = cleanText(ref.id, `provenance.evidence[${index}].id`, 200, true);
    return { type, id };
  });
}

function cleanProvenance(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('new wants require provenance');
  const origin = cleanText(value.origin, 'provenance.origin', 40, true);
  if (!ORIGINS.has(origin)) throw new Error('provenance.origin is invalid');
  const formation_context = cleanText(value.formation_context, 'provenance.formation_context', 1000, origin === 'self_generated');
  const evidence = cleanEvidence(value.evidence || []);
  if (origin === 'self_generated' && evidence.length === 0) {
    throw new Error('self-generated wants require formation evidence');
  }
  const formation_protocol = cleanText(value.formation_protocol, 'provenance.formation_protocol', 100);
  const receiptBound = [RECEIPT_BOUND_FORMATION_PROTOCOL,
    RECEIPT_BOUND_REAPPRAISAL_PROTOCOL].includes(formation_protocol);
  if (formation_protocol && !receiptBound) throw new Error('provenance.formation_protocol is invalid');
  let generation_receipt = null;
  let source_dream_id = '';
  let supersedes_aim_id = '';
  if (receiptBound) {
    source_dream_id = cleanText(value.source_dream_id, 'provenance.source_dream_id', 500, true);
    if (!value.generation_receipt || typeof value.generation_receipt !== 'object'
      || Array.isArray(value.generation_receipt)) throw new Error('receipt-bound wants require a generation receipt');
    const serialized = JSON.stringify(value.generation_receipt);
    if (serialized.length > 120000) throw new Error('provenance.generation_receipt is too large');
    generation_receipt = JSON.parse(serialized);
    if (!/^[a-f0-9]{64}$/.test(String(generation_receipt.receipt_commitment || ''))) {
      throw new Error('receipt-bound wants require a committed generation receipt');
    }
    if (formation_protocol === RECEIPT_BOUND_REAPPRAISAL_PROTOCOL) {
      supersedes_aim_id = cleanText(value.supersedes_aim_id,
        'provenance.supersedes_aim_id', 100, true);
    }
  }
  return {
    origin,
    formation_context,
    evidence,
    formed_at: cleanText(value.formed_at || now, 'provenance.formed_at', 40, true),
    epistemic_status: receiptBound ? 'receipt_bound_subject_synthesis'
      : origin === 'self_generated' ? 'subject_attested' : 'source_labeled',
    ...(receiptBound ? { formation_protocol, source_dream_id, generation_receipt } : {}),
    ...(supersedes_aim_id ? { supersedes_aim_id } : {}),
  };
}

function cleanEvaluation(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('evaluation must be an object');
  const counterevidence = (Array.isArray(value.counterevidence) ? value.counterevidence : [])
    .slice(0, 3).map((item, index) => cleanText(item, `evaluation.counterevidence[${index}]`, 500, true));
  const horizon_days = Number(value.horizon_days);
  if (!counterevidence.length || !Number.isInteger(horizon_days) || horizon_days < 14 || horizon_days > 90) {
    throw new Error('evaluation requires counterevidence and a 14-to-90-day horizon');
  }
  return {
    success_observation: cleanText(value.success_observation, 'evaluation.success_observation', 700, true),
    counterevidence,
    horizon_days,
  };
}

function cleanProgress(value) {
  if (!Array.isArray(value || [])) throw new Error('progress must be an array');
  return (value || []).slice(0, 100).map((entry, index) => {
    if (typeof entry === 'string') return cleanText(entry, `progress[${index}]`, 1000, true);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`progress[${index}] is invalid`);
    const evidence_receipt = entry.evidence_receipt == null ? null : (() => {
      if (!entry.evidence_receipt || typeof entry.evidence_receipt !== 'object'
        || Array.isArray(entry.evidence_receipt)) throw new Error(`progress[${index}].evidence_receipt is invalid`);
      const serialized = JSON.stringify(entry.evidence_receipt);
      if (serialized.length > 30000) throw new Error(`progress[${index}].evidence_receipt is too large`);
      return JSON.parse(serialized);
    })();
    return {
      at: cleanText(entry.at || entry.date, `progress[${index}].at`, 40, true),
      note: cleanText(entry.note, `progress[${index}].note`, 1000, true),
      evidence: cleanEvidence(entry.evidence || []),
      ...(evidence_receipt ? { evidence_receipt } : {}),
    };
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeWantUpdate(previousItems, requestedItems, options = {}) {
  if (!Array.isArray(requestedItems)) throw new Error('items must be an array');
  if (requestedItems.length > 20) throw new Error('at most 20 wants are allowed');
  const now = options.now || new Date().toISOString();
  const previous = new Map((Array.isArray(previousItems) ? previousItems : []).map(item => [item.id, item]));
  const seen = new Set();
  const items = requestedItems.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`items[${index}] must be an object`);
    const id = cleanText(raw.id, `items[${index}].id`, 100, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error(`items[${index}].id is invalid`);
    if (seen.has(id)) throw new Error(`duplicate want id: ${id}`);
    seen.add(id);
    const old = previous.get(id);
    const want = cleanText(raw.want, `items[${index}].want`, 1000, true);
    const why = cleanText(raw.why, `items[${index}].why`, 1000, true);
    const status = cleanText(raw.status || 'active', `items[${index}].status`, 20, true);
    if (!STATUSES.has(status)) throw new Error(`items[${index}].status is invalid`);
    if (old && old.status !== 'active' && status === 'active') {
      throw new Error(`closed want ${id} cannot be reopened; create a new want`);
    }
    if (old && (old.want !== want || old.why !== why)) {
      throw new Error(`want and why are immutable for existing id ${id}; retire it and create a new want`);
    }
    if (old?.provenance && raw.provenance && stableHash(raw.provenance) !== stableHash(old.provenance)) {
      throw new Error(`provenance is immutable for existing id ${id}`);
    }
    if (old?.evaluation && raw.evaluation && stableHash(raw.evaluation) !== stableHash(old.evaluation)) {
      throw new Error(`evaluation is immutable for existing id ${id}`);
    }
    const progress = cleanProgress(raw.progress);
    const previousProgress = old?.progress ? cleanProgress(old.progress) : [];
    if (old?.progress && (progress.length < previousProgress.length
      || previousProgress.some((entry, i) => stableHash(entry) !== stableHash(progress[i])))) {
      throw new Error(`progress history is append-only for existing id ${id}`);
    }
    const provenance = old?.provenance || (old ? {
      origin: 'unknown',
      formation_context: 'Legacy want predating provenance capture.',
      evidence: [],
      formed_at: cleanText(old.added || now, `items[${index}].legacy_formed_at`, 40, true),
      epistemic_status: 'legacy_unverified',
    } : cleanProvenance(raw.provenance, now));
    const evaluation = old?.evaluation || cleanEvaluation(raw.evaluation);
    return {
      id, want, why, status,
      added: old?.added || cleanText(raw.added || now.slice(0, 10), `items[${index}].added`, 40, true),
      progress,
      provenance,
      ...(evaluation ? { evaluation } : {}),
      revision: Number.isInteger(old?.revision) ? old.revision + 1 : 1,
      updated_at: now,
      ...(status !== 'active' ? { closed_at: old?.closed_at || now } : {}),
    };
  });
  const removedActive = [...previous.values()].filter(item => item.status === 'active' && !seen.has(item.id));
  if (removedActive.length) throw new Error(`active wants must be completed or retired before removal: ${removedActive.map(item => item.id).join(', ')}`);
  return items;
}

function eventPayload(event = {}) {
  const value = JSON.parse(JSON.stringify(event || {}));
  delete value.event_commitment;
  return value;
}

function wantRevisionEvent(previousRecord, nextRecord, actor = 'nora', options = {}) {
  const previousHash = previousRecord ? stableHash(previousRecord) : null;
  const recordHash = stableHash(nextRecord);
  const event = {
    protocol_version: HISTORY_PROTOCOL_VERSION,
    hash_protocol: HASH_PROTOCOL,
    at: cleanText(options.at || nextRecord.updated_at, 'event.at', 40, true),
    actor: cleanText(String(actor), 'actor', 100, true),
    previous_hash: previousHash,
    record_hash: recordHash,
    active_ids: nextRecord.items.filter(item => item.status === 'active').map(item => item.id),
    record: nextRecord,
    ...(options.checkpoint ? { checkpoint: JSON.parse(JSON.stringify(options.checkpoint)) } : {}),
  };
  event.event_commitment = stableHash(eventPayload(event));
  return event;
}

function verifyWantHistory(events, currentRecord) {
  if (!Array.isArray(events)) return { valid: false, reason: 'history_not_array' };
  if (!events.length) {
    return currentRecord ? { valid: false, reason: 'current_record_without_history' }
      : { valid: true, events: 0, head: null, protocol_version: HISTORY_PROTOCOL_VERSION,
        hash_protocol: HASH_PROTOCOL, complete_chain_verified: true };
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event?.protocol_version !== HISTORY_PROTOCOL_VERSION || event?.hash_protocol !== HASH_PROTOCOL) {
      return { valid: false, reason: 'unsupported_event_protocol', index: i };
    }
    if (!event.event_commitment || stableHash(eventPayload(event)) !== event.event_commitment) {
      return { valid: false, reason: 'event_commitment_mismatch', index: i };
    }
    if (!event?.record || !Array.isArray(event.record.items)) {
      return { valid: false, reason: 'record_shape_invalid', index: i };
    }
    if (stableHash(event.record) !== event.record_hash) return { valid: false, reason: 'record_hash_mismatch', index: i };
    const activeIds = event.record.items.filter(item => item.status === 'active').map(item => item.id);
    if (canonicalJson(activeIds) !== canonicalJson(event.active_ids || [])) {
      return { valid: false, reason: 'active_ids_mismatch', index: i };
    }
    if (i === 0 && event.previous_hash !== null) return { valid: false, reason: 'genesis_previous_hash_present', index: i };
    if (i > 0 && event.previous_hash !== events[i - 1].record_hash) return { valid: false, reason: 'chain_mismatch', index: i };
  }
  if (events.length && currentRecord && events[events.length - 1].record_hash !== stableHash(currentRecord)) {
    return { valid: false, reason: 'current_record_mismatch' };
  }
  return { valid: true, events: events.length, head: events[events.length - 1].record_hash,
    protocol_version: HISTORY_PROTOCOL_VERSION, hash_protocol: HASH_PROTOCOL,
    complete_chain_verified: true };
}

function archivePayload(archive = {}) {
  const value = JSON.parse(JSON.stringify(archive || {}));
  delete value.archive_commitment;
  return value;
}

function legacyArchiveSource(events, currentRecord, integrity) {
  return { events: JSON.parse(JSON.stringify(events || [])),
    current_record: currentRecord ? JSON.parse(JSON.stringify(currentRecord)) : null,
    integrity_at_archival: JSON.parse(JSON.stringify(integrity || {})) };
}

function createLegacyWantHistoryArchive(events, currentRecord, integrity, now = new Date()) {
  const source = legacyArchiveSource(events, currentRecord, integrity);
  const archive = {
    protocol: LEGACY_ARCHIVE_PROTOCOL,
    archived_at: new Date(now).toISOString(),
    source_commitment: stableHash(source),
    legacy_event_count: Array.isArray(events) ? events.length : 0,
    integrity_at_archival: source.integrity_at_archival,
    legacy_events: source.events,
    current_record: source.current_record,
  };
  archive.archive_commitment = stableHash(archivePayload(archive));
  return archive;
}

function auditLegacyWantHistoryArchive(archive) {
  const source = legacyArchiveSource(archive?.legacy_events, archive?.current_record,
    archive?.integrity_at_archival);
  const checks = {
    protocol_verified: archive?.protocol === LEGACY_ARCHIVE_PROTOCOL,
    source_commitment_verified: Boolean(archive?.source_commitment
      && archive.source_commitment === stableHash(source)),
    archive_commitment_verified: Boolean(archive?.archive_commitment
      && archive.archive_commitment === stableHash(archivePayload(archive))),
    event_count_verified: Number(archive?.legacy_event_count) === source.events.length,
  };
  return { ...checks, complete_archive_verified: Object.values(checks).every(Boolean),
    source_history_replay_verified: Boolean(archive?.integrity_at_archival?.valid) };
}

function migrateLegacyWantHistory(events, currentRecord, archives = [], now = new Date()) {
  const history = Array.isArray(events) ? events : [];
  if (!Array.isArray(archives)) throw new Error('wants history archives must be an array');
  const existingAudit = verifyWantHistory(history, currentRecord);
  if (existingAudit.valid) return { migrated: false, history, archives, integrity: existingAudit };
  if (!currentRecord || !Array.isArray(currentRecord.items)) {
    throw new Error('cannot checkpoint wants history without a current record');
  }
  if (history.some(event => event?.protocol_version === HISTORY_PROTOCOL_VERSION
    || event?.hash_protocol === HASH_PROTOCOL)) {
    throw new Error(`canonical wants history failed integrity: ${existingAudit.reason}`);
  }
  const integrityAtArchival = {
    valid: false,
    reason: existingAudit.reason,
    ...(Number.isInteger(existingAudit.index) ? { index: existingAudit.index } : {}),
    epistemic_status: history.length
      ? 'legacy_hash_chain_not_replay_verified' : 'preledger_state_not_replay_verified',
  };
  const source = legacyArchiveSource(history, currentRecord, integrityAtArchival);
  const sourceCommitment = stableHash(source);
  let archive = archives.find(item => item?.source_commitment === sourceCommitment) || null;
  if (archive && !auditLegacyWantHistoryArchive(archive).complete_archive_verified) {
    throw new Error('matching legacy wants archive failed integrity');
  }
  const nextArchives = archives.slice();
  if (!archive) {
    archive = createLegacyWantHistoryArchive(history, currentRecord, integrityAtArchival, now);
    nextArchives.push(archive);
  }
  const checkpoint = {
    kind: 'legacy_unverified_state_checkpoint_v1',
    legacy_archive_commitment: archive.archive_commitment,
    legacy_source_commitment: archive.source_commitment,
    legacy_event_count: history.length,
    source_integrity_at_migration: integrityAtArchival,
    epistemic_status: 'current_state_committed_without_retroactive_source_verification',
  };
  const checkpointEvent = wantRevisionEvent(null, currentRecord,
    'system:canonical-wants-ledger-migration', { at: new Date(now).toISOString(), checkpoint });
  const nextHistory = [checkpointEvent];
  return { migrated: true, history: nextHistory, archives: nextArchives,
    archive, integrity: verifyWantHistory(nextHistory, currentRecord) };
}

function compactWantHistory(events, currentRecord, { maxEvents = 40, now = new Date() } = {}) {
  const history = Array.isArray(events) ? events : [];
  if (history.length < maxEvents) return { compacted: false, history };
  const audit = verifyWantHistory(history, currentRecord);
  if (!audit.valid) throw new Error(`cannot compact invalid wants history: ${audit.reason}`);
  const checkpoint = {
    kind: 'bounded_verified_chain_checkpoint_v1',
    prior_event_count: history.length,
    prior_head: audit.head,
    prior_chain_commitment: stableHash(history),
    prior_chain_audit_commitment: stableHash(audit),
    epistemic_status: 'prior_verified_chain_content_compacted_to_commitment',
  };
  const event = wantRevisionEvent(null, currentRecord, 'system:wants-ledger-compaction',
    { at: new Date(now).toISOString(), checkpoint });
  return { compacted: true, history: [event], checkpoint };
}

module.exports = { RECEIPT_BOUND_FORMATION_PROTOCOL, RECEIPT_BOUND_REAPPRAISAL_PROTOCOL,
  HISTORY_PROTOCOL_VERSION, HASH_PROTOCOL, LEGACY_ARCHIVE_PROTOCOL, canonicalJson,
  normalizeWantUpdate, stableHash, eventPayload, wantRevisionEvent, verifyWantHistory,
  archivePayload, createLegacyWantHistoryArchive, auditLegacyWantHistoryArchive,
  migrateLegacyWantHistory, compactWantHistory };
