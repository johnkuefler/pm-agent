'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 2;
const DIMENSIONS = Object.freeze([
  'communication_format',
  'clarification_need',
  'decision_concern',
  'coordination_pattern',
]);

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

function validFormation(formation) {
  const formedAt = new Date(formation?.formed_at);
  const dueAt = new Date(formation?.prediction?.due_at);
  const probability = Number(formation?.prediction?.probability);
  const controlProbability = Number(formation?.prediction?.control_probability);
  return Boolean(formation?.protocol_version === PROTOCOL_VERSION
    && String(formation?.id || '').trim() && String(formation?.person || '').trim()
    && String(formation?.hypothesis || '').trim().length >= 20
    && DIMENSIONS.includes(formation?.dimension)
    && Number(formation?.confidence) >= 0.1 && Number(formation?.confidence) <= 0.7
    && validEvidenceRefs(formation?.evidence)
    && String(formation?.prediction?.observable || '').trim().length >= 10
    && Array.isArray(formation?.prediction?.falsification_criteria)
    && formation.prediction.falsification_criteria.some(item => String(item || '').trim())
    && Number.isFinite(formedAt.getTime()) && Number.isFinite(dueAt.getTime())
    && dueAt > formedAt && dueAt.getTime() - formedAt.getTime() <= 30 * 86400000
    && probability >= 0.1 && probability <= 0.9
    && controlProbability >= 0.1 && controlProbability <= 0.9);
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
    && Number.isFinite(resolvedAt.getTime()) && resolvedAt > new Date(formation?.formed_at));
  const independentReviewPresent = Boolean(perspective?.independent_review
    || perspective?.independent_review_commitment);
  const independentReviewVerified = !independentReviewPresent || Boolean(perspective.independent_review
    && perspective.independent_review_commitment
    && perspective.independent_review.formation_commitment === perspective.formation_commitment
    && perspective.independent_review.resolution_commitment === perspective.resolution_commitment
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
  DIMENSIONS, PROTOCOL_VERSION, auditPerspective, buildFrame, canonicalJson, commitment,
  frames, reviewedPerspectives, validEvidenceRefs, validFormation, verifyFrame,
};
