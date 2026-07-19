'use strict';

const crypto = require('crypto');
const dreamIdeaSeed = require('./dream-idea-seed');

const OBSERVATION_PROTOCOL_VERSION = 1;
const OBSERVATION_WINDOW_MIN_DAYS = 2;
const OBSERVATION_WINDOW_MAX_DAYS = 30;
const OBSERVATION_MIN_OPPORTUNITIES = 1;
const OBSERVATION_MAX_OPPORTUNITIES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function cleanObservationText(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 600);
}

function normalizeObservationPlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('dream insights require a prospective observation_plan');
  }
  const windowDays = Number(input.window_days);
  const minimumOpportunities = Number(input.minimum_opportunities);
  const opportunityDefinition = cleanObservationText(input.opportunity_definition);
  if (!Number.isInteger(windowDays) || windowDays < OBSERVATION_WINDOW_MIN_DAYS
    || windowDays > OBSERVATION_WINDOW_MAX_DAYS) {
    throw new Error(`observation_plan.window_days must be an integer from ${OBSERVATION_WINDOW_MIN_DAYS} to ${OBSERVATION_WINDOW_MAX_DAYS}`);
  }
  if (!Number.isInteger(minimumOpportunities)
    || minimumOpportunities < OBSERVATION_MIN_OPPORTUNITIES
    || minimumOpportunities > OBSERVATION_MAX_OPPORTUNITIES) {
    throw new Error(`observation_plan.minimum_opportunities must be an integer from ${OBSERVATION_MIN_OPPORTUNITIES} to ${OBSERVATION_MAX_OPPORTUNITIES}`);
  }
  if (opportunityDefinition.length < 10) {
    throw new Error('observation_plan.opportunity_definition must define one natural opportunity');
  }
  return { window_days: windowDays, minimum_opportunities: minimumOpportunities,
    opportunity_definition: opportunityDefinition };
}

function normalizeObservationPlan(input, formedAt) {
  const relative = normalizeObservationPlanInput(input);
  const started = new Date(formedAt);
  if (!Number.isFinite(started.getTime())) throw new Error('observation_plan requires a valid formation time');
  const observationStartedAt = started.toISOString();
  return {
    protocol_version: OBSERVATION_PROTOCOL_VERSION,
    ...relative,
    observation_started_at: observationStartedAt,
    resolve_not_before: new Date(started.getTime() + relative.window_days * DAY_MS).toISOString(),
  };
}

function observationPlanAudit(insight) {
  const formationPlan = insight?.formation_record?.observation_plan;
  const projectedPlan = insight?.observation_plan;
  if (!formationPlan && !projectedPlan) return {
    observation_protocol: 'legacy_unbounded', observation_plan_present: false,
    observation_plan_verified: true, observation_plan_projection_verified: true,
    observation_plan_resolution_binding_verified: true,
    observation_window_timing_verified: true, observation_opportunities_verified: true,
    complete_chain_verified: true,
  };
  let normalized = null;
  try { normalized = normalizeObservationPlan(formationPlan, insight?.formation_record?.formed_at); } catch { normalized = null; }
  const observationPlanVerified = Boolean(normalized
    && canonicalJson(normalized) === canonicalJson(formationPlan));
  const projectionVerified = Boolean(observationPlanVerified
    && canonicalJson(projectedPlan) === canonicalJson(formationPlan));
  const resolution = insight?.resolution_record;
  const resolutionPresent = Boolean(resolution || insight?.resolution_commitment);
  const expectedCommitment = observationPlanVerified ? commitment(formationPlan) : null;
  const resolutionBindingVerified = !resolutionPresent || Boolean(resolution
    && resolution.observation_plan_commitment === expectedCommitment);
  const retired = resolution?.outcome === 'retired';
  const resolvedAt = new Date(resolution?.resolved_at || '').getTime();
  const resolveNotBefore = new Date(formationPlan?.resolve_not_before || '').getTime();
  const timingVerified = !resolutionPresent || retired || Boolean(Number.isFinite(resolvedAt)
    && Number.isFinite(resolveNotBefore) && resolvedAt >= resolveNotBefore);
  const opportunities = resolution?.opportunities_observed;
  const opportunitiesInteger = Number.isInteger(opportunities) && opportunities >= 0 && opportunities <= 10000;
  const opportunitiesVerified = !resolutionPresent || retired
    ? (!resolutionPresent || opportunities == null || opportunitiesInteger)
    : Boolean(opportunitiesInteger && (resolution?.outcome === 'unclear'
      || opportunities >= formationPlan.minimum_opportunities));
  return {
    observation_protocol: 'prospective_window_v1', observation_plan_present: true,
    observation_plan_verified: observationPlanVerified,
    observation_plan_projection_verified: projectionVerified,
    observation_plan_resolution_binding_verified: resolutionBindingVerified,
    observation_window_timing_verified: timingVerified,
    observation_opportunities_verified: opportunitiesVerified,
    complete_chain_verified: observationPlanVerified && projectionVerified
      && resolutionBindingVerified && timingVerified && opportunitiesVerified,
  };
}

function resolutionEligibility(insight, now = new Date(), outcome = null) {
  const role = roleEligibility(insight);
  if (outcome !== 'retired' && !role.eligible) return {
    eligible: false, reason: 'retired_role_residue', observation_protocol: 'role_boundary',
    resolve_not_before: null, minimum_opportunities: null,
  };
  const audit = observationPlanAudit(insight);
  const plan = insight?.formation_record?.observation_plan || null;
  if (!audit.complete_chain_verified) return {
    eligible: false, reason: 'observation_plan_integrity_failed',
    observation_protocol: audit.observation_protocol,
  };
  if (!plan) return {
    eligible: true, reason: 'legacy_unbounded_candidate', observation_protocol: 'legacy_unbounded',
    resolve_not_before: null, minimum_opportunities: null,
  };
  if (outcome === 'retired') return {
    eligible: true, reason: 'retirement_allowed_before_window_close',
    observation_protocol: audit.observation_protocol,
    resolve_not_before: plan.resolve_not_before,
    minimum_opportunities: plan.minimum_opportunities,
  };
  const nowMs = new Date(now).getTime();
  const notBeforeMs = new Date(plan.resolve_not_before).getTime();
  const eligible = Number.isFinite(nowMs) && Number.isFinite(notBeforeMs) && nowMs >= notBeforeMs;
  return {
    eligible, reason: eligible ? 'observation_window_complete' : 'observation_window_open',
    observation_protocol: audit.observation_protocol,
    resolve_not_before: plan.resolve_not_before,
    minimum_opportunities: plan.minimum_opportunities,
  };
}

function roleEligibility(insight = {}) {
  const formation = insight?.formation_record || {};
  const values = [insight.statement, formation.statement, formation.next_observation,
    formation.expected_usefulness, formation.observation_plan?.opportunity_definition,
    ...(formation.source_ideas || []).map(item => item?.idea)];
  const reasons = [...new Set(values.flatMap(value => dreamIdeaSeed.roleEligibility(String(value || '')).reasons))];
  return { eligible: reasons.length === 0,
    state: reasons.length ? 'retired_role_residue' : 'eligible', reasons };
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
    && insight?.formed_at === formation.formed_at
    && canonicalJson(insight?.observation_plan) === canonicalJson(formation?.observation_plan));
  const observationAudit = observationPlanAudit(insight);
  const generationReceiptPresent = Boolean(insight?.generation_receipt
    || formation?.generation_receipt_commitment);
  let generationReceiptVerified = !generationReceiptPresent;
  if (generationReceiptPresent && insight?.generation_receipt
    && formation?.generation_receipt_commitment === insight.generation_receipt.receipt_commitment) {
    // Lazy load avoids a module-initialization cycle: formation uses this module's lifecycle helpers.
    const dreamInsightReflection = require('./dream-insight-reflection');
    generationReceiptVerified = dreamInsightReflection.auditReceipt(
      insight.generation_receipt, { insight }).complete_chain_verified;
  }
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
    && sourceIdeasVerified && sourceDateSeparationVerified && generationReceiptVerified && resolutionVerified
    && resolutionSemanticsVerified && independentReviewVerified
    && independentReviewSemanticsVerified && statusLifecycleVerified
    && observationAudit.complete_chain_verified;
  const role = roleEligibility(insight);
  return {
    formation_commitment_verified: formationCommitmentVerified,
    projection_matches_formation: projectionMatchesFormation,
    source_ideas_verified: sourceIdeasVerified,
    source_date_separation_verified: sourceDateSeparationVerified,
    generation_receipt_present: generationReceiptPresent,
    generation_receipt_verified: generationReceiptVerified,
    resolution_present: resolutionPresent,
    resolution_verified: resolutionVerified,
    resolution_semantics_verified: resolutionSemanticsVerified,
    independent_review_present: independentReviewPresent,
    independent_review_verified: independentReviewVerified,
    independent_review_semantics_verified: independentReviewSemanticsVerified,
    status_lifecycle_verified: statusLifecycleVerified,
    ...observationAudit,
    role_eligibility: role,
    final_evidence_eligible: Boolean(expectedReviewOutcome && completeChainVerified && role.eligible),
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
    && roleEligibility(insight).eligible && insightAudit(insight, dreams).final_evidence_eligible)
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
  OBSERVATION_PROTOCOL_VERSION, OBSERVATION_WINDOW_MIN_DAYS, OBSERVATION_WINDOW_MAX_DAYS,
  OBSERVATION_MIN_OPPORTUNITIES, OBSERVATION_MAX_OPPORTUNITIES,
  canonicalJson, commitment, dreamInsights, eligibleSnapshots, insightAudit, roleEligibility,
  normalizeObservationPlanInput, normalizeObservationPlan, observationPlanAudit,
  resolutionEligibility, snapshotFor, validEvidenceRefs, verifyFinalSnapshot,
};
