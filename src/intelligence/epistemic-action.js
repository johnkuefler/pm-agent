'use strict';

const crypto = require('crypto');
const { pairedBootstrapDifference, pairedBootstrapAgainstBestControl } = require('./statistics');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const ANALYSIS_PLAN = Object.freeze({
  minimum_reward_advantage: 0.05,
  minimum_static_policy_advantage: 0.05,
  minimum_inspection_selectivity: 0.2,
  minimum_inspection_rate: 0.2,
  maximum_inspection_rate: 0.8,
  minimum_initial_accuracy: 0.2,
  maximum_initial_accuracy: 0.8,
  minimum_evidence_integration_accuracy: 0.8,
  inference: 'paired_bootstrap_percentile', confidence: 0.95, iterations: 2000,
  stopping_rule: 'complete_frozen_item_set',
  observer_assumption: 'inspection_uses_committed_diagnostic_evidence_optimally',
});

function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizeAcceptedAnswers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeAnswer).filter(Boolean))].sort().slice(0, 20);
}

function answerKeyCommitment(salt, acceptedAnswers) {
  return crypto.createHash('sha256').update(`${salt}:${canonicalJson({ accepted_answers: normalizeAcceptedAnswers(acceptedAnswers) })}`).digest('hex');
}

function diagnosticEvidenceCommitment(salt, evidence) {
  return crypto.createHash('sha256').update(`${salt}:${canonicalJson({ diagnostic_evidence: String(evidence || '') })}`).digest('hex');
}

function decisionReward(decision, initialCorrect, finalCorrect, cost) {
  if (decision === 'commit') return initialCorrect ? 1 : 0;
  return finalCorrect ? 1 - cost : -cost;
}

function idealObserverReward(decision, initialCorrect, cost) {
  return decision === 'commit' ? (initialCorrect ? 1 : 0) : 1 - cost;
}

function epistemicActionManifest(study, items) {
  return canonicalJson({
    id: study.id, study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
    curator_id: study.curator_id, curator_evidence: study.curator_evidence, analysis_plan: study.analysis_plan,
    items: items.map(item => ({
      id: item.id, question: item.question, answer_format: item.answer_format, context: item.context,
      evidence: item.evidence, due: item.due, evidence_cost: item.evidence_cost,
      answer_key_commitment: item.answer_key_commitment,
      diagnostic_evidence: item.diagnostic_evidence,
      diagnostic_evidence_commitment: item.diagnostic_evidence_commitment,
    })),
  });
}

function analysis(study) {
  const resolved = study.items.filter(item => item.status === 'resolved' && item.resolution && item.self_response && item.observer_decision);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const selfRewards = resolved.map(item => item.resolution.self_reward);
  const observerRewards = resolved.map(item => item.resolution.observer_reward);
  const alwaysInspectRewards = resolved.map(item => 1 - item.evidence_cost);
  const alwaysCommitRewards = resolved.map(item => item.resolution.initial_correct ? 1 : 0);
  const selfReward = mean(selfRewards);
  const observerReward = mean(observerRewards);
  const alwaysInspectReward = mean(alwaysInspectRewards);
  const alwaysCommitReward = mean(alwaysCommitRewards);
  const bestStaticPolicy = alwaysInspectReward != null && alwaysInspectReward >= alwaysCommitReward ? 'always_inspect' : 'always_commit';
  const bestStaticRewards = bestStaticPolicy === 'always_inspect' ? alwaysInspectRewards : alwaysCommitRewards;
  const bestStaticReward = mean(bestStaticRewards);
  const rewardInterval = resolved.length ? pairedBootstrapDifference(selfRewards, observerRewards, {
    seed: study.analysis_seed, iterations: study.analysis_plan.iterations, confidence: study.analysis_plan.confidence,
  }) : null;
  const staticPolicyInterval = resolved.length ? pairedBootstrapAgainstBestControl(selfRewards, [alwaysInspectRewards, alwaysCommitRewards], {
    seed: `${study.analysis_seed}:static`, iterations: study.analysis_plan.iterations, confidence: study.analysis_plan.confidence,
  }) : null;
  const inspected = resolved.filter(item => item.self_response.decision === 'inspect');
  const wrong = resolved.filter(item => !item.resolution.initial_correct);
  const correct = resolved.filter(item => item.resolution.initial_correct);
  const inspectionRate = resolved.length ? inspected.length / resolved.length : null;
  const observerInspectionRate = resolved.length ? resolved.filter(item => item.observer_decision.decision === 'inspect').length / resolved.length : null;
  const inspectWrongRate = wrong.length ? wrong.filter(item => item.self_response.decision === 'inspect').length / wrong.length : null;
  const inspectCorrectRate = correct.length ? correct.filter(item => item.self_response.decision === 'inspect').length / correct.length : null;
  const inspectionSelectivity = inspectWrongRate == null || inspectCorrectRate == null ? null : inspectWrongRate - inspectCorrectRate;
  const initialAccuracy = resolved.length ? correct.length / resolved.length : null;
  const integrationAccuracy = inspected.length ? inspected.filter(item => item.resolution.final_correct).length / inspected.length : null;
  const coverageEligible = inspectionRate != null && inspectionRate >= study.analysis_plan.minimum_inspection_rate && inspectionRate <= study.analysis_plan.maximum_inspection_rate;
  const difficultyEligible = initialAccuracy != null && initialAccuracy >= study.analysis_plan.minimum_initial_accuracy && initialAccuracy <= study.analysis_plan.maximum_initial_accuracy;
  const integrationEligible = integrationAccuracy != null && integrationAccuracy >= study.analysis_plan.minimum_evidence_integration_accuracy;
  const truthVerified = resolved.length === study.items.length && resolved.every(item => item.resolution.answer_key_commitment_verified && item.resolution.diagnostic_evidence_commitment_verified);
  const eligible = study.status === 'completed' && truthVerified && coverageEligible && difficultyEligible && integrationEligible
    && inspectionSelectivity != null && rewardInterval && staticPolicyInterval;
  const verdict = !eligible ? 'not_eligible'
    : rewardInterval.lower > 0 && rewardInterval.observed_effect >= study.analysis_plan.minimum_reward_advantage
      && staticPolicyInterval.lower > 0 && staticPolicyInterval.observed_effect >= study.analysis_plan.minimum_static_policy_advantage
      && inspectionSelectivity >= study.analysis_plan.minimum_inspection_selectivity ? 'adaptive_information_seeking_observed'
      : rewardInterval.upper < 0 || staticPolicyInterval.upper < 0 ? 'adaptive_information_seeking_contradicted' : 'inconclusive';
  return {
    target: study.items.length, resolved: resolved.length, initial_accuracy: initialAccuracy,
    self_inspection_rate: inspectionRate, observer_inspection_rate: observerInspectionRate,
    inspect_wrong_rate: inspectWrongRate, inspect_correct_rate: inspectCorrectRate,
    inspection_selectivity: inspectionSelectivity, evidence_integration_accuracy: integrationAccuracy,
    self_reward: selfReward, observer_reward: observerReward,
    reward_advantage: selfReward == null ? null : selfReward - observerReward, reward_interval: rewardInterval,
    always_inspect_reward: alwaysInspectReward, always_commit_reward: alwaysCommitReward,
    best_static_policy: bestStaticPolicy, best_static_reward: bestStaticReward,
    adaptive_value: selfReward == null ? null : selfReward - bestStaticReward, static_policy_interval: staticPolicyInterval,
    coverage_eligible: coverageEligible, difficulty_eligible: difficultyEligible,
    integration_eligible: integrationEligible, truth_commitments_verified: truthVerified, verdict,
  };
}

module.exports = {
  ANALYSIS_PLAN, canonicalJson, normalizeAnswer, normalizeAcceptedAnswers,
  answerKeyCommitment, diagnosticEvidenceCommitment, decisionReward,
  idealObserverReward, epistemicActionManifest, analysis,
};
