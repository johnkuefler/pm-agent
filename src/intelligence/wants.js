const crypto = require('crypto');

const STATUSES = new Set(['active', 'completed', 'retired']);
const ORIGINS = new Set(['self_generated', 'user_suggested', 'system_seed', 'unknown']);
const RECEIPT_BOUND_FORMATION_PROTOCOL = 'server_direct_subject_aim_reflection_v1';
const RECEIPT_BOUND_REAPPRAISAL_PROTOCOL = 'server_direct_subject_aim_reappraisal_v1';

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

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function wantRevisionEvent(previousRecord, nextRecord, actor = 'nora') {
  const previousHash = previousRecord ? stableHash(previousRecord) : null;
  const recordHash = stableHash(nextRecord);
  return {
    at: nextRecord.updated_at,
    actor: cleanText(String(actor), 'actor', 100, true),
    previous_hash: previousHash,
    record_hash: recordHash,
    active_ids: nextRecord.items.filter(item => item.status === 'active').map(item => item.id),
    record: nextRecord,
  };
}

function verifyWantHistory(events, currentRecord) {
  if (!Array.isArray(events)) return { valid: false, reason: 'history_not_array' };
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event?.record || stableHash(event.record) !== event.record_hash) return { valid: false, reason: 'record_hash_mismatch', index: i };
    if (i > 0 && event.previous_hash !== events[i - 1].record_hash) return { valid: false, reason: 'chain_mismatch', index: i };
  }
  if (events.length && currentRecord && events[events.length - 1].record_hash !== stableHash(currentRecord)) {
    return { valid: false, reason: 'current_record_mismatch' };
  }
  return { valid: true, events: events.length, head: events.length ? events[events.length - 1].record_hash : null };
}

module.exports = { RECEIPT_BOUND_FORMATION_PROTOCOL, RECEIPT_BOUND_REAPPRAISAL_PROTOCOL,
  normalizeWantUpdate, stableHash, wantRevisionEvent, verifyWantHistory };
