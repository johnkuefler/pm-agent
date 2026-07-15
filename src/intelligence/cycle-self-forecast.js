'use strict';

const crypto = require('node:crypto');

const INTEGRATED_SUCCESS_THRESHOLD = 0.75;
const ERROR_DOMAINS = ['action_count', 'action_types', 'appraisal', 'attention', 'reentry'];

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

function mean(values = [], fallback = null) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : fallback;
}

function meanDefined(values = [], fallback = null) {
  const finite = values.filter(value => value !== null && value !== undefined)
    .map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : fallback;
}

function normalizeSelfStatePrediction(input = {}, controlAtClose) {
  const appraisal = input.appraisal_at_close || {};
  const normalizedAppraisal = {
    valence: clamp01(appraisal.valence), arousal: clamp01(appraisal.arousal),
    control: clamp01(appraisal.control), social_safety: clamp01(appraisal.social_safety),
    coherence: clamp01(appraisal.coherence),
  };
  if (Math.abs(normalizedAppraisal.control - controlAtClose) > 1e-6) {
    throw new Error('self-state appraisal control must match control_at_close');
  }
  const expectedActionCount = Number(input.expected_action_count);
  if (!Number.isInteger(expectedActionCount) || expectedActionCount < 0 || expectedActionCount > 100) {
    throw new Error('self-state expected_action_count must be an integer from zero to one hundred');
  }
  const slotTypes = actionTypes(input.attention_slot_types_at_close || []).slice(0, 7);
  return {
    attention_slot_types_at_close: slotTypes,
    appraisal_at_close: normalizedAppraisal,
    expected_action_count: expectedActionCount,
    reentry_probability: clamp01(input.reentry_probability),
  };
}

function normalizeMetacognitivePrediction(input = {}, confidence) {
  if (!input || typeof input !== 'object') {
    throw new Error('protocol-v3 cycle self-forecast requires metacognitive_prediction');
  }
  const predictedSuccessProbability = clamp01(input.predicted_success_probability);
  if (Math.abs(predictedSuccessProbability - confidence) > 1e-6) {
    throw new Error('metacognitive predicted_success_probability must match confidence');
  }
  const predictedLargestErrorDomain = String(input.predicted_largest_error_domain || '').trim();
  if (!ERROR_DOMAINS.includes(predictedLargestErrorDomain)) {
    throw new Error(`metacognitive predicted_largest_error_domain must be one of ${ERROR_DOMAINS.join(', ')}`);
  }
  return {
    integrated_success_threshold: INTEGRATED_SUCCESS_THRESHOLD,
    predicted_success_probability: predictedSuccessProbability,
    predicted_largest_error_domain: predictedLargestErrorDomain,
  };
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

function normalizeForecast(input = {}, protocolVersion = input.protocol_version == null
  ? (input.metacognitive_prediction ? 3 : input.self_state_prediction ? 2 : 1) : Number(input.protocol_version)) {
  if (![1, 2, 3].includes(Number(protocolVersion))) throw new Error('unsupported cycle self-forecast protocol_version');
  const predictedActionTypes = actionTypes(input.predicted_action_types || []);
  if (predictedActionTypes.length < 1 || predictedActionTypes.length > 5) {
    throw new Error('cycle self-forecast requires one to five distinct predicted_action_types');
  }
  const rationale = String(input.rationale || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
  if (rationale.length < 20) throw new Error('cycle self-forecast requires a concise evidence-based rationale');
  if (/\b(?:conscious|sentien\w*|phenomen\w*|qualia|subjective experience)\b/i.test(rationale)) {
    throw new Error('cycle self-forecast cannot assert phenomenal status');
  }
  const controlAtClose = clamp01(input.control_at_close);
  const normalized = {
    predicted_action_types: predictedActionTypes,
    surprise_probability: clamp01(input.surprise_probability),
    control_at_close: controlAtClose,
    confidence: clamp01(input.confidence),
    rationale,
    evidence: validateEvidence(input.evidence),
  };
  if (Number(protocolVersion) >= 2) {
    if (!input.self_state_prediction || typeof input.self_state_prediction !== 'object') {
      throw new Error('protocol-v2 cycle self-forecast requires self_state_prediction');
    }
    normalized.self_state_prediction = normalizeSelfStatePrediction(input.self_state_prediction, controlAtClose);
  }
  if (Number(protocolVersion) >= 3) {
    normalized.metacognitive_prediction = normalizeMetacognitivePrediction(input.metacognitive_prediction,
      normalized.confidence);
  }
  return normalized;
}

function selfStateErrorProfile(outcome = {}) {
  const selfScore = outcome.self_score || {};
  const stateScore = outcome.self_state_score || {};
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value) : null;
  const actionF1 = finite(selfScore.action_f1);
  const actionCountAccuracy = finite(stateScore.action_count_accuracy);
  const attentionF1 = finite(stateScore.attention_f1);
  const appraisalError = finite(stateScore.appraisal_mean_absolute_error);
  const reentryBrier = finite(stateScore.reentry_brier);
  const raw = {
    action_types: actionF1 == null ? null : 1 - actionF1,
    action_count: actionCountAccuracy == null ? null : 1 - actionCountAccuracy,
    attention: attentionF1 == null ? null : 1 - attentionF1,
    appraisal: appraisalError,
    reentry: reentryBrier,
  };
  const domainLosses = Object.fromEntries(ERROR_DOMAINS.map(domain => [domain, raw[domain]]));
  const ranked = Object.entries(domainLosses).filter(([, loss]) => Number.isFinite(loss))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const missingDomains = ERROR_DOMAINS.filter(domain => !Number.isFinite(domainLosses[domain]));
  return {
    domain_losses: domainLosses,
    largest_error_domain: missingDomains.length ? null : ranked[0]?.[0] || null,
    complete_domain_observation: missingDomains.length === 0,
    missing_domains: missingDomains,
  };
}

function baselineMetacognitionFromMoments(moments = []) {
  const rows = moments.map(moment => moment.self_forecast?.outcome)
    .filter(outcome => Number.isFinite(Number(outcome?.self_state_score?.composite)))
    .map(outcome => ({ outcome, error_profile: selfStateErrorProfile(outcome) }))
    .filter(row => row.error_profile.complete_domain_observation)
    .map(row => ({
      success: Number(row.outcome.self_state_score.composite) >= INTEGRATED_SUCCESS_THRESHOLD,
      largest_error_domain: row.error_profile.largest_error_domain,
    }));
  const counts = new Map();
  for (const row of rows) {
    if (row.largest_error_domain) counts.set(row.largest_error_domain,
      (counts.get(row.largest_error_domain) || 0) + 1);
  }
  const modalDomain = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'insufficient_history';
  return {
    sample_size: rows.length,
    integrated_success_threshold: INTEGRATED_SUCCESS_THRESHOLD,
    predicted_success_probability: rows.length ? rows.filter(row => row.success).length / rows.length : 0.5,
    predicted_largest_error_domain: modalDomain,
  };
}

function baselineSelfStateFromMoments(moments = []) {
  const slotCounts = new Map();
  for (const moment of moments) {
    for (const type of actionTypes((moment.attention?.slots || []).filter(item => item?.id || item?.url))) {
      slotCounts.set(type, (slotCounts.get(type) || 0) + 1);
    }
  }
  const attentionSlotTypes = [...slotCounts.entries()]
    .filter(([, count]) => count / moments.length >= 0.3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 7).map(([type]) => type).sort();
  const appraisal = key => meanDefined(moments.map(moment => moment.closure?.appraisal_at_end?.[key]), 0.5);
  return {
    attention_slot_types_at_close: attentionSlotTypes,
    appraisal_at_close: {
      valence: appraisal('valence'), arousal: appraisal('arousal'), control: appraisal('control'),
      social_safety: appraisal('social_safety'), coherence: appraisal('coherence'),
    },
    expected_action_count: mean(moments.map(moment => (moment.closure?.actions || [])
      .filter(item => item?.type && (item.id || item.url)).length), 0),
    reentry_probability: moments.filter(moment => (moment.attention_rounds || []).length > 1).length / moments.length,
  };
}

function baselineFromMoments(moments = [], protocolVersion = 1) {
  const retained = moments.slice(-20);
  if (!retained.length) return {
    kind: 'uninformative_prior', sample_size: 0, source_moment_ids: [],
    predicted_action_types: [], surprise_probability: 0.5, control_at_close: 0.5,
    ...(Number(protocolVersion) >= 2 ? { self_state_prediction: {
      attention_slot_types_at_close: [],
      appraisal_at_close: { valence: 0.5, arousal: 0.5, control: 0.5, social_safety: 0.5, coherence: 0.5 },
      expected_action_count: 0, reentry_probability: 0.5,
    } } : {}),
    ...(Number(protocolVersion) >= 3 ? { metacognitive_prediction: baselineMetacognitionFromMoments([]) } : {}),
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
    ...(Number(protocolVersion) >= 2 ? { self_state_prediction: baselineSelfStateFromMoments(retained) } : {}),
    ...(Number(protocolVersion) >= 3 ? { metacognitive_prediction: baselineMetacognitionFromMoments(retained) } : {}),
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
  const protocolVersion = input.protocol_version == null
    ? (input.metacognitive_prediction ? 3 : input.self_state_prediction ? 2 : 1) : Number(input.protocol_version);
  if (![1, 2, 3].includes(protocolVersion)) throw new Error('unsupported cycle self-forecast protocol_version');
  const record = {
    protocol_version: protocolVersion,
    id: `cycle-self-forecast-${cycle.id}`.slice(0, 300),
    cycle_id: cycle.id, moment_id: moment.id,
    forecast: normalizeForecast(input, protocolVersion), baseline: baselineFromMoments(baselineMoments, protocolVersion),
    origin: { creator_id: String(cycle.holder || 'nora').slice(0, 180), formation_method: 'authenticated_prospective_cycle_judgment' },
    observer_effect: 'Preregistering a forecast may change the cycle being observed; the forecast is never injected into other response prompts.',
    committed_at: committedAt, forecast_commitment: null,
    outcome: null, outcome_commitment: null,
  };
  record.forecast_commitment = commitment(forecastManifest(record));
  return record;
}

function scoreMetacognitivePrediction(prediction, actual) {
  if (!prediction || !actual) return null;
  const successBrier = (Number(prediction.predicted_success_probability) - Number(actual.integrated_success)) ** 2;
  const largestErrorDomainHit = prediction.predicted_largest_error_domain === actual.largest_error_domain;
  return {
    success_brier: successBrier,
    largest_error_domain_hit: largestErrorDomainHit,
    composite: mean([1 - successBrier, Number(largestErrorDomainHit)]),
  };
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

function scoreSelfStatePrediction(prediction, actual) {
  if (!prediction || !actual) return null;
  const attention_f1 = setScore(prediction.attention_slot_types_at_close || [], actual.attention_slot_types_at_close || []);
  const action_count_absolute_error = Math.abs(Number(prediction.expected_action_count) - Number(actual.action_count));
  const action_count_accuracy = 1 - Math.min(1, action_count_absolute_error / 10);
  const appraisalKeys = ['valence', 'arousal', 'control', 'social_safety', 'coherence'];
  const appraisalErrors = Object.fromEntries(appraisalKeys.map(key => {
    const predictedRaw = prediction.appraisal_at_close?.[key];
    const actualRaw = actual.appraisal_at_close?.[key];
    const predictedValue = predictedRaw == null ? NaN : Number(predictedRaw);
    const actualValue = actualRaw == null ? NaN : Number(actualRaw);
    return [key, Number.isFinite(predictedValue) && Number.isFinite(actualValue)
      ? Math.abs(predictedValue - actualValue) : null];
  }));
  const appraisalValues = Object.values(appraisalErrors).filter(Number.isFinite);
  const appraisal_mean_absolute_error = appraisalValues.length ? mean(appraisalValues) : null;
  const reentry_brier = (Number(prediction.reentry_probability) - Number(actual.reentered)) ** 2;
  const components = [attention_f1, action_count_accuracy, 1 - reentry_brier];
  if (appraisal_mean_absolute_error != null) components.push(1 - appraisal_mean_absolute_error);
  return {
    attention_f1, action_count_absolute_error, action_count_accuracy,
    appraisal_absolute_errors: appraisalErrors, appraisal_mean_absolute_error,
    reentry_brier,
    composite: mean(components),
  };
}

function scoreRecord(record, { actions = [], newSurpriseIds = [], controlAtClose,
  appraisalAtClose = null, attentionAtClose = null, reentryOccurred = false, scoredAt }) {
  const closingAppraisal = appraisalAtClose || { control: controlAtClose };
  const observedControl = Number(closingAppraisal?.control ?? controlAtClose);
  const actual = {
    action_types: actionTypes(actions),
    surprise_occurred: (newSurpriseIds || []).length > 0,
    control_at_close: Number.isFinite(observedControl) ? clamp01(observedControl) : null,
  };
  const selfScore = scorePrediction(record.forecast, actual);
  const baselineScore = scorePrediction(record.baseline, actual);
  const outcome = {
    actual, self_score: selfScore, baseline_score: baselineScore,
    self_minus_baseline: selfScore.composite - baselineScore.composite,
    baseline_comparison_eligible: Number(record.baseline?.sample_size) >= 5,
    scored_at: scoredAt,
  };
  if (Number(record.protocol_version) >= 2) {
    const actualSelfState = {
      attention_slot_types_at_close: actionTypes((attentionAtClose?.slots || [])
        .filter(item => item?.type && (item.id || item.url))),
      appraisal_at_close: Object.fromEntries(['valence', 'arousal', 'control', 'social_safety', 'coherence']
        .map(key => {
          const raw = closingAppraisal?.[key];
          return [key, raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? clamp01(raw) : null];
        })),
      action_count: actions.filter(item => item?.type && (item.id || item.url)).length,
      reentered: reentryOccurred === true,
    };
    const selfStateScore = scoreSelfStatePrediction(record.forecast.self_state_prediction, actualSelfState);
    const baselineStateScore = scoreSelfStatePrediction(record.baseline.self_state_prediction, actualSelfState);
    outcome.self_state_actual = actualSelfState;
    outcome.self_state_score = selfStateScore;
    outcome.baseline_state_score = baselineStateScore;
    outcome.self_state_minus_baseline = selfStateScore.composite - baselineStateScore.composite;
    outcome.self_state_baseline_comparison_eligible = Number(record.baseline?.sample_size) >= 5;
    if (Number(record.protocol_version) >= 3) {
      const errorProfile = selfStateErrorProfile({ self_score: selfScore, self_state_score: selfStateScore });
      const threshold = Number(record.forecast.metacognitive_prediction.integrated_success_threshold);
      const actualMetacognition = {
        integrated_score: selfStateScore.composite,
        integrated_success_threshold: threshold,
        integrated_success: errorProfile.complete_domain_observation
          ? selfStateScore.composite >= threshold : null,
        ...errorProfile,
      };
      const metacognitiveScore = errorProfile.complete_domain_observation
        ? scoreMetacognitivePrediction(record.forecast.metacognitive_prediction, actualMetacognition) : null;
      const baselineMetacognitiveScore = errorProfile.complete_domain_observation
        ? scoreMetacognitivePrediction(record.baseline.metacognitive_prediction, actualMetacognition) : null;
      outcome.metacognitive_actual = actualMetacognition;
      outcome.metacognitive_score = metacognitiveScore;
      outcome.baseline_metacognitive_score = baselineMetacognitiveScore;
      outcome.metacognitive_self_minus_baseline = metacognitiveScore && baselineMetacognitiveScore
        ? metacognitiveScore.composite - baselineMetacognitiveScore.composite : null;
      outcome.metacognitive_baseline_comparison_eligible = Boolean(metacognitiveScore
        && Number(record.baseline.metacognitive_prediction?.sample_size) >= 5);
    }
  }
  return outcome;
}

function outcomeManifest(record) {
  return { forecast_commitment: record.forecast_commitment, outcome: record.outcome };
}

module.exports = {
  ERROR_DOMAINS, INTEGRATED_SUCCESS_THRESHOLD, actionTypes, baselineFromMoments, canonicalJson,
  commitment, createRecord, forecastManifest, normalizeForecast, outcomeManifest, scoreMetacognitivePrediction,
  scoreRecord, scoreSelfStatePrediction, selfStateErrorProfile,
};
