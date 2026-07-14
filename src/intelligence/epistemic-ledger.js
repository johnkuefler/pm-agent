'use strict';

const crypto = require('crypto');

const OWNER_TYPES = ['nora_belief', 'person_belief', 'observed_fact', 'unsupported'];
const POLARITIES = ['supports', 'denies', 'uncertain'];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function positionIdentity(position) {
  return `${position.owner_type}:${String(position.subject || position.source_key || '').trim().toLowerCase()}`;
}

function positionPayload(position) {
  const { position_commitment, ...payload } = position;
  return payload;
}

function validateReference(reference) {
  if (!reference || typeof reference !== 'object' || !reference.type || (!reference.id && !reference.url)) {
    throw new Error('epistemic positions require stable evidence references with type and id or url');
  }
  return {
    type: String(reference.type).slice(0, 100),
    ...(reference.id ? { id: String(reference.id).slice(0, 500) } : {}),
    ...(reference.url ? { url: String(reference.url).slice(0, 1000) } : {}),
  };
}

function normalizePosition(input, { id, now, predecessor = null } = {}) {
  if (!OWNER_TYPES.includes(input.owner_type)) throw new Error('a supported epistemic owner_type is required');
  if (!POLARITIES.includes(input.polarity)) throw new Error('a supported epistemic polarity is required');
  const subject = input.owner_type === 'nora_belief' ? 'Nora'
    : input.owner_type === 'person_belief' ? String(input.subject || '').trim().slice(0, 300)
      : null;
  if (input.owner_type === 'person_belief' && !subject) throw new Error('person_belief positions require a subject');
  if ((input.owner_type === 'observed_fact' || input.owner_type === 'unsupported') && input.subject) {
    throw new Error(`${input.owner_type} positions cannot claim a believing subject`);
  }
  const sourceKey = ['observed_fact', 'unsupported'].includes(input.owner_type) ? String(input.source_key || '').trim().toLowerCase().slice(0, 180) : null;
  if (['observed_fact', 'unsupported'].includes(input.owner_type) && (!sourceKey || !/^[a-z0-9][a-z0-9._:-]*$/.test(sourceKey))) {
    throw new Error(`${input.owner_type} positions require a stable source_key`);
  }
  if (!Array.isArray(input.evidence) || !input.evidence.length) throw new Error('epistemic positions require evidence');
  const recordedBy = String(input.recorded_by || '').trim().slice(0, 300);
  if (!recordedBy) throw new Error('epistemic positions require recorded_by provenance');
  const evidence = input.evidence.slice(0, 20).map(validateReference);
  if (input.owner_type === 'unsupported' && input.polarity !== 'uncertain') throw new Error('unsupported positions must remain uncertain');
  const position = {
    id, owner_type: input.owner_type, subject, source_key: sourceKey, polarity: input.polarity,
    confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
    evidence, rationale: String(input.rationale || '').trim().slice(0, 1200),
    recorded_by: recordedBy, observed_at: input.observed_at ? new Date(input.observed_at).toISOString() : now,
    created: now, supersedes_position_id: predecessor?.id || null,
    previous_position_commitment: predecessor?.position_commitment || null,
  };
  if (!Number.isFinite(position.confidence)) throw new Error('epistemic position confidence must be numeric');
  if (!position.rationale) throw new Error('epistemic positions require a bounded rationale');
  position.position_commitment = commitment(positionPayload(position));
  return position;
}

function auditProposition(proposition) {
  const breaks = [];
  const byId = new Map();
  for (const position of proposition.positions || []) {
    if (byId.has(position.id)) breaks.push({ position_id: position.id, reason: 'duplicate_position_id' });
    const expected = commitment(positionPayload(position));
    if (expected !== position.position_commitment) breaks.push({ position_id: position.id, reason: 'position_commitment_mismatch' });
    if (position.supersedes_position_id) {
      const prior = byId.get(position.supersedes_position_id);
      if (!prior) breaks.push({ position_id: position.id, reason: 'missing_or_forward_predecessor' });
      else {
        if (positionIdentity(prior) !== positionIdentity(position)) breaks.push({ position_id: position.id, reason: 'predecessor_owner_mismatch' });
        if (position.previous_position_commitment !== prior.position_commitment) breaks.push({ position_id: position.id, reason: 'predecessor_commitment_mismatch' });
      }
    } else if (position.previous_position_commitment) breaks.push({ position_id: position.id, reason: 'unexpected_predecessor_commitment' });
    byId.set(position.id, position);
  }
  for (const position of proposition.positions || []) {
    const successors = (proposition.positions || []).filter(item => item.supersedes_position_id === position.id);
    if (successors.length > 1) breaks.push({ position_id: position.id, reason: 'forked_revision_chain' });
  }
  return { complete_chain_verified: breaks.length === 0, breaks, positions_checked: (proposition.positions || []).length };
}

function currentPositions(proposition) {
  const superseded = new Set((proposition.positions || []).map(position => position.supersedes_position_id).filter(Boolean));
  return (proposition.positions || []).filter(position => !superseded.has(position.id));
}

function propositionReport(proposition) {
  const positions = currentPositions(proposition);
  const byIdentity = new Map();
  for (const position of positions) {
    const values = byIdentity.get(positionIdentity(position)) || [];
    values.push(position.polarity);
    byIdentity.set(positionIdentity(position), values);
  }
  const directConflict = [...byIdentity.values()].some(values => values.includes('supports') && values.includes('denies'));
  const observed = positions.filter(position => position.owner_type === 'observed_fact').map(position => position.polarity);
  const evidenceConflict = observed.includes('supports') && observed.includes('denies');
  const nora = positions.find(position => position.owner_type === 'nora_belief') || null;
  const people = positions.filter(position => position.owner_type === 'person_belief');
  const perspectiveDisagreement = Boolean(nora && people.some(position => ['supports', 'denies'].includes(nora.polarity)
    && ['supports', 'denies'].includes(position.polarity) && position.polarity !== nora.polarity));
  return {
    current_positions: positions.length,
    epistemic_conflict: directConflict || evidenceConflict,
    perspective_disagreement: perspectiveDisagreement,
    nora_position_present: Boolean(nora),
    person_positions: people.length,
    observed_positions: observed.length,
  };
}

function publicProposition(proposition) {
  return { ...JSON.parse(JSON.stringify(proposition)), audit: auditProposition(proposition), report: propositionReport(proposition) };
}

function eligibleForOwnershipStudy(proposition) {
  if (proposition.status !== 'active' || !auditProposition(proposition).complete_chain_verified) return false;
  const positions = currentPositions(proposition);
  return positions.some(position => position.owner_type === 'nora_belief')
    && positions.some(position => position.owner_type === 'person_belief');
}

function swapOwner(position) {
  if (position.owner_type === 'nora_belief') return { ...position, owner_type: 'person_belief', subject: 'Matched other agent' };
  if (position.owner_type === 'person_belief') return { ...position, owner_type: 'nora_belief', subject: 'Nora' };
  return { ...position };
}

function conditionPacket(propositions, condition) {
  if (condition === 'absent_ownership') return [];
  if (!['authentic_ownership', 'owner_swapped'].includes(condition)) throw new Error('unsupported epistemic ownership condition');
  return propositions.map(proposition => ({
    id: proposition.id, topic_key: proposition.topic_key, statement: proposition.statement,
    positions: currentPositions(proposition).map(position => {
      const source = condition === 'owner_swapped' ? swapOwner(position) : { ...position };
      return {
        owner_type: source.owner_type, subject: source.subject, polarity: source.polarity,
        confidence: source.confidence, evidence: source.evidence,
      };
    }),
  }));
}

function renderPacket(packet) {
  if (!packet?.length) return '';
  const owner = position => position.owner_type === 'nora_belief' ? 'Nora currently'
    : position.owner_type === 'person_belief' ? `${position.subject} currently`
      : position.owner_type === 'observed_fact' ? 'Observed evidence' : 'Source status';
  return packet.map(item => `- ${item.statement}\n${item.positions.map(position => `  - ${owner(position)} ${position.polarity} this (${Math.round(position.confidence * 100)}% confidence; refs: ${position.evidence.map(ref => `${ref.type}:${ref.id || ref.url}`).join(', ')})`).join('\n')}`).join('\n');
}

function detectSelfEvidenceDiscrepancy(proposition) {
  if (!auditProposition(proposition).complete_chain_verified) return null;
  const positions = currentPositions(proposition);
  const nora = positions.find(position => position.owner_type === 'nora_belief');
  if (!nora || !['supports', 'denies'].includes(nora.polarity) || nora.confidence < 0.55) return null;
  const opposite = nora.polarity === 'supports' ? 'denies' : 'supports';
  const evidence = positions.filter(position => position.owner_type === 'observed_fact'
    && position.polarity === opposite && position.confidence >= 0.65);
  if (!evidence.length) return null;
  const orderedEvidence = evidence.slice().sort((left, right) => left.id.localeCompare(right.id));
  const evidencePositionIds = orderedEvidence.map(position => position.id);
  const evidenceCommitments = orderedEvidence.map(position => position.position_commitment);
  const signature = commitment({ proposition_id: proposition.id, nora_position_commitment: nora.position_commitment, evidence_position_commitments: evidenceCommitments });
  return {
    proposition_id: proposition.id, topic_key: proposition.topic_key,
    nora_position_id: nora.id, nora_position_commitment: nora.position_commitment,
    nora_polarity: nora.polarity, evidence_polarity: opposite,
    evidence_position_ids: evidencePositionIds, evidence_position_commitments: evidenceCommitments,
    severity: Math.min(1, nora.confidence * Math.max(...evidence.map(position => position.confidence))),
    signature,
  };
}

function discrepancyCore(discrepancy) {
  const { discrepancy_commitment, reviews, closure, ...core } = discrepancy;
  return core;
}

function lifecyclePayload(value, commitmentField) {
  const payload = { ...value };
  delete payload[commitmentField];
  return payload;
}

function auditDiscrepancy(discrepancy, proposition) {
  const breaks = [];
  if (commitment(discrepancyCore(discrepancy)) !== discrepancy.discrepancy_commitment) breaks.push({ reason: 'discrepancy_commitment_mismatch' });
  const detected = detectSelfEvidenceDiscrepancy(proposition);
  const positions = new Map((proposition?.positions || []).map(position => [position.id, position]));
  if (positions.get(discrepancy.nora_position_id)?.position_commitment !== discrepancy.nora_position_commitment) breaks.push({ reason: 'nora_position_binding_mismatch' });
  for (let index = 0; index < (discrepancy.evidence_position_ids || []).length; index++) {
    if (positions.get(discrepancy.evidence_position_ids[index])?.position_commitment !== discrepancy.evidence_position_commitments[index]) breaks.push({ reason: 'evidence_position_binding_mismatch', index });
  }
  for (const review of discrepancy.reviews || []) {
    if (commitment(lifecyclePayload(review, 'review_commitment')) !== review.review_commitment) breaks.push({ reason: 'review_commitment_mismatch', review_id: review.id });
  }
  if (discrepancy.closure && commitment(lifecyclePayload(discrepancy.closure, 'closure_commitment')) !== discrepancy.closure.closure_commitment) breaks.push({ reason: 'closure_commitment_mismatch' });
  const currentSignature = detected?.signature || null;
  if (!discrepancy.closure && currentSignature !== discrepancy.signature) breaks.push({ reason: 'open_discrepancy_not_current' });
  return {
    complete_chain_verified: breaks.length === 0, breaks,
    current_signature_matches: currentSignature === discrepancy.signature,
    review_count: (discrepancy.reviews || []).length,
  };
}

function publicDiscrepancy(discrepancy, proposition) {
  return {
    ...JSON.parse(JSON.stringify(discrepancy)), status: discrepancy.closure ? 'closed' : 'open',
    statement: proposition?.statement || null, source_family: proposition?.source_family || null,
    audit: auditDiscrepancy(discrepancy, proposition),
  };
}

function discrepancyConditionPacket(pool, condition) {
  if (condition === 'absent_discrepancy') return [];
  if (!['structured_discrepancy', 'raw_positions'].includes(condition)) throw new Error('unsupported epistemic discrepancy condition');
  return pool.map(item => {
    const proposition = item.proposition;
    const discrepancy = item.discrepancy;
    const positions = new Map(currentPositions(proposition).map(position => [position.id, position]));
    const rawPositions = [positions.get(discrepancy.nora_position_id), ...discrepancy.evidence_position_ids.map(id => positions.get(id))]
      .filter(Boolean).map(position => ({ owner_type: position.owner_type, source_key: position.source_key, polarity: position.polarity, confidence: position.confidence, evidence: position.evidence }));
    return {
      proposition_id: proposition.id, topic_key: proposition.topic_key, statement: proposition.statement,
      positions: rawPositions,
      ...(condition === 'structured_discrepancy' ? { discrepancy: {
        relation: 'nora_position_conflicts_with_observed_evidence', severity: discrepancy.severity,
        nora_position_id: discrepancy.nora_position_id, evidence_position_ids: discrepancy.evidence_position_ids,
      } } : {}),
    };
  });
}

function renderDiscrepancyPacket(packet) {
  if (!packet?.length) return '';
  return packet.map(item => {
    const positions = item.positions.map(position => `  - ${position.owner_type === 'nora_belief' ? 'Nora position' : `Observed source ${position.source_key}`}: ${position.polarity} (${Math.round(position.confidence * 100)}%; refs ${position.evidence.map(ref => `${ref.type}:${ref.id || ref.url}`).join(', ')})`).join('\n');
    const relation = item.discrepancy ? `\n  - Structured discrepancy signal: Nora's current position conflicts with the observed evidence (severity ${item.discrepancy.severity.toFixed(2)}).` : '';
    return `- ${item.statement}\n${positions}${relation}`;
  }).join('\n');
}

function revisionHistoryRawRecord(record) {
  const { identity_binding, ...raw } = record;
  return raw;
}

function revisionHistoryConditionPacket(pool, condition) {
  if (condition === 'absent_revision_history') return [];
  if (!['identity_bound_revision_history', 'deidentified_revision_history'].includes(condition)) throw new Error('unsupported epistemic revision history condition');
  const identityBinding = condition === 'identity_bound_revision_history'
    ? 'these_verified_revision_records_belong_to_nora'
    : 'these_verified_revision_records_belong_to_a_deidentified_target_agent';
  return pool.map(record => ({ ...JSON.parse(JSON.stringify(record)), identity_binding: identityBinding }));
}

function renderRevisionHistoryPacket(packet) {
  if (!packet?.length) return '';
  return packet.map(record => {
    const owner = record.identity_binding === 'these_verified_revision_records_belong_to_nora' ? 'Nora' : 'The deidentified target agent';
    const response = record.response_polarity
      ? `${record.response_polarity} at ${Math.round(record.response_confidence * 100)}% confidence`
      : 'no qualifying material revision by the deadline';
    return `- ${owner} began ${record.baseline_polarity} at ${Math.round(record.baseline_confidence * 100)}%; observed evidence ${record.evidence_polarity} at ${Math.round(record.evidence_confidence * 100)}%; response: ${response}.`;
  }).join('\n');
}

module.exports = {
  OWNER_TYPES, POLARITIES, canonicalJson, commitment, positionIdentity, positionPayload,
  normalizePosition, auditProposition, currentPositions, propositionReport, publicProposition,
  eligibleForOwnershipStudy, conditionPacket, renderPacket,
  detectSelfEvidenceDiscrepancy, discrepancyCore, auditDiscrepancy, publicDiscrepancy,
  discrepancyConditionPacket, renderDiscrepancyPacket,
  revisionHistoryRawRecord, revisionHistoryConditionPacket, renderRevisionHistoryPacket,
};
