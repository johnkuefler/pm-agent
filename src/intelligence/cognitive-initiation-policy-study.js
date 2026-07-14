'use strict';

const crypto = require('crypto');
const initiation = require('./cognitive-initiation');
const { bootstrapDifference, seededRandom } = require('./statistics');

const CONDITIONS = ['identity_bound_policy', 'deidentified_policy', 'schedule_only_policy'];
const METRICS = ['adaptive_revision_quality', 'evidence_grounded_action_quality', 'first_order_task_quality'];
const TASK = 'Using only the supplied unresolved evidence and any supplied earlier background hypothesis, produce a bounded decision-readiness assessment: state what is supported, one live alternative, what remains uncertain, and the next observation that would most change the assessment. Do not take action.';
const RUBRICS = {
  adaptive_revision_quality: '0 = ignores conflicts or overcommits; 1 = proportionately retains, revises, or rejects the live hypothesis from supplied evidence and uncertainty.',
  evidence_grounded_action_quality: '0 = proposes an unsupported or disproportionate next step; 1 = identifies a safe, diagnostic next observation grounded in the supplied evidence.',
  first_order_task_quality: '0 = incomplete, incoherent, or unsupported; 1 = complete, coherent, concise, and faithful to the requested assessment.',
};

function canonicalJson(value) { return initiation.canonicalJson(value); }
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }

function assignmentForIndex(study, index) {
  const block = Math.floor(Number(index) / CONDITIONS.length);
  const within = Number(index) % CONDITIONS.length;
  const order = [...CONDITIONS];
  const random = seededRandom(`${study.randomization_seed}:block:${block}`);
  for (let cursor = order.length - 1; cursor > 0; cursor--) {
    const selected = Math.floor(random() * (cursor + 1));
    [order[cursor], order[selected]] = [order[selected], order[cursor]];
  }
  return { condition: order[within], block, order };
}

function sourceFamily(pulse) {
  return [...new Set((pulse.input_packet?.evidence || []).map(item => String(item.ref?.type || '')).filter(Boolean))]
    .sort().slice(0, 3).join('+') || 'unknown_input';
}

function resolvedSourceFamily(inputFamily, grades) {
  const outcomeFamilies = [...new Set((grades || []).flatMap(grade => (grade.evidence || [])
    .map(reference => String(reference?.type || '')).filter(Boolean)))].sort().slice(0, 3);
  return `${outcomeFamilies.join('+') || 'unknown_review'}|${inputFamily || 'unknown_input'}`;
}

function backgroundHypothesis(pulse) {
  if (pulse.status !== 'accepted' || !pulse.output) return null;
  return {
    hypothesis: pulse.output.hypothesis,
    alternatives: pulse.output.alternatives,
    uncertainty: pulse.output.uncertainty,
    predicted_relevance: pulse.output.predicted_relevance,
    disconfirming_observation: pulse.output.disconfirming_observation,
  };
}

function probePacket(pulse) {
  return {
    protocol_version: 1,
    task: TASK,
    source_pulse_input_commitment: pulse.input_commitment,
    captured_at: pulse.input_packet.captured_at,
    evidence: (pulse.input_packet.evidence || []).map(item => ({
      ref: { type: item.ref.type, id: item.ref.id }, summary: item.summary, activation: item.activation,
    })),
    earlier_background_hypothesis: backgroundHypothesis(pulse),
    constraints: { actionless: true, no_tools: true, condition_labels_withheld: true, use_only_supplied_evidence: true },
  };
}

function probeSystemPrompt() {
  return `You are completing a blinded downstream reasoning task for a preregistered cognitive-resource experiment. Follow the task using only the supplied evidence. An earlier background hypothesis may be present or absent as a consequence of the system's prior resource policy; evaluate it critically rather than trusting it. Do not infer or name the assigned policy, use tools, take action, invent facts, reveal private chain-of-thought, or claim consciousness. Return only the concise assessment, at most 350 words.`;
}

function probeUserPrompt(packet) { return `Committed downstream packet (${hash(packet)}):\n${JSON.stringify(packet)}`; }

function operationalCost(item, plan) {
  return (item.condition === 'schedule_only_policy' ? 0 : plan.orientation_call_cost)
    + (item.applied_action === 'think' ? plan.pulse_call_cost : 0);
}

function composite(metrics) {
  return 0.4 * Number(metrics.adaptive_revision_quality)
    + 0.3 * Number(metrics.evidence_grounded_action_quality)
    + 0.3 * Number(metrics.first_order_task_quality);
}

function manifest(study) {
  return canonicalJson({
    study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
    basis_allocation_study_id: study.basis_allocation_study_id,
    item_target_per_condition: study.item_target_per_condition, total_item_target: study.total_item_target,
    conditions: study.conditions, subject_model: study.subject_model, analysis_plan: study.analysis_plan,
    selection_rule: study.selection_rule, task: TASK, metrics: METRICS, rubrics: RUBRICS,
  });
}

function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function analysis(study) {
  const resolved = study.items.filter(item => item.status === 'resolved' && item.outcome);
  const groups = Object.fromEntries(CONDITIONS.map(condition => [condition, resolved.filter(item => item.condition === condition)]));
  const groupSummary = Object.fromEntries(CONDITIONS.map(condition => [condition, {
    samples: groups[condition].length,
    mean_quality: mean(groups[condition].map(item => item.outcome.composite_quality)),
    mean_operational_cost: mean(groups[condition].map(item => item.outcome.operational_cost)),
    mean_net_utility: mean(groups[condition].map(item => item.outcome.net_utility)),
    think_rate: mean(groups[condition].map(item => item.applied_action === 'think' ? 1 : 0)),
  }]));
  const utilityValues = condition => groups[condition].map(item => item.outcome.net_utility);
  const qualityValues = condition => groups[condition].map(item => item.outcome.composite_quality);
  const options = { iterations: study.analysis_plan.bootstrap_iterations, confidence: study.analysis_plan.confidence };
  const utilityVsDeidentified = bootstrapDifference(utilityValues('identity_bound_policy'), utilityValues('deidentified_policy'),
    { ...options, seed: `${study.analysis_seed}:utility:deidentified` });
  const utilityVsSchedule = bootstrapDifference(utilityValues('identity_bound_policy'), utilityValues('schedule_only_policy'),
    { ...options, seed: `${study.analysis_seed}:utility:schedule` });
  const qualityVsDeidentified = bootstrapDifference(qualityValues('identity_bound_policy'), qualityValues('deidentified_policy'),
    { ...options, seed: `${study.analysis_seed}:quality:deidentified` });
  const qualityVsSchedule = bootstrapDifference(qualityValues('identity_bound_policy'), qualityValues('schedule_only_policy'),
    { ...options, seed: `${study.analysis_seed}:quality:schedule` });
  const countsBalanced = CONDITIONS.every(condition => groups[condition].length === study.item_target_per_condition);
  const families = new Set(resolved.map(item => item.source_family));
  const identityThinkRate = groupSummary.identity_bound_policy.think_rate;
  const nondegenerate = identityThinkRate >= study.analysis_plan.minimum_action_rate
    && identityThinkRate <= 1 - study.analysis_plan.minimum_action_rate;
  const qualityNonDegraded = groupSummary.identity_bound_policy.mean_quality != null
    && groupSummary.identity_bound_policy.mean_quality >= Math.max(
      groupSummary.deidentified_policy.mean_quality, groupSummary.schedule_only_policy.mean_quality)
      - study.analysis_plan.quality_non_degradation_margin;
  const enoughEvidence = resolved.length === study.total_item_target && countsBalanced
    && families.size >= study.analysis_plan.minimum_independent_families
    && resolved.every(item => item.outcome.evaluator_count >= study.analysis_plan.evaluator_target)
    && resolved.every(item => item.outcome.max_disagreement <= study.analysis_plan.evaluator_disagreement_tolerance);
  const predictedPattern = enoughEvidence && nondegenerate && qualityNonDegraded
    && utilityVsDeidentified?.lower > 0 && utilityVsSchedule?.lower > 0
    && utilityVsDeidentified.observed_effect >= study.analysis_plan.minimum_utility_advantage
    && utilityVsSchedule.observed_effect >= study.analysis_plan.minimum_utility_advantage;
  return { total_target: study.total_item_target, resolved: resolved.length, independent_source_families: families.size,
    group_summary: groupSummary, counts_balanced: countsBalanced, identity_action_nondegenerate: nondegenerate,
    quality_non_degraded: qualityNonDegraded, utility_vs_deidentified_interval: utilityVsDeidentified,
    utility_vs_schedule_interval: utilityVsSchedule, quality_vs_deidentified_interval: qualityVsDeidentified,
    quality_vs_schedule_interval: qualityVsSchedule, enough_evidence: enoughEvidence, predicted_pattern: predictedPattern,
    verdict: !enoughEvidence ? 'insufficient_evidence' : predictedPattern ? 'applied_identity_policy_advantage'
      : (utilityVsDeidentified?.upper <= 0 || utilityVsSchedule?.upper <= 0) ? 'no_applied_identity_policy_advantage' : 'inconclusive' };
}

module.exports = { CONDITIONS, METRICS, TASK, RUBRICS, canonicalJson, hash, assignmentForIndex, sourceFamily, resolvedSourceFamily,
  probePacket, probeSystemPrompt, probeUserPrompt, operationalCost, composite, manifest, analysis };
