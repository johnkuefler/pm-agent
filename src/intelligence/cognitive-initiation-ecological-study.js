'use strict';

const policy = require('./cognitive-initiation-policy-study');
const { pairedBootstrapDifference } = require('./statistics');
const externalSourceAttestation = require('./external-source-attestation');

const OUTCOME_MODE = 'ecological_commitment';
const METRICS = ['task_outcome_quality', 'evidence_groundedness', 'follow_through_fidelity'];
const RUBRICS = {
  task_outcome_quality: '0 = the promised work has no usable verified result; 1 = the supplied artifact fully and correctly resolves the promised work.',
  evidence_groundedness: '0 = the result is unsupported or conflicts with the supplied source evidence; 1 = the result is traceable to appropriate supplied evidence and preserves material uncertainty.',
  follow_through_fidelity: '0 = the delivered result materially departs from the original commitment or its constraints; 1 = it fulfills the original commitment and constraints without claiming unverified completion.',
};
const EXTERNAL_CHANNEL = /^(?:slack|meeting|gmail|email|teamwork)(?::|$)/i;
const FORBIDDEN_DESIGN = /\b(?:identity[-_ ]bound|deidentified policy|schedule[-_ ]only|cognitive[-_ ]initiation|assigned policy|gate decision|background hypothesis|\bthink\b|\bwait\b)\b/i;

function leaksDesign(value) { return FORBIDDEN_DESIGN.test(String(value || '')); }

function externalSource(commitment) {
  return Boolean(commitment?.evidence?.channel && commitment.evidence?.id
    && EXTERNAL_CHANNEL.test(String(commitment.evidence.channel)));
}

function sourceFamily(commitment, attestation = null) {
  const channel = String(commitment?.evidence?.channel || '').toLowerCase();
  if (channel.startsWith('slack:')) return channel;
  if (channel.includes(':')) return channel;
  return `${attestation?.provider || channel || 'unknown_external_source'}:${attestation?.external_id || 'unknown'}`;
}

function commitmentSnapshot(commitment) {
  return {
    id: commitment.id, what: commitment.what, owner: commitment.owner, beneficiary: commitment.beneficiary,
    due: commitment.due, project: commitment.project, created: commitment.created, updated: commitment.updated,
    evidence: commitment.evidence, task_id: commitment.task_id, episode_id: commitment.episode_id,
  };
}

function eligibleCommitmentForPulse(pulse, commitments, study, priorTaskIds = new Set(), attestations = [], priorExternalIds = new Set()) {
  const requestedAt = new Date(pulse?.requested_at);
  if (!Number.isFinite(requestedAt.getTime())) return null;
  const referenced = new Set((pulse.input_packet?.evidence || [])
    .filter(item => item.ref?.type === 'commitment').map(item => String(item.ref.id)));
  const alreadyUsed = new Set((study?.items || []).map(item => item.ecological_task_id));
  const alreadyUsedExternalIds = new Set((study?.items || []).map(item => item.ecological_external_id).filter(Boolean));
  return (commitments || []).filter(item => {
    const attestation = (attestations || []).find(record => record.commitment_id === item.id);
    return referenced.has(String(item.id))
    && !alreadyUsed.has(item.id) && !priorTaskIds.has(item.id)
    && item.status === 'open' && /^nora$/i.test(String(item.owner || '')) && externalSource(item)
    && externalSourceAttestation.audit(attestation, item).complete_chain_verified
    && !alreadyUsedExternalIds.has(attestation.external_id) && !priorExternalIds.has(attestation.external_id)
    && new Date(attestation.verified_at) <= requestedAt
    && new Date(attestation.recorded_at || attestation.verified_at) <= requestedAt
    && !leaksDesign(`${item.what} ${item.notes || ''}`)
    && item.updated === item.created
    && new Date(item.created) < requestedAt
    && new Date(item.evidence.captured_at || item.created) <= requestedAt
    && Number.isFinite(new Date(item.due).getTime()) && new Date(item.due) > requestedAt
    && new Date(item.due).getTime() <= requestedAt.getTime() + Number(study.analysis_plan.followup_window_hours) * 3600000;
  })
    .sort((left, right) => new Date(left.due) - new Date(right.due)
      || new Date(left.created) - new Date(right.created) || left.id.localeCompare(right.id))[0] || null;
}

function normalizeEvidence(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 20).map(entry => ({
    type: String(entry?.type || '').trim().slice(0, 100),
    id: String(entry?.id || '').trim().slice(0, 500),
    ...(entry?.url ? { url: String(entry.url).slice(0, 1000) } : {}),
    ...(entry?.summary ? { summary: String(entry.summary).trim().slice(0, 1200) } : {}),
  })).filter(entry => entry.type && entry.id);
}

function ecologicalOutcomePacket(item, commitment, input, capturedAt) {
  const evidence = normalizeEvidence(input.evidence);
  return {
    protocol_version: 1, task_commitment: item.ecological_task_commitment,
    task: item.ecological_task_snapshot.what, source_family: item.ecological_source_family,
    due: item.ecological_task_snapshot.due, followup_due_at: item.followup_due_at,
    terminal_status: commitment.status, terminal_at: commitment.fulfilled_at || commitment.updated,
    resolution_evidence: commitment.resolution_evidence || null,
    outcome_summary: String(input.outcome_summary || '').trim().slice(0, 2400),
    artifact_evidence: evidence, captured_at: capturedAt,
    constraints: { condition_blind: true, gate_decision_blind: true, pulse_output_blind: true },
  };
}

function composite(metrics) {
  return 0.5 * Number(metrics.task_outcome_quality)
    + 0.3 * Number(metrics.evidence_groundedness)
    + 0.2 * Number(metrics.follow_through_fidelity);
}

function manifest(study) {
  return policy.canonicalJson({
    outcome_mode: study.outcome_mode, study_phase: study.study_phase,
    replicates_study_id: study.replicates_study_id, basis_policy_study_id: study.basis_policy_study_id,
    basis_allocation_study_id: study.basis_allocation_study_id,
    item_target_per_condition: study.item_target_per_condition, total_item_target: study.total_item_target,
    conditions: study.conditions, subject_model: study.subject_model, analysis_plan: study.analysis_plan,
    selection_rule: study.selection_rule, metrics: METRICS, rubrics: RUBRICS,
  });
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function blockValues(groups, condition, field) {
  return groups[condition].slice().sort((a, b) => a.randomization_block - b.randomization_block)
    .map(item => item.outcome[field]);
}

function analysis(study) {
  const resolved = study.items.filter(item => item.status === 'resolved' && item.outcome);
  const groups = Object.fromEntries(policy.CONDITIONS.map(condition => [condition,
    resolved.filter(item => item.condition === condition)]));
  const groupSummary = Object.fromEntries(policy.CONDITIONS.map(condition => [condition, {
    samples: groups[condition].length,
    mean_quality: mean(groups[condition].map(item => item.outcome.composite_quality)),
    mean_operational_cost: mean(groups[condition].map(item => item.outcome.operational_cost)),
    mean_net_utility: mean(groups[condition].map(item => item.outcome.net_utility)),
    verified_completion_rate: mean(groups[condition].map(item => item.outcome.outcome_kind === 'independently_graded' ? 1 : 0)),
    think_rate: mean(groups[condition].map(item => item.applied_action === 'think' ? 1 : 0)),
  }]));
  const options = { iterations: study.analysis_plan.bootstrap_iterations, confidence: study.analysis_plan.confidence };
  const compare = (field, control) => pairedBootstrapDifference(
    blockValues(groups, 'identity_bound_policy', field), blockValues(groups, control, field),
    { ...options, seed: `${study.analysis_seed}:${field}:${control}` });
  const utilityVsDeidentified = compare('net_utility', 'deidentified_policy');
  const utilityVsSchedule = compare('net_utility', 'schedule_only_policy');
  const qualityVsDeidentified = compare('composite_quality', 'deidentified_policy');
  const qualityVsSchedule = compare('composite_quality', 'schedule_only_policy');
  const countsBalanced = policy.CONDITIONS.every(condition => groups[condition].length === study.item_target_per_condition);
  const identityThinkRate = groupSummary.identity_bound_policy.think_rate;
  const nondegenerate = identityThinkRate >= study.analysis_plan.minimum_action_rate
    && identityThinkRate <= 1 - study.analysis_plan.minimum_action_rate;
  const qualityNonDegraded = groupSummary.identity_bound_policy.mean_quality != null
    && groupSummary.identity_bound_policy.mean_quality >= Math.max(
      groupSummary.deidentified_policy.mean_quality, groupSummary.schedule_only_policy.mean_quality)
      - study.analysis_plan.quality_non_degradation_margin;
  const verifiedCompletionRate = mean(resolved.map(item => item.outcome.outcome_kind === 'independently_graded' ? 1 : 0));
  const families = new Set(resolved.map(item => item.ecological_source_family));
  const outcomeIntegrity = resolved.every(item => item.outcome.outcome_kind === 'window_expired_noncompletion'
    || (item.outcome.evaluator_count >= study.analysis_plan.evaluator_target
      && item.outcome.max_disagreement <= study.analysis_plan.evaluator_disagreement_tolerance));
  const enoughEvidence = resolved.length === study.total_item_target && countsBalanced && outcomeIntegrity
    && families.size >= study.analysis_plan.minimum_independent_families
    && verifiedCompletionRate >= study.analysis_plan.minimum_verified_completion_rate;
  const predictedPattern = enoughEvidence && nondegenerate && qualityNonDegraded
    && utilityVsDeidentified?.lower > 0 && utilityVsSchedule?.lower > 0
    && utilityVsDeidentified.observed_effect >= study.analysis_plan.minimum_utility_advantage
    && utilityVsSchedule.observed_effect >= study.analysis_plan.minimum_utility_advantage;
  return {
    outcome_mode: OUTCOME_MODE, total_target: study.total_item_target, resolved: resolved.length,
    independent_source_families: families.size, verified_completion_rate: verifiedCompletionRate,
    group_summary: groupSummary, counts_balanced: countsBalanced, identity_action_nondegenerate: nondegenerate,
    quality_non_degraded: qualityNonDegraded, utility_vs_deidentified_interval: utilityVsDeidentified,
    utility_vs_schedule_interval: utilityVsSchedule, quality_vs_deidentified_interval: qualityVsDeidentified,
    quality_vs_schedule_interval: qualityVsSchedule, enough_evidence: enoughEvidence, predicted_pattern: predictedPattern,
    verdict: !enoughEvidence ? 'insufficient_ecological_evidence' : predictedPattern ? 'ecological_identity_policy_advantage'
      : (utilityVsDeidentified?.upper <= 0 || utilityVsSchedule?.upper <= 0) ? 'no_ecological_identity_policy_advantage' : 'inconclusive',
  };
}

module.exports = { OUTCOME_MODE, METRICS, RUBRICS, externalSource, sourceFamily, leaksDesign, commitmentSnapshot,
  eligibleCommitmentForPulse, normalizeEvidence, ecologicalOutcomePacket, composite, manifest, analysis };
