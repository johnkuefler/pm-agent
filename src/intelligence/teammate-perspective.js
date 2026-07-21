'use strict';

const crypto = require('crypto');
const slackEvidence = require('./slack-evidence');

const PROTOCOL_VERSION = 2;
const SOURCE_REPLAY_CONTRACT_VERSION = 1;
const AUTOMATED_REVIEW_PROTOCOL_VERSION = 1;
const AUTOMATED_EVALUATOR_PREFIX = 'provider-disjoint-openai-teammate-perspective:';
const DIMENSIONS = Object.freeze([
  'communication_format',
  'clarification_need',
  'decision_concern',
  'coordination_pattern',
]);
const FORBIDDEN_INFERENCE = /\b(personality|temperament|character trait|feels?|feelings?|thinks?|thoughts?|believes?|beliefs?|intends?|intentions?|wants?|motives?|motivation|private state|inner state|mental state|diagnos(?:is|e|ed)|personality disorder|depress(?:ed|ion)|anxi(?:ous|ety)|adhd|autis(?:m|tic)|psychopath|sentien(?:t|ce)|consciousness|qualia|intimacy|intimate)\b/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validEvidenceRefs(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref && typeof ref === 'object'
    && String(ref.type || ref.channel || '').trim() && String(ref.id || ref.url || '').trim());
}

function validCanonicalEvidenceRefs(refs) {
  if (!validEvidenceRefs(refs)) return false;
  const parsed = refs.map(slackEvidence.parseCanonicalMessageRef);
  return parsed.every(Boolean) && new Set(parsed.map(ref => ref.id)).size === parsed.length;
}

function containsForbiddenInference(...values) {
  return values.flat(Infinity).some(value => FORBIDDEN_INFERENCE.test(String(value || '')));
}

function automationReceiptPayload(receipt = {}) {
  const payload = JSON.parse(JSON.stringify(receipt || {}));
  delete payload.receipt_commitment;
  return payload;
}

function validFormationAutomation(formation = {}) {
  if (!formation.automation_receipt && !formation.automation_packet && !formation.automation_output) return true;
  const receipt = formation.automation_receipt;
  const packet = formation.automation_packet;
  const output = formation.automation_output;
  const dueDays = Math.round((new Date(formation.prediction?.due_at).getTime()
    - new Date(formation.formed_at).getTime()) / 86400000);
  const sourceInteractions = Array.isArray(packet?.source_interactions) ? packet.source_interactions : [];
  const sourceIds = sourceInteractions.map(item => item?.id);
  const sourceReviewCommitments = sourceInteractions.map(item => item?.review_commitment);
  const packetEvidenceIds = sourceInteractions.flatMap(item => Array.isArray(item?.evidence)
    ? item.evidence.map(evidence => evidence?.ref?.id) : []);
  const allowedEvidenceIds = Array.isArray(packet?.allowed_evidence_ids)
    ? packet.allowed_evidence_ids : [];
  const sourceDays = new Set(sourceInteractions.map(item => String(item?.created || '').slice(0, 10))
    .filter(Boolean));
  return Boolean(receipt && packet && output
    && receipt.protocol_version === 1 && receipt.provider === 'anthropic'
    && String(receipt.model || '').trim() && String(receipt.response_id || '').trim()
    && (receipt.response_model === receipt.model
      || String(receipt.response_model || '').startsWith(`${receipt.model}-`))
    && packet.protocol_version === 1 && packet.person === formation.person
    && packet.formed_at === formation.formed_at
    && Array.isArray(packet.allowed_dimensions)
    && canonicalJson(packet.allowed_dimensions) === canonicalJson(DIMENSIONS)
    && String(packet.epistemic_boundary || '').trim()
    && sourceInteractions.length >= 2 && sourceInteractions.length <= 6
    && sourceDays.size >= 2
    && sourceIds.every(value => String(value || '').trim())
    && new Set(sourceIds).size === sourceIds.length
    && sourceReviewCommitments.every(value => /^[a-f0-9]{64}$/i.test(String(value || '')))
    && packetEvidenceIds.every(value => String(value || '').trim())
    && new Set(packetEvidenceIds).size === packetEvidenceIds.length
    && canonicalJson(allowedEvidenceIds) === canonicalJson(packetEvidenceIds.slice(0, 12))
    && receipt.packet_commitment === commitment(packet)
    && /^[a-f0-9]{64}$/i.test(String(receipt.prompt_protocol_commitment || ''))
    && Array.isArray(receipt.source_interaction_ids) && receipt.source_interaction_ids.length >= 2
    && new Set(receipt.source_interaction_ids).size === receipt.source_interaction_ids.length
    && Array.isArray(receipt.source_review_commitments)
    && receipt.source_review_commitments.length === receipt.source_interaction_ids.length
    && receipt.source_review_commitments.every(value => /^[a-f0-9]{64}$/i.test(String(value || '')))
    && canonicalJson(receipt.source_interaction_ids) === canonicalJson(sourceIds)
    && canonicalJson(receipt.source_review_commitments) === canonicalJson(sourceReviewCommitments)
    && receipt.created_at === formation.formed_at
    && !containsForbiddenInference(output.hypothesis, output.observable,
      output.falsification_criteria, output.rationale)
    && receipt.output_commitment === commitment(output)
    && receipt.receipt_commitment === commitment(automationReceiptPayload(receipt))
    && output.hypothesis === formation.hypothesis
    && output.dimension === formation.dimension
    && Number(output.confidence) === Number(formation.confidence)
    && output.observable === formation.prediction.observable
    && Number(output.due_days) === dueDays
    && Number(output.probability) === Number(formation.prediction.probability)
    && Number(output.control_probability) === Number(formation.prediction.control_probability)
    && canonicalJson(output.falsification_criteria) === canonicalJson(formation.prediction.falsification_criteria)
    && canonicalJson(output.evidence_ids) === canonicalJson(formation.evidence.map(ref => ref.id))
    && output.evidence_ids.every(id => allowedEvidenceIds.includes(id)));
}

function automatedReviewReceiptPayload(receipt = {}) {
  const payload = JSON.parse(JSON.stringify(receipt || {}));
  delete payload.receipt_commitment;
  return payload;
}

function validAutomatedReviewReceipt(receipt, evidence, outcome, evaluatorId) {
  if (!receipt || typeof receipt !== 'object') return false;
  const reviews = Array.isArray(receipt.reviews) ? receipt.reviews : [];
  const sourceCommitments = Array.isArray(receipt.source_readback_commitments)
    ? receipt.source_readback_commitments : [];
  const evidenceCommitments = (evidence || []).map(ref => commitment(ref)).sort();
  const receiptEvidenceCommitments = sourceCommitments.map(item => item?.evidence_ref_commitment).sort();
  const roles = reviews.map(item => item?.role).sort();
  const responseIds = reviews.map(item => item?.response_id);
  const reviewOutcomes = reviews.map(item => item?.outcome);
  const replayedConsensus = reviewOutcomes.length === 2 && reviewOutcomes[0] === reviewOutcomes[1]
    ? reviewOutcomes[0] : 'unclear';
  return Boolean(receipt.protocol_version === AUTOMATED_REVIEW_PROTOCOL_VERSION
    && receipt.provider === 'openai' && receipt.subject_provider === 'anthropic'
    && receipt.provider_disjoint_from_subject === true && receipt.condition_blind === true
    && receipt.subject_outcome_blind === true && receipt.store === false
    && String(receipt.model || '').trim()
    && String(evaluatorId || '').startsWith(AUTOMATED_EVALUATOR_PREFIX)
    && receipt.evaluator_id === evaluatorId && receipt.consensus_outcome === outcome
    && /^[a-f0-9]{64}$/i.test(String(receipt.packet_commitment || ''))
    && sourceCommitments.length === evidenceCommitments.length
    && new Set(receiptEvidenceCommitments).size === receiptEvidenceCommitments.length
    && JSON.stringify(receiptEvidenceCommitments) === JSON.stringify(evidenceCommitments)
    && sourceCommitments.every(item => /^[a-f0-9]{64}$/i.test(String(item?.snapshot_commitment || '')))
    && reviews.length === 2 && JSON.stringify(roles) === JSON.stringify(['evidence_first', 'failure_first'])
    && new Set(responseIds).size === 2 && receipt.consensus_outcome === replayedConsensus
    && reviews.every(item => item && item.model === receipt.model && item.status === 'completed'
      && ['supported', 'contradicted', 'unclear'].includes(item.outcome)
      && (item.response_model === receipt.model
        || String(item.response_model || '').startsWith(`${receipt.model}-`))
      && item.packet_commitment === receipt.packet_commitment && String(item.response_id || '').trim()
      && /^[a-f0-9]{64}$/i.test(String(item.prompt_protocol_commitment || ''))
      && /^[a-f0-9]{64}$/i.test(String(item.output_commitment || '')))
    && receipt.receipt_commitment === commitment(automatedReviewReceiptPayload(receipt)));
}

function validFormation(formation) {
  const formedAt = new Date(formation?.formed_at);
  const dueAt = new Date(formation?.prediction?.due_at);
  const probability = Number(formation?.prediction?.probability);
  const controlProbability = Number(formation?.prediction?.control_probability);
  return Boolean(formation?.protocol_version === PROTOCOL_VERSION
    && String(formation?.id || '').trim() && String(formation?.person || '').trim()
    && String(formation?.hypothesis || '').trim().length >= 20
    && !containsForbiddenInference(formation?.hypothesis, formation?.prediction?.observable,
      formation?.prediction?.falsification_criteria)
    && DIMENSIONS.includes(formation?.dimension)
    && Number(formation?.confidence) >= 0.1 && Number(formation?.confidence) <= 0.7
    && validEvidenceRefs(formation?.evidence)
    && (formation.source_replay_contract_version == null
      || (formation.source_replay_contract_version === SOURCE_REPLAY_CONTRACT_VERSION
        && validCanonicalEvidenceRefs(formation.evidence)))
    && String(formation?.prediction?.observable || '').trim().length >= 10
    && Array.isArray(formation?.prediction?.falsification_criteria)
    && formation.prediction.falsification_criteria.some(item => String(item || '').trim())
    && Number.isFinite(formedAt.getTime()) && Number.isFinite(dueAt.getTime())
    && dueAt > formedAt && dueAt.getTime() - formedAt.getTime() <= 30 * 86400000
    && probability >= 0.1 && probability <= 0.9
    && controlProbability >= 0.1 && controlProbability <= 0.9
    && validFormationAutomation(formation));
}

function auditPerspective(perspective, relationshipName = '') {
  const formation = perspective?.formation_record;
  const formationValid = validFormation(formation);
  const formationCommitmentVerified = Boolean(formationValid && perspective?.formation_commitment
    && commitment(formation) === perspective.formation_commitment);
  const projectionMatchesFormation = Boolean(formation
    && perspective?.protocol_version === PROTOCOL_VERSION
    && perspective?.id === formation.id && perspective?.person === formation.person
    && perspective?.hypothesis === formation.hypothesis && perspective?.dimension === formation.dimension
    && Number(perspective?.confidence) === Number(formation.confidence)
    && perspective?.created === formation.formed_at
    && String(relationshipName).trim().toLowerCase() === String(formation.person).trim().toLowerCase());
  const resolutionPresent = Boolean(perspective?.resolution_record || perspective?.resolution_commitment);
  const resolutionVerified = !resolutionPresent || Boolean(perspective.resolution_record
    && perspective.resolution_commitment
    && perspective.resolution_record.formation_commitment === perspective.formation_commitment
    && commitment(perspective.resolution_record) === perspective.resolution_commitment);
  const resolvedAt = new Date(perspective?.resolution_record?.resolved_at);
  const resolutionSemanticsVerified = !resolutionPresent || Boolean(
    ['supported', 'contradicted', 'unclear', 'retired'].includes(perspective.resolution_record?.outcome)
    && String(perspective.resolution_record?.observed || '').trim().length >= 10
    && validEvidenceRefs(perspective.resolution_record?.evidence)
    && (perspective.resolution_record?.source_replay_contract_version == null
      || (perspective.resolution_record.source_replay_contract_version === SOURCE_REPLAY_CONTRACT_VERSION
        && validCanonicalEvidenceRefs(perspective.resolution_record.evidence)))
    && Number.isFinite(resolvedAt.getTime()) && resolvedAt > new Date(formation?.formed_at));
  const independentReviewPresent = Boolean(perspective?.independent_review
    || perspective?.independent_review_commitment);
  const automatedReceiptRequired = String(perspective?.independent_review?.evaluator_id || '')
    .startsWith(AUTOMATED_EVALUATOR_PREFIX);
  const automatedReceiptVerified = !independentReviewPresent || (!automatedReceiptRequired
    ? !perspective?.independent_review?.automated_review_receipt
    : validAutomatedReviewReceipt(perspective.independent_review.automated_review_receipt,
      perspective.independent_review.evidence, perspective.independent_review.outcome,
      perspective.independent_review.evaluator_id));
  const independentReviewVerified = !independentReviewPresent || Boolean(perspective.independent_review
    && perspective.independent_review_commitment
    && perspective.independent_review.formation_commitment === perspective.formation_commitment
    && perspective.independent_review.resolution_commitment === perspective.resolution_commitment
    && automatedReceiptVerified
    && commitment(perspective.independent_review) === perspective.independent_review_commitment);
  const independentReviewSemanticsVerified = !independentReviewPresent || Boolean(
    ['supported', 'contradicted', 'unclear'].includes(perspective.independent_review?.outcome)
    && String(perspective.independent_review?.evaluator_id || '').trim()
    && String(perspective.independent_review?.rationale || '').trim().length >= 10
    && validEvidenceRefs(perspective.independent_review?.evidence)
    && perspective.independent_review?.subject_outcome === perspective.resolution_record?.outcome
    && perspective.independent_review?.subject_agreement
      === (perspective.independent_review?.outcome === perspective.resolution_record?.outcome)
    && Number.isFinite(new Date(perspective.independent_review?.reviewed_at).getTime())
    && new Date(perspective.independent_review.reviewed_at) >= resolvedAt);
  const finalOutcomes = {
    independently_supported: 'supported',
    independently_contradicted: 'contradicted',
    inconclusive: 'unclear',
  };
  const expectedReviewOutcome = finalOutcomes[perspective?.status];
  const statusLifecycleVerified = perspective?.status === 'open'
    ? !resolutionPresent && !independentReviewPresent
    : perspective?.status === 'awaiting_independent_review'
      ? resolutionPresent && !independentReviewPresent
        && ['supported', 'contradicted', 'unclear'].includes(perspective.resolution_record?.outcome)
      : perspective?.status === 'retired'
        ? resolutionPresent && !independentReviewPresent && perspective.resolution_record?.outcome === 'retired'
        : Boolean(expectedReviewOutcome && resolutionPresent && independentReviewPresent
          && perspective.independent_review?.outcome === expectedReviewOutcome);
  const completeChainVerified = formationCommitmentVerified && projectionMatchesFormation
    && resolutionVerified && resolutionSemanticsVerified && independentReviewVerified
    && independentReviewSemanticsVerified && statusLifecycleVerified;
  return {
    protocol_version: perspective?.protocol_version || null,
    formation_valid: formationValid,
    formation_commitment_verified: formationCommitmentVerified,
    projection_matches_formation: projectionMatchesFormation,
    resolution_present: resolutionPresent,
    resolution_verified: resolutionVerified,
    resolution_semantics_verified: resolutionSemanticsVerified,
    independent_review_present: independentReviewPresent,
    independent_review_verified: independentReviewVerified,
    independent_review_semantics_verified: independentReviewSemanticsVerified,
    automated_review_receipt_verified: automatedReceiptVerified,
    status_lifecycle_verified: statusLifecycleVerified,
    final_evidence_eligible: Boolean(expectedReviewOutcome && completeChainVerified),
    scored_evidence_eligible: Boolean(['supported', 'contradicted'].includes(expectedReviewOutcome)
      && completeChainVerified),
    complete_chain_verified: completeChainVerified,
  };
}

function perspectiveSnapshot(perspective) {
  return JSON.parse(JSON.stringify(perspective));
}

function reviewedPerspectives(relationship) {
  return (relationship?.perspectives || []).filter(item =>
    auditPerspective(item, relationship?.name).final_evidence_eligible);
}

function scoredOutcome(perspective) {
  const outcome = perspective?.independent_review?.outcome;
  return outcome === 'supported' ? 1 : outcome === 'contradicted' ? 0 : null;
}

function brier(records, key) {
  if (!records.length) return null;
  return records.reduce((sum, item) => {
    const probability = Number(item.formation_record.prediction[key]);
    const outcome = scoredOutcome(item);
    return sum + (probability - outcome) ** 2;
  }, 0) / records.length;
}

function buildFrame(relationship) {
  const reviewed = reviewedPerspectives(relationship);
  const scored = reviewed.filter(item => scoredOutcome(item) != null);
  const dimensions = [...new Set(scored.map(item => item.dimension))].sort();
  if (scored.length < 3 || dimensions.length < 2) return null;
  const sources = scored.map(perspectiveSnapshot)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.id.localeCompare(b.id));
  const selfBrier = brier(sources, 'probability');
  const controlBrier = brier(sources, 'control_probability');
  if (selfBrier >= controlBrier) return null;
  const body = {
    protocol_version: 1,
    relationship_id: relationship.id,
    person: relationship.name,
    source_perspective_ids: sources.map(item => item.id),
    source_commitments: sources.map(item => item.independent_review_commitment),
    dimensions,
    scored_prediction_count: sources.length,
    supported_patterns: sources.filter(item => item.independent_review.outcome === 'supported')
      .map(item => ({ dimension: item.dimension, hypothesis: item.hypothesis,
        confidence: item.confidence, observable: item.formation_record.prediction.observable,
        falsification_criteria: [...item.formation_record.prediction.falsification_criteria] })),
    contradicted_patterns: sources.filter(item => item.independent_review.outcome === 'contradicted')
      .map(item => ({ dimension: item.dimension, hypothesis: item.hypothesis,
        observable: item.formation_record.prediction.observable })),
    calibration: {
      brier: selfBrier,
      control_brier: controlBrier,
      advantage_over_control: controlBrier - selfBrier,
    },
    source_records: sources,
  };
  return { ...body, frame_commitment: commitment(body) };
}

function verifyFrame(frame, relationships = []) {
  const relationship = relationships.find(item => item.id === frame?.relationship_id
    && String(item.name).trim().toLowerCase() === String(frame?.person).trim().toLowerCase());
  const rebuilt = relationship ? buildFrame(relationship) : null;
  return Boolean(rebuilt && canonicalJson(rebuilt) === canonicalJson(frame));
}

function frames(relationships = []) {
  return relationships.map(buildFrame).filter(Boolean);
}

module.exports = {
  AUTOMATED_EVALUATOR_PREFIX, AUTOMATED_REVIEW_PROTOCOL_VERSION, DIMENSIONS, PROTOCOL_VERSION,
  SOURCE_REPLAY_CONTRACT_VERSION, auditPerspective, automatedReviewReceiptPayload, buildFrame,
  automationReceiptPayload, canonicalJson, commitment, containsForbiddenInference, frames, reviewedPerspectives,
  validAutomatedReviewReceipt, validFormationAutomation,
  validCanonicalEvidenceRefs, validEvidenceRefs, validFormation, verifyFrame,
};
