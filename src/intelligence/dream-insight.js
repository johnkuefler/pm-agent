'use strict';

const crypto = require('crypto');

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
    && String(ref.type || '').trim() && String(ref.id || ref.url || '').trim());
}

function dreamInsights(dreams = []) {
  return dreams.flatMap(dream => (Array.isArray(dream.reflection?.insight_candidates)
    ? dream.reflection.insight_candidates : [])
    .map(insight => ({ dream, insight })));
}

function insightAudit(insight, dreams = []) {
  const formation = insight?.formation_record;
  const sources = Array.isArray(formation?.source_ideas) ? formation.source_ideas : [];
  const sourceDreams = sources.map(source => dreams.find(dream => dream.id === source.dream_id));
  const sourceIdeasVerified = sources.length >= 2 && sourceDreams.every((dream, index) => dream
    && Number.isInteger(sources[index].idea_index)
    && dream.date === sources[index].dream_date
    && dream.reflection?.ideas?.[sources[index].idea_index] === sources[index].idea);
  const sourceDateSeparationVerified = new Set(sources.map(source => source.dream_id)).size === sources.length
    && new Set(sources.map(source => source.dream_date)).size === sources.length;
  const formationCommitmentVerified = Boolean(formation && insight?.formation_commitment
    && commitment(formation) === insight.formation_commitment);
  const projectionMatchesFormation = Boolean(formation
    && insight?.id === formation.id
    && insight?.statement === formation.statement
    && insight?.scope === formation.scope
    && Number(insight?.confidence) === Number(formation.confidence)
    && insight?.formed_at === formation.formed_at);
  const resolutionPresent = Boolean(insight?.resolution_record || insight?.resolution_commitment);
  const resolutionVerified = !resolutionPresent || Boolean(insight.resolution_record
    && insight.resolution_commitment
    && insight.resolution_record.formation_commitment === insight.formation_commitment
    && commitment(insight.resolution_record) === insight.resolution_commitment);
  const resolutionSemanticsVerified = !resolutionPresent || Boolean(
    ['supported', 'contradicted', 'unclear', 'retired'].includes(insight.resolution_record?.outcome)
    && String(insight.resolution_record?.observation || '').trim()
    && validEvidenceRefs(insight.resolution_record?.evidence));
  const independentReviewPresent = Boolean(insight?.independent_review
    || insight?.independent_review_commitment);
  const independentReviewVerified = !independentReviewPresent || Boolean(insight.independent_review
    && insight.independent_review_commitment
    && insight.independent_review.formation_commitment === insight.formation_commitment
    && insight.independent_review.resolution_commitment === insight.resolution_commitment
    && commitment(insight.independent_review) === insight.independent_review_commitment);
  const independentReviewSemanticsVerified = !independentReviewPresent || Boolean(
    ['supported', 'contradicted', 'unclear'].includes(insight.independent_review?.outcome)
    && String(insight.independent_review?.evaluator_id || '').trim()
    && String(insight.independent_review?.rationale || '').trim()
    && validEvidenceRefs(insight.independent_review?.evidence)
    && insight.independent_review?.subject_outcome === insight.resolution_record?.outcome
    && insight.independent_review?.subject_agreement
      === (insight.independent_review?.outcome === insight.resolution_record?.outcome));
  const finalStatusOutcomes = {
    independently_supported: 'supported',
    independently_contradicted: 'contradicted',
    inconclusive: 'unclear',
  };
  const expectedReviewOutcome = finalStatusOutcomes[insight?.status];
  const statusLifecycleVerified = insight?.status === 'candidate'
    ? !resolutionPresent && !independentReviewPresent
    : insight?.status === 'awaiting_independent_review'
      ? resolutionPresent && !independentReviewPresent
        && ['supported', 'contradicted', 'unclear'].includes(insight.resolution_record?.outcome)
      : insight?.status === 'retired'
        ? resolutionPresent && !independentReviewPresent && insight.resolution_record?.outcome === 'retired'
        : Boolean(expectedReviewOutcome && resolutionPresent && independentReviewPresent
          && insight.independent_review?.outcome === expectedReviewOutcome);
  const completeChainVerified = formationCommitmentVerified && projectionMatchesFormation
    && sourceIdeasVerified && sourceDateSeparationVerified && resolutionVerified
    && resolutionSemanticsVerified && independentReviewVerified
    && independentReviewSemanticsVerified && statusLifecycleVerified;
  return {
    formation_commitment_verified: formationCommitmentVerified,
    projection_matches_formation: projectionMatchesFormation,
    source_ideas_verified: sourceIdeasVerified,
    source_date_separation_verified: sourceDateSeparationVerified,
    resolution_present: resolutionPresent,
    resolution_verified: resolutionVerified,
    resolution_semantics_verified: resolutionSemanticsVerified,
    independent_review_present: independentReviewPresent,
    independent_review_verified: independentReviewVerified,
    independent_review_semantics_verified: independentReviewSemanticsVerified,
    status_lifecycle_verified: statusLifecycleVerified,
    final_evidence_eligible: Boolean(expectedReviewOutcome && completeChainVerified),
    complete_chain_verified: completeChainVerified,
  };
}

function snapshotFor(insight, dreams = []) {
  const found = dreamInsights(dreams).find(item => item.insight?.id === insight?.id);
  if (!found) return null;
  return { ...JSON.parse(JSON.stringify(found.insight)), anchor_dream_id: found.dream.id };
}

function eligibleSnapshots(dreams = []) {
  return dreamInsights(dreams).filter(({ insight }) => insight?.status === 'independently_supported'
    && insightAudit(insight, dreams).final_evidence_eligible)
    .map(({ insight }) => snapshotFor(insight, dreams));
}

function verifyFinalSnapshot(snapshot, dreams = []) {
  if (!snapshot?.id || snapshot.status !== 'independently_supported') return false;
  const matches = dreamInsights(dreams).filter(item => item.insight?.id === snapshot.id);
  const found = matches[0];
  if (matches.length !== 1 || !insightAudit(found.insight, dreams).final_evidence_eligible) return false;
  return canonicalJson(snapshotFor(found.insight, dreams)) === canonicalJson(snapshot);
}

module.exports = {
  canonicalJson, commitment, dreamInsights, eligibleSnapshots, insightAudit,
  snapshotFor, validEvidenceRefs, verifyFinalSnapshot,
};
