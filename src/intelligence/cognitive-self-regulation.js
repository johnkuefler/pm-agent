'use strict';

const cognitivePulse = require('./cognitive-pulse');

const MIN_CALIBRATION_SAMPLES = 10;
const MIN_SELF_SCORE = 0.6;
const MIN_BASELINE_ADVANTAGE = 0.05;

function clamp01(value) { return Math.max(0, Math.min(1, Number(value))); }

function referenceKey(reference) { return `${reference?.type || ''}:${reference?.id || ''}`; }

function adaptiveIntervalMinutes(forecast) {
  const value = clamp01(forecast?.expected_value_of_next_pulse);
  if (value >= 0.75) return 30;
  if (value >= 0.5) return 60;
  if (value >= 0.25) return 120;
  return 240;
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function jaccard(left, right) {
  const a = new Set((left || []).map(referenceKey)); const b = new Set((right || []).map(referenceKey));
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter(value => b.has(value)).length / union.size : 1;
}

function resolutionFor(record, nextPulse) {
  const forecast = record.forecast; const actual = nextPulse.output;
  const continuationObserved = actual.predecessor_update?.disposition === 'drop' ? 0 : 1;
  const focusScore = jaccard(forecast.next_focus_refs, actual.focus_refs);
  const uncertaintyScore = 1 - Math.abs(clamp01(forecast.expected_uncertainty) - clamp01(actual.uncertainty));
  const continuationScore = 1 - Math.pow(clamp01(forecast.expected_continuation_probability) - continuationObserved, 2);
  const baselineFocusScore = jaccard(record.persistence_baseline.focus_refs, actual.focus_refs);
  const baselineUncertaintyScore = 1 - Math.abs(clamp01(record.persistence_baseline.uncertainty) - clamp01(actual.uncertainty));
  const baselineContinuationScore = 1 - Math.pow(0.5 - continuationObserved, 2);
  const selfScore = mean([focusScore, uncertaintyScore, continuationScore]);
  const baselineScore = mean([baselineFocusScore, baselineUncertaintyScore, baselineContinuationScore]);
  return { next_pulse_id: nextPulse.id, next_output_commitment: nextPulse.output_commitment,
    observed_at: nextPulse.completed_at, elapsed_minutes:
      (new Date(nextPulse.completed_at) - new Date(record.created_at)) / 60000,
    actual: { focus_refs: actual.focus_refs, uncertainty: actual.uncertainty,
      predecessor_disposition: actual.predecessor_update?.disposition || null,
      continuation_observed: continuationObserved },
    metrics: { focus_jaccard: focusScore, uncertainty_score: uncertaintyScore,
      continuation_brier_score: continuationScore, self_forecast_score: selfScore,
      persistence_focus_jaccard: baselineFocusScore,
      persistence_uncertainty_score: baselineUncertaintyScore,
      persistence_continuation_brier_score: baselineContinuationScore,
      persistence_baseline_score: baselineScore, advantage: selfScore - baselineScore } };
}

function recordAudit(record, sourcePulse, nextPulse = null) {
  const sourceVerified = Boolean(sourcePulse && sourcePulse.status === 'accepted'
    && sourcePulse.output_commitment === record.source_output_commitment
    && cognitivePulse.commitment(sourcePulse.output?.metacognitive_forecast) === record.forecast_commitment
    && cognitivePulse.commitment(record.forecast) === record.forecast_commitment
    && cognitivePulse.canonicalJson(sourcePulse.output.metacognitive_forecast)
      === cognitivePulse.canonicalJson(record.forecast));
  const intervalVerified = adaptiveIntervalMinutes(record.forecast) === record.adaptive_interval_minutes
    && Number.isFinite(record.effective_interval_minutes) && record.effective_interval_minutes >= 5
    && record.effective_interval_minutes <= 1440;
  let resolutionVerified = record.status === 'open' && !record.resolution;
  if (record.status === 'resolved') resolutionVerified = Boolean(nextPulse && nextPulse.predecessor_id === sourcePulse?.id
    && cognitivePulse.canonicalJson(resolutionFor(record, nextPulse)) === cognitivePulse.canonicalJson(record.resolution));
  return { source_verified: sourceVerified, interval_verified: intervalVerified,
    resolution_verified: resolutionVerified,
    complete_chain_verified: sourceVerified && intervalVerified && resolutionVerified };
}

function calibrationPolicy(records, audit = () => ({ complete_chain_verified: true })) {
  const resolved = (records || []).filter(record => record.status === 'resolved'
    && record.resolution && audit(record).complete_chain_verified);
  const selfScore = mean(resolved.map(record => record.resolution.metrics.self_forecast_score));
  const baselineScore = mean(resolved.map(record => record.resolution.metrics.persistence_baseline_score));
  const advantage = selfScore == null || baselineScore == null ? null : selfScore - baselineScore;
  const calibrated = resolved.length >= MIN_CALIBRATION_SAMPLES
    && selfScore >= MIN_SELF_SCORE && advantage >= MIN_BASELINE_ADVANTAGE;
  return { mode: calibrated ? 'calibrated_adaptive' : 'fixed_default', resolved_samples: resolved.length,
    mean_self_forecast_score: selfScore, mean_persistence_baseline_score: baselineScore,
    mean_advantage: advantage, thresholds: { minimum_samples: MIN_CALIBRATION_SAMPLES,
      minimum_self_score: MIN_SELF_SCORE, minimum_baseline_advantage: MIN_BASELINE_ADVANTAGE } };
}

function cadenceForForecast(forecast, policy, defaultIntervalMinutes = 30, studyCadenceSealed = false) {
  const fallback = Math.max(5, Math.min(1440, Number(defaultIntervalMinutes) || 30));
  const mode = studyCadenceSealed ? 'study_fixed_default' : policy?.mode || 'fixed_default';
  return { application_mode: mode, adaptive_interval_minutes: adaptiveIntervalMinutes(forecast),
    default_interval_minutes: fallback,
    effective_interval_minutes: mode === 'calibrated_adaptive' ? adaptiveIntervalMinutes(forecast) : fallback };
}

module.exports = { MIN_CALIBRATION_SAMPLES, MIN_SELF_SCORE, MIN_BASELINE_ADVANTAGE,
  adaptiveIntervalMinutes, jaccard, resolutionFor, recordAudit, calibrationPolicy, cadenceForForecast };
