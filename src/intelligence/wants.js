const crypto = require('crypto');

const STATUSES = new Set(['active', 'completed', 'retired']);
const ORIGINS = new Set(['self_generated', 'user_suggested', 'system_seed', 'unknown']);

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
  return {
    origin,
    formation_context,
    evidence,
    formed_at: cleanText(value.formed_at || now, 'provenance.formed_at', 40, true),
    epistemic_status: origin === 'self_generated' ? 'subject_attested' : 'source_labeled',
  };
}

function cleanProgress(value) {
  if (!Array.isArray(value || [])) throw new Error('progress must be an array');
  return (value || []).slice(0, 100).map((entry, index) => {
    if (typeof entry === 'string') return cleanText(entry, `progress[${index}]`, 1000, true);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`progress[${index}] is invalid`);
    return {
      at: cleanText(entry.at, `progress[${index}].at`, 40, true),
      note: cleanText(entry.note, `progress[${index}].note`, 1000, true),
      evidence: cleanEvidence(entry.evidence || []),
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
    const progress = cleanProgress(raw.progress);
    if (old?.progress && (progress.length < old.progress.length || old.progress.some((entry, i) => stableHash(entry) !== stableHash(progress[i])))) {
      throw new Error(`progress history is append-only for existing id ${id}`);
    }
    const provenance = old?.provenance || (old ? {
      origin: 'unknown',
      formation_context: 'Legacy want predating provenance capture.',
      evidence: [],
      formed_at: cleanText(old.added || now, `items[${index}].legacy_formed_at`, 40, true),
      epistemic_status: 'legacy_unverified',
    } : cleanProvenance(raw.provenance, now));
    return {
      id, want, why, status,
      added: old?.added || cleanText(raw.added || now.slice(0, 10), `items[${index}].added`, 40, true),
      progress,
      provenance,
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

module.exports = { normalizeWantUpdate, stableHash, wantRevisionEvent, verifyWantHistory };
