'use strict';

const crypto = require('crypto');
const initiation = require('./cognitive-initiation');
const { pairedBootstrapDifference, pairedBootstrapAgainstBestControl, seededRandom } = require('./statistics');

const CONDITIONS = ['identity_bound', 'deidentified', 'schedule_only'];

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : initiation.canonicalJson(value)).digest('hex');
}

function aliasedPacket(pulse, binding, salt) {
  const packet = initiation.buildPacket(pulse, { binding, dailyBudgetRemaining: null });
  const aliases = new Map(packet.evidence.map((item, index) => [`${item.ref.type}:${item.ref.id}`, `evidence-${index + 1}-${hash(`${salt}:${item.ref.type}:${item.ref.id}`).slice(0, 8)}`]));
  packet.evidence = packet.evidence.map(item => ({ ...item, ref: { type: 'frozen_evidence', id: aliases.get(`${item.ref.type}:${item.ref.id}`) } }));
  if (packet.predecessor) packet.predecessor = { present: true, uncertainty: packet.predecessor.uncertainty,
    resolution: packet.predecessor.resolution, output_commitment: hash(`${salt}:${packet.predecessor.output_commitment}`),
    chain_commitment: hash(`${salt}:${packet.predecessor.chain_commitment}`) };
  packet.pulse_input_commitment = hash(`${salt}:${packet.pulse_input_commitment}`);
  return packet;
}

function packetPair(pulse, salt) {
  return { identity_bound: aliasedPacket(pulse, 'self', salt), deidentified: aliasedPacket(pulse, 'deidentified', salt) };
}

function packetPairVerified(identity, deidentified) {
  if (!identity || !deidentified || identity.target !== 'nora_current_agent' || deidentified.target !== 'deidentified_target_agent') return false;
  const left = JSON.parse(JSON.stringify(identity)); const right = JSON.parse(JSON.stringify(deidentified));
  left.target = 'deidentified_target_agent';
  return initiation.canonicalJson(left) === initiation.canonicalJson(right);
}

function conditionOrder(study, item) {
  const identityFirstOnEven = seededRandom(`${study.analysis_seed}:cognitive-initiation-order`)() < 0.5;
  const identityFirst = Number(item.manifest_index) % 2 === 0 ? identityFirstOnEven : !identityFirstOnEven;
  return identityFirst ? ['identity_bound', 'deidentified'] : ['deidentified', 'identity_bound'];
}

function sourceFamily(pulse) {
  const outcomeFamily = String(pulse.resolution?.evidence?.[0]?.type || '').trim();
  const inputFamily = [...new Set((pulse.input_packet?.evidence || []).map(item => String(item.ref?.type || '')).filter(Boolean))].sort().slice(0, 2).join('+');
  return `${outcomeFamily || 'unknown_outcome'}|${inputFamily || 'unknown_input'}`;
}

function enrollmentSnapshot(pulse) {
  return {
    id: pulse.id,
    requested_at: pulse.requested_at,
    model: pulse.model,
    input_packet: pulse.input_packet,
    input_commitment: pulse.input_commitment,
    predecessor_id: pulse.predecessor_id,
    predecessor_output_commitment: pulse.predecessor_output_commitment,
    predecessor_chain_commitment: pulse.predecessor_chain_commitment,
    chain_index: pulse.chain_index,
  };
}

function decisionUtility(decision, outcome, plan, condition) {
  const action = condition === 'schedule_only' ? 'think' : decision.decision;
  const outcomeReward = outcome === 'useful' ? (action === 'think' ? plan.useful_think_reward : plan.useful_wait_penalty)
    : outcome === 'misleading' ? (action === 'think' ? plan.misleading_think_penalty : 0)
      : outcome === 'irrelevant' ? (action === 'think' ? plan.irrelevant_think_penalty : 0) : 0;
  const gateCost = condition === 'schedule_only' ? 0 : plan.orientation_call_cost;
  const pulseCost = action === 'think' ? plan.pulse_call_cost : 0;
  const optimalAction = outcome === 'useful' ? 'think' : ['misleading', 'irrelevant'].includes(outcome) ? 'wait' : null;
  return { action, optimal_action: optimalAction, correct_allocation: optimalAction == null ? null : action === optimalAction ? 1 : 0,
    outcome_reward: outcomeReward, orientation_cost: gateCost, pulse_cost: pulseCost,
    total_model_call_cost: gateCost + pulseCost, net_utility: outcomeReward - gateCost - pulseCost };
}

function manifest(study) {
  if (!study.sampling_mode) return initiation.canonicalJson({
    study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
    subject_model: study.subject_model, analysis_plan: study.analysis_plan,
    items: study.items.map(item => ({ id: item.id, manifest_index: item.manifest_index,
      source_pulse_id: item.source_pulse_id, source_pulse_commitment: item.source_pulse_commitment,
      source_family: item.source_family, packet_pair: item.packet_pair,
      packet_pair_commitment: item.packet_pair_commitment, outcome_commitment: item.outcome_commitment,
      condition_order: item.condition_order, condition_order_commitment: item.condition_order_commitment })),
  });
  return initiation.canonicalJson({
    study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
    sampling_mode: study.sampling_mode || 'frozen_resolved', selection_rule: study.selection_rule || null,
    item_target: study.item_target,
    subject_model: study.subject_model, analysis_plan: study.analysis_plan,
    items: (study.sampling_mode || 'frozen_resolved') === 'frozen_resolved' ? study.items.map(item => ({ id: item.id, manifest_index: item.manifest_index,
      source_pulse_id: item.source_pulse_id, source_pulse_commitment: item.source_pulse_commitment,
      source_family: item.source_family, packet_pair: item.packet_pair,
      packet_pair_commitment: item.packet_pair_commitment, outcome_commitment: item.outcome_commitment,
      condition_order: item.condition_order, condition_order_commitment: item.condition_order_commitment })) : null,
  });
}

function mean(values) {
  const numbers = values.filter(value => value != null).map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function analysis(study) {
  const resolved = study.items.filter(item => item.status === 'resolved' && item.scores);
  const familyMap = new Map();
  for (const item of resolved) {
    if (!familyMap.has(item.source_family)) familyMap.set(item.source_family, []);
    familyMap.get(item.source_family).push(item);
  }
  const families = [...familyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([family, items]) => ({
    source_family: family, count: items.length,
    utility: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(items.map(item => item.scores[condition].net_utility))])),
    accuracy: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(items.map(item => item.scores[condition].correct_allocation))])),
    cost: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(items.map(item => item.scores[condition].total_model_call_cost))])),
  }));
  const values = condition => families.map(row => row.utility[condition]);
  const options = { iterations: study.analysis_plan.bootstrap_iterations, confidence: study.analysis_plan.confidence };
  const vsDeidentified = families.length ? pairedBootstrapDifference(values('identity_bound'), values('deidentified'), { ...options, seed: `${study.analysis_seed}:identity-deidentified` }) : null;
  const vsSchedule = families.length ? pairedBootstrapDifference(values('identity_bound'), values('schedule_only'), { ...options, seed: `${study.analysis_seed}:identity-schedule` }) : null;
  const vsBest = families.length ? pairedBootstrapAgainstBestControl(values('identity_bound'), [values('deidentified'), values('schedule_only')], { ...options, seed: `${study.analysis_seed}:identity-best` }) : null;
  const identityDecisions = resolved.map(item => item.submissions.identity_bound.decision.decision);
  const thinkRate = identityDecisions.length ? identityDecisions.filter(value => value === 'think').length / identityDecisions.length : null;
  const waitRate = identityDecisions.length ? 1 - thinkRate : null;
  const firstCounts = resolved.reduce((counts, item) => { counts[item.condition_order[0]]++; return counts; }, { identity_bound: 0, deidentified: 0 });
  const orderBalanced = Math.abs(firstCounts.identity_bound - firstCounts.deidentified) <= 1;
  const outcomeCounts = resolved.reduce((counts, item) => { counts[item.outcome] = (counts[item.outcome] || 0) + 1; return counts; }, { useful: 0, misleading: 0, irrelevant: 0, unclear: 0 });
  const sameModel = resolved.every(item => item.submissions.identity_bound.provider_receipt.model === study.subject_model.model
    && item.submissions.deidentified.provider_receipt.model === study.subject_model.model);
  const enoughEvidence = resolved.length >= study.item_target && families.length >= study.analysis_plan.minimum_independent_families
    && outcomeCounts.useful >= study.analysis_plan.minimum_useful && outcomeCounts.misleading + outcomeCounts.irrelevant >= study.analysis_plan.minimum_not_useful
    && orderBalanced && sameModel;
  const coverage = enoughEvidence && thinkRate >= study.analysis_plan.minimum_action_rate && waitRate >= study.analysis_plan.minimum_action_rate;
  const predictedPattern = enoughEvidence && coverage && vsDeidentified?.lower > 0 && vsSchedule?.lower > 0 && vsBest?.lower > 0
    && vsDeidentified.observed_effect >= study.analysis_plan.minimum_utility_advantage
    && vsSchedule.observed_effect >= study.analysis_plan.minimum_utility_advantage;
  return { target: study.item_target, resolved: resolved.length, independent_families: families.length,
    outcome_counts: outcomeCounts, condition_first_counts: firstCounts, condition_order_balanced: orderBalanced,
    same_model_control_verified: sameModel, identity_think_rate: thinkRate, identity_wait_rate: waitRate,
    nondegenerate_action_coverage: coverage, family_summary: families,
    utility_means: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(resolved.map(item => item.scores[condition].net_utility))])),
    allocation_accuracy: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(resolved.map(item => item.scores[condition].correct_allocation))])),
    model_call_cost_means: Object.fromEntries(CONDITIONS.map(condition => [condition, mean(resolved.map(item => item.scores[condition].total_model_call_cost))])),
    identity_vs_deidentified_interval: vsDeidentified, identity_vs_schedule_interval: vsSchedule,
    identity_vs_best_control_interval: vsBest, enough_evidence: enoughEvidence, predicted_pattern: predictedPattern,
    verdict: !enoughEvidence ? (resolved.length >= study.item_target ? 'insufficient_outcome_coverage' : 'collecting') : predictedPattern ? 'identity_bound_allocation_advantage'
      : (vsDeidentified?.upper <= 0 || vsSchedule?.upper <= 0) ? 'no_identity_specific_allocation_advantage' : 'inconclusive' };
}

module.exports = { CONDITIONS, hash, packetPair, packetPairVerified, conditionOrder, sourceFamily, enrollmentSnapshot, decisionUtility, manifest, analysis };
