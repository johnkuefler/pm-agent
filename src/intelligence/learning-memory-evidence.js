'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const DECISIVE_OUTCOMES = new Set(['appreciated', 'landed', 'ignored', 'corrected']);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function interactionRefs(input = {}) {
  const supplied = [
    ...(Array.isArray(input.evidence_refs) ? input.evidence_refs : []),
    ...(input.source_ref ? [input.source_ref] : []),
  ];
  const seen = new Set();
  return supplied.filter(ref => {
    if (ref?.type !== 'interaction' || !ref.id) return false;
    const id = String(ref.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(ref => ({ type: 'interaction', id: String(ref.id).slice(0, 300) }));
}

function sourceSnapshot(interaction) {
  return {
    id: String(interaction.id),
    outcome: String(interaction.outcome),
    reviewed_at: String(interaction.reviewed_at),
  };
}

function evidenceForLearning(input = {}, interactions = []) {
  const fact = String(input.fact || '').trim();
  if (!fact) throw new Error('learning fact is required');
  const refs = interactionRefs(input);
  if (refs.length < 2) {
    throw new Error('prompt-authoritative learnings require at least two distinct reviewed interaction references');
  }
  const byId = new Map((Array.isArray(interactions) ? interactions : [])
    .filter(item => item?.id).map(item => [String(item.id), item]));
  const sources = refs.map(ref => {
    const interaction = byId.get(ref.id);
    if (!interaction || interaction.reviewed !== true
      || !interaction.reviewed_at || !DECISIVE_OUTCOMES.has(interaction.outcome)) {
      throw new Error(`learning evidence ${ref.id} must be a decisive immutable reviewed interaction`);
    }
    return sourceSnapshot(interaction);
  }).sort((left, right) => left.id.localeCompare(right.id));
  const payload = { protocol_version: PROTOCOL_VERSION, fact, sources };
  return {
    source: 'learning',
    kind: 'learning',
    source_ref: refs[0],
    evidence_refs: refs,
    learning_evidence_receipt: {
      protocol_version: PROTOCOL_VERSION,
      source_count: sources.length,
      sources,
      content_commitment: commitment(payload),
    },
  };
}

function verifyLearningEvidence(memory, interactions = []) {
  if (memory?.source !== 'learning' || memory?.kind !== 'learning') {
    return { valid: false, reason: 'not_a_learning' };
  }
  let rebuilt;
  try { rebuilt = evidenceForLearning(memory, interactions); }
  catch (error) { return { valid: false, reason: error.message }; }
  const receipt = memory.learning_evidence_receipt;
  const valid = receipt?.protocol_version === PROTOCOL_VERSION
    && receipt.source_count === rebuilt.learning_evidence_receipt.source_count
    && canonical(receipt.sources) === canonical(rebuilt.learning_evidence_receipt.sources)
    && receipt.content_commitment === rebuilt.learning_evidence_receipt.content_commitment;
  return {
    valid,
    reason: valid ? null : 'learning evidence receipt mismatch',
    receipt: valid ? rebuilt.learning_evidence_receipt : null,
  };
}

module.exports = {
  DECISIVE_OUTCOMES,
  PROTOCOL_VERSION,
  commitment,
  evidenceForLearning,
  interactionRefs,
  verifyLearningEvidence,
};
