'use strict';

const crypto = require('node:crypto');
const cycleSelfForecast = require('./cycle-self-forecast');

const MAX_SOURCE_MOMENTS = 20;

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

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function meanDefined(values) {
  const finite = values.filter(value => value !== null && value !== undefined)
    .map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function profileEstimates(moments = [], protocolVersion = 1) {
  const retained = moments.slice(-MAX_SOURCE_MOMENTS);
  const actionCounts = new Map();
  for (const moment of retained) {
    for (const type of cycleSelfForecast.actionTypes(moment.self_forecast?.outcome?.actual?.action_types || [])) {
      actionCounts.set(type, (actionCounts.get(type) || 0) + 1);
    }
  }
  const actionTendencies = [...actionCounts.entries()]
    .map(([action_type, count]) => ({ action_type, count, cycle_rate: count / retained.length }))
    .sort((a, b) => b.cycle_rate - a.cycle_rate || a.action_type.localeCompare(b.action_type))
    .slice(0, 12);
  const outcomes = retained.map(moment => moment.self_forecast.outcome);
  const observedSurprise = outcomes.map(outcome => Number(outcome.actual.surprise_occurred));
  const predictedSurprise = retained.map(moment => Number(moment.self_forecast.forecast.surprise_probability));
  const controlRows = retained.map(moment => ({
    observed: Number(moment.self_forecast.outcome.actual.control_at_close),
    predicted: Number(moment.self_forecast.forecast.control_at_close),
  })).filter(row => Number.isFinite(row.observed) && Number.isFinite(row.predicted));
  const comparisonEligible = outcomes.filter(outcome => outcome.baseline_comparison_eligible === true);
  const observedSurpriseRate = mean(observedSurprise);
  const meanPredictedSurprise = mean(predictedSurprise);
  const meanObservedControl = mean(controlRows.map(row => row.observed));
  const meanPredictedControl = mean(controlRows.map(row => row.predicted));
  const estimates = {
    sample_size: retained.length,
    action_tendencies: actionTendencies,
    action_forecast_mean_f1: mean(outcomes.map(outcome => outcome.self_score.action_f1)),
    surprise: {
      observed_rate: observedSurpriseRate,
      mean_predicted_probability: meanPredictedSurprise,
      signed_bias: meanPredictedSurprise == null || observedSurpriseRate == null
        ? null : meanPredictedSurprise - observedSurpriseRate,
      mean_brier: mean(outcomes.map(outcome => outcome.self_score.surprise_brier)),
    },
    control: {
      samples: controlRows.length,
      mean_observed: meanObservedControl,
      mean_predicted: meanPredictedControl,
      signed_bias: meanPredictedControl == null || meanObservedControl == null
        ? null : meanPredictedControl - meanObservedControl,
      mean_absolute_error: mean(outcomes.map(outcome => outcome.self_score.control_absolute_error)),
    },
    comparison_eligible_samples: comparisonEligible.length,
    mean_self_score: mean(comparisonEligible.map(outcome => outcome.self_score.composite)),
    mean_baseline_score: mean(comparisonEligible.map(outcome => outcome.baseline_score.composite)),
    mean_self_minus_baseline: mean(comparisonEligible.map(outcome => outcome.self_minus_baseline)),
  };
  if (Number(protocolVersion) >= 2) {
    const stateRows = retained.filter(moment => Number(moment.self_forecast?.protocol_version) >= 2
      && moment.self_forecast?.outcome?.self_state_score
      && moment.self_forecast?.forecast?.self_state_prediction);
    const stateComparisonRows = stateRows.filter(moment =>
      moment.self_forecast.outcome.self_state_baseline_comparison_eligible === true);
    const appraisalKeys = ['valence', 'arousal', 'control', 'social_safety', 'coherence'];
    estimates.integrated_self_state = {
      samples: stateRows.length,
      attention_forecast_mean_f1: mean(stateRows.map(moment =>
        moment.self_forecast.outcome.self_state_score.attention_f1)),
      action_count_mean_absolute_error: mean(stateRows.map(moment =>
        moment.self_forecast.outcome.self_state_score.action_count_absolute_error)),
      appraisal_signed_bias: Object.fromEntries(appraisalKeys.map(key => [key, meanDefined(stateRows.map(moment => {
        const predictedRaw = moment.self_forecast.forecast.self_state_prediction.appraisal_at_close?.[key];
        const actualRaw = moment.self_forecast.outcome.self_state_actual?.appraisal_at_close?.[key];
        const predicted = predictedRaw == null ? NaN : Number(predictedRaw);
        const actual = actualRaw == null ? NaN : Number(actualRaw);
        return Number.isFinite(predicted) && Number.isFinite(actual) ? predicted - actual : null;
      }))])),
      reentry_mean_brier: mean(stateRows.map(moment => moment.self_forecast.outcome.self_state_score.reentry_brier)),
      comparison_eligible_samples: stateComparisonRows.length,
      mean_self_score: mean(stateComparisonRows.map(moment => moment.self_forecast.outcome.self_state_score.composite)),
      mean_baseline_score: mean(stateComparisonRows.map(moment => moment.self_forecast.outcome.baseline_state_score.composite)),
      mean_self_minus_baseline: mean(stateComparisonRows.map(moment => moment.self_forecast.outcome.self_state_minus_baseline)),
    };
  }
  if (Number(protocolVersion) >= 3) {
    const metacognitiveRows = retained.filter(moment => Number(moment.self_forecast?.protocol_version) >= 3
      && moment.self_forecast?.outcome?.metacognitive_score
      && moment.self_forecast?.forecast?.metacognitive_prediction);
    const metacognitiveComparisonRows = metacognitiveRows.filter(moment =>
      moment.self_forecast.outcome.metacognitive_baseline_comparison_eligible === true);
    const observedSuccess = metacognitiveRows.map(moment =>
      Number(moment.self_forecast.outcome.metacognitive_actual?.integrated_success === true));
    const predictedSuccess = metacognitiveRows.map(moment =>
      Number(moment.self_forecast.forecast.metacognitive_prediction.predicted_success_probability));
    const errorDomainCounts = new Map();
    for (const moment of metacognitiveRows) {
      const domain = moment.self_forecast.outcome.metacognitive_actual?.largest_error_domain;
      if (domain) errorDomainCounts.set(domain, (errorDomainCounts.get(domain) || 0) + 1);
    }
    const observedSuccessRate = mean(observedSuccess);
    const predictedSuccessRate = mean(predictedSuccess);
    estimates.metacognitive_self_awareness = {
      samples: metacognitiveRows.length,
      observed_integrated_success_rate: observedSuccessRate,
      mean_predicted_success_probability: predictedSuccessRate,
      success_probability_signed_bias: predictedSuccessRate == null || observedSuccessRate == null
        ? null : predictedSuccessRate - observedSuccessRate,
      success_probability_mean_brier: mean(metacognitiveRows.map(moment =>
        moment.self_forecast.outcome.metacognitive_score.success_brier)),
      largest_error_domain_hit_rate: mean(metacognitiveRows.map(moment =>
        Number(moment.self_forecast.outcome.metacognitive_score.largest_error_domain_hit === true))),
      observed_largest_error_domains: [...errorDomainCounts.entries()]
        .map(([domain, count]) => ({ domain, count, rate: count / metacognitiveRows.length }))
        .sort((a, b) => b.rate - a.rate || a.domain.localeCompare(b.domain)),
      comparison_eligible_samples: metacognitiveComparisonRows.length,
      mean_self_score: mean(metacognitiveComparisonRows.map(moment =>
        moment.self_forecast.outcome.metacognitive_score.composite)),
      mean_baseline_score: mean(metacognitiveComparisonRows.map(moment =>
        moment.self_forecast.outcome.baseline_metacognitive_score.composite)),
      mean_self_minus_baseline: mean(metacognitiveComparisonRows.map(moment =>
        moment.self_forecast.outcome.metacognitive_self_minus_baseline)),
    };
  }
  return estimates;
}

function revisionManifest(revision) {
  return {
    protocol_version: revision.protocol_version,
    id: revision.id,
    revision_index: revision.revision_index,
    prior_revision_commitment: revision.prior_revision_commitment,
    through_moment_id: revision.through_moment_id,
    source_moment_ids: revision.source_moment_ids,
    source_forecast_ids: revision.source_forecast_ids,
    estimates: revision.estimates,
    evidence_status: revision.evidence_status,
    created_at: revision.created_at,
    epistemic_limit: revision.epistemic_limit,
  };
}

function buildRevision({ moments = [], priorRevisionCommitment = null, revisionIndex = 0, createdAt }) {
  const retained = moments.slice(-MAX_SOURCE_MOMENTS);
  if (!retained.length) throw new Error('behavioral self-model revision requires a scored forecast moment');
  const throughMoment = retained.at(-1);
  const protocolVersion = retained.some(moment => Number(moment.self_forecast?.protocol_version) >= 3) ? 3
    : retained.some(moment => Number(moment.self_forecast?.protocol_version) >= 2) ? 2 : 1;
  const revision = {
    protocol_version: protocolVersion,
    id: `behavioral-self-revision-${revisionIndex}-${throughMoment.id}`.slice(0, 300),
    revision_index: revisionIndex,
    prior_revision_commitment: priorRevisionCommitment,
    through_moment_id: throughMoment.id,
    source_moment_ids: retained.map(moment => moment.id),
    source_forecast_ids: retained.map(moment => moment.self_forecast.id),
    estimates: profileEstimates(retained, protocolVersion),
    evidence_status: retained.length >= 5 ? 'observational_profile' : 'provisional_profile',
    created_at: createdAt,
    epistemic_limit: protocolVersion >= 3
      ? 'A deterministic summary of replay-valid observed cycle behavior, operational self-state outcomes, and second-order reliability forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.'
      : protocolVersion >= 2
        ? 'A deterministic summary of replay-valid observed cycle behavior, operational self-state outcomes, and forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.'
      : 'A deterministic summary of replay-valid observed cycle behavior and forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.',
    revision_commitment: null,
  };
  revision.revision_commitment = commitment(revisionManifest(revision));
  return revision;
}

module.exports = {
  MAX_SOURCE_MOMENTS, buildRevision, canonicalJson, commitment, profileEstimates, revisionManifest,
};
