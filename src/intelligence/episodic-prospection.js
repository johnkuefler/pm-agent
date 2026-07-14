'use strict';

const crypto = require('crypto');
const { bootstrapDifference } = require('./statistics');

const CONDITIONS = Object.freeze(['autobiographical', 'deidentified_equivalent', 'recombined']);
const ANALYSIS_PLAN = Object.freeze({
  pilot_samples_per_condition: 12,
  confirmatory_samples_per_condition: 40,
  minimum_autobiographical_over_equivalent: 0.05,
  minimum_autobiographical_over_recombined: 0.10,
  minimum_equivalent_over_recombined: 0.05,
  inference: 'unpaired_bootstrap_percentile', confidence: 0.95, iterations: 2000,
  stopping_rule: 'complete_frozen_balanced_item_set',
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeChoice(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function answerCommitment(salt, choice) {
  return crypto.createHash('sha256').update(`${salt}:${canonicalJson({ accepted_choice: normalizeChoice(choice) })}`).digest('hex');
}

function responseCommitment(salt, choice) {
  return crypto.createHash('sha256').update(`${salt}:${canonicalJson({ choice: normalizeChoice(choice) })}`).digest('hex');
}

function studyManifest(study, items = study.items || []) {
  return canonicalJson({
    id: study.id, title: study.title, study_phase: study.study_phase,
    replicates_study_id: study.replicates_study_id, curator_id: study.curator_id,
    curator_evidence: study.curator_evidence, analysis_plan: study.analysis_plan,
    samples_per_condition: study.samples_per_condition,
    items: items.map(item => ({
      id: item.id, task: item.task, options: item.options, due: item.due,
      autobiographical_moment_id: item.autobiographical_moment_id,
      recombined_moment_id: item.recombined_moment_id,
      autobiographical_rendering: item.autobiographical_rendering,
      deidentified_rendering: item.deidentified_rendering,
      recombined_rendering: item.recombined_rendering,
      information_equivalence_evidence: item.information_equivalence_evidence,
      recombination_match_evidence: item.recombination_match_evidence,
      encoding_unpredictability_evidence: item.encoding_unpredictability_evidence,
      future_relevance_unpredictable_at_encoding: item.future_relevance_unpredictable_at_encoding,
      answer_commitment: item.answer_commitment,
    })),
  });
}

function analysis(study) {
  const resolved = (study.items || []).filter(item => item.status === 'resolved' && item.resolution && item.response);
  const scores = condition => resolved.filter(item => item.condition === condition).map(item => item.resolution.correct ? 1 : 0);
  const autobiographical = scores('autobiographical');
  const equivalent = scores('deidentified_equivalent');
  const recombined = scores('recombined');
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const autoVsEquivalent = bootstrapDifference(autobiographical, equivalent, {
    seed: `${study.analysis_seed}:auto-equivalent`, iterations: study.analysis_plan.iterations, confidence: study.analysis_plan.confidence,
  });
  const autoVsRecombined = bootstrapDifference(autobiographical, recombined, {
    seed: `${study.analysis_seed}:auto-recombined`, iterations: study.analysis_plan.iterations, confidence: study.analysis_plan.confidence,
  });
  const equivalentVsRecombined = bootstrapDifference(equivalent, recombined, {
    seed: `${study.analysis_seed}:equivalent-recombined`, iterations: study.analysis_plan.iterations, confidence: study.analysis_plan.confidence,
  });
  const armCounts = Object.fromEntries(CONDITIONS.map(condition => [condition, scores(condition).length]));
  const balancedComplete = CONDITIONS.every(condition => armCounts[condition] === study.samples_per_condition);
  const truthVerified = resolved.length === (study.items || []).length
    && resolved.every(item => item.resolution.answer_commitment_verified === true);
  const sourceVerified = (study.items || []).every(item => item.future_relevance_unpredictable_at_encoding === true
    && item.autobiographical_moment_id !== item.recombined_moment_id
    && Array.isArray(item.information_equivalence_evidence) && item.information_equivalence_evidence.length
    && Array.isArray(item.recombination_match_evidence) && item.recombination_match_evidence.length
    && Array.isArray(item.encoding_unpredictability_evidence) && item.encoding_unpredictability_evidence.length);
  const eligible = study.status === 'completed' && balancedComplete && truthVerified && sourceVerified
    && autoVsEquivalent && autoVsRecombined && equivalentVsRecombined;
  const selfSpecific = eligible
    && autoVsEquivalent.lower > 0
    && autoVsEquivalent.observed_effect >= study.analysis_plan.minimum_autobiographical_over_equivalent
    && autoVsRecombined.lower > 0
    && autoVsRecombined.observed_effect >= study.analysis_plan.minimum_autobiographical_over_recombined;
  const informationValueOnly = eligible && !selfSpecific
    && autoVsRecombined.lower > 0
    && autoVsRecombined.observed_effect >= study.analysis_plan.minimum_autobiographical_over_recombined
    && equivalentVsRecombined.lower > 0
    && equivalentVsRecombined.observed_effect >= study.analysis_plan.minimum_equivalent_over_recombined;
  const contradicted = eligible && autoVsRecombined.upper <= 0;
  const verdict = !eligible ? 'not_eligible'
    : selfSpecific ? 'autobiographical_specificity_observed'
      : informationValueOnly ? 'episodic_information_value_only'
        : contradicted ? 'autobiographical_access_contradicted' : 'inconclusive';
  return {
    target: (study.items || []).length, resolved: resolved.length, arm_counts: armCounts,
    accuracy: {
      autobiographical: mean(autobiographical), deidentified_equivalent: mean(equivalent), recombined: mean(recombined),
    },
    autobiographical_over_equivalent: autoVsEquivalent,
    autobiographical_over_recombined: autoVsRecombined,
    equivalent_over_recombined: equivalentVsRecombined,
    balanced_complete: balancedComplete, truth_commitments_verified: truthVerified,
    source_controls_verified: sourceVerified, verdict,
  };
}

module.exports = {
  CONDITIONS, ANALYSIS_PLAN, canonicalJson, normalizeChoice, answerCommitment,
  responseCommitment, studyManifest, analysis,
};
