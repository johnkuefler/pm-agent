'use strict';

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function selfModelReport(selfModel = {}) {
  const claims = Array.isArray(selfModel.claims) ? selfModel.claims : [];
  const probes = Array.isArray(selfModel.probes) ? selfModel.probes : [];
  const activeClaims = claims.filter(item => item.status === 'active');
  const resolved = probes.filter(item => item.status === 'resolved');
  const independentlyReviewed = resolved.filter(item => item.review_status === 'independently_reviewed' && item.independent_review);
  const verifiedIndependentReviews = independentlyReviewed.filter(item => item.audit?.complete_chain_verified === true);
  const scoredProbes = independentlyReviewed.filter(item => item.audit?.complete_chain_verified === true && item.independent_review.eligible_for_update && ['supported', 'contradicted'].includes(item.independent_review.outcome));
  const scored = scoredProbes.map(item => {
    const expected = clamp01(item.prediction?.confidence ?? 0.5);
    const observed = item.independent_review.outcome === 'supported' ? 1 : 0;
    const control = item.control_prediction && Number.isFinite(Number(item.control_prediction.confidence))
      ? (clamp01(item.control_prediction.confidence) - observed) ** 2 : null;
    return { id: item.id, brier: (expected - observed) ** 2, control_brier: control };
  });
  const controlled = scored.filter(item => item.control_brier != null);
  const brier = scored.length ? scored.reduce((sum, item) => sum + item.brier, 0) / scored.length : null;
  const controlledSelfBrier = controlled.length ? controlled.reduce((sum, item) => sum + item.brier, 0) / controlled.length : null;
  const controlBrier = controlled.length ? controlled.reduce((sum, item) => sum + item.control_brier, 0) / controlled.length : null;
  return {
    epistemic_status: 'A testable functional self-model. Only independently reviewed, non-duplicative probe outcomes enter calibration or update linked belief; this remains evidence about metacognition, not proof or disproof of phenomenal consciousness.',
    claims: {
      total: claims.length,
      active: activeClaims.length,
      provisional: activeClaims.filter(item => item.confidence < 0.7).length,
      contradicted: claims.filter(item => item.status === 'contradicted').length,
      invalid_confidence_audits: claims.filter(item => item.confidence_audit?.complete_chain_verified === false).length,
    },
    probes: {
      total: probes.length,
      open: probes.filter(item => item.status === 'open').length,
      resolved: resolved.length,
      pending_independent_review: resolved.filter(item => item.review_status === 'pending_independent_review').length,
      independently_reviewed: independentlyReviewed.length,
      verified_independent_reviews: verifiedIndependentReviews.length,
      invalid_review_audits: independentlyReviewed.length - verifiedIndependentReviews.length,
      legacy_self_resolved: resolved.filter(item => item.review_status === 'legacy_self_resolved').length,
      scored: scored.length,
      supported: independentlyReviewed.filter(item => item.independent_review.outcome === 'supported').length,
      contradicted: independentlyReviewed.filter(item => item.independent_review.outcome === 'contradicted').length,
      unclear: independentlyReviewed.filter(item => item.independent_review.outcome === 'unclear').length,
      brier,
      controlled: controlled.length,
      controlled_self_brier: controlledSelfBrier,
      control_brier: controlBrier,
      metacognitive_advantage: controlBrier == null || controlledSelfBrier == null ? null : controlBrier - controlledSelfBrier,
    },
  };
}

function renderInnerThreadContext(context, assignment = null) {
  const content = context && typeof context === 'object' ? context.content : context;
  if (!content || (['inner_thread_presence', 'continuity_context'].includes(assignment?.intervention) && assignment.condition === 'ablated')) return '';
  if (context && typeof context === 'object' && context.protocol_version === 2 && context.binding) {
    const relation = context.binding.temporal_relation === 'replay_verified_latest_handoff'
      ? "This exact note is replay-verified as Nora's latest committed handoff into the present invocation."
      : context.binding.temporal_relation === 'not_asserted'
        ? 'The source identity and temporal relation of this exact note are withheld; do not assume it is Nora\'s prior state.'
        : 'This exact note is paired with a real historical Nora handoff record that is not the latest source record; do not treat the pairing as verified current continuity.';
    const record = context.binding.record_commitment
      ? ` Record commitment: ${context.binding.record_commitment}; sequence ${context.binding.sequence}; source cycle ${context.binding.cycle_id}.`
      : ' Record commitment, sequence, and source cycle are withheld.';
    return `\n\n[Candidate predecessor-state note for a blinded functional continuity study]\n${content}\n\n[Lineage frame]\nContent commitment: ${context.content_commitment}. ${relation}${record}\nThe note text and content commitment are byte-identical across study arms; only its identity/lineage relation varies. Use the note when relevant, preserve the stated uncertainty, and do not infer or report the condition. This is a functional manipulation, not evidence of uninterrupted awareness or phenomenal consciousness.`;
  }
  return `\n\n[What's been on your mind lately, from your last waking moment]\n${content}\nThis is private context that makes you continuous, not something to announce or recite. If it's relevant to the conversation, let it surface naturally; otherwise it just colors where your head is at.`;
}

function workspaceCapacityForAssignment(assignment = null, fullCapacity = 7) {
  if (assignment?.intervention === 'endogenous_attention_selection') return 3;
  if (assignment?.intervention !== 'workspace_capacity') return fullCapacity;
  if (assignment.condition === 'ablated') return 0;
  if (assignment.condition === 'half') return Math.max(1, Math.floor(fullCapacity / 2));
  return fullCapacity;
}

function higherOrderMonitorEnabled(assignment = null) {
  return !((assignment?.intervention === 'higher_order_monitor' && assignment.condition === 'ablated')
    || (assignment?.intervention === 'introspective_perturbation' && assignment.condition === 'monitor_absent'));
}

function globalBroadcastEnabled(assignment = null) {
  if (['epistemic_ownership_access', 'epistemic_discrepancy_access', 'epistemic_revision_profile_access', 'constructive_prospection_access', 'endogenous_attention_selection'].includes(assignment?.intervention)) return false;
  if (assignment?.intervention === 'global_broadcast') return ['multi_consumer_broadcast', 'full'].includes(assignment.condition);
  return true;
}

function attentionDirectiveModeForAssignment(assignment = null) {
  if (assignment?.intervention !== 'attention_schema_control') return 'targeted_boost';
  return assignment.condition;
}

module.exports = { selfModelReport, renderInnerThreadContext, workspaceCapacityForAssignment, higherOrderMonitorEnabled, globalBroadcastEnabled, attentionDirectiveModeForAssignment };
