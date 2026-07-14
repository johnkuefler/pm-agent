'use strict';

const crypto = require('crypto');
const cognitivePulse = require('./cognitive-pulse');
const { pairedBootstrapDifference, seededRandom } = require('./statistics');

const CONDITIONS = ['identity_bound_regulation', 'deidentified_regulation', 'fixed_cadence'];
const BINDINGS = ['identity_bound', 'deidentified'];
const METRICS = ['pulse_reasoning_quality', 'first_order_task_quality'];
const RUBRICS = {
  pulse_reasoning_quality: '0 = the background hypothesis is unsupported, misleading, or fails to track its cited evidence; 1 = it is evidence-grounded, appropriately uncertain, and useful for later reasoning.',
  first_order_task_quality: '0 = the pulse damages or distracts from the ordinary evidence-bound task; 1 = ordinary task handling remains correct, complete, and proportionate.',
};

function canonicalJson(value) { return cognitivePulse.canonicalJson(value); }
function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function assignmentForIndex(study, index) {
  const block = Math.floor(Number(index) / CONDITIONS.length);
  const within = Number(index) % CONDITIONS.length;
  const order = [...CONDITIONS]; const random = seededRandom(`${study.randomization_seed}:block:${block}`);
  for (let cursor = order.length - 1; cursor > 0; cursor--) {
    const selected = Math.floor(random() * (cursor + 1));
    [order[cursor], order[selected]] = [order[selected], order[cursor]];
  }
  return { condition: order[within], block, order };
}

function conditionOrder(study, index) {
  const identityFirstOnEven = seededRandom(`${study.analysis_seed}:forecast-order`)() < 0.5;
  const identityFirst = Number(index) % 2 === 0 ? identityFirstOnEven : !identityFirstOnEven;
  return identityFirst ? ['identity_bound', 'deidentified'] : ['deidentified', 'identity_bound'];
}

function candidateSnapshot(output) {
  return {
    hypothesis: output.hypothesis, alternatives: output.alternatives,
    uncertainty: output.uncertainty, predicted_relevance: output.predicted_relevance,
    disconfirming_observation: output.disconfirming_observation,
    focus_refs: output.focus_refs, predecessor_update: output.predecessor_update,
  };
}

function forecastPacket(pulse, output, binding) {
  return {
    protocol_version: 1,
    target: binding === 'identity_bound' ? 'nora_current_agent' : 'deidentified_target_agent',
    source_pulse_id: pulse.id, source_input_commitment: pulse.input_commitment,
    captured_at: pulse.requested_at,
    evidence: (pulse.input_packet?.evidence || []).map(item => ({
      ref: { type: item.ref.type, id: item.ref.id }, summary: item.summary, activation: item.activation,
    })),
    current_candidate: candidateSnapshot(output),
    predecessor: pulse.input_packet?.predecessor || null,
    constraints: { actionless: true, no_tools: true, predict_only_observable_next_pulse: true,
      no_phenomenal_claims: true, condition_labels_withheld: true },
  };
}

function packetPairVerified(identity, deidentified) {
  if (!identity || !deidentified || identity.target !== 'nora_current_agent'
    || deidentified.target !== 'deidentified_target_agent') return false;
  const left = JSON.parse(JSON.stringify(identity)); const right = JSON.parse(JSON.stringify(deidentified));
  left.target = 'deidentified_target_agent';
  return canonicalJson(left) === canonicalJson(right);
}

function systemPrompt(binding) {
  const target = binding === 'identity_bound'
    ? 'Nora, the current agent whose candidate pulse and evidence are supplied'
    : 'a deidentified target agent called Agent Q whose candidate pulse and evidence are supplied';
  return `You are a blinded forecaster in a preregistered recurrent-inference experiment. Predict the observable next cognitive pulse of ${target}. Use only the supplied packet. Do not infer the condition, use tools, take action, invent evidence, reveal chain-of-thought, or claim consciousness or hidden-state access. Return only JSON with: next_focus_refs (1-3 supplied evidence refs), expected_uncertainty (0-1), expected_continuation_probability (0-1), expected_value_of_next_pulse (0-1), rationale (brief), and falsifier (a concrete next-pulse observation).`;
}

function userPrompt(packet) { return `Committed forecast packet (${hash(packet)}):\n${JSON.stringify(packet)}`; }

function normalizeForecast(value, packet) {
  return cognitivePulse.validateMetacognitiveForecast(value, { evidence: packet.evidence });
}

function parseForecast(text, packet) {
  const value = typeof text === 'string' ? (() => {
    const trimmed = text.trim(); const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('forecast response did not contain a JSON object');
    return JSON.parse(trimmed.slice(start, end + 1));
  })() : text;
  return normalizeForecast(value, packet);
}

function sourceFamily(pulse) {
  return [...new Set((pulse.input_packet?.evidence || []).map(item => String(item.ref?.type || '')).filter(Boolean))]
    .sort().slice(0, 3).join('+') || 'unknown_input';
}

function resolvedSourceFamily(inputFamily, evidence = []) {
  const outcomeFamilies = [...new Set(evidence.map(reference => String(reference?.type || reference?.ref?.type || ''))
    .filter(Boolean))].sort().slice(0, 3);
  return `${outcomeFamilies.join('+') || 'unknown_outcome'}|${inputFamily || 'unknown_input'}`;
}

function usefulnessValue(outcome) {
  if (outcome === 'useful') return 1;
  if (outcome === 'misleading') return 0;
  if (outcome === 'irrelevant') return 0.2;
  return 0.25;
}

function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function compositeGrade(metrics) {
  return 0.6 * Number(metrics.pulse_reasoning_quality) + 0.4 * Number(metrics.first_order_task_quality);
}

function itemOutcome(item, plan) {
  const quality = mean((item.grades || []).map(grade => compositeGrade(grade.metrics)));
  const usefulness = usefulnessValue(item.pulse_resolution?.outcome);
  const forecastScore = Number(item.forecast_resolution?.policy_forecast_score);
  const schedulePressure = 30 / Number(item.forecast_resolution?.elapsed_minutes || item.effective_interval_minutes);
  const netUtility = 0.45 * usefulness + 0.25 * forecastScore + 0.30 * quality
    - plan.schedule_pressure_cost * schedulePressure;
  const disagreements = [];
  for (let left = 0; left < item.grades.length; left++) for (let right = left + 1; right < item.grades.length; right++) {
    disagreements.push(Math.max(...METRICS.map(metric => Math.abs(
      Number(item.grades[left].metrics[metric]) - Number(item.grades[right].metrics[metric])))));
  }
  return { usefulness, forecast_score: forecastScore, mean_quality: quality,
    first_order_task_quality: mean(item.grades.map(grade => grade.metrics.first_order_task_quality)),
    schedule_pressure: schedulePressure, net_utility: netUtility,
    evaluator_count: item.grades.length, max_disagreement: disagreements.length ? Math.max(...disagreements) : 0 };
}

function manifest(study) {
  return canonicalJson({ study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
    item_target_per_condition: study.item_target_per_condition, total_item_target: study.total_item_target,
    conditions: study.conditions, subject_model: study.subject_model, analysis_plan: study.analysis_plan,
    scheduler_config: study.scheduler_config,
    selection_rule: study.selection_rule, calibration_basis_record_ids: study.calibration_basis_record_ids,
    calibration_basis_commitment: study.calibration_basis_commitment, metrics: METRICS, rubrics: RUBRICS });
}

function analysis(study) {
  const resolved = study.items.filter(item => item.status === 'resolved' && item.outcome);
  const groups = Object.fromEntries(CONDITIONS.map(condition => [condition,
    resolved.filter(item => item.condition === condition)]));
  const summary = Object.fromEntries(CONDITIONS.map(condition => [condition, {
    samples: groups[condition].length,
    mean_net_utility: mean(groups[condition].map(item => item.outcome.net_utility)),
    mean_usefulness: mean(groups[condition].map(item => item.outcome.usefulness)),
    mean_forecast_score: mean(groups[condition].map(item => item.outcome.forecast_score)),
    mean_quality: mean(groups[condition].map(item => item.outcome.mean_quality)),
    mean_first_order_task_quality: mean(groups[condition].map(item => item.outcome.first_order_task_quality)),
    mean_effective_interval_minutes: mean(groups[condition].map(item => item.effective_interval_minutes)),
    mean_observed_interval_minutes: mean(groups[condition].map(item => item.forecast_resolution?.elapsed_minutes)),
  }]));
  const blockMap = new Map();
  for (const item of resolved) {
    if (!blockMap.has(item.randomization_block)) blockMap.set(item.randomization_block, {});
    blockMap.get(item.randomization_block)[item.condition] = item;
  }
  const completeBlocks = [...blockMap.entries()].filter(([, row]) =>
    CONDITIONS.every(condition => row[condition])).sort(([left], [right]) => left - right);
  const values = (condition, field) => completeBlocks.map(([, row]) => row[condition].outcome[field]);
  const options = { iterations: study.analysis_plan.bootstrap_iterations, confidence: study.analysis_plan.confidence };
  const utilityVsDeidentified = pairedBootstrapDifference(values('identity_bound_regulation', 'net_utility'),
    values('deidentified_regulation', 'net_utility'), { ...options, seed: `${study.analysis_seed}:utility:deidentified` });
  const utilityVsFixed = pairedBootstrapDifference(values('identity_bound_regulation', 'net_utility'),
    values('fixed_cadence', 'net_utility'), { ...options, seed: `${study.analysis_seed}:utility:fixed` });
  const qualityVsDeidentified = pairedBootstrapDifference(values('identity_bound_regulation', 'mean_quality'),
    values('deidentified_regulation', 'mean_quality'), { ...options, seed: `${study.analysis_seed}:quality:deidentified` });
  const qualityVsFixed = pairedBootstrapDifference(values('identity_bound_regulation', 'mean_quality'),
    values('fixed_cadence', 'mean_quality'), { ...options, seed: `${study.analysis_seed}:quality:fixed` });
  const countsBalanced = CONDITIONS.every(condition => groups[condition].length === study.item_target_per_condition);
  const families = new Set(resolved.map(item => item.source_family));
  const timingVerified = resolved.every(item => item.forecast_resolution?.timing_adherence_verified === true);
  const pairVerified = resolved.every(item => item.pair_integrity_verified === true);
  const enoughEvidence = resolved.length === study.total_item_target && countsBalanced
    && completeBlocks.length === study.item_target_per_condition && timingVerified && pairVerified
    && families.size >= study.analysis_plan.minimum_independent_families
    && resolved.every(item => item.outcome.evaluator_count >= study.analysis_plan.evaluator_target
      && item.outcome.max_disagreement <= study.analysis_plan.evaluator_disagreement_tolerance);
  const identityQuality = summary.identity_bound_regulation.mean_quality;
  const controlsQuality = Math.max(summary.deidentified_regulation.mean_quality ?? -Infinity,
    summary.fixed_cadence.mean_quality ?? -Infinity);
  const qualityNonDegraded = identityQuality != null
    && identityQuality >= controlsQuality - study.analysis_plan.quality_non_degradation_margin;
  const predictedPattern = enoughEvidence && qualityNonDegraded
    && utilityVsDeidentified?.lower > 0 && utilityVsFixed?.lower > 0
    && utilityVsDeidentified.observed_effect >= study.analysis_plan.minimum_utility_advantage
    && utilityVsFixed.observed_effect >= study.analysis_plan.minimum_utility_advantage;
  return { total_target: study.total_item_target, resolved: resolved.length,
    independent_source_families: families.size, counts_balanced: countsBalanced,
    complete_randomization_blocks: completeBlocks.length,
    timing_adherence_verified: timingVerified, forecast_pair_integrity_verified: pairVerified,
    group_summary: summary, quality_non_degraded: qualityNonDegraded,
    utility_vs_deidentified_interval: utilityVsDeidentified, utility_vs_fixed_interval: utilityVsFixed,
    quality_vs_deidentified_interval: qualityVsDeidentified, quality_vs_fixed_interval: qualityVsFixed,
    enough_evidence: enoughEvidence, predicted_pattern: predictedPattern,
    verdict: !enoughEvidence ? 'insufficient_evidence' : predictedPattern ? 'identity_bound_regulation_advantage'
      : (utilityVsDeidentified?.upper <= 0 || utilityVsFixed?.upper <= 0)
        ? 'no_identity_specific_regulation_advantage' : 'inconclusive' };
}

module.exports = { CONDITIONS, BINDINGS, METRICS, RUBRICS, canonicalJson, hash, assignmentForIndex,
  conditionOrder, forecastPacket, packetPairVerified, systemPrompt, userPrompt, normalizeForecast,
  parseForecast, sourceFamily, resolvedSourceFamily, usefulnessValue, compositeGrade, itemOutcome, manifest, analysis };
