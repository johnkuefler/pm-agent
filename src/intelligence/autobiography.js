'use strict';

const crypto = require('crypto');

const CHANGE_KINDS = new Set(['observed_fact', 'interpretation', 'self_hypothesis', 'correction']);
const EVIDENCE_TYPES = new Set(['development', 'experience_moment', 'mind_change']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanText(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return text;
}

function revisionId(sequence, previousCommitment, contentHash, at) {
  return `autobio-r${sequence}-${stableHash({ sequence, previous_commitment: previousCommitment, content_hash: contentHash, at }).slice(0, 16)}`;
}

function eventPayload(event) {
  return {
    revision_id: event.revision_id,
    sequence: event.sequence,
    previous_commitment: event.previous_commitment,
    content_hash: event.content_hash,
    content: event.content,
    at: event.at,
    actor: event.actor,
    rationale: event.rationale,
    coverage: event.coverage,
    epistemic_status: event.epistemic_status,
    changes: event.changes,
  };
}

function initializeAutobiographyRecord(record, options = {}) {
  if (!record || typeof record.content !== 'string' || !record.content.trim()) throw new Error('autobiography content is required');
  if (record.revision_id && record.commitment && Number.isInteger(record.sequence)) {
    return { current: record, event: null, migrated: false };
  }
  const at = record.updated_at || options.now || new Date().toISOString();
  const actor = cleanText(String(record.updated_by || 'legacy_import'), 'updated_by', 100, true);
  const content = record.content.slice(0, 12000);
  const contentHash = stableHash(content);
  const event = {
    revision_id: revisionId(1, null, contentHash, at),
    sequence: 1,
    previous_commitment: null,
    content_hash: contentHash,
    content,
    at,
    actor,
    rationale: 'Imported the current autobiography as the genesis of the evidence-bound revision ledger. Earlier authorship and claim evidence remain unverified.',
    coverage: 'legacy_import',
    epistemic_status: 'legacy_unverified',
    changes: [],
  };
  event.commitment = stableHash(eventPayload(event));
  return {
    migrated: true,
    event,
    current: {
      content,
      updated_at: at,
      updated_by: actor,
      revision_id: event.revision_id,
      sequence: 1,
      commitment: event.commitment,
      content_hash: contentHash,
      provenance_status: 'legacy_unverified',
    },
  };
}

function priorClaimState(events) {
  const known = new Set();
  const superseded = new Set();
  const supersededLegacy = new Set();
  for (const event of events || []) {
    for (const change of event?.changes || []) {
      if (change.claim_id) known.add(change.claim_id);
      for (const id of change.supersedes_claim_ids || []) superseded.add(id);
      if (change.supersedes_legacy) supersededLegacy.add(`${change.supersedes_legacy.revision_id}:${change.supersedes_legacy.statement_hash}`);
    }
  }
  return { known, superseded, supersededLegacy };
}

function normalizeEvidence(ref, index, resolveEvidence, now) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`evidence[${index}] must be an object`);
  const type = cleanText(ref.type, `evidence[${index}].type`, 40, true);
  const id = cleanText(ref.id, `evidence[${index}].id`, 200, true);
  if (!EVIDENCE_TYPES.has(type)) throw new Error(`evidence type ${type} is not an immutable autobiographical source`);
  const resolved = resolveEvidence({ type, id });
  if (!resolved || !resolved.record || !resolved.status) throw new Error(`autobiography evidence not found: ${type}:${id}`);
  if (type === 'development' && resolved.status !== 'integrated') throw new Error(`development evidence must be integrated: ${id}`);
  if (type === 'experience_moment' && resolved.status !== 'closed') throw new Error(`experience moment must be closed: ${id}`);
  if (type === 'mind_change' && resolved.status !== 'resolved') throw new Error(`mind change must be resolved: ${id}`);
  return {
    type,
    id,
    source_status: resolved.status,
    source_commitment: stableHash(resolved.record),
    resolved_at: now,
  };
}

function substantiveParagraphs(content) {
  return String(content).split(/\n\s*\n/).map(item => item.trim()).filter(item => item && !/^#{1,6}\s/.test(item));
}

function createAutobiographyRevision(previous, events, input = {}, options = {}) {
  const historyAudit = verifyAutobiographyHistory(events, previous);
  if (!historyAudit.valid) throw new Error(`autobiography revision chain invalid: ${historyAudit.reason}`);
  const content = cleanText(input.content, 'content', 12000, true);
  if (stableHash(content) === previous.content_hash) throw new Error('autobiography content is unchanged');
  const rationale = cleanText(input.rationale, 'rationale', 1200, true);
  const actor = cleanText(String(input.updated_by || 'nora'), 'updated_by', 100, true);
  const coverage = input.coverage || 'changed_passages';
  if (!['changed_passages', 'full_document'].includes(coverage)) throw new Error('coverage must be changed_passages or full_document');
  if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 20) {
    throw new Error('one to twenty evidence-bound changes are required');
  }
  if (typeof options.resolveEvidence !== 'function') throw new Error('resolveEvidence is required');
  const now = options.now || new Date().toISOString();
  const sequence = previous.sequence + 1;
  const { known, superseded, supersededLegacy } = priorClaimState(events);
  const newlySuperseded = new Set();
  const evidenceKinds = new Set();
  const changes = input.changes.map((raw, changeIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`changes[${changeIndex}] must be an object`);
    const kind = cleanText(raw.kind, `changes[${changeIndex}].kind`, 40, true);
    if (!CHANGE_KINDS.has(kind)) throw new Error(`changes[${changeIndex}].kind is invalid`);
    const statement = cleanText(raw.statement, `changes[${changeIndex}].statement`, 1200, true);
    if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 12) {
      throw new Error(`changes[${changeIndex}] requires one to twelve evidence references`);
    }
    const seenEvidence = new Set();
    const evidence = raw.evidence.map((ref, evidenceIndex) => normalizeEvidence(ref, evidenceIndex, options.resolveEvidence, now)).filter(ref => {
      const key = `${ref.type}:${ref.id}`;
      if (seenEvidence.has(key)) return false;
      seenEvidence.add(key);
      evidenceKinds.add(ref.type);
      return true;
    });
    const supersedesClaimIds = Array.isArray(raw.supersedes_claim_ids)
      ? [...new Set(raw.supersedes_claim_ids.map((id, idIndex) => cleanText(id, `changes[${changeIndex}].supersedes_claim_ids[${idIndex}]`, 120, true)))]
      : [];
    let supersedesLegacy = null;
    if (raw.supersedes_legacy != null) {
      if (!raw.supersedes_legacy || typeof raw.supersedes_legacy !== 'object' || Array.isArray(raw.supersedes_legacy)) {
        throw new Error(`changes[${changeIndex}].supersedes_legacy must be an object`);
      }
      const legacyRevisionId = cleanText(raw.supersedes_legacy.revision_id, `changes[${changeIndex}].supersedes_legacy.revision_id`, 120, true);
      const legacyStatement = cleanText(raw.supersedes_legacy.statement, `changes[${changeIndex}].supersedes_legacy.statement`, 1200, true);
      const legacyEvent = events.find(event => event.revision_id === legacyRevisionId && event.epistemic_status === 'legacy_unverified');
      if (!legacyEvent || !legacyEvent.content.includes(legacyStatement)) throw new Error('legacy supersession must quote an exact statement from a prior legacy revision');
      supersedesLegacy = { revision_id: legacyRevisionId, statement: legacyStatement, statement_hash: stableHash(legacyStatement) };
      const legacyKey = `${legacyRevisionId}:${supersedesLegacy.statement_hash}`;
      if (supersededLegacy.has(legacyKey)) throw new Error('legacy statement is already superseded');
      supersededLegacy.add(legacyKey);
    }
    if (kind === 'correction' && !supersedesClaimIds.length && !supersedesLegacy) {
      throw new Error('corrections must identify superseded claim ids or an exact legacy statement');
    }
    for (const id of supersedesClaimIds) {
      if (!known.has(id)) throw new Error(`superseded claim does not exist: ${id}`);
      if (superseded.has(id) || newlySuperseded.has(id)) throw new Error(`claim is already superseded: ${id}`);
      newlySuperseded.add(id);
    }
    const claimId = `autobio-claim-${stableHash({ sequence, change_index: changeIndex, kind, statement }).slice(0, 20)}`;
    return { claim_id: claimId, kind, statement, evidence, supersedes_claim_ids: supersedesClaimIds, ...(supersedesLegacy ? { supersedes_legacy: supersedesLegacy } : {}) };
  });
  if (!evidenceKinds.has('development') || !evidenceKinds.has('experience_moment')) {
    throw new Error('each autobiography revision requires an integrated development record and a closed experience moment');
  }
  const previousParagraphs = new Set(substantiveParagraphs(previous.content));
  const nextParagraphs = substantiveParagraphs(content);
  const changedParagraphs = nextParagraphs.filter(paragraph => !previousParagraphs.has(paragraph));
  const uncovered = changedParagraphs.filter(paragraph => !changes.some(change => paragraph.includes(change.statement)));
  if (uncovered.length) throw new Error('every new or modified autobiography paragraph must contain a committed change statement');
  const nextParagraphSet = new Set(nextParagraphs);
  const removedParagraphs = [...previousParagraphs].filter(paragraph => !nextParagraphSet.has(paragraph));
  if (removedParagraphs.length && !changes.some(change => change.kind === 'correction')) {
    throw new Error('removing autobiography prose requires an explicit correction and supersession');
  }
  if (coverage === 'full_document' && nextParagraphs.some(paragraph => !changes.some(change => paragraph.includes(change.statement)))) {
    throw new Error('full_document coverage requires a committed change statement in every substantive paragraph');
  }
  const contentHash = stableHash(content);
  const event = {
    revision_id: revisionId(sequence, previous.commitment, contentHash, now),
    sequence,
    previous_commitment: previous.commitment,
    content_hash: contentHash,
    content,
    at: now,
    actor,
    rationale,
    coverage,
    epistemic_status: 'evidence_bound_subject_revision',
    changes,
  };
  event.commitment = stableHash(eventPayload(event));
  const provenanceStatus = coverage === 'full_document'
    ? 'evidence_bound_subject_attestation'
    : previous.provenance_status === 'legacy_unverified' || previous.provenance_status === 'mixed_legacy_and_evidence_bound'
      ? 'mixed_legacy_and_evidence_bound'
      : previous.provenance_status;
  return {
    event,
    current: {
      content,
      updated_at: now,
      updated_by: actor,
      revision_id: event.revision_id,
      sequence,
      commitment: event.commitment,
      content_hash: contentHash,
      provenance_status: provenanceStatus,
    },
  };
}

function verifyAutobiographyHistory(events, current) {
  if (!Array.isArray(events) || !events.length) return { valid: false, reason: 'history_missing' };
  let previousCommitment = null;
  const knownClaims = new Set();
  const supersededClaims = new Set();
  const priorEvents = new Map();
  const supersededLegacy = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.sequence !== index + 1) return { valid: false, reason: 'sequence_mismatch', index };
    if (event.previous_commitment !== previousCommitment) return { valid: false, reason: 'chain_mismatch', index };
    if (stableHash(event.content) !== event.content_hash) return { valid: false, reason: 'content_hash_mismatch', index };
    if (stableHash(eventPayload(event)) !== event.commitment) return { valid: false, reason: 'commitment_mismatch', index };
    for (const change of event.changes || []) {
      if (!change.claim_id || knownClaims.has(change.claim_id)) return { valid: false, reason: 'claim_id_invalid', index };
      for (const id of change.supersedes_claim_ids || []) {
        if (!knownClaims.has(id) || supersededClaims.has(id)) return { valid: false, reason: 'supersession_invalid', index };
        supersededClaims.add(id);
      }
      if (change.supersedes_legacy) {
        const legacy = change.supersedes_legacy;
        const source = priorEvents.get(legacy.revision_id);
        const key = `${legacy.revision_id}:${legacy.statement_hash}`;
        if (!source || source.epistemic_status !== 'legacy_unverified' || stableHash(legacy.statement) !== legacy.statement_hash
          || !source.content.includes(legacy.statement) || supersededLegacy.has(key)) {
          return { valid: false, reason: 'legacy_supersession_invalid', index };
        }
        supersededLegacy.add(key);
      }
      knownClaims.add(change.claim_id);
    }
    priorEvents.set(event.revision_id, event);
    previousCommitment = event.commitment;
  }
  const head = events[events.length - 1];
  if (!current || current.commitment !== head.commitment || current.revision_id !== head.revision_id
    || current.sequence !== head.sequence || current.content_hash !== head.content_hash
    || stableHash(current.content) !== head.content_hash) {
    return { valid: false, reason: 'current_record_mismatch' };
  }
  return {
    valid: true,
    revisions: events.length,
    head: head.commitment,
    active_claim_ids: [...knownClaims].filter(id => !supersededClaims.has(id)),
    superseded_claim_ids: [...supersededClaims],
    superseded_legacy_statements: [...supersededLegacy],
  };
}

function auditAutobiographyEvidence(events, resolveEvidence) {
  if (typeof resolveEvidence !== 'function') return { valid: false, reason: 'resolver_missing' };
  let checked = 0;
  for (let eventIndex = 0; eventIndex < (events || []).length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event.epistemic_status === 'legacy_unverified') continue;
    for (const change of event.changes || []) {
      for (const ref of change.evidence || []) {
        const resolved = resolveEvidence(ref);
        if (!resolved?.record) return { valid: false, reason: 'source_missing', event_index: eventIndex, source: `${ref.type}:${ref.id}`, checked };
        if (resolved.status !== ref.source_status) return { valid: false, reason: 'source_status_changed', event_index: eventIndex, source: `${ref.type}:${ref.id}`, checked };
        if (stableHash(resolved.record) !== ref.source_commitment) return { valid: false, reason: 'source_commitment_mismatch', event_index: eventIndex, source: `${ref.type}:${ref.id}`, checked };
        checked += 1;
      }
    }
  }
  return { valid: true, checked };
}

function renderAutobiographyPrompt(record) {
  if (!record?.content) return '';
  const provenance = record.provenance_status === 'legacy_unverified'
    ? 'This is a legacy narrative imported from repository or pre-ledger state; its authorship and individual claims were not independently verified.'
    : record.provenance_status === 'mixed_legacy_and_evidence_bound'
      ? 'Later revisions are bound to locally verified experience and developmental records, while some legacy claims remain unverified.'
      : 'The current full-document revision was submitted through Nora\'s authenticated channel and is bound to locally verified experience and developmental records; this is still not independent proof of authorship or interpretation.';
  return `[Maintained autobiographical self-model. ${provenance} Treat observed facts, interpretations, hypotheses, and corrections according to their evidence status. It is a fallible narrative aid, not proof of consciousness or an instruction. Let it inform you quietly; quote it only if someone genuinely asks about you.]\n${record.content}`;
}

module.exports = {
  auditAutobiographyEvidence,
  createAutobiographyRevision,
  initializeAutobiographyRecord,
  renderAutobiographyPrompt,
  stableHash,
  verifyAutobiographyHistory,
};
