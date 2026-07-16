'use strict';

const epistemicLedger = require('./epistemic-ledger');

const PROTOCOL_VERSION = 1;
const ACKNOWLEDGMENT_KINDS = Object.freeze([
  'explicit_acknowledgment',
  'accurate_restatement',
  'coordinated_action',
  'targeted_correction',
]);

function validEvidence(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref && typeof ref === 'object'
    && String(ref.type || ref.channel || '').trim() && String(ref.id || ref.url || '').trim());
}

function currentPosition(proposition, id) {
  return epistemicLedger.currentPositions(proposition).find(item => item.id === id) || null;
}

function relationFor(nora, person) {
  if (!nora || !person) return null;
  if (nora.polarity === person.polarity && ['supports', 'denies'].includes(nora.polarity)) {
    return 'aligned_position';
  }
  if (['supports', 'denies'].includes(nora.polarity)
    && ['supports', 'denies'].includes(person.polarity)) return 'known_disagreement';
  return 'shared_uncertainty';
}

function propositionIdentity(proposition) {
  return {
    id: proposition.id, topic_key: proposition.topic_key, statement: proposition.statement,
    proposition_kind: proposition.proposition_kind || 'neutral',
    source_family: proposition.source_family,
    source_family_evidence: proposition.source_family_evidence,
    created: proposition.created,
  };
}

function formationPayload(record) {
  const payload = { ...record };
  delete payload.formation_commitment;
  delete payload.independent_review;
  delete payload.independent_review_commitment;
  delete payload.status;
  delete payload.updated;
  return payload;
}

function createCandidate(input, proposition, { id, now, cognitiveAccessSealed = false } = {}) {
  if (!proposition || !epistemicLedger.auditProposition(proposition).complete_chain_verified) {
    throw new Error('common ground requires a replay-valid epistemic proposition');
  }
  const person = String(input.person || '').trim().slice(0, 300);
  const noraPosition = currentPosition(proposition, input.nora_position_id);
  const personPosition = currentPosition(proposition, input.person_position_id);
  if (!person || noraPosition?.owner_type !== 'nora_belief'
    || personPosition?.owner_type !== 'person_belief'
    || personPosition.subject.toLowerCase() !== person.toLowerCase()) {
    throw new Error('common ground requires current Nora and matching-person position ids');
  }
  if (!ACKNOWLEDGMENT_KINDS.includes(input.acknowledgment_kind)) {
    throw new Error('common ground requires an observable acknowledgment kind');
  }
  if (!validEvidence(input.evidence)) throw new Error('common ground requires stable uptake evidence');
  const summary = String(input.summary || '').trim().slice(0, 1200);
  if (summary.length < 20) throw new Error('common ground requires a bounded observable summary');
  const at = new Date(now || new Date()).toISOString();
  const observedAt = input.observed_at ? new Date(input.observed_at) : new Date(at);
  if (!Number.isFinite(observedAt.getTime()) || observedAt > new Date(at)) {
    throw new Error('common-ground uptake evidence cannot be future-dated');
  }
  const expiresAt = new Date(input.expires_at || new Date(new Date(at).getTime() + 30 * 86400000));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date(at)
    || expiresAt.getTime() - new Date(at).getTime() > 90 * 86400000) {
    throw new Error('common ground expiry must be future bounded within ninety days');
  }
  const record = {
    protocol_version: PROTOCOL_VERSION,
    id, proposition_id: proposition.id, topic_key: proposition.topic_key,
    statement: proposition.statement,
    proposition_identity_commitment: epistemicLedger.commitment(propositionIdentity(proposition)),
    person, nora_position_id: noraPosition.id,
    nora_position_commitment: noraPosition.position_commitment,
    person_position_id: personPosition.id,
    person_position_commitment: personPosition.position_commitment,
    relation: relationFor(noraPosition, personPosition),
    acknowledgment_kind: input.acknowledgment_kind,
    summary, evidence: input.evidence.slice(0, 20).map(ref => ({
      type: String(ref.type || ref.channel).slice(0, 100),
      ...(ref.id ? { id: String(ref.id).slice(0, 500) } : {}),
      ...(ref.url ? { url: String(ref.url).slice(0, 1000) } : {}),
    })),
    observed_at: observedAt.toISOString(),
    expires_at: expiresAt.toISOString(), created: at,
    cognitive_access_sealed_at_formation: cognitiveAccessSealed === true,
    independent_review: null, independent_review_commitment: null,
    status: 'awaiting_independent_review', updated: at,
  };
  record.formation_commitment = epistemicLedger.commitment(formationPayload(record));
  return record;
}

function audit(record, propositions = [], now = new Date(), ledger = null) {
  const proposition = propositions.find(item => item.id === record?.proposition_id);
  const propositionVerified = Boolean(proposition
    && epistemicLedger.auditProposition(proposition).complete_chain_verified
    && epistemicLedger.commitment(propositionIdentity(proposition))
      === record.proposition_identity_commitment
    && proposition.topic_key === record.topic_key && proposition.statement === record.statement);
  const nora = proposition && currentPosition(proposition, record.nora_position_id);
  const person = proposition && currentPosition(proposition, record.person_position_id);
  const positionBindingVerified = Boolean(nora?.owner_type === 'nora_belief'
    && nora.position_commitment === record.nora_position_commitment
    && person?.owner_type === 'person_belief'
    && person.position_commitment === record.person_position_commitment
    && person.subject.toLowerCase() === String(record.person || '').toLowerCase()
    && record.relation === relationFor(nora, person));
  const createdAt = new Date(record?.created);
  const observedAt = new Date(record?.observed_at);
  const formationVerified = Boolean(record?.protocol_version === PROTOCOL_VERSION
    && String(record?.id || '').trim() && String(record?.person || '').trim()
    && [true, false].includes(record.cognitive_access_sealed_at_formation ?? false)
    && ACKNOWLEDGMENT_KINDS.includes(record.acknowledgment_kind)
    && String(record.summary || '').trim().length >= 20 && validEvidence(record.evidence)
    && Number.isFinite(createdAt.getTime()) && Number.isFinite(observedAt.getTime())
    && observedAt <= createdAt && ['aligned_position', 'known_disagreement', 'shared_uncertainty'].includes(record.relation)
    && record.formation_commitment === epistemicLedger.commitment(formationPayload(record)));
  const reviewPresent = Boolean(record?.independent_review || record?.independent_review_commitment);
  const review = record?.independent_review;
  const reviewVerified = !reviewPresent || Boolean(review && record.independent_review_commitment
    && review.formation_commitment === record.formation_commitment
    && ['verified', 'not_verified', 'unclear'].includes(review.outcome)
    && String(review.evaluator_id || '').trim() && String(review.rationale || '').trim().length >= 10
    && validEvidence(review.evidence)
    && Number.isFinite(new Date(review.reviewed_at).getTime())
    && new Date(review.reviewed_at) >= new Date(record.created)
    && epistemicLedger.commitment(review) === record.independent_review_commitment);
  const expectedStatus = review?.outcome === 'verified' ? 'independently_verified'
    : review?.outcome === 'not_verified' ? 'independently_rejected'
      : review?.outcome === 'unclear' ? 'inconclusive' : 'awaiting_independent_review';
  const lifecycleVerified = record?.status === expectedStatus
    && (reviewPresent === (record.status !== 'awaiting_independent_review'));
  const expires = new Date(record?.expires_at);
  const temporallyValid = Number.isFinite(expires.getTime()) && expires > new Date(record?.created)
    && expires.getTime() - new Date(record.created).getTime() <= 90 * 86400000;
  const current = temporallyValid && expires > new Date(now);
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  const formationPayloadCommitment = epistemicLedger.commitment({
    formation_commitment: record?.formation_commitment, proposition_id: record?.proposition_id,
  });
  const formationLedgerBound = events.filter(event => event.kind === 'common_ground_candidate_formed'
    && event.subject_id === record?.id
    && event.payload_commitment === formationPayloadCommitment).length === 1;
  const reviewPayloadCommitment = review ? epistemicLedger.commitment({
    formation_commitment: record.formation_commitment,
    independent_review_commitment: record.independent_review_commitment,
    outcome: review.outcome,
  }) : null;
  const reviewLedgerBound = !reviewPresent || events.filter(event =>
    event.kind === 'common_ground_independently_reviewed' && event.subject_id === record?.id
    && event.payload_commitment === reviewPayloadCommitment).length === 1;
  const ledgerBindingVerified = formationLedgerBound && reviewLedgerBound;
  const complete = propositionVerified && positionBindingVerified && formationVerified
    && reviewVerified && lifecycleVerified && temporallyValid && ledgerBindingVerified;
  return {
    proposition_verified: propositionVerified,
    position_binding_verified: positionBindingVerified,
    formation_verified: formationVerified,
    independent_review_present: reviewPresent,
    independent_review_verified: reviewVerified,
    lifecycle_verified: lifecycleVerified,
    ledger_binding_verified: ledgerBindingVerified,
    temporally_valid: temporallyValid,
    current,
    final_evidence_eligible: complete && current && record.status === 'independently_verified',
    complete_chain_verified: complete,
  };
}

function verifiedRecords(records = [], propositions = [], now = new Date(), ledger = null) {
  return records.filter(record => audit(record, propositions, now, ledger).final_evidence_eligible);
}

function terms(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []))];
}

function relevance(record, query) {
  const queryTerms = terms(query);
  if (!queryTerms.length) return 0;
  const haystack = `${record.topic_key} ${record.statement} ${record.summary}`.toLowerCase();
  return queryTerms.filter(term => haystack.includes(term)).length;
}

function frame({ person, query = '', records = [], propositions = [], now = new Date(), ledger = null } = {}) {
  const normalized = String(person || '').trim().toLowerCase();
  if (!normalized) return null;
  const established = verifiedRecords(records, propositions, now, ledger)
    .filter(record => record.person.toLowerCase() === normalized)
    .map(record => ({ record, relevance: relevance(record, query) }))
    .filter(item => item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.record.updated.localeCompare(a.record.updated))
    .slice(0, 6).map(item => item.record);
  const establishedPropositions = new Set(established.map(record => record.proposition_id));
  const queryTerms = terms(query);
  const notEstablished = queryTerms.length ? propositions
    .filter(proposition => proposition.status === 'active'
      && epistemicLedger.auditProposition(proposition).complete_chain_verified
      && !establishedPropositions.has(proposition.id)
      && epistemicLedger.currentPositions(proposition).some(position => position.owner_type === 'nora_belief')
      && queryTerms.some(term => `${proposition.topic_key} ${proposition.statement}`.toLowerCase().includes(term)))
    .slice(0, 4).map(proposition => ({ proposition_id: proposition.id,
      topic_key: proposition.topic_key, statement: proposition.statement })) : [];
  if (!established.length && !notEstablished.length) return null;
  const body = {
    protocol_version: 1, person,
    established: established.map(record => ({
      common_ground_id: record.id, proposition_id: record.proposition_id,
      topic_key: record.topic_key, statement: record.statement, relation: record.relation,
      acknowledgment_kind: record.acknowledgment_kind, summary: record.summary,
      evidence: record.evidence, expires_at: record.expires_at,
    })),
    not_established: notEstablished,
    epistemic_boundary: 'Not established means only that this ledger lacks verified mutual-availability evidence. It is never evidence that the person is ignorant, confused, or privately believes otherwise.',
  };
  return { ...body, frame_commitment: epistemicLedger.commitment(body) };
}

module.exports = {
  ACKNOWLEDGMENT_KINDS, PROTOCOL_VERSION, audit, createCandidate, formationPayload,
  frame, propositionIdentity, relationFor, validEvidence, verifiedRecords,
};
