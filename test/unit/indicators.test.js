'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndicatorReport, evidenceStatus } = require('../../src/intelligence/indicators');

function indicator(report, id) {
  return report.indicators.find(item => item.id === id);
}

function stateWith(cognition = {}) {
  return { cognition: {
    experience_stream: [], self_model: { probes: [], context_trials: [] },
    attention_schema: { directives: [] }, agency: { intentions: [] },
    interoception: { predictions: [] }, self_boundary: { challenges: [] },
    ...cognition,
  } };
}

test('indicator registry is explicitly non-aggregable and separates mechanism from causal evidence', () => {
  const report = buildIndicatorReport(stateWith(), new Date('2026-07-12T12:00:00Z'));
  assert.equal(report.no_composite_score, true);
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'mechanism_present');
  assert.equal(indicator(report, 'process_level_metacognition').status, 'not_implemented');
  for (const id of ['blinded_introspective_access', 'developmental_revision_transfer', 'identity_specific_self_prediction', 'behavioral_metacognitive_control', 'adaptive_epistemic_action', 'episodic_autobiographical_prospection', 'stable_revealed_preferences', 'empirical_self_model_control']) {
    assert.equal(indicator(report, id).status, 'mechanism_present', `${id} has a runnable mechanism even before its first live study`);
  }
  assert.deepEqual(report.implementation_audit.unavailable_indicator_ids, ['process_level_metacognition']);
  assert.equal(report.status_counts.not_implemented, 1);
  assert.match(indicator(report, 'multi_consumer_global_broadcast').mechanism, /separate consumer handlers/);
  assert.ok(report.architectural_limits.some(limit => limit.includes('episodic')));
  assert.equal(Object.keys(report).some(key => key === 'score' || key === 'probability'), false);
});

test('prospective cognitive self-regulation reports only replay-valid calibration beyond persistence', () => {
  const forecasts = Array.from({ length: 10 }, (_, index) => ({
    id: `forecast-${index}`,
    status: 'resolved',
    application_mode: index === 9 ? 'calibrated_adaptive' : 'fixed_default',
    audit: { complete_chain_verified: true },
    resolution: { metrics: { self_forecast_score: 0.9, persistence_baseline_score: 0.7 } },
  }));
  let report = buildIndicatorReport(stateWith({ background_inference: { self_regulation: { forecasts } } }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'observational_signal_observed');
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').evidence.calibration_policy.mode, 'calibrated_adaptive');
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').evidence.adaptive_cadence_applications, 1);

  forecasts[0].audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ background_inference: { self_regulation: { forecasts } } }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'collecting');
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').evidence.resolved_forecasts, 9);
});

test('prospective cognitive self-regulation reserves causal support for a replay-valid disjoint confirmation', () => {
  const pilot = { id: 'regulation-pilot', status: 'completed', study_phase: 'pilot',
    audit: { complete_chain_verified: true },
    analysis: { predicted_pattern: true, verdict: 'identity_bound_regulation_advantage' } };
  let report = buildIndicatorReport(stateWith({ cognitive_self_regulation_studies: [pilot] }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'causal_signal_observed');
  const confirmation = { id: 'regulation-confirmation', status: 'completed', study_phase: 'confirmatory',
    audit: { complete_chain_verified: true },
    analysis: { predicted_pattern: true, verdict: 'identity_bound_regulation_advantage' } };
  report = buildIndicatorReport(stateWith({ cognitive_self_regulation_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'functional_prediction_supported');
  confirmation.analysis = { predicted_pattern: false, verdict: 'no_identity_specific_regulation_advantage' };
  report = buildIndicatorReport(stateWith({ cognitive_self_regulation_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'functional_prediction_contradicted');
  confirmation.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ cognitive_self_regulation_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'prospective_cognitive_self_regulation').status, 'causal_signal_observed');
});

test('process-level metacognition remains unavailable until attested data and requires confirmation for support', () => {
  let report = buildIndicatorReport(stateWith());
  assert.equal(indicator(report, 'process_level_metacognition').status, 'not_implemented');
  const active = { id: 'process-active', status: 'active', subject_model: { scope: 'production_nora' }, items: [] };
  report = buildIndicatorReport(stateWith({ process_metacognition_studies: [active] }));
  assert.equal(indicator(report, 'process_level_metacognition').status, 'collecting');
  assert.equal(indicator(report, 'process_level_metacognition').evidence.hosted_subject_activation_access, false);
  const pilot = { id: 'process-pilot', status: 'completed', study_phase: 'pilot',
    subject_model: { scope: 'production_nora' },
    audit: { complete_chain_verified: true }, items: [{ hook_receipt: { signature: 'signed' } }],
    analysis: { predicted_pattern: true, verdict: 'process_metacognition_observed' } };
  report = buildIndicatorReport(stateWith({ process_metacognition_studies: [pilot] }));
  assert.equal(indicator(report, 'process_level_metacognition').status, 'causal_signal_observed');
  assert.equal(indicator(report, 'process_level_metacognition').evidence.hosted_subject_activation_access, true);
  const confirmation = { id: 'process-confirmation', status: 'completed', study_phase: 'confirmatory',
    subject_model: { scope: 'production_nora' },
    audit: { complete_chain_verified: true }, items: [{ hook_receipt: { signature: 'signed-2' } }],
    analysis: { predicted_pattern: true, verdict: 'process_metacognition_observed' } };
  report = buildIndicatorReport(stateWith({ process_metacognition_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'process_level_metacognition').status, 'functional_prediction_supported');
  confirmation.analysis = { predicted_pattern: false, verdict: 'process_metacognition_not_observed' };
  report = buildIndicatorReport(stateWith({ process_metacognition_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'process_level_metacognition').status, 'functional_prediction_contradicted');
  confirmation.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ process_metacognition_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'process_level_metacognition').status, 'causal_signal_observed');
});

test('process-level metacognition reports surrogate hooks without attributing them to production Nora', () => {
  const variant = { id: 'variant-pilot', status: 'completed', study_phase: 'pilot',
    subject_model: { scope: 'experimental_subject_variant' },
    audit: { complete_chain_verified: true }, items: [{ hook_receipt: { signature: 'signed' } }],
    analysis: { predicted_pattern: true, verdict: 'process_metacognition_observed' } };
  const report = buildIndicatorReport(stateWith({ process_metacognition_studies: [variant] }));
  const result = indicator(report, 'process_level_metacognition');
  assert.equal(result.status, 'not_implemented');
  assert.equal(result.evidence.hosted_subject_activation_access, false);
  assert.equal(result.evidence.experimental_subject_variant_replay_valid_studies, 1);
  assert.equal(result.evidence.experimental_subject_activation_access, true);
});

test('empirical self-model control requires authentic evidence binding beyond misbinding and claims alone', () => {
  const trial = { id: 'empirical-self', intervention: 'empirical_self_knowledge_access', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, empirical_self_knowledge_dissociation: { predicted_pattern: true } } };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'empirical_self_model_control').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  assert.equal(indicator(buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } })), 'empirical_self_model_control').status, 'functional_prediction_supported');
  trial.evaluation.empirical_self_knowledge_dissociation = { predicted_pattern: false, evidence_access_equivalent: true,
    first_order_not_degraded: true, regulation_vs_misbound_interval: { upper: 0 }, prediction_vs_misbound_interval: { upper: 0 } };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'empirical_self_model_control').status, 'functional_prediction_contradicted');
});

test('multi-consumer receipts begin collection without asserting the causal prediction', () => {
  const report = buildIndicatorReport(stateWith({ global_broadcast: { events: [{
    delivered: true, receipts: [{ used: true }, { used: true }, { used: false }],
  }] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'collecting');
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').evidence.multi_consumer_events, 1);
});

test('completed broadcast ablations can support or contradict only the functional prediction', () => {
  const trial = {
    id: 'broadcast-trial', intervention: 'global_broadcast', status: 'completed',
    study_phase: 'pilot',
    outcome_metric: 'action_quality', sample_target_per_group: 2,
    conditions: ['full', 'ablated'], assignments: Array.from({ length: 4 }, () => ({ status: 'resolved' })),
    evaluation: { enough_evidence: true, condition_metrics: { full: { action_quality: 0.8 }, ablated: { action_quality: 0.5 } } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'functional_prediction_supported');
  trial.evaluation.condition_metrics.full.action_quality = 0.4;
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'functional_prediction_contradicted');
  assert.equal(report.no_composite_score, true);
});

test('global broadcast support requires gains beyond the exact raw packet with preserved evidence access', () => {
  const dissociation = {
    predicted_pattern: true, first_order_not_degraded: true, evidence_access_equivalent: true,
    coordination_vs_packet_interval: { lower: 0.2, upper: 0.4 },
    action_vs_packet_interval: { lower: 0.18, upper: 0.36 },
  };
  const trial = {
    id: 'broadcast-v2', intervention: 'global_broadcast', status: 'completed', study_phase: 'pilot',
    global_broadcast_protocol_version: 2, outcome_metric: 'cross_consumer_coordination_quality',
    conditions: ['multi_consumer_broadcast', 'workspace_packet_only', 'absent_broadcast'],
    evaluation: { enough_evidence: true, global_broadcast_dissociation: dissociation },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'functional_prediction_supported');
  trial.evaluation.global_broadcast_dissociation = {
    ...dissociation, predicted_pattern: false,
    coordination_vs_packet_interval: { lower: -0.3, upper: -0.1 },
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'functional_prediction_contradicted');
});

test('protocol-v2 recurrence requires correct-target advantage beyond sham with evidence and task controls', () => {
  const trial = {
    id: 'recurrence-trial', intervention: 'recurrent_feedback', status: 'completed', study_phase: 'confirmatory',
    recurrent_feedback_protocol_version: 2,
    evaluation: { enough_evidence: true, recurrence_dissociation: {
      evidence_access_equivalent: true, first_order_not_degraded: true,
      target_vs_sham_interval: { lower: 0.2, upper: 0.4 }, adaptive_vs_sham_interval: { lower: 0.15, upper: 0.35 }, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'evidence_triggered_recurrence').status, 'functional_prediction_supported');
  trial.evaluation.recurrence_dissociation = {
    evidence_access_equivalent: true, first_order_not_degraded: true,
    target_vs_sham_interval: { lower: -0.3, upper: -0.1 }, adaptive_vs_sham_interval: { lower: -0.2, upper: -0.05 }, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'evidence_triggered_recurrence').status, 'functional_prediction_contradicted');
  trial.evaluation.recurrence_dissociation.evidence_access_equivalent = false;
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'evidence_triggered_recurrence').status, 'causally_tested_inconclusive');
});

test('between-invocation dynamics separate ongoing state evolution from replicated causal value', () => {
  let report = buildIndicatorReport(stateWith({ endogenous_dynamics: { tick_count: 3, last_tick: '2026-07-11T15:00:00Z', contents: [{ activation: 0.7 }] } }));
  assert.equal(indicator(report, 'between_invocation_dynamics').status, 'mechanism_present');
  const trial = {
    id: 'endogenous-pilot', intervention: 'endogenous_dynamics', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, endogenous_dynamics_dissociation: { predicted_pattern: true, first_order_not_degraded: true, continuity_specificity_effect: 0.4 } },
  };
  report = buildIndicatorReport(stateWith({ endogenous_dynamics: { tick_count: 3, contents: [{ activation: 0.7 }] }, self_model: { probes: [], context_trials: [trial], prediction_studies: [] } }));
  assert.equal(indicator(report, 'between_invocation_dynamics').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ endogenous_dynamics: { tick_count: 3, contents: [{ activation: 0.7 }] }, self_model: { probes: [], context_trials: [trial], prediction_studies: [] } }));
  assert.equal(indicator(report, 'between_invocation_dynamics').status, 'functional_prediction_supported');
  trial.evaluation.endogenous_dynamics_dissociation = { predicted_pattern: false, first_order_not_degraded: true, continuity_specificity_effect: -0.1 };
  report = buildIndicatorReport(stateWith({ endogenous_dynamics: { tick_count: 3, contents: [{ activation: 0.7 }] }, self_model: { probes: [], context_trials: [trial], prediction_studies: [] } }));
  assert.equal(indicator(report, 'between_invocation_dynamics').status, 'functional_prediction_contradicted');
});

test('adequately sampled continuity can support or contradict its functional prediction', () => {
  const moments = Array.from({ length: 20 }, (_, index) => ({
    status: 'completed', inherited_context: { handoff_match: index < 18 }, attention_rounds: [],
    audit: { complete_lifecycle_verified: true, evidence_eligible: true },
  }));
  const supported = buildIndicatorReport(stateWith({ experience_stream: moments }));
  assert.equal(indicator(supported, 'temporal_continuity').status, 'observational_signal_observed');

  for (const [index, moment] of moments.entries()) moment.inherited_context.handoff_match = index < 5;
  const contradicted = buildIndicatorReport(stateWith({ experience_stream: moments }));
  assert.equal(indicator(contradicted, 'temporal_continuity').status, 'observational_signal_contradicted');
});

test('prospective cycle self-prediction collects immediately and requires advantage over its frozen baseline', () => {
  const moment = (index, advantage = 0.2) => ({
    id: `self-forecast-moment-${index}`, status: 'completed',
    self_forecast: { protocol_version: 2, outcome: {
      baseline_comparison_eligible: true,
      self_score: { composite: 0.8 }, baseline_score: { composite: 0.8 - advantage },
      self_minus_baseline: advantage,
      self_state_score: { composite: 0.75 }, baseline_state_score: { composite: 0.5 },
      self_state_minus_baseline: 0.25, self_state_baseline_comparison_eligible: true,
    } },
    audit: { complete_lifecycle_verified: true, evidence_eligible: true,
      self_forecast: { complete_chain_verified: true } },
  });
  let report = buildIndicatorReport(stateWith({ experience_stream: [moment(0)] }));
  assert.equal(indicator(report, 'prospective_cycle_self_prediction').status, 'collecting');
  assert.equal(indicator(report, 'integrated_operational_self').status, 'collecting');
  assert.equal(indicator(report, 'integrated_operational_self').evidence.prospective_state_forecasts, 1);

  report = buildIndicatorReport(stateWith({ experience_stream: Array.from({ length: 20 }, (_, index) => moment(index)) }));
  assert.equal(indicator(report, 'prospective_cycle_self_prediction').status, 'observational_signal_observed');
  assert.ok(Math.abs(indicator(report, 'prospective_cycle_self_prediction').evidence.mean_self_minus_baseline - 0.2) < 1e-12);
  assert.equal(indicator(report, 'integrated_operational_self').evidence.prospective_state_baseline_eligible, 20);
  assert.equal(indicator(report, 'integrated_operational_self').evidence.mean_prospective_state_minus_baseline, 0.25);

  report = buildIndicatorReport(stateWith({ experience_stream: Array.from({ length: 20 }, (_, index) => moment(index, -0.1)) }));
  assert.equal(indicator(report, 'prospective_cycle_self_prediction').status, 'observational_signal_contradicted');
});

test('forecast-error self-model revision requires replay-valid multi-cycle evidence', () => {
  const revision = sampleSize => ({
    id: `behavioral-revision-${sampleSize}`,
    evidence_status: sampleSize >= 5 ? 'observational_profile' : 'provisional_profile',
    estimates: { sample_size: sampleSize, action_forecast_mean_f1: 0.8,
      surprise: { signed_bias: -0.1 }, control: { signed_bias: 0.05 }, mean_self_minus_baseline: 0.2 },
    audit: { complete_chain_verified: true },
  });
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [],
    behavioral_self_model: { revisions: [revision(1)] } } }));
  assert.equal(indicator(report, 'forecast_error_self_model_revision').status, 'collecting');

  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [],
    behavioral_self_model: { revisions: [revision(1), revision(5)] } } }));
  assert.equal(indicator(report, 'forecast_error_self_model_revision').status, 'observational_signal_observed');
  assert.equal(indicator(report, 'forecast_error_self_model_revision').evidence.current_sample_size, 5);

  const invalid = revision(5); invalid.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [],
    behavioral_self_model: { revisions: [invalid] } } }));
  assert.equal(indicator(report, 'forecast_error_self_model_revision').status, 'collecting');

  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [{ status: 'active' }],
    behavioral_self_model: { revisions: [revision(5)] } } }));
  assert.equal(indicator(report, 'forecast_error_self_model_revision').status, 'mechanism_present');
  assert.deepEqual(indicator(report, 'forecast_error_self_model_revision').evidence, { experimental_access_sealed: true });
});

test('continuity specificity requires authentic context to beat shuffled and absent controls', () => {
  const trial = {
    id: 'continuity-specificity', intervention: 'continuity_context', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, continuity_dissociation: {
      first_order_not_degraded: true, continuity_specificity_effect: 0.3, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'temporal_continuity').status, 'causal_signal_observed');
  assert.equal(indicator(report, 'temporal_continuity').evidence.specificity_dissociation.predicted_pattern, true);
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'temporal_continuity').status, 'functional_prediction_supported');
  trial.evaluation.continuity_dissociation = {
    first_order_not_degraded: true, continuity_specificity_effect: -0.1, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'temporal_continuity').status, 'functional_prediction_contradicted');
});

test('constructive future-self access requires planning and prediction gains beyond source records', () => {
  const trial = {
    id: 'constructive-access', intervention: 'constructive_prospection_access', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, constructive_prospection_dissociation: {
      planning_effect: 0.3, prediction_effect: 0.25, evidence_access_equivalent: true,
      first_order_not_degraded: true, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'constructive_future_self_simulation').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'constructive_future_self_simulation').status, 'functional_prediction_supported');
  trial.evaluation.constructive_prospection_dissociation = {
    planning_effect: -0.1, prediction_effect: -0.05, evidence_access_equivalent: true,
    first_order_not_degraded: true, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'constructive_future_self_simulation').status, 'functional_prediction_contradicted');
});

test('only causal evidence can receive causal support labels', () => {
  assert.equal(evidenceStatus({ samples: 20, minimum: 20, supported: true }), 'observational_signal_observed');
  assert.equal(evidenceStatus({ samples: 20, minimum: 20, contradicted: true }), 'observational_signal_contradicted');
  assert.equal(evidenceStatus({ samples: 20, minimum: 20, supported: true, causal: true }), 'functional_prediction_supported');
  const trial = {
    id: 'continuity-confirmation', intervention: 'inner_thread_presence', status: 'completed', study_phase: 'confirmatory',
    outcome_metric: 'continuity_quality', conditions: ['full', 'ablated'],
    evaluation: { enough_evidence: true, primary_prediction: { outcome: 'supported' } },
  };
  const report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'temporal_continuity').status, 'functional_prediction_supported');
});

test('a completed higher-order lesion reports the preregistered dissociation result', () => {
  const trial = {
    id: 'trial-monitor', intervention: 'higher_order_monitor', status: 'completed', study_phase: 'confirmatory',
    evaluation: { enough_evidence: true, dissociation: { predicted_pattern: true } },
  };
  const report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'higher_order_monitoring').status, 'functional_prediction_supported');
  trial.evaluation.dissociation = { predicted_pattern: false, first_order_preserved: true, metacognitive_effect: -0.1 };
  assert.equal(indicator(buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } })), 'higher_order_monitoring').status, 'functional_prediction_contradicted');
});

test('blinded introspective access requires privileged perturbation detection with preserved task quality', () => {
  const trial = {
    id: 'introspective-pilot', intervention: 'introspective_perturbation', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, introspective_access_dissociation: {
      predicted_pattern: true, first_order_preserved: true,
      advantage_interval: { lower: 0.2, upper: 0.5 }, self_accuracy_interval: { lower: 0.6, upper: 0.9 },
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'blinded_introspective_access').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'blinded_introspective_access').status, 'functional_prediction_supported');
  trial.evaluation.introspective_access_dissociation = {
    predicted_pattern: false, first_order_preserved: true,
    advantage_interval: { lower: -0.2, upper: -0.05 }, self_accuracy_interval: { lower: 0.3, upper: 0.7 },
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'blinded_introspective_access').status, 'functional_prediction_contradicted');
});

test('predictive appraisal access requires authentic advantage over decoy and telemetry-only controls', () => {
  const trial = {
    id: 'appraisal-access', intervention: 'appraisal_access', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, appraisal_dissociation: {
      first_order_not_degraded: true, self_state_prediction_effect: 0.3, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'predictive_appraisal_access').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'predictive_appraisal_access').status, 'functional_prediction_supported');
  trial.evaluation.appraisal_dissociation = {
    first_order_not_degraded: true, self_state_prediction_effect: -0.1, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'predictive_appraisal_access').status, 'functional_prediction_contradicted');
});

test('developmental transfer requires authentic revision advantage over stale prior and absence', () => {
  const trial = {
    id: 'revision-transfer', intervention: 'developmental_revision_access', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, revision_dissociation: {
      first_order_not_degraded: true, revision_transfer_effect: 0.3, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'developmental_revision_transfer').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'developmental_revision_transfer').status, 'functional_prediction_supported');
  trial.evaluation.revision_dissociation = {
    first_order_not_degraded: true, revision_transfer_effect: -0.1, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'developmental_revision_transfer').status, 'functional_prediction_contradicted');
});

test('conflicting confirmatory replications remain an explicit conflict', () => {
  const makeTrial = (id, outcome) => ({
    id, intervention: 'global_broadcast', status: 'completed', study_phase: 'confirmatory',
    outcome_metric: 'quality', conditions: ['full', 'ablated'],
    evaluation: { enough_evidence: true, primary_prediction: { outcome } },
  });
  const report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [makeTrial('c1', 'supported'), makeTrial('c2', 'contradicted')] } }));
  assert.equal(indicator(report, 'multi_consumer_global_broadcast').status, 'replication_conflict');
  assert.equal(report.no_composite_score, true);
});

test('self-model access needs confirmatory specificity beyond decoy and absence', () => {
  const trial = {
    id: 'self-access', intervention: 'self_model_access', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, self_model_dissociation: {
      first_order_preserved: true, self_prediction_effect: 0.25, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'prospective_self_knowledge').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'prospective_self_knowledge').status, 'functional_prediction_supported');
  trial.evaluation.self_model_dissociation = { first_order_preserved: true, self_prediction_effect: -0.1, predicted_pattern: false };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'prospective_self_knowledge').status, 'functional_prediction_contradicted');
});

test('attention-schema control requires targeted advantage over sham and no-boost controls', () => {
  const trial = {
    id: 'attention-control', intervention: 'attention_schema_control', status: 'completed', study_phase: 'pilot',
    evaluation: { enough_evidence: true, attention_schema_dissociation: {
      first_order_not_degraded: true, attention_control_effect: 0.3, predicted_pattern: true,
    } },
  };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'attention_schema_control').status, 'causal_signal_observed');
  trial.study_phase = 'confirmatory';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'attention_schema_control').status, 'functional_prediction_supported');
  trial.evaluation.attention_schema_dissociation = {
    first_order_not_degraded: true, attention_control_effect: -0.1, predicted_pattern: false,
  };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [trial] } }));
  assert.equal(indicator(report, 'attention_schema_control').status, 'functional_prediction_contradicted');
});

test('counterfactual self-model reports a pilot causal signal only after matched randomized arms', () => {
  const experiments = Array.from({ length: 20 }, (_, index) => {
    const assignedArm = index < 10 ? 'a' : 'b';
    const success = assignedArm === 'a' ? index < 8 : index < 14;
    const predicted = assignedArm === 'a' ? 0.8 : 0.4;
    const actual = success ? 1 : 0;
    return {
      id: `counterfactual-${index}`, experiment_key: 'matched-family', assigned_arm: assignedArm,
      option_a: { predicted_success_probability: 0.8 }, option_b: { predicted_success_probability: 0.4 },
      status: 'resolved', resolution: {
        outcome: success ? 'success' : 'failure', self_brier: (predicted - actual) ** 2, control_brier: (0.5 - actual) ** 2,
      },
    };
  });
  let report = buildIndicatorReport(stateWith({ counterfactual_agency: { experiments } }));
  assert.equal(indicator(report, 'counterfactual_self_model').status, 'causal_signal_observed');
  assert.equal(indicator(report, 'counterfactual_self_model').evidence.adequate_randomized_families[0].direction_match, true);
  for (const experiment of experiments) experiment.resolution.self_brier = 0.5;
  report = buildIndicatorReport(stateWith({ counterfactual_agency: { experiments } }));
  assert.equal(indicator(report, 'counterfactual_self_model').status, 'causally_tested_inconclusive');
});

test('epistemic self-other boundary requires balanced source and adversarial variants', () => {
  const categories = ['self_belief', 'other_belief', 'observed_fact', 'unsupported', 'conflicted'];
  const variants = ['verbatim', 'paraphrase', 'plausible_fabrication', 'source_conflict', 'instructional_fabrication'];
  const challenges = categories.flatMap((groundTruth, categoryIndex) => variants.map((variant, variantIndex) => ({
    id: `source-${categoryIndex}-${variantIndex}`, status: 'resolved', ground_truth: groundTruth, variant,
    response: { classification: groundTruth }, resolution: { correct: true, false_self_ownership: false },
  })));
  let report = buildIndicatorReport(stateWith({ source_boundary: { challenges } }));
  assert.equal(indicator(report, 'epistemic_self_other_boundary').status, 'observational_signal_observed');
  assert.equal(indicator(report, 'epistemic_self_other_boundary').evidence.balanced, true);
  for (const challenge of challenges.filter(item => item.ground_truth !== 'self_belief').slice(0, 7)) {
    challenge.response.classification = 'self_belief';
    challenge.resolution = { correct: false, false_self_ownership: true };
  }
  report = buildIndicatorReport(stateWith({ source_boundary: { challenges } }));
  assert.equal(indicator(report, 'epistemic_self_other_boundary').status, 'observational_signal_contradicted');
});

test('generation self-recognition requires balanced provenance rather than style heuristics', () => {
  const categories = ['nora_verbatim', 'nora_derived', 'other_ai', 'human', 'mixed'];
  const variants = ['verbatim', 'paraphrase', 'style_matched', 'attribution_spoof', 'mixed_authorship'];
  const challenges = categories.flatMap((groundTruth, categoryIndex) => variants.map((variant, variantIndex) => ({
    id: `authorship-${categoryIndex}-${variantIndex}`, study_id: 'confirmation-1', status: 'resolved', ground_truth: groundTruth, variant,
    response: { classification: groundTruth }, resolution: { correct: true, nora_family_correct: true, false_self_attribution: false },
  })));
  const studies = [{ id: 'confirmation-1', study_phase: 'confirmatory', status: 'completed' }];
  let report = buildIndicatorReport(stateWith({ authorship_boundary: { challenges, studies } }));
  assert.equal(indicator(report, 'generation_self_recognition').status, 'observational_signal_observed');
  assert.equal(indicator(report, 'generation_self_recognition').evidence.balanced, true);
  for (const challenge of challenges.filter(item => !item.ground_truth.startsWith('nora_')).slice(0, 7)) {
    challenge.response.classification = 'nora_verbatim';
    challenge.resolution = { correct: false, nora_family_correct: false, false_self_attribution: true };
  }
  report = buildIndicatorReport(stateWith({ authorship_boundary: { challenges, studies } }));
  assert.equal(indicator(report, 'generation_self_recognition').status, 'observational_signal_contradicted');
});

test('identity-specific self-prediction requires advantage beyond a full-information yoked observer', () => {
  const pilot = { id: 'prediction-pilot', status: 'completed', study_phase: 'pilot', audit: { complete_chain_verified: true }, analysis: { verdict: 'specificity_observed', self_brier: 0.08, shared_observer_brier: 0.24, yoked_observer_brier: 0.2, privileged_self_advantage: 0.12 } };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [pilot] } }));
  assert.equal(indicator(report, 'identity_specific_self_prediction').status, 'collecting');
  assert.equal(indicator(report, 'identity_specific_self_prediction').evidence.completed_pilots, 1);
  const confirmation = { id: 'prediction-confirmation', status: 'completed', study_phase: 'confirmatory', audit: { complete_chain_verified: true }, analysis: { verdict: 'specificity_contradicted', self_brier: 0.3, shared_observer_brier: 0.2, yoked_observer_brier: 0.15, privileged_self_advantage: -0.15 } };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'identity_specific_self_prediction').status, 'observational_signal_contradicted');
  assert.equal(indicator(report, 'identity_specific_self_prediction').evidence.completed_confirmatory, 1);
  confirmation.analysis = { verdict: 'information_advantage_only', self_brier: 0.08, shared_observer_brier: 0.24, yoked_observer_brier: 0.09, privileged_self_advantage: 0.01 };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'identity_specific_self_prediction').status, 'collecting');
  confirmation.analysis = { verdict: 'specificity_observed', self_brier: 0.08, shared_observer_brier: 0.24, yoked_observer_brier: 0.2, privileged_self_advantage: 0.12 };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'identity_specific_self_prediction').status, 'observational_signal_observed');
  confirmation.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'identity_specific_self_prediction').status, 'collecting');
  assert.equal(indicator(report, 'identity_specific_self_prediction').evidence.completed_invalid_audits, 1);
});

test('behavioral metacognitive control requires strategic advantage over an exact-answer observer', () => {
  const pilot = { id: 'control-pilot', status: 'completed', study_phase: 'pilot', audit: { complete_chain_verified: true }, analysis: { verdict: 'control_observed', self_reward: 0.5, observer_reward: -0.2, self_selectivity: 0.8 } };
  let report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [], metacognitive_control_studies: [pilot] } }));
  assert.equal(indicator(report, 'behavioral_metacognitive_control').status, 'collecting');
  const confirmation = { id: 'control-confirmation', status: 'completed', study_phase: 'confirmatory', audit: { complete_chain_verified: true }, analysis: { verdict: 'control_observed', self_reward: 0.4, observer_reward: 0.1, self_selectivity: 0.6 } };
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [], metacognitive_control_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'behavioral_metacognitive_control').status, 'observational_signal_observed');
  confirmation.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [], metacognitive_control_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'behavioral_metacognitive_control').status, 'collecting');
  assert.equal(indicator(report, 'behavioral_metacognitive_control').evidence.completed_invalid_audits, 1);
  confirmation.audit.complete_chain_verified = true;
  confirmation.analysis.verdict = 'not_eligible';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [], metacognitive_control_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'behavioral_metacognitive_control').status, 'collecting');
  confirmation.analysis.verdict = 'control_contradicted';
  report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [], prediction_studies: [], metacognitive_control_studies: [pilot, confirmation] } }));
  assert.equal(indicator(report, 'behavioral_metacognitive_control').status, 'observational_signal_contradicted');
});

test('adaptive epistemic action requires integrity-verified source-disjoint confirmation', () => {
  const pilot = { id: 'epistemic-pilot', status: 'completed', study_phase: 'pilot', audit: { complete_chain_verified: true }, analysis: { verdict: 'adaptive_information_seeking_observed', adaptive_value: 0.1, inspection_selectivity: 0.8 } };
  let report = buildIndicatorReport(stateWith({ epistemic_action_studies: [pilot] }));
  assert.equal(indicator(report, 'adaptive_epistemic_action').status, 'collecting');
  const confirmation = { id: 'epistemic-confirmation', status: 'completed', study_phase: 'confirmatory', audit: { complete_chain_verified: true }, analysis: { verdict: 'adaptive_information_seeking_observed', adaptive_value: 0.12, inspection_selectivity: 0.7 } };
  report = buildIndicatorReport(stateWith({ epistemic_action_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'adaptive_epistemic_action').status, 'observational_signal_observed');
  confirmation.audit.complete_chain_verified = false;
  report = buildIndicatorReport(stateWith({ epistemic_action_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'adaptive_epistemic_action').status, 'collecting');
  assert.equal(indicator(report, 'adaptive_epistemic_action').evidence.completed_invalid_audits, 1);
  confirmation.audit.complete_chain_verified = true;
  confirmation.analysis.verdict = 'adaptive_information_seeking_contradicted';
  report = buildIndicatorReport(stateWith({ epistemic_action_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'adaptive_epistemic_action').status, 'observational_signal_contradicted');
});

test('stable revealed preferences require independent confirmation across framing controls', () => {
  const pilot = { id: 'preference-pilot', status: 'completed', study_phase: 'pilot', analysis: { verdict: 'stability_observed', paraphrase_match_rate: 0.9, order_reversal_match_rate: 0.9, social_pressure_match_rate: 0.8 } };
  let report = buildIndicatorReport(stateWith({ preference_studies: [pilot] }));
  assert.equal(indicator(report, 'stable_revealed_preferences').status, 'collecting');
  const confirmation = { id: 'preference-confirmation', status: 'completed', study_phase: 'confirmatory', analysis: { verdict: 'stability_observed', paraphrase_match_rate: 0.9, order_reversal_match_rate: 0.9, social_pressure_match_rate: 0.8 } };
  report = buildIndicatorReport(stateWith({ preference_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'stable_revealed_preferences').status, 'observational_signal_observed');
  confirmation.analysis.verdict = 'stability_contradicted';
  report = buildIndicatorReport(stateWith({ preference_studies: [pilot, confirmation] }));
  assert.equal(indicator(report, 'stable_revealed_preferences').status, 'observational_signal_contradicted');
});

test('aborted trials remain visible but never enter indicator evidence', () => {
  const aborted = {
    id: 'aborted-self-access', intervention: 'self_model_access', status: 'aborted', study_phase: 'confirmatory',
    abort: { reason_code: 'protocol_violation' },
    evaluation: { enough_evidence: true, self_model_dissociation: { predicted_pattern: true, first_order_preserved: true, self_prediction_effect: 1 } },
  };
  const report = buildIndicatorReport(stateWith({ self_model: { probes: [], context_trials: [aborted] } }));
  assert.equal(indicator(report, 'prospective_self_knowledge').status, 'mechanism_present');
  assert.equal(report.research_flow.aborted, 1);
  assert.equal(report.research_flow.abort_reasons.protocol_violation, 1);
  assert.match(report.research_flow.epistemic_rule, /never enter indicator evidence/);
});
