'use strict';

const crypto = require('node:crypto');
const cycleSelfForecast = require('./cycle-self-forecast');

const MAX_SOURCE_MOMENTS = 20;
const TRUST_MINIMUM_COMPARISONS = 20;
const TRUST_ADVANTAGE_MARGIN = 0.02;

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

function trustDisposition(samples, advantage) {
  const count = Number(samples) || 0;
  const effect = advantage == null ? null : Number(advantage);
  if (count < TRUST_MINIMUM_COMPARISONS || !Number.isFinite(effect)) return 'collecting';
  if (effect >= TRUST_ADVANTAGE_MARGIN) return 'self_model_eligible';
  if (effect <= 0) return 'defer_to_baseline';
  return 'uncertain_defer_to_baseline';
}

function trustPolicy({ estimates = {}, sourceType, sourceId, sourceCommitment }) {
  const source_type = String(sourceType || '').trim();
  const source_id = String(sourceId || '').trim();
  const source_commitment = String(sourceCommitment || '').trim().toLowerCase();
  if (!source_type || !source_id || !/^[a-f0-9]{64}$/.test(source_commitment)) {
    throw new Error('behavioral self trust policy requires a committed source');
  }
  const domain = (samples, advantage, baseline_kind) => ({
    comparison_eligible_samples: Number(samples) || 0,
    mean_self_minus_baseline: advantage == null || !Number.isFinite(Number(advantage))
      ? null : Number(advantage),
    baseline_kind,
    disposition: trustDisposition(samples, advantage),
  });
  const domains = {
    behavioral_prediction: domain(estimates.comparison_eligible_samples,
      estimates.mean_self_minus_baseline, 'frozen_historical_behavior'),
    integrated_self_state: domain(estimates.integrated_self_state?.comparison_eligible_samples,
      estimates.integrated_self_state?.mean_self_minus_baseline, 'frozen_historical_self_state'),
    metacognitive_reliability: domain(estimates.metacognitive_self_awareness?.comparison_eligible_samples,
      estimates.metacognitive_self_awareness?.mean_self_minus_baseline,
      'historical_success_rate_and_modal_error_domain'),
    substrate_prediction: domain(estimates.substrate_self_model?.comparison_eligible_samples,
      estimates.substrate_self_model?.mean_self_minus_persistence, 'start_state_persistence'),
  };
  const policy = {
    protocol_version: 1,
    source_type, source_id, source_commitment,
    minimum_comparisons: TRUST_MINIMUM_COMPARISONS,
    self_model_advantage_margin: TRUST_ADVANTAGE_MARGIN,
    domains,
    self_model_eligible_domains: Object.entries(domains)
      .filter(([, value]) => value.disposition === 'self_model_eligible').map(([key]) => key),
    baseline_dominant_domains: Object.entries(domains)
      .filter(([, value]) => ['defer_to_baseline', 'uncertain_defer_to_baseline'].includes(value.disposition))
      .map(([key]) => key),
    epistemic_limit: 'A deterministic replay-bound control policy for when to trust this bounded self-model. Deferral records a measured predictive limitation, not an identity fact, instruction, hidden-state report, or consciousness evidence.',
  };
  policy.policy_commitment = commitment(policy);
  return policy;
}

function verifyTrustPolicy(policy) {
  if (!policy || typeof policy !== 'object' || !/^[a-f0-9]{64}$/.test(
    String(policy.policy_commitment || ''))) return false;
  const manifest = JSON.parse(JSON.stringify(policy));
  const expected = manifest.policy_commitment;
  delete manifest.policy_commitment;
  return commitment(manifest) === expected;
}

function profileEstimates(moments = [], protocolVersion = 1) {
  const retained = moments.slice(-MAX_SOURCE_MOMENTS);
  const actionCounts = new Map();
  for (const moment of retained) {
    for (const type of cycleSelfForecast.activeActionTypes(
      moment.self_forecast?.outcome?.actual?.action_types || [], protocolVersion)) {
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
    const protocolFloor = Number(protocolVersion) >= 4 ? 4 : 3;
    const metacognitiveRows = retained.filter(moment => Number(moment.self_forecast?.protocol_version) >= protocolFloor
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
  if (Number(protocolVersion) >= 4) {
    const substrateRows = retained.filter(moment => Number(moment.self_forecast?.protocol_version) >= 4
      && moment.self_forecast?.outcome?.substrate_score
      && moment.self_forecast?.forecast?.substrate_prediction);
    const comparisonRows = substrateRows.filter(moment =>
      moment.self_forecast.outcome.substrate_baseline_comparison_eligible === true);
    estimates.substrate_self_model = {
      samples: substrateRows.length,
      comparison_eligible_samples: comparisonRows.length,
      mean_self_score: mean(comparisonRows.map(moment =>
        moment.self_forecast.outcome.substrate_score.composite)),
      mean_persistence_score: mean(comparisonRows.map(moment =>
        moment.self_forecast.outcome.baseline_substrate_score.composite)),
      mean_self_minus_persistence: mean(comparisonRows.map(moment =>
        moment.self_forecast.outcome.substrate_self_minus_baseline)),
      observed_restarts: comparisonRows.filter(moment =>
        moment.self_forecast.outcome.substrate_actual?.restart_observed === true).length,
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
  const protocolVersion = retained.some(moment => Number(moment.self_forecast?.protocol_version) >= 5) ? 5
    : retained.some(moment => Number(moment.self_forecast?.protocol_version) >= 4) ? 4
    : retained.some(moment => Number(moment.self_forecast?.protocol_version) >= 3) ? 3
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
    epistemic_limit: protocolVersion >= 4
      ? 'A deterministic summary of replay-valid observed cycle behavior, operational self-state outcomes, second-order reliability errors, and observable runtime substrate forecast errors. It is a bounded, revisable prior, not identity essence, biological interoception, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.'
      : protocolVersion >= 3
      ? 'A deterministic summary of replay-valid observed cycle behavior, operational self-state outcomes, and second-order reliability forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.'
      : protocolVersion >= 2
        ? 'A deterministic summary of replay-valid observed cycle behavior, operational self-state outcomes, and forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.'
      : 'A deterministic summary of replay-valid observed cycle behavior and forecast errors. It is a bounded, revisable prior, not identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.',
    revision_commitment: null,
  };
  revision.revision_commitment = commitment(revisionManifest(revision));
  return revision;
}

function forecastPriorManifest(prior) {
  return {
    protocol_version: prior.protocol_version,
    id: prior.id,
    source_revision_id: prior.source_revision_id,
    source_revision_commitment: prior.source_revision_commitment,
    through_moment_id: prior.through_moment_id,
    source_moment_ids: prior.source_moment_ids,
    excluded_immediate_predecessor_id: prior.excluded_immediate_predecessor_id,
    sample_size: prior.sample_size,
    estimates: prior.estimates,
    evidence_status: prior.evidence_status,
    excluded_retired_action_observations: prior.excluded_retired_action_observations,
    epistemic_limit: prior.epistemic_limit,
  };
}

function buildForecastPrior({ revision, excludedImmediatePredecessorId }) {
  if (!revision?.revision_commitment || Number(revision.estimates?.sample_size) !== MAX_SOURCE_MOMENTS) {
    throw new Error('behavioral self prior requires a mature committed twenty-cycle revision');
  }
  const excludedId = String(excludedImmediatePredecessorId || '').trim();
  if (!excludedId || revision.through_moment_id === excludedId
    || (revision.source_moment_ids || []).includes(excludedId)) {
    throw new Error('behavioral self prior must exclude the immediate predecessor outcome');
  }
  const rawTendencies = revision.estimates?.action_tendencies || [];
  const activeTendencies = rawTendencies.filter(item =>
    !cycleSelfForecast.RETIRED_ACTION_TYPES.includes(String(item.action_type || '')));
  const excludedRetiredObservations = rawTendencies
    .filter(item => cycleSelfForecast.RETIRED_ACTION_TYPES.includes(String(item.action_type || '')))
    .reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const estimates = JSON.parse(JSON.stringify(revision.estimates));
  estimates.action_tendencies = activeTendencies.map(item => JSON.parse(JSON.stringify(item)));
  const prior = {
    protocol_version: 1,
    id: `behavioral-self-prior-${revision.id}`.slice(0, 300),
    source_revision_id: revision.id,
    source_revision_commitment: revision.revision_commitment,
    through_moment_id: revision.through_moment_id,
    source_moment_ids: JSON.parse(JSON.stringify(revision.source_moment_ids || [])),
    excluded_immediate_predecessor_id: excludedId,
    sample_size: Number(revision.estimates.sample_size),
    estimates,
    evidence_status: 'lagged_observational_prior',
    excluded_retired_action_observations: excludedRetiredObservations,
    epistemic_limit: 'A replay-audited operational prior derived only from outcomes before the immediate predecessor. Retired action families are excluded. It is a fallible historical prior, not an instruction, identity essence, authority, a guarantee, hidden-state access, or evidence of phenomenal consciousness.',
    content_commitment: null,
  };
  prior.content_commitment = commitment(forecastPriorManifest(prior));
  return prior;
}

module.exports = {
  MAX_SOURCE_MOMENTS, TRUST_MINIMUM_COMPARISONS, TRUST_ADVANTAGE_MARGIN,
  buildRevision, buildForecastPrior, canonicalJson, commitment,
  forecastPriorManifest, profileEstimates, revisionManifest, trustDisposition, trustPolicy,
  verifyTrustPolicy,
};
