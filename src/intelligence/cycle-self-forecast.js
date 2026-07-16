'use strict';

const crypto = require('node:crypto');

const INTEGRATED_SUCCESS_THRESHOLD = 0.75;
const ERROR_DOMAINS = ['action_count', 'action_types', 'appraisal', 'attention', 'reentry'];
const SUBSTRATE_ERROR_DOMAIN = 'substrate';
// These labels describe the removed development-dispatch role. Historical lifecycle records retain
// them for audit, but protocol-v5 operational forecasts, profiles, baselines, and outcomes must not
// carry the retired role forward as a live behavioral possibility.
const RETIRED_ACTION_TYPES = Object.freeze([
  'dev_dispatch', 'dev_round_followup', 'dev_round_intake',
]);
const RETIRED_ACTION_TYPE_SET = new Set(RETIRED_ACTION_TYPES);
const SUBSTRATE_PREDICTION_KEYS = [
  'error_probability', 'warning_probability', 'backup_probability',
  'embedding_backlog_probability', 'restart_probability',
];

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

function activeActionTypes(actions = [], protocolVersion = 1) {
  const normalized = actionTypes(actions);
  return Number(protocolVersion) >= 5
    ? normalized.filter(type => !RETIRED_ACTION_TYPE_SET.has(type)) : normalized;
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

function normalizeSubstrateObservation(soma = {}) {
  if (!soma || typeof soma !== 'object') return null;
  const vitals = soma.vitals && typeof soma.vitals === 'object' ? soma.vitals : {};
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value) : null;
  const observation = {
    source_updated_at: soma.updated_at ? String(soma.updated_at).slice(0, 80) : null,
    errors10: finite(vitals.errors10), warns10: finite(vitals.warns10),
    loop_lag_ms: finite(vitals.loopLag), uptime_minutes: finite(vitals.uptimeMin),
    on_backup: typeof vitals.onBackup === 'boolean' ? vitals.onBackup : null,
    memory_count: finite(vitals.memCount), embedding_backlog: finite(vitals.embedBacklog),
    process_epoch_id: vitals.processEpochId
      ? String(vitals.processEpochId).trim().slice(0, 120) : null,
  };
  return Object.values(observation).some(value => value !== null) ? observation : null;
}

function normalizeSubstratePrediction(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('protocol-v4 cycle self-forecast requires substrate_prediction');
  }
  return Object.fromEntries(SUBSTRATE_PREDICTION_KEYS.map(key => [key, clamp01(input[key])]));
}

function persistenceSubstratePrediction(observation = null) {
  const probability = value => value == null ? 0.5 : Number(Boolean(value));
  return {
    error_probability: observation?.errors10 == null ? 0.5 : probability(observation.errors10 > 0),
    warning_probability: observation?.warns10 == null ? 0.5 : probability(observation.warns10 > 0),
    backup_probability: probability(observation?.on_backup),
    embedding_backlog_probability: observation?.embedding_backlog == null
      ? 0.5 : probability(observation.embedding_backlog > 0),
    restart_probability: 0,
  };
}

function substrateActual({ start = null, close = null, startedAt = null, finishedAt = null } = {}) {
  if (!close) return null;
  const boolOrNull = value => value == null ? null : Boolean(value);
  const started = new Date(startedAt).getTime(); const finished = new Date(finishedAt).getTime();
  const elapsedMinutes = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? (finished - started) / 60000 : null;
  const processEpochComparable = Boolean(start?.process_epoch_id && close.process_epoch_id);
  const uptimeRestartObserved = start?.uptime_minutes == null || close.uptime_minutes == null
    || elapsedMinutes == null ? null
    : close.uptime_minutes + 2 < start.uptime_minutes + elapsedMinutes;
  const restartObserved = processEpochComparable
    ? start.process_epoch_id !== close.process_epoch_id : uptimeRestartObserved;
  return {
    error_present: close.errors10 == null ? null : boolOrNull(close.errors10 > 0),
    warning_present: close.warns10 == null ? null : boolOrNull(close.warns10 > 0),
    backup_active: boolOrNull(close.on_backup),
    embedding_backlog_present: close.embedding_backlog == null
      ? null : boolOrNull(close.embedding_backlog > 0),
    restart_observed: restartObserved,
    elapsed_minutes: elapsedMinutes,
    start_observation: start ? JSON.parse(JSON.stringify(start)) : null,
    close_observation: JSON.parse(JSON.stringify(close)),
  };
}

function scoreSubstratePrediction(prediction, actual) {
  if (!prediction || !actual) return null;
  const actualByPrediction = {
    error_probability: actual.error_present,
    warning_probability: actual.warning_present,
    backup_probability: actual.backup_active,
    embedding_backlog_probability: actual.embedding_backlog_present,
    restart_probability: actual.restart_observed,
  };
  const brier = Object.fromEntries(SUBSTRATE_PREDICTION_KEYS.map(key => {
    const observed = actualByPrediction[key];
    return [key, observed == null ? null : (Number(prediction[key]) - Number(observed)) ** 2];
  }));
  const values = Object.values(brier).filter(Number.isFinite);
  return {
    brier,
    mean_brier: values.length ? mean(values) : null,
    observed_components: values.length,
    composite: values.length ? mean(values.map(value => 1 - value)) : null,
  };
}

function normalizeSelfStatePrediction(input = {}, controlAtClose, protocolVersion = 2) {
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
  const rawSlotTypes = actionTypes(input.attention_slot_types_at_close || []);
  if (Number(protocolVersion) >= 5 && rawSlotTypes.some(type => RETIRED_ACTION_TYPE_SET.has(type))) {
    throw new Error('protocol-v5 self-state prediction cannot carry a retired development-dispatch action type');
  }
  const slotTypes = activeActionTypes(rawSlotTypes, protocolVersion).slice(0, 7);
  return {
    attention_slot_types_at_close: slotTypes,
    appraisal_at_close: normalizedAppraisal,
    expected_action_count: expectedActionCount,
    reentry_probability: clamp01(input.reentry_probability),
  };
}

function normalizeMetacognitivePrediction(input = {}, confidence, protocolVersion = 3) {
  if (!input || typeof input !== 'object') {
    throw new Error(`protocol-v${protocolVersion} cycle self-forecast requires metacognitive_prediction`);
  }
  const predictedSuccessProbability = clamp01(input.predicted_success_probability);
  if (Math.abs(predictedSuccessProbability - confidence) > 1e-6) {
    throw new Error('metacognitive predicted_success_probability must match confidence');
  }
  const predictedLargestErrorDomain = String(input.predicted_largest_error_domain || '').trim();
  const errorDomains = Number(protocolVersion) >= 4
    ? [...ERROR_DOMAINS, SUBSTRATE_ERROR_DOMAIN] : ERROR_DOMAINS;
  if (!errorDomains.includes(predictedLargestErrorDomain)) {
    throw new Error(`metacognitive predicted_largest_error_domain must be one of ${errorDomains.join(', ')}`);
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
  ? (input.substrate_prediction ? 4 : input.metacognitive_prediction ? 3 : input.self_state_prediction ? 2 : 1) : Number(input.protocol_version)) {
  if (![1, 2, 3, 4, 5].includes(Number(protocolVersion))) throw new Error('unsupported cycle self-forecast protocol_version');
  const predictedActionTypes = actionTypes(input.predicted_action_types || []);
  if (predictedActionTypes.length < 1 || predictedActionTypes.length > 5) {
    throw new Error('cycle self-forecast requires one to five distinct predicted_action_types');
  }
  if (Number(protocolVersion) >= 5 && predictedActionTypes.some(type => RETIRED_ACTION_TYPE_SET.has(type))) {
    throw new Error('protocol-v5 cycle self-forecast cannot predict a retired development-dispatch action type');
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
    normalized.self_state_prediction = normalizeSelfStatePrediction(input.self_state_prediction,
      controlAtClose, protocolVersion);
  }
  if (Number(protocolVersion) >= 3) {
    normalized.metacognitive_prediction = normalizeMetacognitivePrediction(input.metacognitive_prediction,
      normalized.confidence, protocolVersion);
  }
  if (Number(protocolVersion) >= 4) {
    normalized.substrate_prediction = normalizeSubstratePrediction(input.substrate_prediction);
  }
  if (Number(protocolVersion) >= 5) {
    const priorCommitment = String(input.behavioral_self_prior_commitment || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(priorCommitment)) {
      throw new Error('protocol-v5 cycle self-forecast requires a behavioral_self_prior_commitment');
    }
    if (!normalized.evidence.some(item => item.type === 'behavioral_self_prior'
      && item.id === priorCommitment)) {
      throw new Error('protocol-v5 cycle self-forecast must cite its behavioral_self_prior commitment');
    }
    normalized.behavioral_self_prior_commitment = priorCommitment;
  }
  return normalized;
}

function selfStateErrorProfile(outcome = {}, { includeSubstrate = Boolean(outcome.substrate_score) } = {}) {
  const selfScore = outcome.self_score || {};
  const stateScore = outcome.self_state_score || {};
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value) : null;
  const actionF1 = finite(selfScore.action_f1);
  const actionCountAccuracy = finite(stateScore.action_count_accuracy);
  const attentionF1 = finite(stateScore.attention_f1);
  const appraisalError = finite(stateScore.appraisal_mean_absolute_error);
  const reentryBrier = finite(stateScore.reentry_brier);
  const substrateLoss = finite(outcome.substrate_score?.composite) == null
    ? null : 1 - finite(outcome.substrate_score.composite);
  const raw = {
    action_types: actionF1 == null ? null : 1 - actionF1,
    action_count: actionCountAccuracy == null ? null : 1 - actionCountAccuracy,
    attention: attentionF1 == null ? null : 1 - attentionF1,
    appraisal: appraisalError,
    reentry: reentryBrier,
    ...(includeSubstrate ? { substrate: substrateLoss } : {}),
  };
  const domains = includeSubstrate ? [...ERROR_DOMAINS, SUBSTRATE_ERROR_DOMAIN] : ERROR_DOMAINS;
  const domainLosses = Object.fromEntries(domains.map(domain => [domain, raw[domain]]));
  const ranked = Object.entries(domainLosses).filter(([, loss]) => Number.isFinite(loss))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const missingDomains = domains.filter(domain => !Number.isFinite(domainLosses[domain]));
  return {
    domain_losses: domainLosses,
    largest_error_domain: missingDomains.length ? null : ranked[0]?.[0] || null,
    complete_domain_observation: missingDomains.length === 0,
    missing_domains: missingDomains,
  };
}

function calibrationSummaryFromMoments(moments = []) {
  const retained = moments.filter(moment => moment?.self_forecast?.outcome?.self_state_score
    && moment.self_forecast.outcome_commitment).slice(-20);
  if (retained.length < 5) return null;
  const stateComparisons = retained.filter(moment =>
    moment.self_forecast.outcome.self_state_baseline_comparison_eligible === true);
  const metacognitive = retained.filter(moment => Number(moment.self_forecast.protocol_version) >= 3
    && moment.self_forecast.outcome.metacognitive_score
    && moment.self_forecast.outcome.metacognitive_actual);
  const metacognitiveComparisons = metacognitive.filter(moment =>
    moment.self_forecast.outcome.metacognitive_baseline_comparison_eligible === true);
  const predictedSuccess = metacognitive.map(moment => Number(
    moment.self_forecast.forecast.metacognitive_prediction.predicted_success_probability));
  const observedSuccess = metacognitive.map(moment => Number(
    moment.self_forecast.outcome.metacognitive_actual.integrated_success === true));
  const errorDomainCounts = new Map();
  for (const moment of metacognitive) {
    const domain = moment.self_forecast.outcome.metacognitive_actual.largest_error_domain;
    if (domain) errorDomainCounts.set(domain, (errorDomainCounts.get(domain) || 0) + 1);
  }
  const meanPredictedSuccess = mean(predictedSuccess);
  const observedSuccessRate = mean(observedSuccess);
  return {
    protocol_version: 1,
    source_moment_ids: retained.map(moment => moment.id),
    source_outcome_commitments: retained.map(moment => moment.self_forecast.outcome_commitment),
    sample_size: retained.length,
    integrated_self_state: {
      comparison_eligible_samples: stateComparisons.length,
      mean_self_score: mean(stateComparisons.map(moment =>
        moment.self_forecast.outcome.self_state_score.composite)),
      mean_baseline_score: mean(stateComparisons.map(moment =>
        moment.self_forecast.outcome.baseline_state_score.composite)),
      mean_self_minus_baseline: mean(stateComparisons.map(moment =>
        moment.self_forecast.outcome.self_state_minus_baseline)),
    },
    metacognitive_reliability: {
      samples: metacognitive.length,
      observed_integrated_success_rate: observedSuccessRate,
      mean_predicted_success_probability: meanPredictedSuccess,
      success_probability_signed_bias: meanPredictedSuccess == null || observedSuccessRate == null
        ? null : meanPredictedSuccess - observedSuccessRate,
      largest_error_domain_hit_rate: mean(metacognitive.map(moment => Number(
        moment.self_forecast.outcome.metacognitive_score.largest_error_domain_hit === true))),
      modal_observed_error_domain: [...errorDomainCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null,
      comparison_eligible_samples: metacognitiveComparisons.length,
      mean_self_score: mean(metacognitiveComparisons.map(moment =>
        moment.self_forecast.outcome.metacognitive_score.composite)),
      mean_baseline_score: mean(metacognitiveComparisons.map(moment =>
        moment.self_forecast.outcome.baseline_metacognitive_score.composite)),
      mean_self_minus_baseline: mean(metacognitiveComparisons.map(moment =>
        moment.self_forecast.outcome.metacognitive_self_minus_baseline)),
    },
    epistemic_limit: 'A replay-derived bounded calibration history, not an instruction, identity fact, guarantee, hidden-state report, or consciousness evidence. Current cycle evidence may override it.',
  };
}

function errorFeedbackFromMoment(moment, historicalMoments = []) {
  const record = moment?.self_forecast;
  if (!record?.outcome?.self_state_score || !record.outcome_commitment) return null;
  const predictedActions = actionTypes(record.forecast.predicted_action_types || []);
  const observedActions = actionTypes(record.outcome.actual?.action_types || []);
  const predictedAttention = actionTypes(record.forecast.self_state_prediction?.attention_slot_types_at_close || []);
  const observedAttention = actionTypes(record.outcome.self_state_actual?.attention_slot_types_at_close || []);
  const predictedAppraisal = record.forecast.self_state_prediction?.appraisal_at_close || {};
  const observedAppraisal = record.outcome.self_state_actual?.appraisal_at_close || {};
  const appraisalKeys = ['valence', 'arousal', 'control', 'social_safety', 'coherence'];
  const error = {
    protocol_version: Number(record.protocol_version) >= 3 ? 2 : 1,
    source_forecast_protocol_version: Number(record.protocol_version),
    forecast_id: record.id,
    source_moment_id: moment.id,
    source_outcome_commitment: record.outcome_commitment,
    source_replay_verified: true,
    scored_at: record.outcome.scored_at,
    action_types: {
      predicted_not_observed: predictedActions.filter(type => !observedActions.includes(type)),
      observed_not_predicted: observedActions.filter(type => !predictedActions.includes(type)),
    },
    action_count: {
      predicted: Number(record.forecast.self_state_prediction.expected_action_count),
      observed: Number(record.outcome.self_state_actual.action_count),
      observed_minus_predicted: Number(record.outcome.self_state_actual.action_count)
        - Number(record.forecast.self_state_prediction.expected_action_count),
    },
    attention_slot_types: {
      predicted_not_observed: predictedAttention.filter(type => !observedAttention.includes(type)),
      observed_not_predicted: observedAttention.filter(type => !predictedAttention.includes(type)),
    },
    appraisal_prediction_minus_observed: Object.fromEntries(appraisalKeys.map(key => {
      const predicted = predictedAppraisal[key] == null ? NaN : Number(predictedAppraisal[key]);
      const observed = observedAppraisal[key] == null ? NaN : Number(observedAppraisal[key]);
      return [key, Number.isFinite(predicted) && Number.isFinite(observed) ? predicted - observed : null];
    })),
    reentry: {
      predicted_probability: Number(record.forecast.self_state_prediction.reentry_probability),
      observed: record.outcome.self_state_actual.reentered === true,
      probability_minus_observed: Number(record.forecast.self_state_prediction.reentry_probability)
        - Number(record.outcome.self_state_actual.reentered === true),
    },
    scores: {
      behavioral_self: record.outcome.self_score.composite,
      behavioral_baseline: record.outcome.baseline_score.composite,
      behavioral_self_minus_baseline: record.outcome.self_minus_baseline,
      integrated_self: record.outcome.self_state_score.composite,
      integrated_baseline: record.outcome.baseline_state_score.composite,
      integrated_self_minus_baseline: record.outcome.self_state_minus_baseline,
      baseline_comparison_eligible: record.outcome.self_state_baseline_comparison_eligible === true,
    },
    epistemic_limit: 'One replay-derived prediction error is an observation, not a stable tendency, instruction, identity fact, hidden-state report, or consciousness evidence.',
  };
  if (Number(record.protocol_version) >= 3 && record.outcome.metacognitive_actual
    && record.outcome.metacognitive_score) {
    error.metacognitive_reliability = {
      predicted_success_probability: Number(
        record.forecast.metacognitive_prediction.predicted_success_probability),
      integrated_success_threshold: Number(
        record.forecast.metacognitive_prediction.integrated_success_threshold),
      observed_integrated_score: Number(record.outcome.metacognitive_actual.integrated_score),
      observed_integrated_success: record.outcome.metacognitive_actual.integrated_success === true,
      probability_minus_observed: Number(
        record.forecast.metacognitive_prediction.predicted_success_probability)
        - Number(record.outcome.metacognitive_actual.integrated_success === true),
      predicted_largest_error_domain:
        record.forecast.metacognitive_prediction.predicted_largest_error_domain,
      observed_largest_error_domain: record.outcome.metacognitive_actual.largest_error_domain,
      largest_error_domain_hit: record.outcome.metacognitive_score.largest_error_domain_hit === true,
      domain_losses: JSON.parse(JSON.stringify(record.outcome.metacognitive_actual.domain_losses)),
      self_score: Number(record.outcome.metacognitive_score.composite),
      baseline_score: Number(record.outcome.baseline_metacognitive_score.composite),
      self_minus_baseline: Number(record.outcome.metacognitive_self_minus_baseline),
      baseline_comparison_eligible:
        record.outcome.metacognitive_baseline_comparison_eligible === true,
    };
  }
  if (Number(record.protocol_version) >= 4 && record.outcome.substrate_actual
    && record.outcome.substrate_score) {
    const finiteOrNull = value => value !== null && value !== undefined
      && Number.isFinite(Number(value)) ? Number(value) : null;
    error.substrate = {
      prediction: JSON.parse(JSON.stringify(record.forecast.substrate_prediction)),
      actual: JSON.parse(JSON.stringify(record.outcome.substrate_actual)),
      self_score: finiteOrNull(record.outcome.substrate_score.composite),
      persistence_baseline_score: finiteOrNull(record.outcome.baseline_substrate_score?.composite),
      self_minus_persistence: finiteOrNull(record.outcome.substrate_self_minus_baseline),
      baseline_comparison_eligible: record.outcome.substrate_baseline_comparison_eligible === true,
    };
  }
  const aggregateCalibration = calibrationSummaryFromMoments(historicalMoments);
  if (aggregateCalibration) {
    error.protocol_version = 3;
    error.aggregate_calibration = aggregateCalibration;
    error.epistemic_limit = 'The latest replay-derived error is one observation. Aggregate calibration is a bounded historical prior, not an instruction, identity fact, guarantee, hidden-state report, or consciousness evidence. Current cycle evidence may override both.';
  }
  return { ...error, feedback_commitment: commitment(error) };
}

function correctionOfferManifest(offer) {
  return {
    protocol_version: offer.protocol_version,
    id: offer.id,
    forecast_id: offer.forecast_id,
    initial_forecast_commitment: offer.initial_forecast_commitment,
    feedback: offer.feedback,
    feedback_commitment: offer.feedback_commitment,
    revealed_at: offer.revealed_at,
  };
}

function createCorrectionOffer({ record, feedback, revealedAt }) {
  const { feedback_commitment: feedbackCommitment, ...feedbackPayload } = feedback || {};
  if (!feedbackCommitment || commitment(feedbackPayload) !== feedbackCommitment) {
    throw new Error('self-correction feedback commitment is invalid');
  }
  const offer = {
    protocol_version: 1,
    id: `${record.id}-feedback`.slice(0, 300),
    forecast_id: record.id,
    initial_forecast_commitment: record.forecast_commitment,
    feedback: JSON.parse(JSON.stringify(feedback)),
    feedback_commitment: feedbackCommitment,
    revealed_at: revealedAt,
    offer_commitment: null,
    revision: null,
  };
  offer.offer_commitment = commitment(correctionOfferManifest(offer));
  return offer;
}

function predictionPayload(forecast = {}) {
  return {
    predicted_action_types: forecast.predicted_action_types || [],
    surprise_probability: forecast.surprise_probability,
    control_at_close: forecast.control_at_close,
    self_state_prediction: forecast.self_state_prediction || null,
    metacognitive_prediction: forecast.metacognitive_prediction || null,
    substrate_prediction: forecast.substrate_prediction || null,
  };
}

function changedPredictionDomains(initial = {}, revised = {}) {
  const changed = [];
  const differs = (left, right) => canonicalJson(left) !== canonicalJson(right);
  if (differs(initial.predicted_action_types, revised.predicted_action_types)) changed.push('action_types');
  if (differs(initial.surprise_probability, revised.surprise_probability)) changed.push('surprise');
  if (differs(initial.self_state_prediction?.expected_action_count,
    revised.self_state_prediction?.expected_action_count)) changed.push('action_count');
  if (differs(initial.self_state_prediction?.attention_slot_types_at_close,
    revised.self_state_prediction?.attention_slot_types_at_close)) changed.push('attention');
  if (differs(initial.self_state_prediction?.appraisal_at_close,
    revised.self_state_prediction?.appraisal_at_close)) changed.push('appraisal');
  if (differs(initial.self_state_prediction?.reentry_probability,
    revised.self_state_prediction?.reentry_probability)) changed.push('reentry');
  if (differs(initial.metacognitive_prediction, revised.metacognitive_prediction)) changed.push('reliability');
  if (differs(initial.substrate_prediction, revised.substrate_prediction)) changed.push('substrate');
  return changed;
}

function correctionRevisionManifest(revision) {
  return {
    protocol_version: revision.protocol_version,
    id: revision.id,
    forecast_id: revision.forecast_id,
    initial_forecast_commitment: revision.initial_forecast_commitment,
    offer_commitment: revision.offer_commitment,
    feedback_commitment: revision.feedback_commitment,
    disposition: revision.disposition,
    forecast: revision.forecast,
    changed_domains: revision.changed_domains,
    committed_at: revision.committed_at,
  };
}

function createCorrectionRevision({ record, input, committedAt }) {
  const offer = record?.self_correction;
  if (!offer?.offer_commitment) throw new Error('self-correction feedback was not offered');
  if (String(input.feedback_commitment || '') !== offer.feedback_commitment) {
    throw new Error('self-correction revision must bind the offered feedback_commitment');
  }
  const revised = normalizeForecast({ ...input, protocol_version: record.protocol_version }, record.protocol_version);
  const disposition = String(input.disposition || 'revise').trim().toLowerCase();
  if (!['revise', 'retain'].includes(disposition)) {
    throw new Error('self-correction disposition must be revise or retain');
  }
  if (!revised.evidence.some(item => item.type === 'forecast_error_feedback'
    && item.id === offer.feedback_commitment)) {
    throw new Error('self-correction revision must cite the offered forecast_error_feedback');
  }
  const changedDomains = changedPredictionDomains(record.forecast, revised);
  const predictionChanged = canonicalJson(predictionPayload(record.forecast))
    !== canonicalJson(predictionPayload(revised));
  if (disposition === 'revise' && (!changedDomains.length || !predictionChanged)) {
    throw new Error('self-correction revision must change at least one scored prediction');
  }
  if (disposition === 'retain' && (changedDomains.length || predictionChanged)) {
    throw new Error('self-correction retain decision must preserve every scored prediction');
  }
  if (Number(record.protocol_version) >= 5
    && revised.behavioral_self_prior_commitment !== record.forecast.behavioral_self_prior_commitment) {
    throw new Error('self-correction revision must preserve the committed behavioral self prior');
  }
  const revision = {
    protocol_version: 1,
    id: `${record.id}-revision`.slice(0, 300),
    forecast_id: record.id,
    initial_forecast_commitment: record.forecast_commitment,
    offer_commitment: offer.offer_commitment,
    feedback_commitment: offer.feedback_commitment,
    disposition,
    forecast: revised,
    changed_domains: changedDomains,
    committed_at: committedAt,
    revision_commitment: null,
  };
  revision.revision_commitment = commitment(correctionRevisionManifest(revision));
  return revision;
}

function baselineMetacognitionFromMoments(moments = [], protocolVersion = 3) {
  const rows = moments.map(moment => moment.self_forecast?.outcome)
    .filter(outcome => Number.isFinite(Number(outcome?.self_state_score?.composite)))
    .map(outcome => ({ outcome, error_profile: selfStateErrorProfile(outcome, {
      includeSubstrate: Number(protocolVersion) >= 4,
    }) }))
    .filter(row => row.error_profile.complete_domain_observation)
    .map(row => ({
      success: row.outcome.metacognitive_actual?.integrated_success == null
        ? Number(row.outcome.self_state_score.composite) >= INTEGRATED_SUCCESS_THRESHOLD
        : row.outcome.metacognitive_actual.integrated_success === true,
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

function baselineSelfStateFromMoments(moments = [], protocolVersion = 1) {
  const slotCounts = new Map();
  for (const moment of moments) {
    for (const type of activeActionTypes((moment.attention?.slots || []).filter(item => item?.id || item?.url),
      protocolVersion)) {
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
    expected_action_count: mean(moments.map(moment => activeActionTypes((moment.closure?.actions || [])
      .filter(item => item?.type && (item.id || item.url)), protocolVersion).length), 0),
    reentry_probability: moments.filter(moment => (moment.attention_rounds || []).length > 1).length / moments.length,
  };
}

function baselineFromMoments(moments = [], protocolVersion = 1, options = {}) {
  const retained = moments.slice(-20);
  if (!retained.length) return {
    kind: 'uninformative_prior', sample_size: 0, source_moment_ids: [],
    predicted_action_types: [], surprise_probability: 0.5, control_at_close: 0.5,
    ...(Number(protocolVersion) >= 2 ? { self_state_prediction: {
      attention_slot_types_at_close: [],
      appraisal_at_close: { valence: 0.5, arousal: 0.5, control: 0.5, social_safety: 0.5, coherence: 0.5 },
      expected_action_count: 0, reentry_probability: 0.5,
    } } : {}),
    ...(Number(protocolVersion) >= 3 ? { metacognitive_prediction: baselineMetacognitionFromMoments([], protocolVersion) } : {}),
    ...(Number(protocolVersion) >= 4 ? {
      substrate_prediction: persistenceSubstratePrediction(options.substrateAtStart || null),
      substrate_baseline_kind: 'start_state_persistence',
    } : {}),
  };
  const counts = new Map();
  for (const moment of retained) {
    for (const type of activeActionTypes(moment.closure?.actions || [], protocolVersion)) {
      counts.set(type, (counts.get(type) || 0) + 1);
    }
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
    ...(Number(protocolVersion) >= 2 ? {
      self_state_prediction: baselineSelfStateFromMoments(retained, protocolVersion),
    } : {}),
    ...(Number(protocolVersion) >= 3 ? { metacognitive_prediction: baselineMetacognitionFromMoments(retained, protocolVersion) } : {}),
    ...(Number(protocolVersion) >= 4 ? {
      substrate_prediction: persistenceSubstratePrediction(options.substrateAtStart || null),
      substrate_baseline_kind: 'start_state_persistence',
    } : {}),
  };
}

function forecastManifest(record) {
  return {
    protocol_version: record.protocol_version, id: record.id,
    cycle_id: record.cycle_id, moment_id: record.moment_id,
    forecast: record.forecast, baseline: record.baseline,
    ...(Number(record.protocol_version) >= 5 ? {
      behavioral_self_prior: record.behavioral_self_prior,
    } : {}),
    origin: record.origin, observer_effect: record.observer_effect,
    committed_at: record.committed_at,
  };
}

function createRecord({ input, cycle, moment, baselineMoments, behavioralSelfPrior = null, committedAt }) {
  const protocolVersion = input.protocol_version == null
    ? (input.substrate_prediction ? 4 : input.metacognitive_prediction ? 3 : input.self_state_prediction ? 2 : 1) : Number(input.protocol_version);
  if (![1, 2, 3, 4, 5].includes(protocolVersion)) throw new Error('unsupported cycle self-forecast protocol_version');
  const normalizedForecast = normalizeForecast(input, protocolVersion);
  if (protocolVersion >= 5 && (!behavioralSelfPrior?.content_commitment
    || normalizedForecast.behavioral_self_prior_commitment !== behavioralSelfPrior.content_commitment)) {
    throw new Error('protocol-v5 forecast must bind the current lagged behavioral self prior');
  }
  const record = {
    protocol_version: protocolVersion,
    id: `cycle-self-forecast-${cycle.id}`.slice(0, 300),
    cycle_id: cycle.id, moment_id: moment.id,
    forecast: normalizedForecast,
    baseline: baselineFromMoments(baselineMoments, protocolVersion, {
      substrateAtStart: moment.substrate_at_start || null,
    }),
    ...(protocolVersion >= 5 ? {
      behavioral_self_prior: JSON.parse(JSON.stringify(behavioralSelfPrior)),
    } : {}),
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
  appraisalAtClose = null, attentionAtClose = null, reentryOccurred = false,
  substrateAtStart = null, substrateAtClose = null, startedAt = null, finishedAt = null, scoredAt }) {
  const closingAppraisal = appraisalAtClose || { control: controlAtClose };
  const observedControl = Number(closingAppraisal?.control ?? controlAtClose);
  const activeActions = activeActionTypes(actions, record.protocol_version);
  const actual = {
    action_types: activeActions,
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
      attention_slot_types_at_close: activeActionTypes((attentionAtClose?.slots || [])
        .filter(item => item?.type && (item.id || item.url)), record.protocol_version),
      appraisal_at_close: Object.fromEntries(['valence', 'arousal', 'control', 'social_safety', 'coherence']
        .map(key => {
          const raw = closingAppraisal?.[key];
          return [key, raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? clamp01(raw) : null];
        })),
      action_count: activeActionTypes(actions.filter(item => item?.type && (item.id || item.url)),
        record.protocol_version).length,
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
  if (Number(record.protocol_version) >= 4) {
    const actualSubstrate = substrateActual({
      start: substrateAtStart, close: substrateAtClose, startedAt, finishedAt,
    });
    const substrateScore = scoreSubstratePrediction(record.forecast.substrate_prediction,
      actualSubstrate);
    const baselineSubstrateScore = scoreSubstratePrediction(record.baseline.substrate_prediction,
      actualSubstrate);
    outcome.substrate_actual = actualSubstrate;
    outcome.substrate_score = substrateScore;
    outcome.baseline_substrate_score = baselineSubstrateScore;
    outcome.substrate_self_minus_baseline = substrateScore?.composite != null
      && baselineSubstrateScore?.composite != null
      ? substrateScore.composite - baselineSubstrateScore.composite : null;
    outcome.substrate_baseline_comparison_eligible = Boolean(substrateScore
      && baselineSubstrateScore && substrateScore.observed_components === SUBSTRATE_PREDICTION_KEYS.length);
    if (outcome.metacognitive_actual) {
      const errorProfile = selfStateErrorProfile(outcome, { includeSubstrate: true });
      const threshold = Number(record.forecast.metacognitive_prediction.integrated_success_threshold);
      const integratedScore = substrateScore?.composite == null
        ? outcome.self_state_score.composite
        : mean([outcome.self_state_score.composite, substrateScore.composite]);
      const actualMetacognition = {
        integrated_score: integratedScore,
        integrated_success_threshold: threshold,
        integrated_success: errorProfile.complete_domain_observation
          ? integratedScore >= threshold : null,
        ...errorProfile,
      };
      const metacognitiveScore = errorProfile.complete_domain_observation
        ? scoreMetacognitivePrediction(record.forecast.metacognitive_prediction,
          actualMetacognition) : null;
      const baselineMetacognitiveScore = errorProfile.complete_domain_observation
        ? scoreMetacognitivePrediction(record.baseline.metacognitive_prediction,
          actualMetacognition) : null;
      outcome.metacognitive_actual = actualMetacognition;
      outcome.metacognitive_score = metacognitiveScore;
      outcome.baseline_metacognitive_score = baselineMetacognitiveScore;
      outcome.metacognitive_self_minus_baseline = metacognitiveScore && baselineMetacognitiveScore
        ? metacognitiveScore.composite - baselineMetacognitiveScore.composite : null;
      outcome.metacognitive_baseline_comparison_eligible = Boolean(metacognitiveScore
        && Number(record.baseline.metacognitive_prediction?.sample_size) >= 5);
    }
  }
  if (record.self_correction?.revision) {
    const revision = record.self_correction.revision;
    const revisedOutcome = scoreRecord({
      protocol_version: record.protocol_version,
      forecast: revision.forecast,
      baseline: record.baseline,
    }, {
      actions, newSurpriseIds, controlAtClose, appraisalAtClose, attentionAtClose,
      reentryOccurred, substrateAtStart, substrateAtClose, startedAt, finishedAt, scoredAt,
    });
    const comparison = (initial, revised) => Number.isFinite(Number(initial))
      && Number.isFinite(Number(revised)) ? {
        initial: Number(initial), revised: Number(revised), revised_minus_initial: Number(revised) - Number(initial),
      } : null;
    outcome.self_correction = {
      protocol_version: 1,
      offer_commitment: record.self_correction.offer_commitment,
      feedback_commitment: record.self_correction.feedback_commitment,
      revision_commitment: revision.revision_commitment,
      disposition: revision.disposition,
      changed_domains: JSON.parse(JSON.stringify(revision.changed_domains || [])),
      behavioral_score: comparison(outcome.self_score?.composite, revisedOutcome.self_score?.composite),
      integrated_self_state_score: comparison(outcome.self_state_score?.composite,
        revisedOutcome.self_state_score?.composite),
      metacognitive_reliability_score: comparison(outcome.metacognitive_score?.composite,
        revisedOutcome.metacognitive_score?.composite),
      substrate_score: comparison(outcome.substrate_score?.composite,
        revisedOutcome.substrate_score?.composite),
    };
  }
  return outcome;
}

function outcomeManifest(record) {
  return { forecast_commitment: record.forecast_commitment, outcome: record.outcome };
}

module.exports = {
  ERROR_DOMAINS, SUBSTRATE_ERROR_DOMAIN, SUBSTRATE_PREDICTION_KEYS, RETIRED_ACTION_TYPES,
  INTEGRATED_SUCCESS_THRESHOLD, actionTypes, baselineFromMoments, calibrationSummaryFromMoments,
  activeActionTypes,
  canonicalJson,
  changedPredictionDomains, commitment, correctionOfferManifest, correctionRevisionManifest,
  createCorrectionOffer, createCorrectionRevision, createRecord, errorFeedbackFromMoment,
  forecastManifest, normalizeForecast, outcomeManifest, scoreMetacognitivePrediction,
  normalizeSubstrateObservation, persistenceSubstratePrediction, scoreRecord,
  scoreSelfStatePrediction, scoreSubstratePrediction, selfStateErrorProfile, substrateActual,
};
