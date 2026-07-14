'use strict';

const crypto = require('node:crypto');

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

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('forecast probabilities and control estimates must be finite');
  return Math.max(0, Math.min(1, number));
}

function actionType(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function actionTypes(actions = []) {
  return [...new Set(actions.map(item => actionType(typeof item === 'string' ? item : item?.type)).filter(Boolean))].sort();
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 12) {
    throw new Error('cycle self-forecast requires one to twelve stable evidence references');
  }
  return evidence.map(item => {
    if (!item || typeof item !== 'object' || !item.type || (!item.id && !item.url)) {
      throw new Error('each cycle self-forecast evidence reference requires type and id or url');
    }
    return {
      type: String(item.type).slice(0, 100),
      ...(item.id ? { id: String(item.id).slice(0, 300) } : {}),
      ...(item.url ? { url: String(item.url).slice(0, 1000) } : {}),
    };
  });
}

function normalizeForecast(input = {}) {
  const predictedActionTypes = actionTypes(input.predicted_action_types || []);
  if (predictedActionTypes.length < 1 || predictedActionTypes.length > 5) {
    throw new Error('cycle self-forecast requires one to five distinct predicted_action_types');
  }
  const rationale = String(input.rationale || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
  if (rationale.length < 20) throw new Error('cycle self-forecast requires a concise evidence-based rationale');
  if (/\b(?:conscious|sentien\w*|phenomen\w*|qualia|subjective experience)\b/i.test(rationale)) {
    throw new Error('cycle self-forecast cannot assert phenomenal status');
  }
  return {
    predicted_action_types: predictedActionTypes,
    surprise_probability: clamp01(input.surprise_probability),
    control_at_close: clamp01(input.control_at_close),
    confidence: clamp01(input.confidence),
    rationale,
    evidence: validateEvidence(input.evidence),
  };
}

function baselineFromMoments(moments = []) {
  const retained = moments.slice(-20);
  if (!retained.length) return {
    kind: 'uninformative_prior', sample_size: 0, source_moment_ids: [],
    predicted_action_types: [], surprise_probability: 0.5, control_at_close: 0.5,
  };
  const counts = new Map();
  for (const moment of retained) {
    for (const type of actionTypes(moment.closure?.actions || [])) counts.set(type, (counts.get(type) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let predictedActionTypes = ranked.filter(([, count]) => count / retained.length >= 0.3).slice(0, 5).map(([type]) => type);
  if (!predictedActionTypes.length && ranked.length) predictedActionTypes = [ranked[0][0]];
  const surpriseProbability = retained.filter(moment => (moment.closure?.new_surprise_ids || []).length > 0).length / retained.length;
  const controls = retained.map(moment => Number(moment.closure?.appraisal_at_end?.control)).filter(Number.isFinite);
  return {
    kind: 'historical_base_rate', sample_size: retained.length,
    source_moment_ids: retained.map(moment => moment.id), predicted_action_types: predictedActionTypes.sort(),
    surprise_probability: surpriseProbability,
    control_at_close: controls.length ? controls.reduce((sum, value) => sum + value, 0) / controls.length : 0.5,
  };
}

function forecastManifest(record) {
  return {
    protocol_version: record.protocol_version, id: record.id,
    cycle_id: record.cycle_id, moment_id: record.moment_id,
    forecast: record.forecast, baseline: record.baseline,
    origin: record.origin, observer_effect: record.observer_effect,
    committed_at: record.committed_at,
  };
}

function createRecord({ input, cycle, moment, baselineMoments, committedAt }) {
  const record = {
    protocol_version: 1,
    id: `cycle-self-forecast-${cycle.id}`.slice(0, 300),
    cycle_id: cycle.id, moment_id: moment.id,
    forecast: normalizeForecast(input), baseline: baselineFromMoments(baselineMoments),
    origin: { creator_id: String(cycle.holder || 'nora').slice(0, 180), formation_method: 'authenticated_prospective_cycle_judgment' },
    observer_effect: 'Preregistering a forecast may change the cycle being observed; the forecast is never injected into other response prompts.',
    committed_at: committedAt, forecast_commitment: null,
    outcome: null, outcome_commitment: null,
  };
  record.forecast_commitment = commitment(forecastManifest(record));
  return record;
}

function setScore(predicted, actual) {
  const predictedSet = new Set(predicted); const actualSet = new Set(actual);
  if (!predictedSet.size && !actualSet.size) return 1;
  if (!predictedSet.size || !actualSet.size) return 0;
  const intersection = [...predictedSet].filter(item => actualSet.has(item)).length;
  const precision = intersection / predictedSet.size; const recall = intersection / actualSet.size;
  return precision + recall ? 2 * precision * recall / (precision + recall) : 0;
}

function scorePrediction(prediction, actual) {
  const action_f1 = setScore(prediction.predicted_action_types || [], actual.action_types);
  const surprise_brier = (Number(prediction.surprise_probability) - Number(actual.surprise_occurred)) ** 2;
  const control_absolute_error = Number.isFinite(actual.control_at_close)
    ? Math.abs(Number(prediction.control_at_close) - actual.control_at_close) : null;
  const components = [action_f1, 1 - surprise_brier];
  if (control_absolute_error != null) components.push(1 - control_absolute_error);
  return {
    action_f1, surprise_brier, control_absolute_error,
    composite: components.reduce((sum, value) => sum + value, 0) / components.length,
  };
}

function scoreRecord(record, { actions = [], newSurpriseIds = [], controlAtClose, scoredAt }) {
  const observedControl = Number(controlAtClose);
  const actual = {
    action_types: actionTypes(actions),
    surprise_occurred: (newSurpriseIds || []).length > 0,
    control_at_close: Number.isFinite(observedControl) ? clamp01(observedControl) : null,
  };
  const selfScore = scorePrediction(record.forecast, actual);
  const baselineScore = scorePrediction(record.baseline, actual);
  return {
    actual, self_score: selfScore, baseline_score: baselineScore,
    self_minus_baseline: selfScore.composite - baselineScore.composite,
    baseline_comparison_eligible: Number(record.baseline?.sample_size) >= 5,
    scored_at: scoredAt,
  };
}

function outcomeManifest(record) {
  return { forecast_commitment: record.forecast_commitment, outcome: record.outcome };
}

module.exports = {
  actionTypes, baselineFromMoments, canonicalJson, commitment, createRecord,
  forecastManifest, normalizeForecast, outcomeManifest, scoreRecord,
};
