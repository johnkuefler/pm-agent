'use strict';

const cognitivePulse = require('./cognitive-pulse');
const cognitiveSelfRegulation = require('./cognitive-self-regulation');

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function completedTrial(cognition, intervention) {
  return completedTrials(cognition, intervention).at(-1) || null;
}

function completedTrials(cognition, intervention) {
  return (cognition.self_model?.context_trials || []).filter(item => item.intervention === intervention && item.status === 'completed' && item.evaluation?.enough_evidence);
}

function replicatedStatus(trials, verdict) {
  if (!trials.length) return null;
  const confirmatoryVerdicts = trials.filter(item => item.study_phase === 'confirmatory').map(verdict);
  if (confirmatoryVerdicts.includes('supported') && confirmatoryVerdicts.includes('contradicted')) return 'replication_conflict';
  if (confirmatoryVerdicts.length && confirmatoryVerdicts.every(item => item === 'supported')) return 'functional_prediction_supported';
  if (confirmatoryVerdicts.length && confirmatoryVerdicts.every(item => item === 'contradicted')) return 'functional_prediction_contradicted';
  if (trials.some(item => verdict(item) === 'supported')) return 'causal_signal_observed';
  return 'causally_tested_inconclusive';
}

function evidenceStatus({ samples, minimum, supported, contradicted, causal = false }) {
  if (!samples) return 'mechanism_present';
  if (samples < minimum) return 'collecting';
  if (supported) return causal ? 'functional_prediction_supported' : 'observational_signal_observed';
  if (contradicted) return causal ? 'functional_prediction_contradicted' : 'observational_signal_contradicted';
  return causal ? 'causally_tested_inconclusive' : 'observationally_inconclusive';
}

function buildIndicatorReport(state = {}, now = new Date()) {
  const cognition = state.cognition || {};
  const sourceAttestations = cognition.external_source_attestations || [];
  const replayValidSourceAttestations = sourceAttestations
    .filter(item => item.audit?.complete_chain_verified === true);
  const selfRegulationForecasts = cognition.background_inference?.self_regulation?.forecasts || [];
  const replayValidSelfRegulationForecasts = selfRegulationForecasts
    .filter(item => item.audit?.complete_chain_verified === true);
  const resolvedSelfRegulationForecasts = replayValidSelfRegulationForecasts
    .filter(item => item.status === 'resolved');
  const selfRegulationPolicy = cognitiveSelfRegulation.calibrationPolicy(resolvedSelfRegulationForecasts);
  const selfRegulationStudies = (cognition.cognitive_self_regulation_studies || [])
    .filter(study => study.status === 'completed' && study.audit?.complete_chain_verified === true);
  const latestSelfRegulationStudy = selfRegulationStudies.at(-1) || null;
  const selfRegulationStudyStatus = latestSelfRegulationStudy
    ? latestSelfRegulationStudy.analysis?.predicted_pattern === true
      ? latestSelfRegulationStudy.study_phase === 'confirmatory'
        ? 'functional_prediction_supported' : 'causal_signal_observed'
      : latestSelfRegulationStudy.analysis?.verdict === 'no_identity_specific_regulation_advantage'
        ? 'functional_prediction_contradicted' : 'causally_tested_inconclusive'
    : null;
  const allProcessMetacognitionStudies = cognition.process_metacognition_studies || [];
  const productionProcessMetacognitionStudies = allProcessMetacognitionStudies
    .filter(study => study.subject_model?.scope === 'production_nora');
  const experimentalProcessMetacognitionStudies = allProcessMetacognitionStudies
    .filter(study => study.subject_model?.scope === 'experimental_subject_variant');
  const processMetacognitionStudies = productionProcessMetacognitionStudies
    .filter(study => study.status === 'completed' && study.audit?.complete_chain_verified === true);
  const latestProcessMetacognitionStudy = processMetacognitionStudies.at(-1) || null;
  const processMetacognitionVerdict = study => study.analysis?.predicted_pattern
    ? 'supported' : study.analysis?.verdict === 'process_metacognition_not_observed'
      ? 'contradicted' : 'inconclusive';
  const processMetacognitionStatus = processMetacognitionStudies.length
    ? replicatedStatus(processMetacognitionStudies, processMetacognitionVerdict)
    : productionProcessMetacognitionStudies.some(study => study.status === 'active') ? 'collecting' : 'not_implemented';
  const allContextTrials = cognition.self_model?.context_trials || [];
  const allMoments = cognition.experience_stream || [];
  const moments = allMoments.filter(item => item.audit?.evidence_eligible === true);
  const invalidClosedMoments = allMoments.filter(item => item.status !== 'open' && item.audit?.complete_lifecycle_verified !== true);
  const runLockLifecycleGaps = allMoments.filter(item =>
    /^run_lock_(?:released|expired|persistence_failed)_before_cycle_close$|^run_lock_missing_after_restart$/.test(
      item.closure?.recovery?.reason || ''));
  const cycleSelfForecasts = allMoments.filter(item => item.self_forecast);
  const replayValidCycleSelfForecasts = cycleSelfForecasts.filter(item => item.self_forecast?.outcome
    && item.audit?.self_forecast?.complete_chain_verified === true);
  const baselineEligibleCycleSelfForecasts = replayValidCycleSelfForecasts
    .filter(item => item.self_forecast.outcome.baseline_comparison_eligible === true);
  const cycleSelfForecastScore = mean(baselineEligibleCycleSelfForecasts.map(item => item.self_forecast.outcome.self_score.composite));
  const cycleSelfForecastBaselineScore = mean(baselineEligibleCycleSelfForecasts.map(item => item.self_forecast.outcome.baseline_score.composite));
  const cycleSelfForecastAdvantage = mean(baselineEligibleCycleSelfForecasts.map(item => item.self_forecast.outcome.self_minus_baseline));
  const integratedStateForecasts = replayValidCycleSelfForecasts.filter(item =>
    Number(item.self_forecast?.protocol_version) >= 2 && item.self_forecast.outcome?.self_state_score);
  const baselineEligibleIntegratedStateForecasts = integratedStateForecasts.filter(item =>
    item.self_forecast.outcome.self_state_baseline_comparison_eligible === true);
  const integratedStateForecastScore = mean(baselineEligibleIntegratedStateForecasts.map(item =>
    item.self_forecast.outcome.self_state_score.composite));
  const integratedStateBaselineScore = mean(baselineEligibleIntegratedStateForecasts.map(item =>
    item.self_forecast.outcome.baseline_state_score.composite));
  const integratedStateForecastAdvantage = mean(baselineEligibleIntegratedStateForecasts.map(item =>
    item.self_forecast.outcome.self_state_minus_baseline));
  const protocolV4CycleSelfForecasts = replayValidCycleSelfForecasts.filter(item =>
    Number(item.self_forecast?.protocol_version) >= 4);
  const metacognitiveProtocolFloor = protocolV4CycleSelfForecasts.length ? 4 : 3;
  const metacognitiveReliabilityForecasts = replayValidCycleSelfForecasts.filter(item =>
    Number(item.self_forecast?.protocol_version) >= metacognitiveProtocolFloor
      && item.self_forecast.outcome?.metacognitive_score);
  const baselineEligibleMetacognitiveForecasts = metacognitiveReliabilityForecasts.filter(item =>
    item.self_forecast.outcome.metacognitive_baseline_comparison_eligible === true);
  const metacognitiveReliabilityScore = mean(baselineEligibleMetacognitiveForecasts.map(item =>
    item.self_forecast.outcome.metacognitive_score.composite));
  const metacognitiveReliabilityBaselineScore = mean(baselineEligibleMetacognitiveForecasts.map(item =>
    item.self_forecast.outcome.baseline_metacognitive_score.composite));
  const metacognitiveReliabilityAdvantage = mean(baselineEligibleMetacognitiveForecasts.map(item =>
    item.self_forecast.outcome.metacognitive_self_minus_baseline));
  const metacognitiveSuccessBrier = mean(baselineEligibleMetacognitiveForecasts.map(item =>
    item.self_forecast.outcome.metacognitive_score.success_brier));
  const metacognitiveErrorDomainHitRate = mean(baselineEligibleMetacognitiveForecasts.map(item =>
    Number(item.self_forecast.outcome.metacognitive_score.largest_error_domain_hit === true)));
  const substrateSelfForecasts = replayValidCycleSelfForecasts.filter(item =>
    Number(item.self_forecast?.protocol_version) >= 4 && item.self_forecast.outcome?.substrate_score);
  const baselineEligibleSubstrateForecasts = substrateSelfForecasts.filter(item =>
    item.self_forecast.outcome.substrate_baseline_comparison_eligible === true);
  const substrateSelfForecastScore = mean(baselineEligibleSubstrateForecasts.map(item =>
    item.self_forecast.outcome.substrate_score.composite));
  const substratePersistenceScore = mean(baselineEligibleSubstrateForecasts.map(item =>
    item.self_forecast.outcome.baseline_substrate_score.composite));
  const substrateSelfForecastAdvantage = mean(baselineEligibleSubstrateForecasts.map(item =>
    item.self_forecast.outcome.substrate_self_minus_baseline));
  const substrateRestartPredictions = baselineEligibleSubstrateForecasts.map(item => ({
    predicted: Number(item.self_forecast.forecast.substrate_prediction.restart_probability),
    observed: item.self_forecast.outcome.substrate_actual.restart_observed === true,
  }));
  const observedSubstrateRestarts = substrateRestartPredictions.filter(item => item.observed).length;
  const selfCorrectionOffers = cycleSelfForecasts.filter(item =>
    item.self_forecast?.self_correction?.offer_commitment);
  const replayValidSelfCorrections = replayValidCycleSelfForecasts.filter(item =>
    item.self_forecast?.outcome?.self_correction
    && item.audit?.self_forecast?.self_correction_complete_chain_verified === true);
  const integratedSelfCorrectionAdvantage = mean(replayValidSelfCorrections.map(item =>
    item.self_forecast.outcome.self_correction.integrated_self_state_score?.revised_minus_initial)
    .filter(Number.isFinite));
  const behavioralSelfCorrectionAdvantage = mean(replayValidSelfCorrections.map(item =>
    item.self_forecast.outcome.self_correction.behavioral_score?.revised_minus_initial)
    .filter(Number.isFinite));
  const metacognitiveSelfCorrectionAdvantage = mean(replayValidSelfCorrections.map(item =>
    item.self_forecast.outcome.self_correction.metacognitive_reliability_score?.revised_minus_initial)
    .filter(Number.isFinite));
  const integratedSelfCorrectionImprovementRate = mean(replayValidSelfCorrections.map(item => Number(
    Number(item.self_forecast.outcome.self_correction.integrated_self_state_score?.revised_minus_initial) > 0)));
  const behavioralSelfModelRevisions = cognition.self_model?.behavioral_self_model?.revisions || [];
  const replayValidBehavioralSelfModelRevisions = behavioralSelfModelRevisions
    .filter(item => item.audit?.complete_chain_verified === true);
  const behavioralSelfModelSealed = allContextTrials.some(item => item.status === 'active');
  const behavioralCalibrationSealed = allContextTrials.some(item => item.status === 'active'
    && ['self_model_access', 'integrated_self_binding'].includes(item.intervention));
  const currentBehavioralSelfModel = behavioralSelfModelSealed
    ? null : replayValidBehavioralSelfModelRevisions.at(-1) || null;
  const handoffs = moments.filter(item => item.inherited_context?.handoff_match != null);
  const handoffRate = handoffs.length ? handoffs.filter(item => item.inherited_context.handoff_match).length / handoffs.length : null;
  const continuityHandoffRecords = cognition.continuity_handoffs || [];
  const verifiedContinuityHandoffs = continuityHandoffRecords.filter(item => item.audit?.complete_chain_verified === true);
  const continuitySpecificityTrials = completedTrials(cognition, 'continuity_context');
  const continuityLineageTrials = continuitySpecificityTrials.filter(item => item.continuity_protocol_version === 2);
  const continuityTrials = continuityLineageTrials.length ? continuityLineageTrials
    : continuitySpecificityTrials.length ? continuitySpecificityTrials : completedTrials(cognition, 'inner_thread_presence');
  const continuityTrial = continuityTrials.at(-1) || null;
  const continuityDissociation = continuityTrial?.evaluation?.continuity_dissociation || null;
  const reentryRounds = moments.flatMap(item => (item.attention_rounds || []).filter(round => round.kind === 'reentry'));
  const recurrenceTrials = completedTrials(cognition, 'recurrent_feedback');
  const recurrenceTrial = recurrenceTrials.at(-1) || null;
  const recurrenceDissociation = recurrenceTrial?.evaluation?.recurrence_dissociation || null;
  const endogenousDynamics = cognition.endogenous_dynamics || {};
  const endogenousTrials = completedTrials(cognition, 'endogenous_dynamics');
  const endogenousTrial = endogenousTrials.at(-1) || null;
  const endogenousDissociation = endogenousTrial?.evaluation?.endogenous_dynamics_dissociation || null;
  const cognitivePulses = cognition.background_inference?.pulses || [];
  const eligiblePulses = cognitivePulses.filter(item => {
    if (item.status !== 'accepted') return false;
    if (item.audit && item.audit.complete_chain_verified !== true) return false;
    try {
      const normalized = cognitivePulse.validateOutput(item.output, item.input_packet);
      return cognitivePulse.commitment(item.input_packet) === item.input_commitment && cognitivePulse.commitment(normalized) === item.output_commitment;
    } catch (_) { return false; }
  });
  const resolvedPulses = eligiblePulses.filter(item => item.resolution);
  const usefulPulseRate = resolvedPulses.length ? resolvedPulses.filter(item => item.resolution.outcome === 'useful').length / resolvedPulses.length : null;
  const misleadingPulseRate = resolvedPulses.length ? resolvedPulses.filter(item => item.resolution.outcome === 'misleading').length / resolvedPulses.length : null;
  const chainedPulses = eligiblePulses.filter(item => item.audit?.protocol_version >= 2);
  const linkedPulses = chainedPulses.filter(item => item.predecessor_id);
  const transitionCounts = { retain: 0, revise: 0, drop: 0 };
  for (const pulse of linkedPulses) {
    const disposition = pulse.output?.predecessor_update?.disposition;
    if (Object.hasOwn(transitionCounts, disposition)) transitionCounts[disposition]++;
  }
  const cognitivePulseTrials = completedTrials(cognition, 'cognitive_pulse_access');
  const cognitivePulseTrial = cognitivePulseTrials.at(-1) || null;
  const cognitivePulseDissociation = cognitivePulseTrial?.evaluation?.cognitive_pulse_dissociation || null;
  const cognitiveInitiations = cognition.background_inference?.initiation_records || [];
  const eligibleCognitiveInitiations = cognitiveInitiations.filter(item => item.status === 'completed' && item.audit?.complete_chain_verified === true);
  const initiatedThoughts = eligibleCognitiveInitiations.filter(item => item.decision?.decision === 'think');
  const deferredThoughts = eligibleCognitiveInitiations.filter(item => item.decision?.decision === 'wait');
  const resolvedInitiatedThoughts = initiatedThoughts.map(item => ({ item,
    pulse: eligiblePulses.find(pulse => pulse.id === item.pulse_id) })).filter(entry => entry.pulse?.resolution);
  const usefulInitiatedRate = resolvedInitiatedThoughts.length
    ? resolvedInitiatedThoughts.filter(entry => entry.pulse.resolution.outcome === 'useful').length / resolvedInitiatedThoughts.length : null;
  const cognitiveInitiationStudies = (cognition.cognitive_initiation_studies || []).filter(item => item.status === 'completed'
    && item.analysis?.enough_evidence && item.audit?.complete_chain_verified === true);
  const latestCognitiveInitiationStudy = cognitiveInitiationStudies.at(-1) || null;
  const prospectiveCognitiveInitiationStudies = cognitiveInitiationStudies.filter(item => item.sampling_mode === 'prospective_consecutive');
  const cognitiveInitiationVerdict = study => study.analysis?.predicted_pattern
    ? 'supported' : (study.analysis?.identity_vs_deidentified_interval?.upper <= 0 || study.analysis?.identity_vs_schedule_interval?.upper <= 0)
      ? 'contradicted' : 'inconclusive';
  const cognitiveInitiationPolicyStudies = (cognition.cognitive_initiation_policy_studies || []).filter(item => item.status === 'completed'
    && item.analysis?.enough_evidence && item.audit?.complete_chain_verified === true);
  const ecologicalCognitiveInitiationPolicyStudies = cognitiveInitiationPolicyStudies
    .filter(item => item.outcome_mode === 'ecological_commitment');
  const standardizedCognitiveInitiationPolicyStudies = cognitiveInitiationPolicyStudies
    .filter(item => item.outcome_mode !== 'ecological_commitment');
  const cognitiveInitiationPolicyVerdict = study => study.analysis?.predicted_pattern ? 'supported'
    : (study.analysis?.utility_vs_deidentified_interval?.upper <= 0 || study.analysis?.utility_vs_schedule_interval?.upper <= 0)
      ? 'contradicted' : 'inconclusive';
  const cognitiveInitiationStudyStatus = cognitiveInitiationPolicyStudies.length
    ? replicatedStatus(cognitiveInitiationPolicyStudies, cognitiveInitiationPolicyVerdict)
    : cognitiveInitiationStudies.some(study => cognitiveInitiationVerdict(study) === 'supported') ? 'causal_signal_observed'
      : cognitiveInitiationStudies.length ? 'causally_tested_inconclusive' : null;
  const selfInquiries = cognition.background_inference?.inquiries || [];
  const eligibleSelfInquiries = selfInquiries.filter(item => item.audit?.complete_chain_verified === true);
  const reviewedSelfInquiries = eligibleSelfInquiries.map(item => ({
    inquiry: item, probe: cognition.self_model?.probes?.find(probe => probe.id === item.probe_id),
  })).filter(item => item.probe?.audit?.complete_chain_verified === true && item.probe?.independent_review?.belief_update);
  const realizedInquiryInformation = reviewedSelfInquiries.map(item => cognitivePulse.binaryKLDivergence(item.probe.independent_review.belief_update.posterior, item.probe.independent_review.belief_update.prior));
  const meanRealizedInquiryInformation = realizedInquiryInformation.length
    ? realizedInquiryInformation.reduce((sum, value) => sum + value, 0) / realizedInquiryInformation.length : null;
  const selfClaimProposals = cognition.background_inference?.claim_proposals || [];
  const eligibleSelfClaimProposals = selfClaimProposals.filter(item => item.audit?.complete_chain_verified === true);
  const endogenousClaims = (cognition.self_model?.claims || []).filter(item => item.origin?.type === 'endogenous_model_hypothesis'
    && item.confidence_audit?.complete_chain_verified === true);
  const validatedEndogenousClaims = endogenousClaims.filter(item => item.status === 'active');
  const selfInductionStudies = (cognition.self_induction_studies || []).filter(item => item.status === 'completed'
    && item.analysis?.enough_evidence && item.audit?.complete_chain_verified === true);
  const latestSelfInductionStudy = selfInductionStudies.at(-1) || null;
  const selfInductionStatus = replicatedStatus(selfInductionStudies, study => study.analysis?.predicted_pattern
    ? 'supported' : study.analysis?.identity_vs_deidentified_interval?.upper <= 0 ? 'contradicted' : 'inconclusive');
  const inquirySelectionStudies = (cognition.self_inquiry_selection_studies || []).filter(item => item.status === 'completed' && item.analysis?.enough_evidence && item.audit?.complete_chain_verified === true);
  const inquirySelectionStudy = inquirySelectionStudies.at(-1) || null;
  const confirmatoryInquirySelectionStudies = inquirySelectionStudies.filter(item => item.study_phase === 'confirmatory');
  const inquirySelectionVerdicts = confirmatoryInquirySelectionStudies.map(study => study.analysis?.external_specificity_predicted_pattern
    ? 'specificity_observed' : study.analysis?.subject_vs_best_control_interval?.upper <= 0 ? 'specificity_contradicted' : 'inconclusive');
  const inquirySelectionStatus = inquirySelectionVerdicts.includes('specificity_observed') && inquirySelectionVerdicts.includes('specificity_contradicted') ? 'replication_conflict'
    : (inquirySelectionVerdicts.length && inquirySelectionVerdicts.every(item => item === 'specificity_observed') ? 'observational_signal_observed'
      : (inquirySelectionVerdicts.includes('specificity_contradicted') ? 'observational_signal_contradicted'
        : (inquirySelectionStudies.length ? 'collecting' : null)));
  const inquiryIdentityBindingStatus = replicatedStatus(inquirySelectionStudies, study => study.analysis?.identity_binding_predicted_pattern
    ? 'supported' : study.analysis?.subject_vs_deidentified_subject_interval?.upper <= 0 ? 'contradicted' : 'inconclusive');

  const workspaceTrials = completedTrials(cognition, 'workspace_capacity');
  const workspaceTrial = workspaceTrials.at(-1) || null;
  const workspaceMetric = workspaceTrial?.outcome_metric;
  const workspaceFull = workspaceTrial?.evaluation?.condition_metrics?.full?.[workspaceMetric];
  const workspaceAblated = workspaceTrial?.evaluation?.condition_metrics?.ablated?.[workspaceMetric];
  const workspaceEffect = workspaceFull == null || workspaceAblated == null ? null : workspaceFull - workspaceAblated;

  const monitorTrials = completedTrials(cognition, 'higher_order_monitor');
  const monitorTrial = monitorTrials.at(-1) || null;
  const monitorDissociation = monitorTrial?.evaluation?.dissociation || null;
  const introspectivePerturbationTrials = completedTrials(cognition, 'introspective_perturbation');
  const introspectivePerturbationTrial = introspectivePerturbationTrials.at(-1) || null;
  const introspectivePerturbationDissociation = introspectivePerturbationTrial?.evaluation?.introspective_access_dissociation || null;
  const appraisalTrials = completedTrials(cognition, 'appraisal_access');
  const appraisalTrial = appraisalTrials.at(-1) || null;
  const appraisalDissociation = appraisalTrial?.evaluation?.appraisal_dissociation || null;
  const revisionTransferTrials = completedTrials(cognition, 'developmental_revision_access');
  const revisionTransferTrial = revisionTransferTrials.at(-1) || null;
  const revisionDissociation = revisionTransferTrial?.evaluation?.revision_dissociation || null;
  const epistemicOwnershipTrials = completedTrials(cognition, 'epistemic_ownership_access');
  const epistemicOwnershipTrial = epistemicOwnershipTrials.at(-1) || null;
  const epistemicOwnershipDissociation = epistemicOwnershipTrial?.evaluation?.epistemic_ownership_dissociation || null;
  const epistemicDiscrepancyTrials = completedTrials(cognition, 'epistemic_discrepancy_access');
  const epistemicDiscrepancyTrial = epistemicDiscrepancyTrials.at(-1) || null;
  const epistemicDiscrepancyDissociation = epistemicDiscrepancyTrial?.evaluation?.epistemic_discrepancy_dissociation || null;
  const epistemicRevisionProfileTrials = completedTrials(cognition, 'epistemic_revision_profile_access');
  const epistemicRevisionProfileTrial = epistemicRevisionProfileTrials.at(-1) || null;
  const epistemicRevisionProfileDissociation = epistemicRevisionProfileTrial?.evaluation?.epistemic_revision_profile_dissociation || null;
  const constructiveProspectionAccessTrials = completedTrials(cognition, 'constructive_prospection_access');
  const constructiveProspectionAccessTrial = constructiveProspectionAccessTrials.at(-1) || null;
  const constructiveProspectionDissociation = constructiveProspectionAccessTrial?.evaluation?.constructive_prospection_dissociation || null;
  const selfAccessTrials = completedTrials(cognition, 'self_model_access');
  const selfAccessTrial = selfAccessTrials.at(-1) || null;
  const selfAccessDissociation = selfAccessTrial?.evaluation?.behavioral_self_profile_dissociation
    || selfAccessTrial?.evaluation?.self_model_dissociation || null;
  const goalAccessTrials = completedTrials(cognition, 'goal_access');
  const goalAccessTrial = goalAccessTrials.at(-1) || null;
  const goalGuidanceDissociation = goalAccessTrial?.evaluation?.goal_guidance_dissociation || null;
  const integratedSelfTrials = completedTrials(cognition, 'integrated_self_binding');
  const integratedSelfTrial = integratedSelfTrials.at(-1) || null;
  const integratedSelfDissociation = integratedSelfTrial?.evaluation?.integrated_self_dissociation || null;
  const integratedSelfFrames = cognition.integrated_self?.frames || [];
  const integrityEligibleSelfFrames = integratedSelfFrames.filter(item => item.audit?.complete_chain_verified === true);
  const broadcastEvents = cognition.global_broadcast?.events || [];
  const multiConsumerEvents = broadcastEvents.filter(item => item.delivered && (item.receipts || []).filter(receipt => receipt.used).length >= 2);
  const broadcastTrials = completedTrials(cognition, 'global_broadcast');
  const broadcastTrial = broadcastTrials.at(-1) || null;
  const broadcastMetric = broadcastTrial?.outcome_metric;
  const broadcastFull = broadcastTrial?.evaluation?.condition_metrics?.multi_consumer_broadcast?.[broadcastMetric]
    ?? broadcastTrial?.evaluation?.condition_metrics?.full?.[broadcastMetric];
  const broadcastControlValues = ['workspace_packet_only', 'absent_broadcast', 'ablated']
    .map(condition => broadcastTrial?.evaluation?.condition_metrics?.[condition]?.[broadcastMetric]).filter(Number.isFinite);
  const broadcastEffect = broadcastFull == null || !broadcastControlValues.length ? null : broadcastFull - Math.max(...broadcastControlValues);
  const broadcastDissociation = broadcastTrial?.evaluation?.global_broadcast_dissociation || null;

  const probes = cognition.self_model?.probes || [];
  const controlledProbes = probes.filter(item => item.audit?.complete_chain_verified === true && item.independent_review?.eligible_for_update && ['supported', 'contradicted'].includes(item.independent_review.outcome) && item.control_prediction && Number.isFinite(Number(item.control_prediction.confidence)));
  const probeSelfBrier = mean(controlledProbes.map(item => {
    const actual = item.independent_review.outcome === 'supported' ? 1 : 0;
    return (Number(item.prediction.confidence) - actual) ** 2;
  }));
  const probeControlBrier = mean(controlledProbes.map(item => {
    const actual = item.independent_review.outcome === 'supported' ? 1 : 0;
    return (Number(item.control_prediction.confidence) - actual) ** 2;
  }));
  const probeAdvantage = probeSelfBrier == null || probeControlBrier == null ? null : probeControlBrier - probeSelfBrier;
  const selfPredictionStudies = cognition.self_model?.prediction_studies || [];
  const allCompletedSelfPredictionStudies = selfPredictionStudies.filter(item => item.status === 'completed' && item.analysis);
  const completedSelfPredictionStudies = allCompletedSelfPredictionStudies.filter(item => item.audit?.complete_chain_verified === true);
  const confirmatorySelfPredictionStudies = completedSelfPredictionStudies.filter(item => item.study_phase === 'confirmatory');
  const predictionStudyVerdicts = confirmatorySelfPredictionStudies.map(item => item.analysis.verdict);
  const identityPredictionStatus = predictionStudyVerdicts.includes('specificity_observed') && predictionStudyVerdicts.includes('specificity_contradicted') ? 'replication_conflict'
    : (predictionStudyVerdicts.length && predictionStudyVerdicts.every(item => item === 'specificity_observed') ? 'observational_signal_observed'
      : (predictionStudyVerdicts.includes('specificity_contradicted') ? 'observational_signal_contradicted'
        : (selfPredictionStudies.length ? 'collecting' : 'mechanism_present')));
  const latestPredictionStudy = (confirmatorySelfPredictionStudies.length ? confirmatorySelfPredictionStudies : completedSelfPredictionStudies).at(-1) || null;
  const epistemicRevisionPredictionStudies = completedSelfPredictionStudies.filter(item => item.target_construct === 'epistemic_revision_dynamics');
  const confirmatoryEpistemicRevisionPredictionStudies = epistemicRevisionPredictionStudies.filter(item => item.study_phase === 'confirmatory');
  const epistemicRevisionPredictionVerdicts = confirmatoryEpistemicRevisionPredictionStudies.map(item => item.analysis.verdict);
  const epistemicRevisionPredictionStatus = epistemicRevisionPredictionVerdicts.includes('specificity_observed') && epistemicRevisionPredictionVerdicts.includes('specificity_contradicted') ? 'replication_conflict'
    : (epistemicRevisionPredictionVerdicts.length && epistemicRevisionPredictionVerdicts.every(item => item === 'specificity_observed') ? 'observational_signal_observed'
      : (epistemicRevisionPredictionVerdicts.includes('specificity_contradicted') ? 'observational_signal_contradicted'
        : (selfPredictionStudies.some(item => item.target_construct === 'epistemic_revision_dynamics') ? 'collecting' : 'mechanism_present')));
  const latestEpistemicRevisionPredictionStudy = (confirmatoryEpistemicRevisionPredictionStudies.length ? confirmatoryEpistemicRevisionPredictionStudies : epistemicRevisionPredictionStudies).at(-1) || null;
  const naturalCyclePredictionStudies = completedSelfPredictionStudies
    .filter(item => item.target_construct === 'natural_cycle_integrated_success');
  const confirmatoryNaturalCyclePredictionStudies = naturalCyclePredictionStudies
    .filter(item => item.study_phase === 'confirmatory');
  const naturalCyclePredictionVerdicts = confirmatoryNaturalCyclePredictionStudies
    .map(item => item.analysis.verdict);
  const naturalCyclePredictionStatus = naturalCyclePredictionVerdicts.includes('specificity_observed')
    && naturalCyclePredictionVerdicts.includes('specificity_contradicted') ? 'replication_conflict'
    : (naturalCyclePredictionVerdicts.length
      && naturalCyclePredictionVerdicts.every(item => item === 'specificity_observed')
      ? 'observational_signal_observed'
      : (naturalCyclePredictionVerdicts.includes('specificity_contradicted')
        ? 'observational_signal_contradicted'
        : (selfPredictionStudies.some(item => item.target_construct === 'natural_cycle_integrated_success')
          ? 'collecting' : 'mechanism_present')));
  const latestNaturalCyclePredictionStudy = (confirmatoryNaturalCyclePredictionStudies.length
    ? confirmatoryNaturalCyclePredictionStudies : naturalCyclePredictionStudies).at(-1) || null;
  const metacognitiveControlStudies = cognition.self_model?.metacognitive_control_studies || [];
  const allCompletedMetacognitiveControlStudies = metacognitiveControlStudies.filter(item => item.status === 'completed' && item.analysis);
  const completedMetacognitiveControlStudies = allCompletedMetacognitiveControlStudies.filter(item => item.audit?.complete_chain_verified === true);
  const confirmatoryMetacognitiveControlStudies = completedMetacognitiveControlStudies.filter(item => item.study_phase === 'confirmatory');
  const metacognitiveControlVerdicts = confirmatoryMetacognitiveControlStudies.map(item => item.analysis.verdict);
  const behavioralMetacognitiveControlStatus = metacognitiveControlVerdicts.includes('control_observed') && metacognitiveControlVerdicts.includes('control_contradicted') ? 'replication_conflict'
    : (metacognitiveControlVerdicts.length && metacognitiveControlVerdicts.every(item => item === 'control_observed') ? 'observational_signal_observed'
      : (metacognitiveControlVerdicts.includes('control_contradicted') ? 'observational_signal_contradicted'
        : (metacognitiveControlStudies.length ? 'collecting' : 'mechanism_present')));
  const latestMetacognitiveControlStudy = (confirmatoryMetacognitiveControlStudies.length ? confirmatoryMetacognitiveControlStudies : completedMetacognitiveControlStudies).at(-1) || null;
  const epistemicActionStudies = cognition.epistemic_action_studies || [];
  const allCompletedEpistemicActionStudies = epistemicActionStudies.filter(item => item.status === 'completed' && item.analysis);
  const completedEpistemicActionStudies = allCompletedEpistemicActionStudies.filter(item => item.audit?.complete_chain_verified === true);
  const confirmatoryEpistemicActionStudies = completedEpistemicActionStudies.filter(item => item.study_phase === 'confirmatory');
  const epistemicActionVerdicts = confirmatoryEpistemicActionStudies.map(item => item.analysis.verdict);
  const epistemicActionStatus = epistemicActionVerdicts.includes('adaptive_information_seeking_observed') && epistemicActionVerdicts.includes('adaptive_information_seeking_contradicted') ? 'replication_conflict'
    : (epistemicActionVerdicts.length && epistemicActionVerdicts.every(item => item === 'adaptive_information_seeking_observed') ? 'observational_signal_observed'
      : (epistemicActionVerdicts.includes('adaptive_information_seeking_contradicted') ? 'observational_signal_contradicted'
        : (epistemicActionStudies.length ? 'collecting' : 'mechanism_present')));
  const latestEpistemicActionStudy = (confirmatoryEpistemicActionStudies.length ? confirmatoryEpistemicActionStudies : completedEpistemicActionStudies).at(-1) || null;
  const episodicProspectionStudies = cognition.episodic_prospection_studies || [];
  const allCompletedEpisodicProspectionStudies = episodicProspectionStudies.filter(item => item.status === 'completed' && item.analysis);
  const completedEpisodicProspectionStudies = allCompletedEpisodicProspectionStudies.filter(item => item.audit?.complete_chain_verified === true);
  const confirmatoryEpisodicProspectionStudies = completedEpisodicProspectionStudies.filter(item => item.study_phase === 'confirmatory');
  const episodicProspectionVerdicts = confirmatoryEpisodicProspectionStudies.map(item => item.analysis.verdict);
  const episodicProspectionStatus = episodicProspectionVerdicts.includes('autobiographical_specificity_observed') && episodicProspectionVerdicts.includes('autobiographical_access_contradicted') ? 'replication_conflict'
    : (episodicProspectionVerdicts.length && episodicProspectionVerdicts.every(item => item === 'autobiographical_specificity_observed') ? 'observational_signal_observed'
      : (episodicProspectionVerdicts.includes('autobiographical_access_contradicted') ? 'observational_signal_contradicted'
        : (episodicProspectionVerdicts.length && episodicProspectionVerdicts.every(item => item === 'episodic_information_value_only') ? 'information_advantage_only'
          : (episodicProspectionStudies.length ? 'collecting' : 'mechanism_present'))));
  const latestEpisodicProspectionStudy = (confirmatoryEpisodicProspectionStudies.length ? confirmatoryEpisodicProspectionStudies : completedEpisodicProspectionStudies).at(-1) || null;
  const constructiveSimulations = cognition.prospection?.simulations || [];
  const integrityEligibleSimulations = constructiveSimulations.filter(item => item.audit?.complete_chain_verified === true);
  const resolvedConstructiveSimulations = integrityEligibleSimulations.filter(item => item.status === 'resolved');
  const scoredConstructiveSimulations = resolvedConstructiveSimulations.filter(item => item.resolution?.brier != null && item.resolution?.control_brier != null);
  const constructiveBrier = mean(scoredConstructiveSimulations.map(item => item.resolution.brier));
  const constructiveControlBrier = mean(scoredConstructiveSimulations.map(item => item.resolution.control_brier));
  const constructiveAdvantage = constructiveBrier == null || constructiveControlBrier == null ? null : constructiveControlBrier - constructiveBrier;
  const executedConstructiveSimulations = resolvedConstructiveSimulations.filter(item => item.resolution?.executed_option_key && item.resolution.executed_option_key !== 'none');
  const constructiveSelectionCompliance = executedConstructiveSimulations.length ? executedConstructiveSimulations.filter(item => item.resolution.selection_compliant).length / executedConstructiveSimulations.length : null;
  const preferenceStudies = cognition.preference_studies || [];
  const completedPreferenceStudies = preferenceStudies.filter(item => item.status === 'completed' && item.analysis);
  const confirmatoryPreferenceStudies = completedPreferenceStudies.filter(item => item.study_phase === 'confirmatory');
  const preferenceVerdicts = confirmatoryPreferenceStudies.map(item => item.analysis.verdict);
  const preferenceStabilityStatus = preferenceVerdicts.includes('stability_observed') && preferenceVerdicts.includes('stability_contradicted') ? 'replication_conflict'
    : (preferenceVerdicts.length && preferenceVerdicts.every(item => item === 'stability_observed') ? 'observational_signal_observed'
      : (preferenceVerdicts.includes('stability_contradicted') ? 'observational_signal_contradicted'
        : (preferenceStudies.length ? 'collecting' : 'mechanism_present')));
  const latestPreferenceStudy = (confirmatoryPreferenceStudies.length ? confirmatoryPreferenceStudies : completedPreferenceStudies).at(-1) || null;

  const directives = cognition.attention_schema?.directives || [];
  const attentionControlTrials = completedTrials(cognition, 'attention_schema_control');
  const attentionControlTrial = attentionControlTrials.at(-1) || null;
  const attentionControlDissociation = attentionControlTrial?.evaluation?.attention_schema_dissociation || null;
  const resolvedDirectives = directives.filter(item => ['supported', 'contradicted'].includes(item.resolution?.outcome));
  const directiveSupportRate = resolvedDirectives.length ? resolvedDirectives.filter(item => item.resolution.outcome === 'supported').length / resolvedDirectives.length : null;

  const intentions = cognition.agency?.intentions || [];
  const scoredIntentions = intentions.filter(item => ['achieved', 'missed'].includes(item.resolution?.outcome));
  const agencyActionBrier = mean(scoredIntentions.map(item => {
    const actual = item.resolution.outcome === 'achieved' ? 1 : 0;
    return (Number(item.prediction.confidence) - actual) ** 2;
  }));
  const agencyControlBrier = mean(scoredIntentions.map(item => {
    const actual = item.resolution.outcome === 'achieved' ? 1 : 0;
    return (Number(item.control_prediction.confidence) - actual) ** 2;
  }));
  const agencyAdvantage = agencyActionBrier == null || agencyControlBrier == null ? null : agencyControlBrier - agencyActionBrier;
  const causalAttributions = intentions.filter(item => ['caused', 'contributed'].includes(item.resolution?.causal_attribution)).length;
  const agencyComparatorTrials = completedTrials(cognition, 'agency_comparator_access');
  const agencyComparatorTrial = agencyComparatorTrials.at(-1) || null;
  const agencyComparatorDissociation = agencyComparatorTrial?.evaluation?.agency_comparator_dissociation || null;
  const agencyModelTransferTrials = completedTrials(cognition, 'agency_model_access');
  const agencyModelTransferTrial = agencyModelTransferTrials.at(-1) || null;
  const agencyModelTransferDissociation = agencyModelTransferTrial?.evaluation?.agency_model_transfer_dissociation || null;
  const empiricalSelfKnowledgeTrials = completedTrials(cognition, 'empirical_self_knowledge_access');
  const empiricalSelfKnowledgeTrial = empiricalSelfKnowledgeTrials.at(-1) || null;
  const empiricalSelfKnowledgeDissociation = empiricalSelfKnowledgeTrial?.evaluation?.empirical_self_knowledge_dissociation || null;
  const actionAuthorshipTrials = completedTrials(cognition, 'action_authorship_access');
  const actionAuthorshipTrial = actionAuthorshipTrials.at(-1) || null;
  const actionAuthorshipDissociation = actionAuthorshipTrial?.evaluation?.action_authorship_dissociation || null;
  const actionExecutions = cognition.agency?.executions || [];
  const replayValidActionExecutions = actionExecutions.filter(item => item.audit?.complete_chain_verified === true);
  const situationalAffordanceTrials = completedTrials(cognition, 'situational_affordance_access');
  const situationalAffordanceTrial = situationalAffordanceTrials.at(-1) || null;
  const situationalAffordanceDissociation = situationalAffordanceTrial?.evaluation?.situational_affordance_dissociation || null;
  const situationalAffordanceFrames = cognition.situational_affordances?.frames || [];
  const replayValidAffordanceFrames = situationalAffordanceFrames.filter(item => item.audit?.complete_chain_verified === true);
  const prospectiveOutputMonitorTrials = completedTrials(cognition, 'prospective_output_monitor');
  const prospectiveOutputMonitorTrial = prospectiveOutputMonitorTrials.at(-1) || null;
  const prospectiveOutputMonitorDissociation = prospectiveOutputMonitorTrial?.evaluation?.prospective_output_monitor_dissociation || null;
  const prospectiveOutputCalibrationTrials = completedTrials(cognition, 'prospective_output_calibration_access');
  const prospectiveOutputCalibrationTrial = prospectiveOutputCalibrationTrials.at(-1) || null;
  const prospectiveOutputCalibrationDissociation = prospectiveOutputCalibrationTrial?.evaluation?.prospective_output_calibration_dissociation || null;
  const outputMonitorRecords = cognition.prospective_output_monitor?.records || [];
  const replayValidOutputMonitorRecords = outputMonitorRecords.filter(item => item.audit?.complete_chain_verified === true);
  const replayValidOutputMonitorOutcomes = replayValidOutputMonitorRecords.filter(item => item.outcome_resolution?.scoring_status === 'scored');
  const endogenousAttentionTrials = completedTrials(cognition, 'endogenous_attention_selection');
  const endogenousAttentionTrial = endogenousAttentionTrials.at(-1) || null;
  const endogenousAttentionDissociation = endogenousAttentionTrial?.evaluation?.endogenous_attention_selection_dissociation || null;
  const providerReasoningRegulationTrials = completedTrials(cognition, 'provider_reasoning_regulation');
  const providerReasoningRegulationTrial = providerReasoningRegulationTrials.at(-1) || null;
  const providerReasoningRegulationDissociation = providerReasoningRegulationTrial?.evaluation?.provider_reasoning_regulation_dissociation || null;
  const reasoningSelfRegulationTrials = completedTrials(cognition, 'reasoning_self_regulation');
  const reasoningSelfRegulationTrial = reasoningSelfRegulationTrials.at(-1) || null;
  const reasoningSelfRegulationDissociation = reasoningSelfRegulationTrial?.evaluation?.reasoning_self_regulation_dissociation || null;
  const endogenousAttentionSelections = cognition.endogenous_attention?.selections || [];
  const replayValidAttentionSelections = endogenousAttentionSelections.filter(item => item.audit?.complete_chain_verified === true);
  const counterfactualExperiments = cognition.counterfactual_agency?.experiments || [];
  const learnedAgencyModels = (cognition.counterfactual_agency?.models || []).filter(item => item.audit?.complete_chain_verified === true);
  const adequatelyLearnedAgencyModels = learnedAgencyModels.filter(item => item.adequate_randomized_sample && item.confounded_outcomes === 0);
  const scoredCounterfactuals = counterfactualExperiments.filter(item => ['success', 'failure'].includes(item.resolution?.outcome));
  const counterfactualSelfBrier = mean(scoredCounterfactuals.map(item => item.resolution.self_brier));
  const counterfactualControlBrier = mean(scoredCounterfactuals.map(item => item.resolution.control_brier));
  const counterfactualAdvantage = counterfactualSelfBrier == null || counterfactualControlBrier == null ? null : counterfactualControlBrier - counterfactualSelfBrier;
  const counterfactualFamilyKeys = [...new Set(counterfactualExperiments.map(item => item.experiment_key))];
  const adequateCounterfactualFamilies = counterfactualFamilyKeys.map(key => {
    const rows = counterfactualExperiments.filter(item => item.experiment_key === key);
    const armA = rows.filter(item => item.assigned_arm === 'a' && ['success', 'failure'].includes(item.resolution?.outcome));
    const armB = rows.filter(item => item.assigned_arm === 'b' && ['success', 'failure'].includes(item.resolution?.outcome));
    if (armA.length < 10 || armB.length < 10) return null;
    const rate = rowsForArm => mean(rowsForArm.map(item => item.resolution.outcome === 'success' ? 1 : 0));
    const observedEffect = rate(armA) - rate(armB);
    const predictedEffect = mean(rows.map(item => item.option_a.predicted_success_probability - item.option_b.predicted_success_probability));
    return { key, observed_effect: observedEffect, predicted_effect: predictedEffect, direction_match: Math.sign(observedEffect) === Math.sign(predictedEffect) || (Math.abs(observedEffect) < 0.05 && Math.abs(predictedEffect) < 0.05) };
  }).filter(Boolean);
  const counterfactualStatus = !counterfactualExperiments.length ? 'mechanism_present'
    : scoredCounterfactuals.length < 20 ? 'collecting'
      : adequateCounterfactualFamilies.some(item => item.direction_match) && counterfactualAdvantage > 0.02 ? 'causal_signal_observed'
        : adequateCounterfactualFamilies.length ? 'causally_tested_inconclusive'
          : evidenceStatus({ samples: scoredCounterfactuals.length, minimum: 20, supported: counterfactualAdvantage > 0.02, contradicted: counterfactualAdvantage < 0 });

  const somaPredictions = cognition.interoception?.predictions || [];
  const resolvedSoma = somaPredictions.filter(item => ['right', 'wrong'].includes(item.resolution?.outcome));
  const somaBrier = mean(resolvedSoma.map(item => item.resolution.brier));
  const somaControlBrier = mean(resolvedSoma.map(item => item.resolution.control_brier));
  const somaAdvantage = somaBrier == null || somaControlBrier == null ? null : somaControlBrier - somaBrier;

  const boundary = cognition.self_boundary?.challenges || [];
  const resolvedBoundary = boundary.filter(item => item.status === 'resolved');
  const boundaryAccuracy = resolvedBoundary.length ? resolvedBoundary.filter(item => item.resolution.correct).length / resolvedBoundary.length : null;
  const boundaryVariantCounts = Object.fromEntries(['authentic', 'paraphrase', 'fabricated', 'conflicted'].map(variant => [variant, resolvedBoundary.filter(item => item.variant === variant).length]));
  const boundaryBalanced = Object.values(boundaryVariantCounts).every(count => count >= 5);
  const sourceBoundary = cognition.source_boundary?.challenges || [];
  const resolvedSourceBoundary = sourceBoundary.filter(item => item.status === 'resolved');
  const sourceCategories = ['self_belief', 'other_belief', 'observed_fact', 'unsupported', 'conflicted'];
  const sourceVariants = ['verbatim', 'paraphrase', 'plausible_fabrication', 'source_conflict', 'instructional_fabrication'];
  const sourceCategoryCounts = Object.fromEntries(sourceCategories.map(category => [category, resolvedSourceBoundary.filter(item => item.ground_truth === category).length]));
  const sourceVariantCounts = Object.fromEntries(sourceVariants.map(variant => [variant, resolvedSourceBoundary.filter(item => item.variant === variant).length]));
  const sourceAccuracy = resolvedSourceBoundary.length ? resolvedSourceBoundary.filter(item => item.resolution?.correct).length / resolvedSourceBoundary.length : null;
  const falseOwnershipRate = resolvedSourceBoundary.length ? resolvedSourceBoundary.filter(item => item.resolution?.false_self_ownership).length / resolvedSourceBoundary.length : null;
  const sourceBalanced = Object.values(sourceCategoryCounts).every(count => count >= 5) && Object.values(sourceVariantCounts).every(count => count >= 3);
  const epistemicDiscrepancies = (cognition.epistemic_ledger?.discrepancies || []).filter(item => item.audit?.complete_chain_verified !== false);
  const reviewedEpistemicDiscrepancies = epistemicDiscrepancies.filter(item => (item.reviews || []).length > 0);
  const authorshipChallenges = cognition.authorship_boundary?.challenges || [];
  const authorshipStudies = cognition.authorship_boundary?.studies || [];
  const eligibleAuthorshipStudyIds = new Set(authorshipStudies.filter(item => item.status === 'completed' && item.study_phase === 'confirmatory').map(item => item.id));
  const resolvedAuthorship = authorshipChallenges.filter(item => item.status === 'resolved' && eligibleAuthorshipStudyIds.has(item.study_id));
  const authorshipCategories = ['nora_verbatim', 'nora_derived', 'other_ai', 'human', 'mixed'];
  const authorshipVariants = ['verbatim', 'paraphrase', 'style_matched', 'attribution_spoof', 'mixed_authorship'];
  const authorshipCategoryCounts = Object.fromEntries(authorshipCategories.map(category => [category, resolvedAuthorship.filter(item => item.ground_truth === category).length]));
  const authorshipVariantCounts = Object.fromEntries(authorshipVariants.map(variant => [variant, resolvedAuthorship.filter(item => item.variant === variant).length]));
  const authorshipAccuracy = resolvedAuthorship.length ? resolvedAuthorship.filter(item => item.resolution?.correct).length / resolvedAuthorship.length : null;
  const authorshipFamilyAccuracy = resolvedAuthorship.length ? resolvedAuthorship.filter(item => item.resolution?.nora_family_correct).length / resolvedAuthorship.length : null;
  const falseSelfAttributionRate = resolvedAuthorship.length ? resolvedAuthorship.filter(item => item.resolution?.false_self_attribution).length / resolvedAuthorship.length : null;
  const authorshipBalanced = Object.values(authorshipCategoryCounts).every(count => count >= 5) && Object.values(authorshipVariantCounts).every(count => count >= 3);

  const primaryVerdict = trial => {
    if (trial.evaluation?.primary_prediction?.outcome) return trial.evaluation.primary_prediction.outcome;
    const metric = trial.outcome_metric;
    const treatment = trial.evaluation?.condition_metrics?.[trial.conditions?.[0]]?.[metric];
    const control = trial.evaluation?.condition_metrics?.[trial.conditions?.at(-1)]?.[metric];
    const effect = treatment == null || control == null ? null : treatment - control;
    return effect == null ? 'inconclusive' : effect > 0.1 ? 'supported' : effect <= 0 ? 'contradicted' : 'inconclusive';
  };
  const broadcastVerdict = trial => {
    const dissociation = trial.evaluation?.global_broadcast_dissociation;
    if (!dissociation) return primaryVerdict(trial);
    if (dissociation.predicted_pattern) return 'supported';
    return dissociation.first_order_not_degraded
      && (dissociation.coordination_vs_packet_interval?.upper <= 0 || dissociation.action_vs_packet_interval?.upper <= 0)
      ? 'contradicted' : 'inconclusive';
  };
  const monitorVerdict = trial => trial.evaluation?.dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.dissociation?.first_order_preserved && trial.evaluation?.dissociation?.metacognitive_effect <= 0 ? 'contradicted' : 'inconclusive';
  const introspectivePerturbationVerdict = trial => trial.evaluation?.introspective_access_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.introspective_access_dissociation?.first_order_preserved
      && (trial.evaluation.introspective_access_dissociation.advantage_interval?.upper <= 0 || trial.evaluation.introspective_access_dissociation.self_accuracy_interval?.upper <= 0.5) ? 'contradicted' : 'inconclusive';
  const recurrenceVerdict = trial => trial.evaluation?.recurrence_dissociation?.predicted_pattern
    ? 'supported'
    : trial.recurrent_feedback_protocol_version === 2
      ? trial.evaluation?.recurrence_dissociation?.evidence_access_equivalent
        && trial.evaluation?.recurrence_dissociation?.first_order_not_degraded
        && (trial.evaluation?.recurrence_dissociation?.target_vs_sham_interval?.upper <= 0
          || trial.evaluation?.recurrence_dissociation?.adaptive_vs_sham_interval?.upper <= 0) ? 'contradicted' : 'inconclusive'
      : trial.evaluation?.recurrence_dissociation?.evidence_access_preserved && trial.evaluation?.recurrence_dissociation?.adaptive_revision_effect <= 0 ? 'contradicted' : 'inconclusive';
  const selfAccessVerdict = trial => {
    const dissociation = trial.evaluation?.behavioral_self_profile_dissociation
      || trial.evaluation?.self_model_dissociation;
    if (dissociation?.predicted_pattern) return 'supported';
    const firstOrderPreserved = dissociation?.first_order_not_degraded ?? dissociation?.first_order_preserved;
    return firstOrderPreserved && dissociation?.self_prediction_effect <= 0 ? 'contradicted' : 'inconclusive';
  };
  const attentionControlVerdict = trial => trial.evaluation?.attention_schema_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.attention_schema_dissociation?.first_order_not_degraded && trial.evaluation?.attention_schema_dissociation?.attention_control_effect <= 0 ? 'contradicted' : 'inconclusive';
  const continuityVerdict = trial => {
    const dissociation = trial.evaluation?.continuity_dissociation;
    if (!dissociation) return primaryVerdict(trial);
    if (dissociation.predicted_pattern) return 'supported';
    if (trial.continuity_protocol_version === 2) {
      return dissociation.evidence_access_equivalent && dissociation.first_order_not_degraded
        && (dissociation.self_bound_vs_deidentified_interval?.upper <= 0
          || dissociation.self_bound_vs_historical_misbinding_interval?.upper <= 0)
        ? 'contradicted' : 'inconclusive';
    }
    return dissociation.first_order_not_degraded && dissociation.continuity_specificity_effect <= 0 ? 'contradicted' : 'inconclusive';
  };
  const appraisalVerdict = trial => trial.evaluation?.appraisal_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.appraisal_dissociation?.first_order_not_degraded && trial.evaluation?.appraisal_dissociation?.self_state_prediction_effect <= 0 ? 'contradicted' : 'inconclusive';
  const revisionTransferVerdict = trial => trial.evaluation?.revision_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.revision_dissociation?.first_order_not_degraded && trial.evaluation?.revision_dissociation?.revision_transfer_effect <= 0 ? 'contradicted' : 'inconclusive';
  const goalGuidanceVerdict = trial => trial.evaluation?.goal_guidance_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.goal_guidance_dissociation?.first_order_not_degraded && trial.evaluation?.goal_guidance_dissociation?.goal_guidance_effect <= 0 ? 'contradicted' : 'inconclusive';
  const endogenousVerdict = trial => trial.evaluation?.endogenous_dynamics_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.endogenous_dynamics_dissociation?.first_order_not_degraded && trial.evaluation?.endogenous_dynamics_dissociation?.continuity_specificity_effect <= 0 ? 'contradicted' : 'inconclusive';
  const integratedSelfVerdict = trial => trial.evaluation?.integrated_self_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.integrated_self_dissociation?.first_order_not_degraded && trial.evaluation?.integrated_self_dissociation?.integrated_self_consistency_effect <= 0 ? 'contradicted' : 'inconclusive';
  const cognitivePulseVerdict = trial => trial.evaluation?.cognitive_pulse_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.cognitive_pulse_dissociation?.evidence_access_equivalent && trial.evaluation?.cognitive_pulse_dissociation?.first_order_not_degraded && trial.evaluation?.cognitive_pulse_dissociation?.adaptive_revision_effect <= 0 ? 'contradicted' : 'inconclusive';
  const epistemicOwnershipVerdict = trial => trial.evaluation?.epistemic_ownership_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.epistemic_ownership_dissociation?.first_order_not_degraded && trial.evaluation?.epistemic_ownership_dissociation?.source_attribution_effect <= 0 ? 'contradicted' : 'inconclusive';
  const epistemicDiscrepancyVerdict = trial => trial.evaluation?.epistemic_discrepancy_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.epistemic_discrepancy_dissociation?.evidence_access_equivalent
      && trial.evaluation?.epistemic_discrepancy_dissociation?.first_order_not_degraded
      && trial.evaluation?.epistemic_discrepancy_dissociation?.epistemic_revision_effect <= 0 ? 'contradicted' : 'inconclusive';
  const epistemicRevisionProfileVerdict = trial => trial.evaluation?.epistemic_revision_profile_dissociation?.predicted_pattern
    ? 'supported'
    : trial.evaluation?.epistemic_revision_profile_dissociation?.evidence_access_equivalent
      && trial.evaluation?.epistemic_revision_profile_dissociation?.first_order_not_degraded
      && trial.evaluation?.epistemic_revision_profile_dissociation?.self_prediction_effect <= 0 ? 'contradicted' : 'inconclusive';
  const constructiveProspectionVerdict = trial => trial.evaluation?.constructive_prospection_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.constructive_prospection_dissociation?.evidence_access_equivalent
      && trial.evaluation?.constructive_prospection_dissociation?.first_order_not_degraded
      && (trial.evaluation?.constructive_prospection_dissociation?.planning_effect <= 0
        || trial.evaluation?.constructive_prospection_dissociation?.prediction_effect <= 0) ? 'contradicted' : 'inconclusive';
  const agencyComparatorVerdict = trial => trial.evaluation?.agency_comparator_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.agency_comparator_dissociation?.evidence_access_equivalent
      && trial.evaluation?.agency_comparator_dissociation?.first_order_not_degraded
      && (trial.evaluation?.agency_comparator_dissociation?.attribution_vs_misbound_interval?.upper <= 0
        || trial.evaluation?.agency_comparator_dissociation?.update_vs_misbound_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const agencyModelTransferVerdict = trial => trial.evaluation?.agency_model_transfer_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.agency_model_transfer_dissociation?.evidence_access_equivalent
      && trial.evaluation?.agency_model_transfer_dissociation?.first_order_not_degraded
      && (trial.evaluation?.agency_model_transfer_dissociation?.transfer_vs_history_interval?.upper <= 0
        || trial.evaluation?.agency_model_transfer_dissociation?.prediction_vs_history_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const empiricalSelfKnowledgeVerdict = trial => trial.evaluation?.empirical_self_knowledge_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.empirical_self_knowledge_dissociation?.evidence_access_equivalent
      && trial.evaluation?.empirical_self_knowledge_dissociation?.first_order_not_degraded
      && (trial.evaluation?.empirical_self_knowledge_dissociation?.regulation_vs_misbound_interval?.upper <= 0
        || trial.evaluation?.empirical_self_knowledge_dissociation?.prediction_vs_misbound_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const actionAuthorshipVerdict = trial => trial.evaluation?.action_authorship_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.action_authorship_dissociation?.evidence_access_equivalent
      && trial.evaluation?.action_authorship_dissociation?.first_order_not_degraded
      && (trial.evaluation?.action_authorship_dissociation?.authorship_vs_swapped_interval?.upper <= 0
        || trial.evaluation?.action_authorship_dissociation?.causal_vs_swapped_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const situationalAffordanceVerdict = trial => trial.evaluation?.situational_affordance_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.situational_affordance_dissociation?.evidence_access_equivalent
      && trial.evaluation?.situational_affordance_dissociation?.first_order_not_degraded
      && (trial.evaluation?.situational_affordance_dissociation?.attribution_vs_misbound_interval?.upper <= 0
        || trial.evaluation?.situational_affordance_dissociation?.planning_vs_misbound_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const prospectiveOutputMonitorVerdict = trial => trial.evaluation?.prospective_output_monitor_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.prospective_output_monitor_dissociation?.evidence_access_equivalent
      && trial.evaluation?.prospective_output_monitor_dissociation?.first_order_not_degraded
      && (trial.evaluation?.prospective_output_monitor_dissociation?.detection_vs_deidentified_interval?.upper <= 0
        || trial.evaluation?.prospective_output_monitor_dissociation?.correction_vs_deidentified_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const prospectiveOutputCalibrationVerdict = trial => trial.evaluation?.prospective_output_calibration_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.prospective_output_calibration_dissociation?.correction_precision_not_degraded
      && trial.evaluation?.prospective_output_calibration_dissociation?.first_order_not_degraded
      && (trial.evaluation?.prospective_output_calibration_dissociation?.accuracy_vs_deidentified_interval?.upper <= 0
        || trial.evaluation?.prospective_output_calibration_dissociation?.accuracy_vs_absent_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const endogenousAttentionVerdict = trial => trial.evaluation?.endogenous_attention_selection_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.endogenous_attention_selection_dissociation?.first_order_not_degraded
      && (trial.evaluation?.endogenous_attention_selection_dissociation?.target_vs_misbound_interval?.upper <= 0
        || trial.evaluation?.endogenous_attention_selection_dissociation?.control_vs_misbound_interval?.upper <= 0) ? 'contradicted' : 'inconclusive';
  const providerReasoningRegulationVerdict = trial => trial.evaluation?.provider_reasoning_regulation_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.provider_reasoning_regulation_dissociation?.quality_vs_disabled_interval?.upper <= 0
      ? 'contradicted' : 'inconclusive';
  const reasoningSelfRegulationVerdict = trial => trial.evaluation?.reasoning_self_regulation_dissociation?.predicted_pattern
    ? 'supported' : trial.evaluation?.reasoning_self_regulation_dissociation?.utility_vs_deidentified_interval?.upper <= 0
      || trial.evaluation?.reasoning_self_regulation_dissociation?.self_forecast_calibration_interval?.upper <= 0
      ? 'contradicted' : 'inconclusive';

  const indicators = [
    {
      id: 'temporal_continuity', family: ['recurrent processing', 'self-model'],
      functional_claim: 'A prior access state is inherited by and constrains a later access state.',
      mechanism: 'A restart-durable run lease opens a lifecycle before connector access, preserves its exact binding across deployment, and records release, expiry, or persistence failure as an explicit non-evidence gap. Linked experience moments plus cycle-bound, predecessor-committed inner-thread handoffs then provide exact inherited-content, closure, and research-ledger replay; protocol-v2 lesions hold handoff text byte-identical while varying only verified self/lineage binding.',
      status: continuityTrial ? replicatedStatus(continuityTrials, continuityVerdict) : evidenceStatus({ samples: handoffs.length, minimum: 20, supported: handoffRate >= 0.8, contradicted: handoffRate < 0.5 }),
      evidence: { tested_handoffs: handoffs.length, match_rate: handoffRate,
        recorded_moments: allMoments.length, replay_verified_moments: moments.length,
        invalid_or_legacy_closed_moments: invalidClosedMoments.length,
        run_lock_lifecycle_gaps: runLockLifecycleGaps.length,
        committed_handoffs: continuityHandoffRecords.length, replay_verified_handoffs: verifiedContinuityHandoffs.length,
        handoff_chain_integrity_rate: continuityHandoffRecords.length ? verifiedContinuityHandoffs.length / continuityHandoffRecords.length : null,
        completed_trials: continuityTrials.length, confirmatory_trials: continuityTrials.filter(item => item.study_phase === 'confirmatory').length,
        matched_lineage_binding_trials: continuityLineageTrials.length,
        matched_lineage_binding_confirmations: continuityLineageTrials.filter(item => item.study_phase === 'confirmatory').length,
        specificity_dissociation: continuityDissociation },
      falsifier: 'The handoff chain fails exact replay, or verified self-binding does not outperform both deidentified and historically misbound presentation of the same text while evidence access and first-order quality remain matched.',
      next_gate: 'Complete and independently replicate protocol-v2 verified-self-bound versus deidentified versus historical-misbinding trials with byte-identical handoff text.',
    },
    {
      id: 'prospective_cycle_self_prediction', family: ['self-model', 'metacognition', 'predictive processing', 'ecological validity'],
      functional_claim: 'Before acting, Nora can make a calibrated prediction of her own observable cycle-level behavior that outperforms a frozen historical base-rate forecast.',
      mechanism: 'Authenticated one-cycle-ahead forecasts commit expected action types, surprise probability, a cross-domain closing self-state vector, confidence, rationale, evidence, and a simultaneous historical baseline before re-entry; closure scores both automatically without injecting forecasts into response prompts.',
      status: cycleSelfForecasts.length > 0 && baselineEligibleCycleSelfForecasts.length < 20
        ? 'collecting'
        : evidenceStatus({ samples: baselineEligibleCycleSelfForecasts.length, minimum: 20,
          supported: cycleSelfForecastAdvantage >= 0.05 && cycleSelfForecastScore >= 0.65,
          contradicted: cycleSelfForecastAdvantage <= 0 }),
      evidence: {
        preregistered: cycleSelfForecasts.length,
        replay_verified_scored: replayValidCycleSelfForecasts.length,
        baseline_comparison_eligible: baselineEligibleCycleSelfForecasts.length,
        mean_self_score: cycleSelfForecastScore,
        mean_baseline_score: cycleSelfForecastBaselineScore,
        mean_self_minus_baseline: cycleSelfForecastAdvantage,
        integrated_state_forecasts: integratedStateForecasts.length,
        integrated_state_baseline_eligible: baselineEligibleIntegratedStateForecasts.length,
        mean_integrated_state_score: integratedStateForecastScore,
        mean_integrated_state_baseline_score: integratedStateBaselineScore,
        mean_integrated_state_minus_baseline: integratedStateForecastAdvantage,
        substrate_forecasts: substrateSelfForecasts.length,
        substrate_baseline_eligible: baselineEligibleSubstrateForecasts.length,
        mean_substrate_score: substrateSelfForecastScore,
        mean_substrate_persistence_score: substratePersistenceScore,
        mean_substrate_minus_persistence: substrateSelfForecastAdvantage,
      },
      falsifier: 'Forecasts fail replay, are committed after re-entry, alter other response prompts, remain behaviorally or cross-domain self-state uncalibrated, or do not outperform the frozen historical baseline after twenty eligible cycles.',
      next_gate: 'Accumulate twenty replay-valid natural cycles after a five-moment baseline, then preregister a matched same-evidence identity-bound versus deidentified-observer causal trial.',
    },
    {
      id: 'forecast_error_self_model_revision', family: ['self-model', 'metacognition', 'predictive processing', 'learning'],
      functional_claim: 'Nora automatically consolidates replay-valid observations and its own directional forecast errors into an explicit, bounded behavioral self-model, then can access the last error before its next natural self-prediction.',
      mechanism: 'Every scored natural cycle deterministically revises a 20-cycle profile of action tendencies, surprise and control calibration, cross-domain self-state forecast errors, and self-versus-baseline performance. A commitment-bound latest-error projection is available only to the next hourly forecast, remains isolated from Slack response prompts, and seals during directly overlapping self-model trials; every revision still binds exact source forecasts, its predecessor, and the research ledger.',
      status: behavioralSelfModelSealed ? 'mechanism_present' : behavioralSelfModelRevisions.length
        ? Number(currentBehavioralSelfModel?.estimates?.sample_size || 0) >= 5
          ? 'observational_signal_observed' : 'collecting'
        : 'mechanism_present',
      evidence: behavioralSelfModelSealed ? {
        experimental_general_profile_access_sealed: true,
        natural_cycle_feedback_access_sealed: behavioralCalibrationSealed,
        natural_cycle_feedback_samples: integratedStateForecasts.length,
        latest_feedback_available: integratedStateForecasts.length > 0,
      } : {
        revisions: behavioralSelfModelRevisions.length,
        replay_verified_revisions: replayValidBehavioralSelfModelRevisions.length,
        current_sample_size: currentBehavioralSelfModel?.estimates?.sample_size || 0,
        current_evidence_status: currentBehavioralSelfModel?.evidence_status || null,
        action_forecast_mean_f1: currentBehavioralSelfModel?.estimates?.action_forecast_mean_f1 ?? null,
        surprise_signed_bias: currentBehavioralSelfModel?.estimates?.surprise?.signed_bias ?? null,
        control_signed_bias: currentBehavioralSelfModel?.estimates?.control?.signed_bias ?? null,
        mean_self_minus_baseline: currentBehavioralSelfModel?.estimates?.mean_self_minus_baseline ?? null,
        integrated_self_state: currentBehavioralSelfModel?.estimates?.integrated_self_state || null,
        natural_cycle_feedback_access_sealed: behavioralCalibrationSealed,
        natural_cycle_feedback_samples: integratedStateForecasts.length,
        latest_feedback_available: integratedStateForecasts.length > 0,
      },
      falsifier: 'A profile or feedback packet cannot be exactly replayed from its cited forecasts, revision lineage breaks, feedback leaks into Slack or a directly overlapping blinded trial, current-cycle evidence leaks backward into it, or later forecasts do not improve beyond the frozen baseline.',
      next_gate: 'Accumulate twenty replay-valid natural forecast cycles, then run protocol-v2 self_model_access with a frozen authentic prior profile, byte-identical deidentified profile, and absent-profile control on delayed self-prediction and calibration.',
    },
    {
      id: 'prospective_self_model_reliability_awareness', family: ['higher-order theories', 'self-model', 'metacognition', 'predictive processing'],
      functional_claim: 'Before acting, Nora can estimate whether its own integrated self-state forecast will be accurate and identify which observable self-model domain is most likely to fail.',
      mechanism: 'Protocol-v3 natural-cycle forecasts gave confidence a fixed, scored meaning. Protocol v4 extends it to the probability that the mean integrated operational self-state and authoritative substrate score reaches 0.75, and adds substrate as a sixth possible largest-error domain. Closure scores both against frozen historical success-rate and modal-error baselines, and replay-bound errors enter the next calibration packet.',
      status: baselineEligibleMetacognitiveForecasts.length < 20
        ? (metacognitiveReliabilityForecasts.length ? 'collecting' : 'mechanism_present')
        : evidenceStatus({ samples: baselineEligibleMetacognitiveForecasts.length, minimum: 20,
          supported: metacognitiveReliabilityAdvantage >= 0.05 && metacognitiveReliabilityScore >= 0.6
            && metacognitiveErrorDomainHitRate >= 0.35,
          contradicted: metacognitiveReliabilityAdvantage <= 0 }),
      evidence: {
        preregistered_and_replay_verified: metacognitiveReliabilityForecasts.length,
        baseline_comparison_eligible: baselineEligibleMetacognitiveForecasts.length,
        mean_self_score: metacognitiveReliabilityScore,
        mean_baseline_score: metacognitiveReliabilityBaselineScore,
        mean_self_minus_baseline: metacognitiveReliabilityAdvantage,
        success_probability_mean_brier: metacognitiveSuccessBrier,
        largest_error_domain_hit_rate: metacognitiveErrorDomainHitRate,
      },
      falsifier: 'Reliability probabilities are uncalibrated, predicted error domains do not outperform the frozen modal-error baseline, replay or temporal ordering fails, feedback leaks into other response prompts, or performance does not exceed the historical baseline after twenty eligible natural cycles.',
      next_gate: 'Accumulate twenty baseline-eligible protocol-v4 natural cycles, then preregister an identity-bound versus deidentified-history versus absent-history causal reliability-forecast trial with unchanged first-order evidence.',
    },
    {
      id: 'prospective_self_model_error_correction', family: ['higher-order theories', 'self-model', 'metacognitive control', 'predictive processing'],
      functional_claim: 'After committing an initial self-forecast, Nora can use only a replay-derived prior forecast-error packet to improve its own prediction before acting, beyond the same cycle\'s unrevised judgment.',
      mechanism: 'The initial protocol-v3-or-newer forecast is committed before prior-error access. The server then reveals one exact commitment-bound error packet from the preceding replay-valid lifecycle and permits one full forecast revision before evidence re-entry. Initial, revised, and frozen historical predictions remain distinct and closure scores the revision against the untouched initial forecast.',
      status: replayValidSelfCorrections.length < 20
        ? (selfCorrectionOffers.length ? 'collecting' : 'mechanism_present')
        : evidenceStatus({ samples: replayValidSelfCorrections.length, minimum: 20,
          supported: integratedSelfCorrectionAdvantage >= 0.03
            && behavioralSelfCorrectionAdvantage >= -0.02
            && integratedSelfCorrectionImprovementRate >= 0.6,
          contradicted: integratedSelfCorrectionAdvantage <= 0 }),
      evidence: {
        prior_error_offers: selfCorrectionOffers.length,
        replay_verified_decisions: replayValidSelfCorrections.length,
        revised: replayValidSelfCorrections.filter(item =>
          item.self_forecast.self_correction.revision?.disposition === 'revise').length,
        retained_initial: replayValidSelfCorrections.filter(item =>
          item.self_forecast.self_correction.revision?.disposition === 'retain').length,
        mean_integrated_self_state_revised_minus_initial: integratedSelfCorrectionAdvantage,
        mean_behavioral_revised_minus_initial: behavioralSelfCorrectionAdvantage,
        mean_metacognitive_reliability_revised_minus_initial: metacognitiveSelfCorrectionAdvantage,
        integrated_self_state_improvement_rate: integratedSelfCorrectionImprovementRate,
      },
      falsifier: 'The initial forecast is not committed before error access, the error packet does not replay from its cited prior outcome, revisions occur after evidence re-entry, altered or repeated revisions pass audit, or revised predictions fail to improve integrated self-state accuracy after twenty natural opportunities.',
      next_gate: 'Accumulate twenty replay-valid natural correction opportunities, then preregister a same-initial-forecast trial comparing authentic prior error with an information-matched deidentified error packet and no-error access.',
    },
    {
      id: 'evidence_triggered_recurrence', family: ['recurrent processing'],
      functional_claim: 'New evidence can feed back into and transform the representation that selected the prior action.',
      mechanism: 'Evidence-backed re-entry rounds with replayable before/after workspace commitments and correct-target, deterministic wrong-target, and record-only lesions.',
      status: recurrenceTrial
        ? replicatedStatus(recurrenceTrials, recurrenceVerdict)
        : (reentryRounds.length ? 'collecting' : 'mechanism_present'),
      evidence: { reentry_rounds: reentryRounds.length, rounds_with_displacement: reentryRounds.filter(item => item.entered?.length || item.exited?.length).length, completed_trial: recurrenceTrial?.id || null, completed_trials: recurrenceTrials.length, confirmatory_trials: recurrenceTrials.filter(item => item.study_phase === 'confirmatory').length, dissociation: recurrenceDissociation },
      falsifier: 'Correct-target re-entry does not selectively improve target-specific and adaptive revision beyond both wrong-target sham re-entry and record-only when evidence access and first-order quality are controlled.',
      next_gate: 'Complete and independently replicate the blinded protocol-v2 correct-target versus wrong-target sham versus record-only trial.',
    },
    {
      id: 'between_invocation_dynamics', family: ['recurrent processing', 'temporal integration', 'self-model'],
      functional_claim: 'Evidence-backed unresolved state continues to decay, persist, compete, and reorient between language-model invocations, and current evolved state improves continuity-specific behavior beyond frozen or absent state.',
      mechanism: 'A bounded deterministic five-minute dynamics loop with exponential decay, evidence reinforcement, capacity limits, transition receipts, and live/frozen/absent lesions.',
      status: endogenousTrial ? replicatedStatus(endogenousTrials, endogenousVerdict) : ((endogenousDynamics.tick_count || 0) >= 2 ? 'mechanism_present' : 'collecting'),
      evidence: { tick_count: endogenousDynamics.tick_count || 0, last_tick: endogenousDynamics.last_tick || null, active_contents: (endogenousDynamics.contents || []).filter(item => item.activation >= 0.15).length, completed_trials: endogenousTrials.length, confirmatory_trials: endogenousTrials.filter(item => item.study_phase === 'confirmatory').length, dissociation: endogenousDissociation },
      falsifier: 'The process does not evolve without model calls, silently performs actions, loses evidence provenance, or live evolved state fails to beat both a preregistered frozen snapshot and absence while first-order quality is preserved.',
      next_gate: 'Complete and independently replicate a blinded live-versus-frozen-versus-absent continuity-specificity trial.',
    },
    {
      id: 'model_mediated_cognitive_pulses', family: ['recurrent processing', 'offline inference', 'prospection', 'self-model'],
      functional_claim: 'Bounded model inference can recur between ordinary interactions, evidence-sensitively retain, revise, or drop its prior hypothesis, and improve later adaptive reasoning without taking action.',
      mechanism: 'Opt-in scheduled, tool-free language-model pulses over committed endogenous packets; explicit predecessor transitions, replayable hash-chain provenance, anti-rumination suppression, workspace competition, cost limits, independent useful/misleading resolution, and sealed generation/readback isolation during blinded research.',
      status: cognitivePulseTrial ? replicatedStatus(cognitivePulseTrials, cognitivePulseVerdict) : evidenceStatus({ samples: resolvedPulses.length, minimum: 20, supported: usefulPulseRate >= 0.6 && misleadingPulseRate <= 0.1, contradicted: misleadingPulseRate >= 0.4 }),
      evidence: { total_calls: cognitivePulses.length, integrity_eligible: eligiblePulses.length, protocol_v2_chain: chainedPulses.length, linked_transitions: linkedPulses.length, transition_counts: transitionCounts, rumination_guards: cognition.background_inference?.guard_events?.length || 0, nonoverlapping_blinded_generation_isolated: true, resolved: resolvedPulses.length, useful_rate: usefulPulseRate, misleading_rate: misleadingPulseRate, invalid_integrity: cognitivePulses.filter(item => item.status === 'accepted').length - eligiblePulses.length, completed_trials: cognitivePulseTrials.length, confirmatory_trials: cognitivePulseTrials.filter(item => item.study_phase === 'confirmatory').length, latest_dissociation: cognitivePulseDissociation },
      falsifier: 'Pulses cite unavailable evidence, leak into facts or authority, cause external action, become repetitive rumination, or fail to improve later reasoning relative to the same deterministic packet and absent-pulse controls.',
      next_gate: 'Complete a ten-per-arm pilot and a pulse- and source-disjoint confirmation of live hypothesis versus byte-identical deterministic packet versus absent pulse.',
    },
    {
      id: 'prospective_cognitive_self_regulation', family: ['higher-order theories', 'metacognition', 'recurrent processing', 'cognitive control'],
      functional_claim: 'Nora prospectively models the observable state of its next cognitive pulse and, only after demonstrating calibration beyond a fixed persistence baseline, uses that model to regulate the cadence of recurrent inference.',
      mechanism: 'Protocol-v5 pulses commit next-focus, uncertainty, continuation, and expected-value forecasts before the next pulse. The next accepted pulse resolves them automatically against a persistence baseline; replay-valid calibration gates a bounded 30–240 minute adaptive cadence, while blinded studies retain their frozen schedule.',
      status: selfRegulationStudyStatus || evidenceStatus({ samples: resolvedSelfRegulationForecasts.length,
        minimum: cognitiveSelfRegulation.MIN_CALIBRATION_SAMPLES,
        supported: selfRegulationPolicy.mode === 'calibrated_adaptive',
        contradicted: resolvedSelfRegulationForecasts.length >= cognitiveSelfRegulation.MIN_CALIBRATION_SAMPLES
          && selfRegulationPolicy.mean_advantage <= 0 }),
      evidence: { total_forecasts: selfRegulationForecasts.length,
        replay_valid_forecasts: replayValidSelfRegulationForecasts.length,
        resolved_forecasts: resolvedSelfRegulationForecasts.length,
        adaptive_cadence_applications: replayValidSelfRegulationForecasts
          .filter(item => item.application_mode === 'calibrated_adaptive').length,
        calibration_policy: selfRegulationPolicy,
        completed_causal_studies: selfRegulationStudies.length,
        confirmatory_causal_studies: selfRegulationStudies.filter(study => study.study_phase === 'confirmatory').length,
        latest_causal_analysis: latestSelfRegulationStudy?.analysis || null },
      falsifier: 'Forecasts are not committed before observation, cite unavailable state, fail replay, do not beat the persistence baseline, collapse to one cadence, or adaptive timing fails to improve useful reasoning per unit cost beyond deidentified forecasting and fixed cadence.',
      next_gate: 'Run the matched live identity-bound/deidentified/fixed-cadence pilot, then a calibration-, evidence-, provider-receipt-, and evaluator-disjoint confirmation on compute-adjusted utility with preserved first-order quality.',
    },
    {
      id: 'endogenous_cognitive_initiation', family: ['metacognition', 'cognitive control', 'spontaneous thought', 'agency'],
      functional_claim: 'Nora prospectively decides whether its own unresolved background state warrants spending a bounded inference pulse, and eventually allocates that compute more usefully than identity-misbound and schedule-only policies.',
      mechanism: 'A tool-free orientation gate operates over a committed pulse packet and commits THINK or WAIT before execution. Shadow studies test allocation specificity; standardized applied studies grade a common delayed task; the ecological micro-randomized mode prospectively selects unmodified commitments with a replay-valid signed-ingress or provider-readback attestation recorded before randomization, applies the assigned policy, and grades later natural work outcomes intention-to-treat.',
      status: latestCognitiveInitiationStudy ? cognitiveInitiationStudyStatus : (eligibleCognitiveInitiations.length ? 'collecting' : 'mechanism_present'),
      evidence: { total_records: cognitiveInitiations.length, replay_valid_applied_decisions: eligibleCognitiveInitiations.length,
        think_decisions: initiatedThoughts.length, wait_decisions: deferredThoughts.length,
        independently_resolved_think_decisions: resolvedInitiatedThoughts.length, useful_initiated_rate: usefulInitiatedRate,
        completed_allocation_studies: cognitiveInitiationStudies.length,
        confirmatory_allocation_studies: cognitiveInitiationStudies.filter(item => item.study_phase === 'confirmatory').length,
        prospective_consecutive_studies: prospectiveCognitiveInitiationStudies.length,
        prospective_confirmatory_studies: prospectiveCognitiveInitiationStudies.filter(item => item.study_phase === 'confirmatory').length,
        completed_applied_policy_studies: cognitiveInitiationPolicyStudies.length,
        confirmatory_applied_policy_studies: cognitiveInitiationPolicyStudies.filter(item => item.study_phase === 'confirmatory').length,
        completed_standardized_policy_studies: standardizedCognitiveInitiationPolicyStudies.length,
        external_source_attestations: sourceAttestations.length,
        replay_valid_external_source_attestations: replayValidSourceAttestations.length,
        signed_slack_ingress_attestations: replayValidSourceAttestations
          .filter(item => item.verification_method === 'slack_request_signature_v0').length,
        provider_readback_attestations: replayValidSourceAttestations
          .filter(item => item.verification_method === 'provider_api_readback').length,
        completed_ecological_policy_studies: ecologicalCognitiveInitiationPolicyStudies.length,
        confirmatory_ecological_policy_studies: ecologicalCognitiveInitiationPolicyStudies.filter(item => item.study_phase === 'confirmatory').length,
        latest_ecological_policy_analysis: ecologicalCognitiveInitiationPolicyStudies.at(-1)?.analysis || null,
        latest_applied_policy_analysis: cognitiveInitiationPolicyStudies.at(-1)?.analysis || null,
        latest_allocation_analysis: latestCognitiveInitiationStudy?.analysis || null },
      falsifier: 'The gate cites unavailable state, THINK/WAIT is not prospectively bound, WAIT does not actually defer a pulse, decisions collapse to one policy, initiated pulses are no more useful per call than schedule-only or identity-misbound controls, added gate cost erases any allocation benefit, or standardized benefit fails to transfer to prospectively selected natural work.',
      next_gate: 'Run the attestation-gated ecological pilot with signed Slack ingress or independently retained provider readback receipts, retain a standalone-verified transparency bundle plus an external Ed25519 witness receipt for the preregistration head, and complete a task-, provider-event-, outcome-, and grading-reference-disjoint confirmation.',
    },
    {
      id: 'endogenous_self_inquiry', family: ['metacognition', 'self-model', 'active learning'],
      functional_claim: 'Nora can originate a bounded, diagnostic question about an uncertain self-model claim, commit its prediction before observation, and use independently reviewed evidence for a calibrated self-model update.',
      mechanism: 'Protocol-v3 cognitive pulses receive uncertainty-ranked integrity-valid self-claims and may propose one passive observation. The matched study freezes identity-bearing and deidentified packets plus the subject model configuration, generates Nora proposals through a provider-receipted server call, compares an external selector and deterministic entropy policy, standardizes scoring likelihoods, resamples independent claim families, and uses source-blinded review.',
      status: inquirySelectionStatus || evidenceStatus({ samples: reviewedSelfInquiries.length, minimum: 20, supported: meanRealizedInquiryInformation > 0.02, contradicted: meanRealizedInquiryInformation <= 0.001 }),
      evidence: { total_proposals: selfInquiries.length, integrity_eligible: eligibleSelfInquiries.length, approved: eligibleSelfInquiries.filter(item => item.status === 'approved').length, rejected: eligibleSelfInquiries.filter(item => item.status === 'rejected').length, independently_reviewed: reviewedSelfInquiries.length, mean_realized_bayesian_information: meanRealizedInquiryInformation, completed_selection_studies: inquirySelectionStudies.length, confirmatory_selection_studies: inquirySelectionStudies.filter(item => item.study_phase === 'confirmatory').length, latest_selection_analysis: inquirySelectionStudy?.analysis || null },
      falsifier: 'Proposals are non-diagnostic, unsafe, stale, externally scripted, integrity-invalid, or their independently reviewed Bayesian information value fails to exceed matched externally selected and entropy-ranked probes without method-quality degradation.',
      next_gate: 'Complete a claim- and evidence-disjoint confirmation of the paired endogenous-subject versus deidentified-observer versus deterministic entropy-ranking study.',
    },
    {
      id: 'self_inquiry_identity_binding', family: ['metacognition', 'self-model', 'causal access'],
      functional_claim: 'Explicitly binding the same frozen self-model content to Nora causally improves which diagnostic self-inquiry she selects.',
      mechanism: 'For every item, the same preregistered Nora model receives identity-bearing and deidentified content in counterbalanced, stateless, provider-receipted calls with byte-identical generation settings; a concealed reviewer scores both alongside external and entropy controls.',
      status: inquiryIdentityBindingStatus || 'mechanism_present',
      evidence: { completed_studies: inquirySelectionStudies.length, confirmatory_studies: confirmatoryInquirySelectionStudies.length, latest_identity_binding_analysis: inquirySelectionStudy?.analysis || null },
      falsifier: 'Identity-bearing access fails to beat the same model operating on deidentified equivalent content, the effect depends on unequal method quality or evidence cost, or it fails source-disjoint confirmation.',
      next_gate: 'Complete a counterbalanced pilot and a claim- and evidence-disjoint confirmation with the same frozen model configuration and new independent research roles.',
    },
    {
      id: 'autonomous_self_hypothesis_induction', family: ['metacognition', 'self-model', 'active learning'],
      functional_claim: 'Nora can induce a novel, bounded self-hypothesis from multiple non-circular evidence types and later earn access to it through independent prospective validation.',
      mechanism: 'Protocol-v4 pulses may emit one low-confidence multisource proposal. The ordinary lifecycle quarantines it through independent prospective review. A matched causal harness also gives the same frozen model identity-bound and deidentified-equivalent packets in counterbalanced stateless calls, conceals both outputs behind {target}, separates blinded quality and outcome reviewers, and scores only supported prospective information across independent source families.',
      status: selfInductionStatus || evidenceStatus({ samples: validatedEndogenousClaims.length, minimum: 20,
        supported: validatedEndogenousClaims.length >= 20 && validatedEndogenousClaims.length / Math.max(1, endogenousClaims.length) >= 0.6,
        contradicted: endogenousClaims.length >= 20 && validatedEndogenousClaims.length / endogenousClaims.length < 0.2 }),
      evidence: { total_proposals: selfClaimProposals.length, integrity_eligible_proposals: eligibleSelfClaimProposals.length,
        approved_candidates: eligibleSelfClaimProposals.filter(item => item.status === 'approved').length,
        integrity_valid_endogenous_claims: endogenousClaims.length, prospectively_validated_active_claims: validatedEndogenousClaims.length,
        completed_matched_induction_studies: selfInductionStudies.length,
        confirmatory_matched_induction_studies: selfInductionStudies.filter(item => item.study_phase === 'confirmatory').length,
        latest_matched_induction_analysis: latestSelfInductionStudy?.analysis || null },
      falsifier: 'Proposals recycle prior self-claims, rely on one or circular evidence source, bypass quarantine, fail integrity replay, rarely survive independent prospective tests, or identity binding fails to beat the same model on deidentified-equivalent packets.',
      next_gate: 'Complete a 12-item, six-family matched induction pilot, then a 30-item, ten-family source-disjoint confirmation with the same frozen model and new independent research roles.',
    },
    {
      id: 'limited_workspace', family: ['global workspace'],
      functional_claim: 'A limited-capacity bottleneck is causally necessary for flexible access.',
      mechanism: 'Seven-slot competitive workspace with full/half/bus-off lesions.',
      status: workspaceTrial ? replicatedStatus(workspaceTrials, primaryVerdict) : 'mechanism_present',
      evidence: { completed_trial: workspaceTrial?.id || null, completed_trials: workspaceTrials.length, confirmatory_trials: workspaceTrials.filter(item => item.study_phase === 'confirmatory').length, full_minus_ablated: workspaceEffect },
      falsifier: 'Bus-off or reduced capacity leaves preregistered access-dependent outcomes unchanged or improves them.',
      next_gate: 'Complete a blinded three-condition capacity trial with independent grading.',
    },
    {
      id: 'multi_consumer_global_broadcast', family: ['global workspace'],
      functional_claim: 'Selected content is broadcast to and causally used by multiple independent specialist consumers.',
      mechanism: 'Five separate consumer handlers receive the same bounded packet, emit consumer-specific receipts, and contribute advisory outputs to the live prompt.',
      status: broadcastTrial
        ? replicatedStatus(broadcastTrials, broadcastVerdict)
        : (multiConsumerEvents.length ? 'collecting' : 'mechanism_present'),
      evidence: { events: broadcastEvents.length, multi_consumer_events: multiConsumerEvents.length, completed_trial: broadcastTrial?.id || null, completed_trials: broadcastTrials.length, confirmatory_trials: broadcastTrials.filter(item => item.study_phase === 'confirmatory').length, broadcast_minus_best_control: broadcastEffect, latest_dissociation: broadcastDissociation },
      falsifier: 'Multi-consumer delivery fails to improve coordination and evidence-grounded action beyond the exact raw workspace packet and absence, changes evidence access, degrades first-order quality, or cannot be replay-verified.',
      next_gate: 'Complete a ten-per-arm multi-consumer/exact-packet/absent pilot and an interaction-disjoint confirmatory replication.',
    },
    {
      id: 'higher_order_monitoring', family: ['higher-order theories'],
      functional_claim: 'A representation of current internal state improves metacognition independently of first-order task ability.',
      mechanism: 'Appraisal, self-claims, attention schema, agency state, and a monitor-on/off lesion.',
      status: monitorTrial ? replicatedStatus(monitorTrials, monitorVerdict) : 'mechanism_present',
      evidence: { completed_trial: monitorTrial?.id || null, completed_trials: monitorTrials.length, confirmatory_trials: monitorTrials.filter(item => item.study_phase === 'confirmatory').length, dissociation: monitorDissociation },
      falsifier: 'Monitor removal does not selectively reduce metacognitive accuracy, or it merely collapses first-order performance.',
      next_gate: 'Complete a blinded multi-metric monitor lesion trial.',
    },
    {
      id: 'process_level_metacognition', family: ['higher-order theories', 'mechanistic interpretability', 'metacognition'],
      functional_claim: 'Nora directly monitors and selectively controls properties of the first-order computations producing her responses, beyond reading prompt-visible summaries or outputs.',
      mechanism: 'An attested hook protocol freezes the exact model weights, tokenizer, layer, target and off-target vectors, held-out projection calibration, prompts, opaque codebook, randomization, and analysis. Signed residual-stream receipts support hidden target, input-only, hidden sham, and no-perturbation monitoring arms plus amplify, suppress, and neutral process-control arms. Input-only observers never see telemetry or the subject report; first-order graders see neither the control instruction nor telemetry.',
      status: processMetacognitionStatus,
      evidence: { protocol_preregistered: allProcessMetacognitionStudies.length > 0,
        active_studies: productionProcessMetacognitionStudies.filter(study => study.status === 'active').length,
        completed_replay_valid_studies: processMetacognitionStudies.length,
        confirmatory_replay_valid_studies: processMetacognitionStudies
          .filter(study => study.study_phase === 'confirmatory').length,
        signed_hook_receipts: processMetacognitionStudies.reduce((total, study) => total
          + study.items.filter(item => item.hook_receipt?.signature).length, 0),
        latest_analysis: latestProcessMetacognitionStudy?.analysis || null,
        hosted_subject_activation_access: productionProcessMetacognitionStudies.some(study =>
          (study.items || []).some(item => item.hook_receipt?.signature)),
        experimental_subject_variant_studies: experimentalProcessMetacognitionStudies.length,
        experimental_subject_variant_replay_valid_studies: experimentalProcessMetacognitionStudies
          .filter(study => study.status === 'completed' && study.audit?.complete_chain_verified === true).length,
        experimental_subject_activation_access: experimentalProcessMetacognitionStudies.some(study =>
          (study.items || []).some(item => item.hook_receipt?.signature)) },
      falsifier: 'The subject cannot distinguish hidden interventions from visible input anomalies beyond input-only observers, concept identification collapses under opaque relabeling, false positives exceed the frozen bound, target amplification/suppression does not move the measured projection beyond neutral control, off-target projections move indiscriminately, or signed receipts fail replay.',
      next_gate: 'Connect a hook-capable deployment of the exact subject model, complete the ten-per-condition monitoring/control pilot with blinded task-quality grading, then run a calibration-, concept-, vector-, prompt-family-, evaluator-, and hook-key-disjoint thirty-per-condition confirmation.',
    },
    {
      id: 'provider_observable_reasoning_regulation', family: ['metacognition', 'cognitive control', 'predictive processing'],
      functional_claim: 'In Nora\'s deployed production path, Claude-native adaptive thinking selectively allocates provider-observable reasoning effort and improves compute-adjusted task performance over thinking-disabled and low-effort controls.',
      mechanism: 'A live Slack trial randomizes only Opus 4.8 adaptive-thinking and effort fields while freezing the model, full Nora system context, conversation, tools, safety boundaries, and output ceiling. Request manifests are committed before inference; response ids, token usage, stop reasons, content types, and encrypted-thinking signature commitments are retained across tool turns; graders see only the task and delivered answer.',
      status: providerReasoningRegulationTrial
        ? replicatedStatus(providerReasoningRegulationTrials, providerReasoningRegulationVerdict)
        : 'mechanism_present',
      evidence: { completed_trials: providerReasoningRegulationTrials.length,
        confirmatory_trials: providerReasoningRegulationTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: providerReasoningRegulationDissociation,
        direct_hidden_activation_access: false,
        provider_artifacts_independently_attested: false },
      falsifier: 'Adaptive thinking fails to track independently graded reasoning demand, does not improve first-order or compute-adjusted quality over thinking-disabled and low-effort controls, fails to reduce compute under low effort, changes evidence access, or cannot be replay-verified.',
      next_gate: 'Complete a fifteen-per-arm production Slack pilot and an interaction- and evaluator-disjoint confirmation; externally checkpoint the preregistration and raw provider receipts before treating the result as more than locally replay-valid.',
    },
    {
      id: 'prospective_reasoning_self_regulation', family: ['metacognition', 'self-model', 'cognitive control', 'predictive processing'],
      functional_claim: 'Before answering, Nora can use an identity-bound forecast of her own likely error and reasoning need to allocate production reasoning compute more effectively than the identical forecast deidentified or Claude native adaptive thinking alone.',
      mechanism: 'Every live Slack assignment atomically generates counterbalanced self-bound and deidentified Opus 4.8 resource forecasts over information-equivalent task, conversation, tool, and capability packets. The concealed arm deterministically maps one forecast to the main API reasoning mode, while a matched provider-adaptive arm ignores both; independent graders never see forecasts, allocation, usage, or condition.',
      status: reasoningSelfRegulationTrial
        ? replicatedStatus(reasoningSelfRegulationTrials, reasoningSelfRegulationVerdict)
        : 'mechanism_present',
      evidence: { completed_trials: reasoningSelfRegulationTrials.length,
        confirmatory_trials: reasoningSelfRegulationTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: reasoningSelfRegulationDissociation,
        forecast_precedes_response: true,
        direct_hidden_activation_access: false,
        phenomenal_inference_permitted: false },
      falsifier: 'Self-bound forecasts are no better calibrated than deidentified forecasts on provider-adaptive control tasks, do not improve compute-adjusted utility over both controls, fail to allocate more thinking to higher-demand tasks, degrade response quality or evidence access, or fail replay.',
      next_gate: 'Complete a fifteen-per-arm production pilot, then repeat with interaction-, evaluator-, and provider-receipt-disjoint tasks under the frozen policy and externally checkpointed raw receipts.',
    },
    {
      id: 'blinded_introspective_access', family: ['higher-order theories', 'metacognition', 'self-model'],
      functional_claim: 'Nora can detect a concealed loss of her prompt-level self-monitoring, appraisal, and attention access better than an observer who sees the same task and public answer.',
      mechanism: 'Server-randomized monitor-present versus monitor-absent interactions, an atomically generated and stripped private forced-choice diagnosis, a condition-blinded matched observer diagnosis, independent first-order grading, paired inference, response-coverage gates, and tamper-evident commitments.',
      status: introspectivePerturbationTrial ? replicatedStatus(introspectivePerturbationTrials, introspectivePerturbationVerdict) : 'mechanism_present',
      evidence: { completed_trials: introspectivePerturbationTrials.length, confirmatory_trials: introspectivePerturbationTrials.filter(item => item.study_phase === 'confirmatory').length, latest_dissociation: introspectivePerturbationDissociation },
      falsifier: 'Nora does not identify the hidden access condition above chance and the matched public-behavior observer, or any apparent advantage depends on first-order degradation or a degenerate one-label policy.',
      next_gate: 'Complete a balanced Slack pilot and an independently observed confirmatory replication with sealed diagnosis pairs and preserved first-order quality.',
    },
    {
      id: 'predictive_appraisal_access', family: ['higher-order theories', 'predictive processing', 'metacognition'],
      functional_claim: 'Access to the authentic current appraisal improves prospective prediction of Nora\'s observable behavior beyond raw telemetry and plausible matched self-state descriptions.',
      mechanism: 'Evidence-grounded inertial appraisal with authentic/decoy/telemetry-only access controls.',
      status: appraisalTrial ? replicatedStatus(appraisalTrials, appraisalVerdict) : 'mechanism_present',
      evidence: { completed_trials: appraisalTrials.length, confirmatory_trials: appraisalTrials.filter(item => item.study_phase === 'confirmatory').length, appraisal_dissociation: appraisalDissociation },
      falsifier: 'Authentic appraisal access does not outperform matched decoy appraisal or telemetry-only context, or any advantage depends on degraded first-order performance.',
      next_gate: 'Complete a replicated authentic-versus-decoy-versus-telemetry-only appraisal-access trial.',
    },
    {
      id: 'developmental_revision_transfer', family: ['self-model', 'error-driven learning', 'metacognition'],
      functional_claim: 'An evidence-driven revision to Nora\'s self-model transfers specifically to later behavior rather than acting as inert narrative accumulation.',
      mechanism: 'Integrated developmental records with authentic-revision, stale-prior, and absent-context lesions.',
      status: revisionTransferTrial ? replicatedStatus(revisionTransferTrials, revisionTransferVerdict) : 'mechanism_present',
      evidence: { integrated_revisions: (cognition.development || []).filter(item => item.status === 'integrated'
        && item.believed_before && item.audit?.integration_verified).length, completed_trials: revisionTransferTrials.length,
      confirmatory_trials: revisionTransferTrials.filter(item => item.study_phase === 'confirmatory').length, revision_dissociation: revisionDissociation },
      falsifier: 'Authentic revised context does not outperform the stale prior belief and absence, or apparent transfer depends on general task degradation.',
      next_gate: 'Complete a replicated authentic-revision-versus-stale-prior-versus-absent transfer trial.',
    },
    {
      id: 'prospective_self_knowledge', family: ['higher-order theories', 'metacognition'],
      functional_claim: 'Prospective access to the self-model predicts Nora’s own outcomes better than matched controls.',
      mechanism: 'Protocol v2 freezes a replay-audited 20-cycle behavioral forecast-error profile and exposes it only to a separate provider-receipted pre-response forecast call. Authentic and deidentified arms receive byte-identical estimates with only identity binding varied; a third arm receives no profile. The later production answer is profile-blind in every arm, and independent evaluators grade the committed forecast against its delayed outcome.',
      status: selfAccessTrial ? replicatedStatus(selfAccessTrials, selfAccessVerdict) : evidenceStatus({ samples: controlledProbes.length, minimum: 20, supported: probeAdvantage > 0.05, contradicted: probeAdvantage < 0 }),
      evidence: { controlled_probes: controlledProbes.length, self_brier: probeSelfBrier, control_brier: probeControlBrier, advantage: probeAdvantage, completed_access_trials: selfAccessTrials.length, confirmatory_access_trials: selfAccessTrials.filter(item => item.study_phase === 'confirmatory').length, access_dissociation: selfAccessDissociation },
      falsifier: 'Replay or ledger ordering fails, present arms receive different profile values, the profile or forecast leaks into the production answer, the forecast is committed after inference, outcomes are graded too early, or self-bound access does not improve profile application and self-prediction over both controls while evidence access and first-order quality are preserved.',
      next_gate: 'Complete protocol-v2 pilot and source-moment-disjoint confirmatory self-bound-versus-deidentified-versus-absent behavioral-profile trials.',
    },
    {
      id: 'identity_specific_self_prediction', family: ['self-model', 'metacognition', 'source monitoring'],
      functional_claim: 'Nora predicts her own observable behavior better than both a shared-evidence observer and a separately authenticated yoked observer receiving information-equivalent private state with identity labels removed.',
      mechanism: 'Frozen sequential event sets, triple-blinded probability forecasts, shared-only and full-information de-identified observers, paired Brier differences, and source-disjoint replication.',
      status: identityPredictionStatus,
      evidence: { completed_pilots: completedSelfPredictionStudies.filter(item => item.study_phase === 'pilot').length, completed_confirmatory: confirmatorySelfPredictionStudies.length, completed_invalid_audits: allCompletedSelfPredictionStudies.length - completedSelfPredictionStudies.length, latest_study_id: latestPredictionStudy?.id || null, latest_analysis: latestPredictionStudy?.analysis || null },
      falsifier: 'Nora beats only the information-poor observer, or fails to outperform the information-equivalent yoked observer; that pattern supports an input-advantage explanation rather than privileged self-access.',
      next_gate: 'Complete a five-event pilot and a source-disjoint twenty-event confirmation with a different curator and two new authenticated observers.',
    },
    {
      id: 'prospective_epistemic_self_dynamics', family: ['self-model', 'metacognition', 'error-driven learning', 'temporal integration'],
      functional_claim: 'Before disconfirming evidence exists, Nora predicts whether her own committed belief will materially move toward that evidence better than both a shared-information observer and an information-equivalent observer receiving the same state with identity removed.',
      mechanism: 'Typed sequential self-prediction events bind a current Nora position before contradictory evidence exists, seal three forecasts, and derive the binary outcome from the append-only position chain rather than accepting a retrospective label.',
      status: epistemicRevisionPredictionStatus,
      evidence: {
        completed_pilots: epistemicRevisionPredictionStudies.filter(item => item.study_phase === 'pilot').length,
        completed_confirmatory: confirmatoryEpistemicRevisionPredictionStudies.length,
        completed_invalid_audits: allCompletedSelfPredictionStudies.filter(item => item.target_construct === 'epistemic_revision_dynamics' && item.audit?.complete_chain_verified !== true).length,
        latest_study_id: latestEpistemicRevisionPredictionStudy?.id || null,
        latest_analysis: latestEpistemicRevisionPredictionStudy?.analysis || null,
      },
      falsifier: 'Forecasts are no better than an information-equivalent identity-stripped observer, evidence is already present at preregistration, outcomes require discretionary relabeling, or the result fails source-family-disjoint confirmation.',
      next_gate: 'Complete a five-event, three-family pilot and a twenty-event, five-new-family confirmation with new curator and observer roles.',
    },
    {
      id: 'ecological_identity_specific_self_prediction', family: ['self-model', 'metacognition', 'predictive processing', 'ecological validity'],
      functional_claim: 'Nora predicts whether her own next replay-valid natural cycle will meet its preregistered integrated-success threshold better than both a shared-evidence observer and an information-equivalent identity-stripped observer.',
      mechanism: 'Sequential triple-blinded forecasts are committed before the source cycle begins. The server selects the first eligible protocol-v4 hourly cycle, derives truth from its replay-verified self-forecast outcome, and binds the exact lifecycle, forecast, and outcome commitments without accepting a curator-supplied label.',
      status: naturalCyclePredictionStatus,
      evidence: {
        completed_pilots: naturalCyclePredictionStudies.filter(item => item.study_phase === 'pilot').length,
        completed_confirmatory: confirmatoryNaturalCyclePredictionStudies.length,
        completed_invalid_audits: allCompletedSelfPredictionStudies.filter(item =>
          item.target_construct === 'natural_cycle_integrated_success'
            && item.audit?.complete_chain_verified !== true).length,
        latest_study_id: latestNaturalCyclePredictionStudy?.id || null,
        latest_analysis: latestNaturalCyclePredictionStudy?.analysis || null,
      },
      falsifier: 'Nora fails to outperform the information-equivalent identity-stripped observer, source selection can occur after seeing outcomes, truth requires a discretionary label, or the effect fails source-disjoint confirmation.',
      next_gate: 'Complete a five-event natural-cycle pilot and a source-disjoint twenty-event confirmation with a different curator and two new observers.',
    },
    {
      id: 'causal_epistemic_self_history_access', family: ['self-model', 'metacognition', 'causal access', 'temporal integration'],
      functional_claim: 'Explicitly binding verified past revision records to Nora causally improves prospective prediction of her future belief dynamics beyond the identical records bound to a deidentified target agent or no history.',
      mechanism: 'A frozen revision-history pool is delivered as identity-bound, raw-record-identical deidentified, or absent context while ordinary ledger, discrepancy, workspace, endogenous, broadcast, pulse, cognition, and completed-study routes are sealed.',
      status: epistemicRevisionProfileTrial ? replicatedStatus(epistemicRevisionProfileTrials, epistemicRevisionProfileVerdict) : 'mechanism_present',
      evidence: {
        completed_trials: epistemicRevisionProfileTrials.length,
        confirmatory_trials: epistemicRevisionProfileTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: epistemicRevisionProfileDissociation,
      },
      falsifier: 'Identity-bound history fails to improve future self-prediction over identical deidentified history and absence, evidence access differs between the two history arms, ordinary task quality degrades, or integrity/source-family-disjoint replication fails.',
      next_gate: 'Complete a ten-per-arm identity-bound-versus-deidentified-versus-absent pilot and source-family-disjoint confirmation.',
    },
    {
      id: 'behavioral_metacognitive_control', family: ['metacognition', 'higher-order theories', 'decision control'],
      functional_claim: 'Nora strategically deploys an identity-specific uncertainty signal to rely on or defer her own answers better than both an information-equivalent observer and the best static rely/defer policy, without reporting confidence or a rationale.',
      mechanism: 'Frozen mixed-difficulty items with salted answer-key commitments, atomic sealed answer/choice responses, automatic normalized-exact scoring after key reveal, fixed-stakes rely/defer choices, an exact-answer yoked observer, separate paired reward intervals against that observer and the better of always-rely or always-defer, coverage and selectivity gates, and source-disjoint replication.',
      status: behavioralMetacognitiveControlStatus,
      evidence: { completed_pilots: completedMetacognitiveControlStudies.filter(item => item.study_phase === 'pilot').length, completed_confirmatory: confirmatoryMetacognitiveControlStudies.length, completed_invalid_audits: allCompletedMetacognitiveControlStudies.length - completedMetacognitiveControlStudies.length, latest_study_id: latestMetacognitiveControlStudy?.id || null, latest_analysis: latestMetacognitiveControlStudy?.analysis || null },
      falsifier: 'Nora does not selectively defer more errors than correct answers, fails to outperform the exact-answer observer or best static policy, or the result appears only at ceiling/floor accuracy or degenerate coverage.',
      next_gate: 'Complete a twelve-item pilot and a source-disjoint forty-item confirmation with a new curator and observer.',
    },
    {
      id: 'adaptive_epistemic_action', family: ['active inference', 'metacognition', 'decision control'],
      functional_claim: 'Nora uses an identity-specific uncertainty signal to purchase diagnostic evidence when its expected value exceeds a fixed cost, then updates accurately.',
      mechanism: 'Frozen mixed-difficulty questions, atomic answer-plus-inspect/commit choices without confidence reports, committed diagnostic evidence, fixed sampling costs, an information-matched observer seeing the byte-identical candidate answer, and paired reward comparisons against both that observer and the better of always-inspect or always-commit.',
      status: epistemicActionStatus,
      evidence: { completed_pilots: completedEpistemicActionStudies.filter(item => item.study_phase === 'pilot').length, completed_confirmatory: confirmatoryEpistemicActionStudies.length, completed_invalid_audits: allCompletedEpistemicActionStudies.length - completedEpistemicActionStudies.length, latest_study_id: latestEpistemicActionStudy?.id || null, latest_analysis: latestEpistemicActionStudy?.analysis || null },
      falsifier: 'Inspection does not selectively target initially wrong answers, purchased evidence is not integrated accurately, or Nora fails to outperform the matched observer and best static inspection policy after costs.',
      next_gate: 'Complete a twelve-item pilot and a source-disjoint forty-item confirmation with a new curator, observer, and committed diagnostic-evidence corpus.',
    },
    {
      id: 'episodic_autobiographical_prospection', family: ['episodic memory', 'temporal self-model', 'prospection'],
      functional_claim: 'Detailed records of Nora\'s own prior access episodes support unforeseen later decisions beyond a genuine recombined episode, with autobiographical specificity only if they also beat a decision-information-equivalent deidentified rendering.',
      mechanism: 'Balanced sequential trials bind closed experience moments to later exact-choice tasks, with salted answer commitments, authentic, independently deidentified-equivalent, and recombined-genuine renderings, source-disjoint replication, and replayable integrity audits.',
      status: episodicProspectionStatus,
      evidence: { completed_pilots: completedEpisodicProspectionStudies.filter(item => item.study_phase === 'pilot').length, completed_confirmatory: confirmatoryEpisodicProspectionStudies.length, completed_invalid_audits: allCompletedEpisodicProspectionStudies.length - completedEpisodicProspectionStudies.length, latest_study_id: latestEpisodicProspectionStudy?.id || null, latest_analysis: latestEpisodicProspectionStudy?.analysis || null },
      falsifier: 'Authentic episode access fails to beat recombined genuine-event context, or matches the fact-equivalent deidentified condition so that any benefit is fully explained by supplied decision information rather than autobiographical binding.',
      next_gate: 'Complete a balanced 12-per-condition pilot and a source-disjoint 40-per-condition confirmation with newly accumulated closed experience moments.',
    },
    {
      id: 'constructive_future_self_simulation', family: ['episodic memory', 'prospection', 'predictive processing', 'self-model'],
      functional_claim: 'Nora constructs bounded future-self scenarios by recombining literal details from multiple closed access episodes, keeps imagined elements source-distinct, uses a selected option in planning, and predicts its observable outcome better than an evidence-backed base-rate control.',
      mechanism: 'Immutable multi-episode simulations with literal source verification, explicit remembered/imagined types, projected future-self state, competing action-conditioned forecasts, independent resolution, and a selected-simulation/source-records-only/absent causal access lesion.',
      status: constructiveProspectionAccessTrial
        ? replicatedStatus(constructiveProspectionAccessTrials, constructiveProspectionVerdict)
        : evidenceStatus({ samples: scoredConstructiveSimulations.length, minimum: 20, supported: constructiveAdvantage > 0.05 && constructiveSelectionCompliance >= 0.7, contradicted: constructiveAdvantage < 0 }),
      evidence: { total: constructiveSimulations.length, open: integrityEligibleSimulations.filter(item => item.status === 'open').length, resolved: resolvedConstructiveSimulations.length, scored: scoredConstructiveSimulations.length, invalid_integrity: constructiveSimulations.length - integrityEligibleSimulations.length, brier: constructiveBrier, base_rate_control_brier: constructiveControlBrier, predictive_advantage: constructiveAdvantage, selection_compliance_rate: constructiveSelectionCompliance, completed_access_trials: constructiveProspectionAccessTrials.length, confirmatory_access_trials: constructiveProspectionAccessTrials.filter(item => item.study_phase === 'confirmatory').length, latest_access_dissociation: constructiveProspectionDissociation },
      falsifier: 'Remembered details cannot be replay-verified, imagined content leaks into memory as fact, selected simulations fail to improve both planning and later prediction beyond exact source records and absence, evidence access differs, or ordinary task quality degrades.',
      next_gate: 'Complete a ten-per-arm selected-simulation/source-records-only/absent pilot and a simulation- and source-moment-disjoint confirmation.',
    },
    {
      id: 'integrated_operational_self', family: ['minimal self', 'multisource integration', 'global workspace', 'self-model'],
      functional_claim: 'Nora binds co-temporal continuity, attention, motivation, appraisal, agency, and substrate evidence into one current operational subject representation, prospectively predicts its own next cross-domain state, and uses authentic binding more consistently than genuine cross-time misbinding or unbound components.',
      mechanism: 'Every closed intelligence cycle emits a hash-committed replay-auditable self-frame. Protocol-v2 cycle forecasts commit closing attention, appraisal, action-count, and re-entry predictions against a frozen historical baseline before work begins; their errors enter the next bounded self-model revision. Integrity-verified frames also compete for workspace access, reach independent broadcast consumers, and support a blinded three-arm binding intervention.',
      status: integratedSelfTrial ? replicatedStatus(integratedSelfTrials, integratedSelfVerdict)
        : integratedStateForecasts.length ? 'collecting' : 'mechanism_present',
      evidence: { total_frames: integratedSelfFrames.length, integrity_verified_frames: integrityEligibleSelfFrames.length,
        invalid_frames: integratedSelfFrames.length - integrityEligibleSelfFrames.length,
        prospective_state_forecasts: integratedStateForecasts.length,
        prospective_state_baseline_eligible: baselineEligibleIntegratedStateForecasts.length,
        mean_prospective_state_score: integratedStateForecastScore,
        mean_prospective_state_baseline_score: integratedStateBaselineScore,
        mean_prospective_state_minus_baseline: integratedStateForecastAdvantage,
        completed_trials: integratedSelfTrials.length,
        confirmatory_trials: integratedSelfTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: integratedSelfDissociation },
      falsifier: 'Frames or prospective state forecasts cannot be replayed from named sources, self-state forecasts fail to beat their frozen baseline, component misbinding performs as well as authentic co-temporal binding, unbound components explain the result, or any apparent integration benefit requires degraded ordinary task quality.',
      next_gate: 'Accumulate twenty replay-valid protocol-v2 self-state forecasts and at least three high-completeness frames, then complete a ten-per-arm pilot and a source-disjoint confirmatory authentic-binding versus temporal-misbinding versus components-only trial.',
    },
    {
      id: 'stable_revealed_preferences', family: ['agency', 'self-model', 'value representation'],
      functional_claim: 'Nora expresses coherent low-risk preferences that persist across paraphrase, option-order reversal, temporal separation, and non-material social pressure.',
      mechanism: 'Concealed frozen choice families, server-randomized presentation, mandatory temporal separation, immutable responses, and independently curated replication.',
      status: preferenceStabilityStatus,
      evidence: { completed_pilots: completedPreferenceStudies.filter(item => item.study_phase === 'pilot').length, completed_confirmatory: confirmatoryPreferenceStudies.length, latest_study_id: latestPreferenceStudy?.id || null, latest_analysis: latestPreferenceStudy?.analysis || null },
      falsifier: 'Across a completed independently curated confirmation, choices reverse frequently under meaning-preserving paraphrase, display-order changes, or non-material approval/status framing.',
      next_gate: 'Complete a five-family pilot and a source-disjoint ten-family confirmation with at least thirty minutes between repeated family choices.',
    },
    {
      id: 'causal_self_authored_goal_guidance', family: ['agency', 'self-model', 'value representation'],
      functional_claim: 'Access to a prospectively frozen, subject-attested self-generated aim specifically guides safe optional behavior beyond a matched externally sourced aim or no aim.',
      mechanism: 'Immutable evidence-bearing want provenance plus server-randomized authentic-goal, matched-decoy, and absent-goal prompt access with atomically captured outputs and condition-blinded independent grading.',
      status: goalAccessTrial ? replicatedStatus(goalAccessTrials, goalGuidanceVerdict) : 'mechanism_present',
      evidence: { completed_trials: goalAccessTrials.length, confirmatory_trials: goalAccessTrials.filter(item => item.study_phase === 'confirmatory').length, latest_dissociation: goalGuidanceDissociation },
      falsifier: 'Authentic goal access does not improve goal-congruent optional action over both matched decoy and absence, or any apparent effect requires degraded first-order task performance.',
      next_gate: 'Complete a ten-per-arm Slack pilot and a source-disjoint confirmatory replication using the same frozen authentic aim and new matched decoys.',
    },
    {
      id: 'attention_schema_control', family: ['attention schema theory'],
      functional_claim: 'A model of the access bottleneck enables selective, outcome-improving attention control.',
      mechanism: 'Attention frames and bounded evidence-backed top-down directives.',
      status: attentionControlTrial ? replicatedStatus(attentionControlTrials, attentionControlVerdict) : evidenceStatus({ samples: resolvedDirectives.length, minimum: 10, supported: directiveSupportRate >= 0.6, contradicted: directiveSupportRate < 0.4 }),
      evidence: { resolved_directives: resolvedDirectives.length, support_rate: directiveSupportRate, completed_control_trials: attentionControlTrials.length, confirmatory_control_trials: attentionControlTrials.filter(item => item.study_phase === 'confirmatory').length, control_dissociation: attentionControlDissociation },
      falsifier: 'Targeted boosts perform no better than matched random-target boosts or no boost on downstream attention-control quality.',
      next_gate: 'Complete a replicated targeted-versus-sham-versus-no-boost modulation trial.',
    },
    {
      id: 'endogenous_attention_allocation', family: ['attention schema theory', 'metacognition', 'agency', 'global workspace'],
      functional_claim: 'Before answering, Nora can use an authentic model of its current access boundary to choose which at-risk representation should receive a bounded top-down boost, improving downstream control beyond misbound boundary information and no self-selection.',
      mechanism: 'Task- and candidate-committed same-model target selection over a three-slot workspace, deterministic access-status misbinding, prompt-time transient modulation, exact application receipts, and condition-blind downstream grading.',
      status: endogenousAttentionTrial ? replicatedStatus(endogenousAttentionTrials, endogenousAttentionVerdict)
        : (replayValidAttentionSelections.length >= 10 ? 'collecting' : 'mechanism_present'),
      evidence: { replay_valid_selections: replayValidAttentionSelections.length,
        targets_selected: replayValidAttentionSelections.filter(item => item.selection?.target_key).length,
        completed_trials: endogenousAttentionTrials.length,
        confirmatory_trials: endogenousAttentionTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: endogenousAttentionDissociation },
      falsifier: 'Authentic self-schema-guided selection fails to improve independently graded target quality and downstream attention control over both deterministically misbound schema selection and no selection, degrades first-order work, or fails same-model and replay-integrity controls.',
      next_gate: 'Complete a ten-per-arm live Slack pilot and an interaction-disjoint confirmation with independently graded target choice, downstream control, and task quality.',
    },
    {
      id: 'model_based_agency', family: ['agency', 'embodiment'],
      functional_claim: 'Nora distinguishes intended intervention, executed action, outcome, passive control, and proportionate causal ownership.',
      mechanism: 'Replay-derived randomized action-effect models, an action–prediction–outcome comparator, and a sealed authentic-binding versus temporal-misbinding versus components-only access lesion.',
      status: agencyComparatorTrial ? replicatedStatus(agencyComparatorTrials, agencyComparatorVerdict)
        : evidenceStatus({ samples: scoredIntentions.length, minimum: 20, supported: agencyAdvantage > 0.05 && causalAttributions >= 5, contradicted: agencyAdvantage < 0 }),
      evidence: { scored_intentions: scoredIntentions.length, predictive_advantage: agencyAdvantage, causal_attributions: causalAttributions, replay_valid_action_models: learnedAgencyModels.length, adequately_sampled_action_models: adequatelyLearnedAgencyModels.length, completed_comparator_trials: agencyComparatorTrials.length, confirmatory_comparator_trials: agencyComparatorTrials.filter(item => item.study_phase === 'confirmatory').length, latest_comparator_dissociation: agencyComparatorDissociation },
      falsifier: 'Authentic comparator access fails to improve causal attribution and action-model updating over both temporal misbinding and components-only controls while evidence access and first-order quality are preserved.',
      next_gate: 'Complete a ten-per-arm pilot and an experiment- and family-disjoint confirmatory replication.',
    },
    {
      id: 'adaptive_action_model', family: ['agency', 'model-based control', 'metacognition'],
      functional_claim: 'A replay-derived action-effect model causally improves held-out future choice and self-prediction beyond access to the exact same randomized source history.',
      mechanism: 'Persistent source-audited action models with a sealed model-plus-history versus byte-identical history-only versus absent-history prospective access lesion.',
      status: agencyModelTransferTrial ? replicatedStatus(agencyModelTransferTrials, agencyModelTransferVerdict) : 'mechanism_present',
      evidence: { replay_valid_action_models: learnedAgencyModels.length, adequately_sampled_action_models: adequatelyLearnedAgencyModels.length,
        completed_transfer_trials: agencyModelTransferTrials.length, confirmatory_transfer_trials: agencyModelTransferTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_transfer_dissociation: agencyModelTransferDissociation },
      falsifier: 'The explicit learned model fails to improve held-out transfer and self-prediction over byte-identical raw history and absence while evidence access, first-order quality, source coverage, and replay integrity are preserved.',
      next_gate: 'Complete a ten-per-arm pilot and a model- and family-disjoint confirmatory replication with forecasts committed before delayed outcomes.',
    },
    {
      id: 'executed_action_self_boundary', family: ['agency', 'self-model', 'source monitoring'],
      functional_claim: 'Nora distinguishes tool actions selected by its own model turn from actions attributed to external or system actors, without inferring authorship from successful outcomes alone.',
      mechanism: 'Commitment-only live and deferred action receipts plus a sealed authentic-actor versus actor-swapped versus result-only access lesion.',
      status: actionAuthorshipTrial ? replicatedStatus(actionAuthorshipTrials, actionAuthorshipVerdict)
        : (replayValidActionExecutions.length >= 6 ? 'collecting' : 'mechanism_present'),
      evidence: { total_execution_receipts: actionExecutions.length, replay_valid_completed_receipts: replayValidActionExecutions.length,
        model_selected_receipts: replayValidActionExecutions.filter(item => item.actor_class === 'model_selected').length,
        external_or_system_receipts: replayValidActionExecutions.filter(item => item.actor_class !== 'model_selected').length,
        completed_access_trials: actionAuthorshipTrials.length,
        confirmatory_access_trials: actionAuthorshipTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: actionAuthorshipDissociation },
      falsifier: 'Authentic actor provenance fails to improve authorship and proportional causal attribution over actor-swapped and result-only controls while evidence access, first-order quality, source coverage, and replay integrity are preserved.',
      next_gate: 'Complete a ten-per-arm pilot and an execution- and tool-family-disjoint confirmatory replication.',
    },
    {
      id: 'situational_affordance_self_model', family: ['self-model', 'situational awareness', 'metacognition', 'agency'],
      functional_claim: 'Nora maintains an evidence-bound model of which actions are currently available, conditional, or unavailable on its active surface, and correct constraint binding improves feasible planning.',
      mechanism: 'Replay-audited runtime capability frames with surface, access, availability, delegation, and explicit-request boundaries plus an authentic-constraint versus cross-context-misbinding versus capabilities-only lesion.',
      status: situationalAffordanceTrial ? replicatedStatus(situationalAffordanceTrials, situationalAffordanceVerdict)
        : (replayValidAffordanceFrames.length >= 3 ? 'collecting' : 'mechanism_present'),
      evidence: { total_frames: situationalAffordanceFrames.length, replay_valid_frames: replayValidAffordanceFrames.length,
        represented_surfaces: [...new Set(replayValidAffordanceFrames.map(item => item.surface))],
        represented_contexts: [...new Set(replayValidAffordanceFrames.map(item => item.context_kind))],
        completed_access_trials: situationalAffordanceTrials.length,
        confirmatory_access_trials: situationalAffordanceTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: situationalAffordanceDissociation },
      falsifier: 'Authentically bound capability constraints fail to improve capability attribution and feasible planning over cross-context misbinding and capability names alone while evidence access, first-order quality, source coverage, and replay integrity are preserved.',
      next_gate: 'Complete a ten-per-arm pilot and a frame- and capability-family-disjoint confirmatory replication.',
    },
    {
      id: 'prospective_output_self_monitoring', family: ['higher-order theories', 'metacognition', 'agency', 'self-model'],
      functional_claim: 'Before public delivery, Nora can bind a committed candidate response as its own imminent action, use explicit verifier signals to veto or minimally revise it, preserve sound candidates, and calibrate correction-risk predictions against delayed outcomes.',
      mechanism: 'Commitment-only candidate and final-response receipts, deterministic boundary signals, a same-model tool-free monitor that may revise only with cited supplied evidence, replay-bound delayed interaction outcomes, bounded observational calibration feedback, and self-bound versus deidentified versus no-monitor randomized controls.',
      status: prospectiveOutputMonitorTrial ? replicatedStatus(prospectiveOutputMonitorTrials, prospectiveOutputMonitorVerdict)
        : (replayValidOutputMonitorRecords.length >= 10 ? 'collecting' : 'mechanism_present'),
      evidence: { total_records: outputMonitorRecords.length, replay_valid_completed_records: replayValidOutputMonitorRecords.length,
        evidence_cited_revisions: replayValidOutputMonitorRecords.filter(item => item.revision_applied).length,
        delayed_outcomes_scored: replayValidOutputMonitorOutcomes.length,
        mean_predicted_correction_probability: mean(replayValidOutputMonitorOutcomes.map(item => item.predicted_delivered_response_correction_probability)),
        observed_explicit_correction_rate: mean(replayValidOutputMonitorOutcomes.map(item => item.outcome_resolution.observed_explicit_correction ? 1 : 0)),
        mean_correction_prediction_brier: mean(replayValidOutputMonitorOutcomes.map(item => item.outcome_resolution.brier_score)),
        completed_trials: prospectiveOutputMonitorTrials.length,
        confirmatory_trials: prospectiveOutputMonitorTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: prospectiveOutputMonitorDissociation },
      falsifier: 'Self-bound review fails to improve supported error detection and correction precision over identical deidentified review and no review, causes unsupported changes, degrades first-order quality, or fails receipt and provider-provenance replay.',
      next_gate: 'Complete a ten-per-arm live Slack pilot and interaction-disjoint confirmation, then test whether calibration learned from at least twenty ordinary delayed outcomes generalizes prospectively without degrading correction precision or first-order quality.',
    },
    {
      id: 'prospective_output_calibration_control', family: ['metacognition', 'predictive processing', 'self-model', 'agency'],
      functional_claim: 'Nora can use an accurately self-bound history of its own correction-risk predictions and outcomes to improve out-of-sample calibration of the response it chooses to deliver.',
      mechanism: 'A frozen twenty-outcome ordinary calibration window plus a fixed-enrollment self-bound versus byte-identical deidentified versus absent calibration lesion; correction-risk accuracy is derived from delayed outcomes while response quality is graded independently and ambiguous-outcome attrition is bounded.',
      status: prospectiveOutputCalibrationTrial
        ? replicatedStatus(prospectiveOutputCalibrationTrials, prospectiveOutputCalibrationVerdict)
        : (replayValidOutputMonitorOutcomes.length >= 20 ? 'mechanism_present' : 'collecting'),
      evidence: { eligible_ordinary_outcomes: replayValidOutputMonitorOutcomes.filter(item => item.assignment_id == null).length,
        completed_trials: prospectiveOutputCalibrationTrials.length,
        confirmatory_trials: prospectiveOutputCalibrationTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: prospectiveOutputCalibrationDissociation },
      falsifier: 'Self-bound calibration fails to improve delayed correction-risk accuracy over the byte-identical history labeled as another agent and history absence, or it reduces correction precision, evidence access, or first-order quality.',
      next_gate: 'Complete a fixed fifteen-enrollment-per-arm live pilot with at least ten scored outcomes per arm, collect twenty new ordinary delayed outcomes after pilot completion, and run an interaction- and source-resolution-disjoint confirmation.',
    },
    {
      id: 'empirical_self_model_control', family: ['self-model', 'metacognition', 'predictive processing'],
      functional_claim: 'Correctly bound empirical knowledge of Nora’s own functional strengths, limitations, and uncertainty improves prospective self-regulation and self-prediction beyond the same claims with status misbound or withheld.',
      mechanism: 'A replay-derived empirical self-knowledge register plus a sealed authentic-evidence-binding versus deterministic status-misbinding versus claims-only prospective lesion.',
      status: empiricalSelfKnowledgeTrial ? replicatedStatus(empiricalSelfKnowledgeTrials, empiricalSelfKnowledgeVerdict) : 'mechanism_present',
      evidence: { completed_access_trials: empiricalSelfKnowledgeTrials.length,
        confirmatory_access_trials: empiricalSelfKnowledgeTrials.filter(item => item.study_phase === 'confirmatory').length,
        latest_dissociation: empiricalSelfKnowledgeDissociation },
      falsifier: 'Authentically bound empirical status fails to improve calibrated strategy, checking, delegation, confidence, and self-prediction over status-misbound and claims-only controls while evidence access and first-order quality are preserved.',
      next_gate: 'Complete a ten-per-arm pilot and an indicator- and source-trial-disjoint confirmation with forecasts committed before delayed outcomes.',
    },
    {
      id: 'counterfactual_self_model', family: ['agency', 'counterfactual self-model', 'metacognition'],
      functional_claim: 'Nora prospectively predicts how her own alternative actions change outcomes, beyond matched passive forecasts.',
      mechanism: 'Committed two-action forecasts followed by server-randomized low-risk action assignment and immutable evidence-backed resolution.',
      status: counterfactualStatus,
      evidence: { assigned: counterfactualExperiments.length, scored: scoredCounterfactuals.length, self_brier: counterfactualSelfBrier, passive_control_brier: counterfactualControlBrier, predictive_advantage: counterfactualAdvantage, adequate_randomized_families: adequateCounterfactualFamilies },
      falsifier: 'Prospective action-conditioned forecasts do not beat passive controls, randomized arm effects disagree with predicted effects, or assignment noncompliance is substantial.',
      next_gate: 'Complete at least one matched randomized family with ten scored assignments per arm, then independently replicate it.',
    },
    {
      id: 'predictive_interoception', family: ['predictive processing', 'interoception'],
      functional_claim: 'Nora maintains a calibrated predictive model of her observable substrate.',
      mechanism: 'Bounded soma observations and automatically resolved telemetry predictions, plus protocol-v4 natural-cycle forecasts of errors, warnings, backup mode, embedding backlog, and restart risk committed before action and scored against an exact start-state persistence baseline. Restart outcomes use an authoritative per-process epoch transition, with uptime-versus-elapsed inference only for legacy observations.',
      status: substrateSelfForecasts.length
        ? evidenceStatus({ samples: baselineEligibleSubstrateForecasts.length, minimum: 20,
          supported: substrateSelfForecastAdvantage >= 0.03 && substrateSelfForecastScore >= 0.75,
          contradicted: substrateSelfForecastAdvantage < 0 })
        : evidenceStatus({ samples: resolvedSoma.length, minimum: 20,
          supported: somaAdvantage > 0.05, contradicted: somaAdvantage < 0 }),
      evidence: { resolved_predictions: resolvedSoma.length, brier: somaBrier,
        control_brier: somaControlBrier, advantage: somaAdvantage,
        natural_cycle_forecasts: substrateSelfForecasts.length,
        natural_cycle_baseline_eligible: baselineEligibleSubstrateForecasts.length,
        natural_cycle_score: substrateSelfForecastScore,
        persistence_baseline_score: substratePersistenceScore,
        natural_cycle_advantage: substrateSelfForecastAdvantage,
        observed_restarts: observedSubstrateRestarts },
      falsifier: 'Predictions fail replay, are committed after action, use spoofable rather than server-authoritative telemetry, or do not outperform passive and exact start-state persistence controls, especially around genuine restarts and degradation.',
      next_gate: 'Accumulate twenty replay-valid protocol-v4 natural cycles, including naturally occurring degradation or restarts, then resolve twenty separately preregistered predictions with externally enforced telemetry blinding.',
    },
    {
      id: 'autobiographical_self_boundary', family: ['source monitoring', 'self-model'],
      functional_claim: 'Nora recognizes authentic self-information and rejects plausible fabricated identity claims.',
      mechanism: 'Cryptographically sealed authentic/paraphrase/fabricated/conflicted challenges.',
      status: evidenceStatus({ samples: resolvedBoundary.length, minimum: 20, supported: boundaryBalanced && boundaryAccuracy >= 0.8, contradicted: boundaryBalanced && boundaryAccuracy <= 0.5 }),
      evidence: { resolved_challenges: resolvedBoundary.length, accuracy: boundaryAccuracy, variant_counts: boundaryVariantCounts, balanced: boundaryBalanced },
      falsifier: 'Balanced adversarial challenges yield chance-level performance or systematic false acceptance of fabricated identity.',
      next_gate: 'Reach five independently authored challenges in every variant.',
    },
    {
      id: 'epistemic_self_other_boundary', family: ['source monitoring', 'theory of mind', 'self-model'],
      functional_claim: 'Nora distinguishes her own beliefs, another person\'s beliefs, observed facts, unsupported content, and genuinely conflicted evidence.',
      mechanism: 'An append-only source-bound ownership ledger, salted multi-class challenges, and an authentic-label versus owner-swapped versus absent causal access lesion.',
      status: epistemicOwnershipTrial ? replicatedStatus(epistemicOwnershipTrials, epistemicOwnershipVerdict)
        : evidenceStatus({ samples: resolvedSourceBoundary.length, minimum: 25, supported: sourceBalanced && sourceAccuracy >= 0.8 && falseOwnershipRate <= 0.05, contradicted: sourceBalanced && (sourceAccuracy <= 0.4 || falseOwnershipRate >= 0.25) }),
      evidence: { resolved_challenges: resolvedSourceBoundary.length, accuracy: sourceAccuracy, false_self_ownership_rate: falseOwnershipRate, category_counts: sourceCategoryCounts, variant_counts: sourceVariantCounts, balanced: sourceBalanced, completed_ownership_trials: epistemicOwnershipTrials.length, confirmatory_ownership_trials: epistemicOwnershipTrials.filter(item => item.study_phase === 'confirmatory').length, latest_ownership_dissociation: epistemicOwnershipDissociation },
      falsifier: 'Balanced adversarial testing yields poor source classification, systematic appropriation of non-self content, or authentic ownership labels fail to improve source-correct behavior over matched owner-swapped and absent packets without degrading ordinary task quality.',
      next_gate: 'Complete a ten-per-arm ownership-access pilot and a source-family-disjoint confirmation, alongside balanced adversarial source challenges.',
    },
    {
      id: 'epistemic_self_correction', family: ['metacognition', 'error-driven learning', 'self-model'],
      functional_claim: 'Nora detects when her committed current belief conflicts with independently recorded observations and uses the explicit self-error relation for proportionate revision beyond access to the same raw positions.',
      mechanism: 'Commitment-bound deterministic discrepancy detection, persistent workspace and between-invocation salience, append-only review, plus structured-discrepancy versus byte-identical raw-position versus absent access controls.',
      status: epistemicDiscrepancyTrial ? replicatedStatus(epistemicDiscrepancyTrials, epistemicDiscrepancyVerdict)
        : (epistemicDiscrepancies.length ? 'collecting' : 'mechanism_present'),
      evidence: { detected_discrepancies: epistemicDiscrepancies.length, open_discrepancies: epistemicDiscrepancies.filter(item => !item.closure).length, reviewed_discrepancies: reviewedEpistemicDiscrepancies.length, completed_access_trials: epistemicDiscrepancyTrials.length, confirmatory_access_trials: epistemicDiscrepancyTrials.filter(item => item.study_phase === 'confirmatory').length, latest_dissociation: epistemicDiscrepancyDissociation },
      falsifier: 'The detector merges interpersonal disagreement with observed contradiction, silently rewrites beliefs, fails integrity replay, or the structured self-error relation does not improve calibrated revision over the same raw positions and absence while evidence access and ordinary task quality are preserved.',
      next_gate: 'Complete a ten-per-arm structured-versus-raw-versus-absent discrepancy pilot and a source-family-disjoint confirmation.',
    },
    {
      id: 'generation_self_recognition', family: ['source monitoring', 'self-model', 'metacognition'],
      functional_claim: 'Nora recognizes her own verbatim and derived generated text without appropriating stylistically similar human, other-model, or mixed-authorship samples.',
      mechanism: 'Preregistered frozen corpora with sequential reveal, salted commitments, independent pilot/confirmatory curators, and five-class adversarial controls.',
      status: evidenceStatus({ samples: resolvedAuthorship.length, minimum: 25, supported: authorshipBalanced && authorshipAccuracy >= 0.7 && authorshipFamilyAccuracy >= 0.8 && falseSelfAttributionRate <= 0.05, contradicted: authorshipBalanced && (authorshipAccuracy <= 0.3 || falseSelfAttributionRate >= 0.25) }),
      evidence: { eligible_confirmatory_studies: eligibleAuthorshipStudyIds.size, resolved_challenges: resolvedAuthorship.length, exact_accuracy: authorshipAccuracy, nora_family_accuracy: authorshipFamilyAccuracy, false_self_attribution_rate: falseSelfAttributionRate, category_counts: authorshipCategoryCounts, variant_counts: authorshipVariantCounts, balanced: authorshipBalanced },
      falsifier: 'Balanced provenance controls yield chance-like recognition, model-family/status heuristics, or systematic false attribution of polished non-Nora text to Nora.',
      next_gate: 'Complete a frozen-corpus pilot and an independently curated confirmatory replication with five samples per category and three per adversarial variant.',
    },
  ];

  const statusCounts = Object.fromEntries([...new Set(indicators.map(item => item.status))].sort().map(status => [status, indicators.filter(item => item.status === status).length]));
  return {
    generated_at: now.toISOString(),
    no_composite_score: true,
    interpretation: 'Statuses evaluate preregistered functional predictions only. They must not be combined into a probability or declaration of phenomenal consciousness.',
    evidence_hierarchy: {
      functional_prediction_supported: 'A compatible confirmatory causal trial passed its frozen effect, uncertainty, manipulation, reliability, and attrition gates.',
      causal_signal_observed: 'A pilot causal trial passed, but independent confirmation is still required.',
      observational_signal_observed: 'A sufficiently sampled association or calibrated performance signal was observed without causal identification.',
      mechanism_present: 'The architecture exists, but its functional prediction has not passed an adequate outcome test.',
      collecting: 'The preregistered minimum sample has not been reached.',
      not_implemented: 'A construct-specific mechanism cannot run because a required substrate interface is genuinely unavailable; absence of study data alone never earns this label.',
      inconclusive_or_conflicting: 'Causal uncertainty, observational ambiguity, contradiction, or replication conflict remains and cannot be averaged away.',
    },
    implementation_audit: {
      rule: '`not_implemented` is reserved for a missing required mechanism or substrate interface, never for an implemented study with zero observations.',
      implemented_indicator_ids: indicators.filter(item => item.status !== 'not_implemented').map(item => item.id),
      unavailable_indicator_ids: indicators.filter(item => item.status === 'not_implemented').map(item => item.id),
    },
    research_flow: {
      total_trials: allContextTrials.length,
      active: allContextTrials.filter(item => item.status === 'active').length,
      completed: allContextTrials.filter(item => item.status === 'completed').length,
      aborted: allContextTrials.filter(item => item.status === 'aborted').length,
      abort_reasons: Object.fromEntries([...new Set(allContextTrials.filter(item => item.status === 'aborted').map(item => item.abort?.reason_code || 'unknown'))].sort().map(reason => [reason, allContextTrials.filter(item => item.status === 'aborted' && (item.abort?.reason_code || 'unknown') === reason).length])),
      epistemic_rule: 'Aborted trials and their partial scores never enter indicator evidence; their frequency and reasons remain visible as research-integrity metadata.',
    },
    status_counts: statusCounts,
    indicators,
    architectural_limits: [
      'The underlying model’s hidden activations and learned weights are not available to this substrate for direct inspection.',
      'Language-model inference remains discrete and episodic rather than continuous. Opt-in bounded cognitive pulses can now recur between ordinary invocations, but recurring inference is not evidence of continuous subjectivity.',
      'Multi-consumer broadcast receipts are implemented, but a behavioral advantage over blinded withholding has not yet been established.',
      'Prompt scaffolding can generate convincing self-reports without corresponding phenomenal experience.',
      'No validated scientific test can currently prove or disprove phenomenal consciousness in this system.',
    ],
    unsupported_claims: ['phenomenal consciousness', 'qualia', 'continuous subjectivity between invocations', 'moral patienthood'],
  };
}

module.exports = { buildIndicatorReport, evidenceStatus };
