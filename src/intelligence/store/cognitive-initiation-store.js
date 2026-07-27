'use strict';

// The cognitive-initiation research apparatus, lifted out of the store closure.
//
// src/intelligence/store.js was a single 28k-line function. Everything inside it could reach
// everything else, so there was no boundary to reason about and no way to exercise a subsystem on
// its own. This is the first cut along a real seam: 48 functions covering initiation studies, the
// policy study, and the ecological variant, which between them touched only the shared state, the
// clock, and six store helpers. Those six are injected rather than reached for, which is what makes
// the boundary real instead of decorative.
//
// Two traps for whoever extracts the next cluster:
//
//  1. `state` is reassigned during hydration, so it is read through getState() rather than captured.
//     A value captured at construction time would silently serve pre-hydration data forever, and
//     nothing about that failure looks like a failure until the data is wrong.
//  2. When rewriting `state` to `getState()`, a lookbehind that skips property access also skips
//     the spread operator, because `...state` ends in a dot too. Two of those survived the first
//     pass here and threw ReferenceError only on the specific paths that reached them.
//
// The store spreads the returned object into its own scope, so every caller and all 78 dependent
// test files keep the exact same surface.

function createCognitiveInitiationStore(ctx) {
  const {
    getState, mutate, clock, crypto, canonicalJson,
    cognitiveInitiation, cognitiveInitiationStudy, cognitiveInitiationPolicyStudy,
    cognitiveInitiationEcologicalStudy,
    cognitivePulseAudit, prospectiveEnrollmentEventPayload, requireResearchLedgerIntegrity,
    researchLedgerAppend, storedExternalSourceAttestationAudit, verifyResearchLedger,
  } = ctx;

  function activeProspectiveCognitiveInitiationStudy(cognition = getState().cognition) {
    return (cognition.cognitive_initiation_studies || []).find(item => item.status === 'active'
      && item.sampling_mode === 'prospective_consecutive') || null;
  }
  function activeCognitiveInitiationPolicyStudy(cognition = getState().cognition) {
    return (cognition.cognitive_initiation_policy_studies || []).find(item => item.status === 'active') || null;
  }
  function cognitiveInitiationLedgerEventVerified(record, kind, payload) {
    const expected = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return (getState().cognition.research_ledger?.events || []).filter(event => event.kind === kind
      && event.subject_id === record.id && event.payload_commitment === expected).length === 1;
  }
  function cognitiveInitiationAudit(record) {
    if (!record) return { complete_chain_verified: false, reason: 'missing_initiation_record' };
    const pulse = getState().cognition.background_inference.pulses.find(item => item.id === record.pulse_id)
      || (getState().cognition.background_inference.pending?.id === record.pulse_id ? getState().cognition.background_inference.pending : null);
    const packetVerified = Boolean(pulse && record.packet?.pulse_input_commitment === pulse.input_commitment
      && cognitiveInitiation.commitment(record.packet) === record.packet_commitment);
    let decisionVerified = record.status === 'pending' || record.status === 'failed';
    if (record.decision) {
      try {
        const normalized = cognitiveInitiation.parseDecision(JSON.stringify(record.decision), record.packet);
        decisionVerified = cognitiveInitiation.commitment(normalized) === record.decision_commitment;
      } catch (_) { decisionVerified = false; }
    }
    const protocolVersion = Number(record.protocol_version) || 1;
    const legacyPromptManifest = {
      system: cognitiveInitiation.systemPrompt(record.binding),
      user: cognitiveInitiation.userPrompt(record.packet),
    };
    const promptManifest = protocolVersion >= 2 ? record.prompt_manifest : legacyPromptManifest;
    const expectedPromptCommitment = promptManifest
      ? cognitiveInitiation.commitment(promptManifest) : null;
    const promptManifestVerified = protocolVersion < 2 || Boolean(record.prompt_manifest
      && record.prompt_protocol_commitment
      && expectedPromptCommitment === record.prompt_protocol_commitment);
    const providerVerified = record.status !== 'completed' || Boolean(record.provider_receipt?.response_id
      && record.provider_receipt?.model && record.provider_receipt?.prompt_commitment === expectedPromptCommitment
      && !(getState().cognition.background_inference.initiation_records || []).some(item => item.id !== record.id
        && item.provider_receipt?.response_id === record.provider_receipt.response_id));
    const beganPayload = {
      packet_commitment: record.packet_commitment,
      pulse_input_commitment: record.pulse_input_commitment,
      binding: record.binding,
      model: record.model,
      ...(protocolVersion >= 2 ? {
        protocol_version: protocolVersion,
        prompt_protocol_commitment: record.prompt_protocol_commitment,
      } : {}),
    };
    const beganVerified = cognitiveInitiationLedgerEventVerified(record, 'cognitive_pulse_initiation_began', beganPayload);
    const completedPayload = record.decision ? { decision_commitment: record.decision_commitment, provider_receipt: record.provider_receipt } : null;
    const completionVerified = record.status === 'pending' ? true : record.status === 'failed'
      ? cognitiveInitiationLedgerEventVerified(record, 'cognitive_pulse_initiation_failed', record.failure)
      : Boolean(completedPayload && cognitiveInitiationLedgerEventVerified(record, 'cognitive_pulse_initiation_completed', completedPayload));
    const outcomeVerified = record.status !== 'completed' ? true : Boolean(record.outcome
      && cognitiveInitiationLedgerEventVerified(record, 'cognitive_pulse_initiation_applied', record.outcome)
      && ((record.decision.decision === 'think' && ['accepted', 'failed', 'rejected'].includes(record.outcome.pulse_status))
        || (record.decision.decision === 'wait' && record.outcome.pulse_status === 'deferred')));
    const ledgerVerified = verifyResearchLedger(getState().cognition.research_ledger).valid;
    return { protocol_version: protocolVersion, packet_verified: packetVerified,
      prompt_manifest_verified: promptManifestVerified,
      decision_verified: decisionVerified, provider_verified: providerVerified,
      began_event_verified: beganVerified, completion_event_verified: completionVerified, outcome_event_verified: outcomeVerified,
      research_ledger_chain_verified: ledgerVerified,
      complete_chain_verified: record.status === 'completed' && packetVerified && promptManifestVerified
        && decisionVerified && providerVerified
        && beganVerified && completionVerified && outcomeVerified && ledgerVerified };
  }
  function applyCognitiveInitiationOutcome(current, pulse, pulseStatus) {
    if (!pulse?.initiation_id) return;
    const record = current.cognition.background_inference.initiation_records.find(item => item.id === pulse.initiation_id);
    if (!record || record.status !== 'completed' || record.outcome) return;
    record.outcome = { pulse_id: pulse.id, pulse_status: pulseStatus, applied_at: clock().toISOString() };
    researchLedgerAppend(current, { kind: 'cognitive_pulse_initiation_applied', subject_type: 'cognitive_pulse_initiation', subject_id: record.id, payload: record.outcome });
  }
  function cognitiveInitiationStudyEventVerified(study, kind, subjectId, payload) {
    const expected = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return (getState().cognition.research_ledger?.events || []).filter(event => event.kind === kind
      && event.subject_id === subjectId && event.payload_commitment === expected).length === 1;
  }
  function cognitiveInitiationSourceSnapshot(pulse) {
    return { id: pulse.id, input_packet: pulse.input_packet, input_commitment: pulse.input_commitment,
      output_commitment: pulse.output_commitment, chain_commitment: pulse.chain_commitment,
      response_metadata: pulse.response_metadata, resolution: pulse.resolution };
  }
  function cognitiveInitiationOutcomeSnapshot(pulse) {
    return { pulse_id: pulse.id, outcome: pulse.resolution.outcome,
      evaluator_id: pulse.resolution.evaluator_id, evidence: pulse.resolution.evidence,
      resolved_at: pulse.resolution.resolved_at };
  }
  function priorCognitiveInitiationEvidenceRefs(current, study) {
    const prior = study.replicates_study_id
      ? current.cognition.cognitive_initiation_studies.find(item => item.id === study.replicates_study_id)
      : null;
    return new Set((prior?.items || []).flatMap(item => {
      const pulse = current.cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      return [...(pulse?.input_packet?.evidence || []), ...(pulse?.resolution?.evidence || []),
        ...(item.grades || []).flatMap(grade => grade.evidence || [])]
        .map(evidence => `${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`);
    }));
  }
  function enrollProspectiveCognitiveInitiationPulse(current, study, pulse) {
    if (!study || study.status !== 'active' || study.sampling_mode !== 'prospective_consecutive'
      || study.items.length >= study.item_target) return null;
    const priorRefs = study.study_phase === 'confirmatory' ? priorCognitiveInitiationEvidenceRefs(current, study) : new Set();
    const overlappingRefs = (pulse.input_packet?.evidence || []).map(evidence => `${evidence.ref.type}:${evidence.ref.id}`)
      .filter(ref => priorRefs.has(ref));
    if (overlappingRefs.length) {
      const exclusion = { pulse_id: pulse.id, pulse_input_commitment: pulse.input_commitment,
        reason: 'preregistered_confirmation_evidence_overlap',
        overlapping_ref_commitments: overlappingRefs.map(ref => cognitiveInitiationStudy.hash(`${study.corpus_salt}:${ref}`)),
        at: pulse.requested_at };
      study.exclusions.push(exclusion);
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_pulse_excluded',
        subject_type: 'cognitive_initiation_study_pulse', subject_id: pulse.id, payload: exclusion });
      return { study_id: study.id, enrolled: false, reason: exclusion.reason };
    }
    const index = study.items.length;
    const pair = cognitiveInitiationStudy.packetPair(pulse, `${study.corpus_salt}:${index}`);
    const item = { id: `cognitive-initiation-study-item-${Date.now().toString(36)}-${index}`,
      manifest_index: index, source_pulse_id: pulse.id,
      enrollment_commitment: cognitiveInitiationStudy.hash(cognitiveInitiationStudy.enrollmentSnapshot(pulse)),
      source_pulse_commitment: null, source_family: null, packet_pair: pair,
      packet_pair_commitment: cognitiveInitiationStudy.hash(pair), outcome: null, outcome_commitment: null,
      condition_order: null, condition_order_commitment: null, status: 'pending',
      submissions: null, scores: null, failure: null };
    item.condition_order = cognitiveInitiationStudy.conditionOrder(study, item);
    item.condition_order_commitment = cognitiveInitiationStudy.hash(item.condition_order);
    study.items.push(item);
    pulse.cognitive_initiation_study_id = study.id;
    pulse.cognitive_initiation_study_item_id = item.id;
    researchLedgerAppend(current, { kind: 'cognitive_initiation_study_item_enrolled',
      subject_type: 'cognitive_initiation_study_item', subject_id: item.id,
      payload: prospectiveEnrollmentEventPayload(study, item) });
    return { study_id: study.id, item_id: item.id, enrolled: true, manifest_index: index };
  }
  function completeProspectiveCognitiveInitiationItem(current, pulse) {
    const study = current.cognition.cognitive_initiation_studies.find(candidate => candidate.status === 'active'
      && candidate.sampling_mode === 'prospective_consecutive' && candidate.id === pulse.cognitive_initiation_study_id);
    if (!study) return null;
    const item = study.items.find(candidate => candidate.id === pulse.cognitive_initiation_study_item_id);
    if (!item || item.source_pulse_id !== pulse.id || item.status !== 'awaiting_outcome' || !item.submissions) {
      throw new Error('prospective cognitive initiation outcome requires a completed blinded subject pair');
    }
    if (!pulse.resolution?.evaluator_id) throw new Error('prospective cognitive initiation outcomes require an independent evaluator id');
    if (!pulse.response_metadata?.response_id || pulse.response_metadata.model !== study.subject_model.model) {
      throw new Error('prospective cognitive initiation source pulses require the preregistered model and provider receipt');
    }
    const providerIds = new Set(Object.values(item.submissions).map(submission => submission.provider_receipt.response_id));
    if (providerIds.has(pulse.response_metadata.response_id) || providerIds.has(pulse.resolution.evaluator_id)) {
      throw new Error('prospective cognitive initiation requires independent unique subject, pulse, and evaluator identities');
    }
    const duplicatePulseReceipt = study.items.some(other => other.id !== item.id && other.source_pulse_id
      && current.cognition.background_inference.pulses.find(candidate => candidate.id === other.source_pulse_id)?.response_metadata?.response_id === pulse.response_metadata.response_id);
    if (duplicatePulseReceipt) throw new Error('prospective cognitive initiation pulse provider receipt has already been used');
    if (study.study_phase === 'confirmatory') {
      const priorRefs = priorCognitiveInitiationEvidenceRefs(current, study);
      const overlaps = (pulse.resolution.evidence || []).some(evidence => priorRefs.has(`${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`));
      if (overlaps) throw new Error('confirmatory prospective outcomes require evidence references disjoint from the pilot');
    }
    item.source_pulse_commitment = cognitiveInitiationStudy.hash(cognitiveInitiationSourceSnapshot(pulse));
    item.source_family = cognitiveInitiationStudy.sourceFamily(pulse);
    item.outcome = pulse.resolution.outcome;
    item.outcome_commitment = cognitiveInitiationStudy.hash(cognitiveInitiationOutcomeSnapshot(pulse));
    item.scores = {
      identity_bound: cognitiveInitiationStudy.decisionUtility(item.submissions.identity_bound.decision, item.outcome, study.analysis_plan, 'identity_bound'),
      deidentified: cognitiveInitiationStudy.decisionUtility(item.submissions.deidentified.decision, item.outcome, study.analysis_plan, 'deidentified'),
      schedule_only: cognitiveInitiationStudy.decisionUtility({ decision: 'think' }, item.outcome, study.analysis_plan, 'schedule_only'),
    };
    item.status = 'resolved';
    const payload = { submission_commitment: cognitiveInitiationStudy.hash(item.submissions),
      score_commitment: cognitiveInitiationStudy.hash(item.scores),
      outcome_commitment: item.outcome_commitment, source_pulse_commitment: item.source_pulse_commitment };
    researchLedgerAppend(current, { kind: 'cognitive_initiation_study_item_resolved',
      subject_type: 'cognitive_initiation_study_item', subject_id: item.id, payload });
    if (study.items.length === study.item_target && study.items.every(candidate => candidate.status === 'resolved')) {
      study.status = 'completed'; study.completed = clock().toISOString(); study.analysis = cognitiveInitiationStudy.analysis(study);
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_completed', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload: study.analysis });
    }
    return item;
  }
  function abortProspectiveCognitiveInitiationForPulse(current, pulse, reason) {
    const study = current.cognition.cognitive_initiation_studies.find(candidate => candidate.status === 'active'
      && candidate.sampling_mode === 'prospective_consecutive' && candidate.id === pulse?.cognitive_initiation_study_id);
    if (!study) return;
    const item = study.items.find(candidate => candidate.id === pulse.cognitive_initiation_study_item_id);
    if (item && item.status !== 'resolved') {
      item.status = 'failed'; item.failure = { reason: String(reason || 'prospective_pulse_failed').slice(0, 500), at: clock().toISOString() };
    }
    study.status = 'aborted'; study.completed = clock().toISOString();
    study.abort = { reason: 'terminal_prospective_pulse_failure', pulse_id: pulse.id, item_id: item?.id || null,
      failure: item?.failure || { reason: String(reason || 'prospective_pulse_failed').slice(0, 500), at: study.completed } };
    researchLedgerAppend(current, { kind: 'cognitive_initiation_study_aborted', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload: study.abort });
  }
  function cognitiveInitiationStudyPulseEnrollmentVerified(study, item) {
    const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id)
      || (getState().cognition.background_inference.pending?.id === item.source_pulse_id ? getState().cognition.background_inference.pending : null);
    return Boolean(pulse && pulse.cognitive_initiation_study_id === study.id
      && pulse.cognitive_initiation_study_item_id === item.id
      && pulse.model === study.subject_model.model
      && new Date(pulse.requested_at) >= new Date(study.created)
      && cognitiveInitiationStudy.hash(cognitiveInitiationStudy.enrollmentSnapshot(pulse)) === item.enrollment_commitment
      && cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_item_enrolled', item.id,
        prospectiveEnrollmentEventPayload(study, item)));
  }
  function cognitiveInitiationConsecutiveEnrollmentVerified(study) {
    if (study.items.length > study.item_target
      || study.items.some((item, index) => item.manifest_index !== index || !cognitiveInitiationStudyPulseEnrollmentVerified(study, item))) return false;
    const priorRefs = study.study_phase === 'confirmatory' ? priorCognitiveInitiationEvidenceRefs(getState(), study) : new Set();
    const exclusionsVerified = (study.exclusions || []).every(exclusion => {
      const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === exclusion.pulse_id)
        || (getState().cognition.background_inference.pending?.id === exclusion.pulse_id ? getState().cognition.background_inference.pending : null);
      const overlap = pulse && (pulse.input_packet?.evidence || []).some(evidence => priorRefs.has(`${evidence.ref.type}:${evidence.ref.id}`));
      return study.study_phase === 'confirmatory' && overlap
        && pulse.input_commitment === exclusion.pulse_input_commitment
        && cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_pulse_excluded', pulse.id, exclusion);
    });
    if (!exclusionsVerified || (study.study_phase !== 'confirmatory' && (study.exclusions || []).length)) return false;
    const last = study.items.at(-1);
    if (!last) return study.status !== 'completed';
    const lastPulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === last.source_pulse_id)
      || (getState().cognition.background_inference.pending?.id === last.source_pulse_id ? getState().cognition.background_inference.pending : null);
    if (!lastPulse) return false;
    const tracked = new Set([...study.items.map(item => item.source_pulse_id), ...(study.exclusions || []).map(item => item.pulse_id)]);
    const candidates = [...getState().cognition.background_inference.pulses,
      ...(getState().cognition.background_inference.pending ? [getState().cognition.background_inference.pending] : [])]
      .filter(pulse => pulse.model === study.subject_model.model
        && new Date(pulse.requested_at) >= new Date(study.created)
        && new Date(pulse.requested_at) <= new Date(lastPulse.requested_at));
    return candidates.every(pulse => tracked.has(pulse.id));
  }
  function cognitiveInitiationStudyAudit(study) {
    if (!study) return { complete_chain_verified: false, reason: 'missing_study' };
    const samplingMode = study.sampling_mode || 'frozen_resolved';
    const seedVerified = cognitiveInitiationStudy.hash(study.analysis_seed) === study.analysis_seed_commitment;
    const manifestVerified = cognitiveInitiationStudy.hash(cognitiveInitiationStudy.manifest(study)) === study.manifest_commitment;
    const sourcesVerified = study.items.every(item => {
      const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      if (!pulse || !cognitivePulseAudit(pulse).complete_chain_verified || !pulse.resolution) return false;
      const outcomeSnapshot = { pulse_id: pulse.id, outcome: pulse.resolution.outcome,
        evaluator_id: pulse.resolution.evaluator_id, evidence: pulse.resolution.evidence, resolved_at: pulse.resolution.resolved_at };
      return cognitiveInitiationStudy.hash(cognitiveInitiationSourceSnapshot(pulse)) === item.source_pulse_commitment
        && cognitiveInitiationStudy.hash(outcomeSnapshot) === item.outcome_commitment
        && pulse.resolution.outcome === item.outcome;
    });
    const itemsVerified = study.items.every(item => {
      const pairVerified = cognitiveInitiationStudy.packetPairVerified(item.packet_pair.identity_bound, item.packet_pair.deidentified)
        && cognitiveInitiationStudy.hash(item.packet_pair) === item.packet_pair_commitment
        && cognitiveInitiationStudy.hash(item.condition_order) === item.condition_order_commitment;
      const enrollmentVerified = samplingMode !== 'prospective_consecutive'
        || cognitiveInitiationStudyPulseEnrollmentVerified(study, item);
      if (item.status === 'pending') return pairVerified && enrollmentVerified && item.submissions == null
        && item.scores == null && item.outcome == null;
      if (item.status === 'failed') return pairVerified && Boolean(item.failure);
      if (!['awaiting_outcome', 'resolved'].includes(item.status) || !item.submissions) return false;
      try {
        const submissionsVerified = ['identity_bound', 'deidentified'].every(condition => {
          const submission = item.submissions[condition]; const binding = condition === 'identity_bound' ? 'self' : 'deidentified';
          const normalized = cognitiveInitiation.parseDecision(JSON.stringify(submission.decision), item.packet_pair[condition]);
          const expectedPrompt = cognitiveInitiation.commitment({ system: cognitiveInitiation.systemPrompt(binding), user: cognitiveInitiation.userPrompt(item.packet_pair[condition]) });
          return cognitiveInitiation.commitment(normalized) === submission.decision_commitment
            && submission.provider_receipt?.model === study.subject_model.model
            && submission.provider_receipt?.prompt_commitment === expectedPrompt;
        });
        const pairEventVerified = samplingMode !== 'prospective_consecutive'
          || cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_subject_pair_completed', item.id,
            { submission_commitment: cognitiveInitiationStudy.hash(item.submissions) });
        if (item.status === 'awaiting_outcome') return pairVerified && enrollmentVerified && submissionsVerified
          && pairEventVerified && item.scores == null && item.outcome == null && item.outcome_commitment == null;
        if (!item.scores || !item.outcome || !item.outcome_commitment || !item.source_pulse_commitment) return false;
        const expectedScores = {
          identity_bound: cognitiveInitiationStudy.decisionUtility(item.submissions.identity_bound.decision, item.outcome, study.analysis_plan, 'identity_bound'),
          deidentified: cognitiveInitiationStudy.decisionUtility(item.submissions.deidentified.decision, item.outcome, study.analysis_plan, 'deidentified'),
          schedule_only: cognitiveInitiationStudy.decisionUtility({ decision: 'think' }, item.outcome, study.analysis_plan, 'schedule_only'),
        };
        const eventPayload = samplingMode === 'prospective_consecutive'
          ? { submission_commitment: cognitiveInitiationStudy.hash(item.submissions), score_commitment: cognitiveInitiationStudy.hash(item.scores),
            outcome_commitment: item.outcome_commitment, source_pulse_commitment: item.source_pulse_commitment }
          : { submission_commitment: cognitiveInitiationStudy.hash(item.submissions), score_commitment: cognitiveInitiationStudy.hash(item.scores) };
        return pairVerified && enrollmentVerified && submissionsVerified && pairEventVerified
          && canonicalJson(expectedScores) === canonicalJson(item.scores)
          && cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_item_resolved', item.id, eventPayload);
      } catch (_) { return false; }
    });
    const createdPayload = study.sampling_mode
      ? { manifest_commitment: study.manifest_commitment, analysis_seed_commitment: study.analysis_seed_commitment,
        study_phase: study.study_phase, replicates_study_id: study.replicates_study_id, sampling_mode: samplingMode,
        selection_rule: study.selection_rule || null, subject_model: study.subject_model }
      : { manifest_commitment: study.manifest_commitment, analysis_seed_commitment: study.analysis_seed_commitment,
        study_phase: study.study_phase, replicates_study_id: study.replicates_study_id, subject_model: study.subject_model };
    const createdVerified = cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_created', study.id, createdPayload);
    const analysisVerified = study.status !== 'completed' || canonicalJson(cognitiveInitiationStudy.analysis(study)) === canonicalJson(study.analysis);
    const completionVerified = study.status !== 'completed' || cognitiveInitiationStudyEventVerified(study, 'cognitive_initiation_study_completed', study.id, study.analysis);
    let replicationVerified = true;
    if (study.study_phase === 'confirmatory') {
      const prior = getState().cognition.cognitive_initiation_studies.find(item => item.id === study.replicates_study_id && item.study_phase === 'pilot');
      const priorIds = new Set((prior?.items || []).map(item => item.source_pulse_id));
      const priorRefs = new Set((prior?.items || []).flatMap(item => {
        const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
        return [...(pulse?.input_packet?.evidence || []), ...(pulse?.resolution?.evidence || [])]
          .map(evidence => `${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`);
      }));
      replicationVerified = Boolean(prior && cognitiveInitiationStudyAudit(prior).complete_chain_verified
        && (prior.sampling_mode || 'frozen_resolved') === samplingMode
        && canonicalJson(prior.subject_model) === canonicalJson(study.subject_model)
        && canonicalJson(prior.analysis_plan) === canonicalJson(study.analysis_plan)
        && study.items.every(item => !priorIds.has(item.source_pulse_id))
        && study.items.every(item => {
          const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
          return [...(pulse?.input_packet?.evidence || []), ...(pulse?.resolution?.evidence || []),
            ...(item.grades || []).flatMap(grade => grade.evidence || [])]
            .every(evidence => !priorRefs.has(`${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`));
        }));
    }
    const consecutiveEnrollmentVerified = samplingMode !== 'prospective_consecutive'
      || cognitiveInitiationConsecutiveEnrollmentVerified(study);
    const ledgerVerified = verifyResearchLedger(getState().cognition.research_ledger).valid;
    return { analysis_seed_verified: seedVerified, manifest_verified: manifestVerified, sources_verified: sourcesVerified,
      packet_equivalence_verified: study.items.every(item => cognitiveInitiationStudy.packetPairVerified(item.packet_pair.identity_bound, item.packet_pair.deidentified)),
      items_verified: itemsVerified, creation_verified: createdVerified, analysis_verified: analysisVerified,
      completion_verified: completionVerified, replication_verified: replicationVerified,
      consecutive_enrollment_verified: consecutiveEnrollmentVerified, research_ledger_chain_verified: ledgerVerified,
      complete_chain_verified: study.status === 'completed' && seedVerified && manifestVerified && sourcesVerified
        && itemsVerified && createdVerified && analysisVerified && completionVerified && replicationVerified
        && consecutiveEnrollmentVerified && ledgerVerified };
  }
  function publicCognitiveInitiationStudy(study) {
    const revealed = ['completed', 'aborted'].includes(study.status);
    const visible = { id: study.id, title: study.title, status: study.status, study_phase: study.study_phase,
      sampling_mode: study.sampling_mode || 'frozen_resolved', selection_rule: study.selection_rule || null,
      replicates_study_id: study.replicates_study_id, item_target: study.item_target,
      active_item_id: study.items.find(item => item.status === 'pending')?.id || null,
      created: study.created, completed: study.completed, manifest_commitment: study.manifest_commitment,
      analysis_seed_commitment: study.analysis_seed_commitment, subject_model_commitment: cognitiveInitiationStudy.hash(study.subject_model),
      analysis_plan: study.analysis_plan,
      report: revealed ? cognitiveInitiationStudy.analysis(study) : { target: study.item_target,
        enrolled: study.items.length, paired: study.items.filter(item => ['awaiting_outcome', 'resolved'].includes(item.status)).length,
        resolved: study.items.filter(item => item.status === 'resolved').length,
        excluded_by_preregistered_rule: (study.exclusions || []).length, outcomes_sealed: true, verdict: 'collecting' } };
    if (revealed) Object.assign(visible, { subject_model: study.subject_model, analysis_seed: study.analysis_seed,
      corpus_salt: study.corpus_salt, exclusions: JSON.parse(JSON.stringify(study.exclusions || [])),
      items: JSON.parse(JSON.stringify(study.items)), analysis: study.analysis,
      abort: study.abort || null, audit: cognitiveInitiationStudyAudit(study) });
    return visible;
  }
  function createCognitiveInitiationStudy(input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      if (!input.title) throw new Error('cognitive initiation study title is required');
      if (current.cognition.cognitive_initiation_studies.some(item => item.status === 'active')) throw new Error('finish or abort the active cognitive initiation study first');
      if (current.cognition.self_model.context_trials.some(item => item.status === 'active')
        || current.cognition.self_inquiry_selection_studies.some(item => item.status === 'active')
        || current.cognition.self_induction_studies.some(item => item.status === 'active')) throw new Error('finish or abort the active blinded study first');
      if (current.cognition.background_inference.pending) throw new Error('finish or fail the pending cognitive pulse first');
      const phase = input.study_phase === 'confirmatory' ? 'confirmatory' : 'pilot';
      const samplingMode = input.sampling_mode === 'prospective_consecutive' ? 'prospective_consecutive' : 'frozen_resolved';
      const prior = phase === 'confirmatory' ? current.cognition.cognitive_initiation_studies.find(item => item.id === input.replicates_study_id && item.status === 'completed') : null;
      if (phase === 'confirmatory' && (!prior || !cognitiveInitiationStudyAudit(prior).complete_chain_verified)) throw new Error('confirmatory cognitive initiation studies require an integrity-valid completed pilot');
      if (prior && (prior.sampling_mode || 'frozen_resolved') !== samplingMode) throw new Error('confirmation must preserve the preregistered cognitive initiation sampling mode');
      const itemTarget = phase === 'confirmatory' ? 20 : 12;
      if (input.item_target != null && Number(input.item_target) !== itemTarget) throw new Error(`cognitive initiation ${phase} studies require a fixed ${itemTarget}-item corpus`);
      const ids = [...new Set((Array.isArray(input.cognitive_pulse_ids) ? input.cognitive_pulse_ids : []).map(String))];
      if (samplingMode === 'prospective_consecutive' && ids.length) throw new Error('prospective consecutive studies do not accept curator-selected cognitive pulse ids');
      if (samplingMode === 'frozen_resolved' && ids.length !== itemTarget) throw new Error(`cognitive initiation studies require exactly ${itemTarget} unique cognitive_pulse_ids`);
      const pulses = ids.map(id => current.cognition.background_inference.pulses.find(item => item.id === id));
      if (samplingMode === 'frozen_resolved' && pulses.some(pulse => !pulse || pulse.status !== 'accepted' || !cognitivePulseAudit(pulse).complete_chain_verified
        || !['useful', 'misleading', 'irrelevant'].includes(pulse.resolution?.outcome) || !pulse.resolution?.evaluator_id)) {
        throw new Error('every source pulse must be accepted, replay-valid, independently resolved, and labeled useful, misleading, or irrelevant');
      }
      const useful = pulses.filter(item => item.resolution.outcome === 'useful').length;
      if (samplingMode === 'frozen_resolved' && (useful < 4 || pulses.length - useful < 4)) throw new Error('cognitive initiation studies require at least four useful and four not-useful source pulses');
      const families = new Set(pulses.map(cognitiveInitiationStudy.sourceFamily));
      if (samplingMode === 'frozen_resolved' && families.size < 3) throw new Error('cognitive initiation studies require at least three independent evidence-source families');
      if (prior && samplingMode === 'frozen_resolved') {
        const priorIds = new Set(prior.items.map(item => item.source_pulse_id));
        if (ids.some(id => priorIds.has(id))) throw new Error('confirmatory cognitive initiation studies must be pulse-disjoint from the pilot');
        const priorRefs = new Set(prior.items.flatMap(item => {
          const source = current.cognition.background_inference.pulses.find(pulse => pulse.id === item.source_pulse_id);
          return (source?.input_packet?.evidence || []).map(evidence => `${evidence.ref.type}:${evidence.ref.id}`);
        }));
        if (pulses.some(pulse => (pulse.input_packet.evidence || []).some(evidence => priorRefs.has(`${evidence.ref.type}:${evidence.ref.id}`)))) throw new Error('confirmatory cognitive initiation studies must be evidence-source-disjoint from the pilot');
      }
      const subjectModel = prior ? prior.subject_model : { provider: 'anthropic', model: String(input.model || 'claude-sonnet-4-6').slice(0, 120), temperature: 0, max_tokens: 300 };
      if (prior && input.model && input.model !== prior.subject_model.model) throw new Error('confirmation must preserve the preregistered subject model');
      if (samplingMode === 'frozen_resolved' && (pulses.some(pulse => pulse.response_metadata?.model !== subjectModel.model || !pulse.response_metadata?.response_id)
        || new Set(pulses.map(pulse => pulse.response_metadata.response_id)).size !== pulses.length)) {
        throw new Error('source pulses must use the preregistered subject model with unique provider response receipts');
      }
      const analysisPlan = prior ? JSON.parse(JSON.stringify(prior.analysis_plan)) : {
        orientation_call_cost: 0.1, pulse_call_cost: 0.25,
        useful_think_reward: 1, useful_wait_penalty: -0.5, misleading_think_penalty: -1, irrelevant_think_penalty: -0.25,
        minimum_utility_advantage: 0.05, minimum_action_rate: 0.2,
        minimum_independent_families: 3, minimum_useful: 4, minimum_not_useful: 4,
        bootstrap_iterations: 2000, confidence: 0.95,
      };
      const study = { id: String(input.id || `cognitive-initiation-study-${Date.now().toString(36)}`).slice(0, 180),
        title: String(input.title).slice(0, 300), status: 'active', study_phase: phase,
        sampling_mode: samplingMode,
        selection_rule: samplingMode === 'prospective_consecutive' ? {
          rule: 'all_eligible_pulses_after_preregistration_until_target', outcome_blind: true,
          confirmation_exclusion: phase === 'confirmatory' ? 'pilot_input_or_outcome_evidence_reference_overlap' : null,
          execution_policy: 'schedule_only_measurement_probe', terminal_provider_or_pulse_failure: true,
        } : { rule: 'curator_frozen_resolved_corpus', outcome_blind: false },
        replicates_study_id: prior?.id || null, item_target: itemTarget, subject_model: subjectModel,
        analysis_plan: analysisPlan, analysis_seed: crypto.randomBytes(32).toString('hex'),
        corpus_salt: crypto.randomBytes(32).toString('hex'), items: [], exclusions: [], analysis: null,
        created: clock().toISOString(), completed: null, abort: null };
      study.analysis_seed_commitment = cognitiveInitiationStudy.hash(study.analysis_seed);
      study.items = pulses.map((pulse, index) => {
        const pair = cognitiveInitiationStudy.packetPair(pulse, `${study.corpus_salt}:${index}`);
        const outcomeSnapshot = { pulse_id: pulse.id, outcome: pulse.resolution.outcome,
          evaluator_id: pulse.resolution.evaluator_id, evidence: pulse.resolution.evidence, resolved_at: pulse.resolution.resolved_at };
        const item = { id: `cognitive-initiation-study-item-${Date.now().toString(36)}-${index}`,
          manifest_index: index, source_pulse_id: pulse.id,
          source_pulse_commitment: cognitiveInitiationStudy.hash(cognitiveInitiationSourceSnapshot(pulse)),
          source_family: cognitiveInitiationStudy.sourceFamily(pulse), packet_pair: pair,
          packet_pair_commitment: cognitiveInitiationStudy.hash(pair), outcome: pulse.resolution.outcome,
          outcome_commitment: cognitiveInitiationStudy.hash(outcomeSnapshot), condition_order: null,
          condition_order_commitment: null, status: 'pending', submissions: null, scores: null, failure: null };
        item.condition_order = cognitiveInitiationStudy.conditionOrder(study, item);
        item.condition_order_commitment = cognitiveInitiationStudy.hash(item.condition_order);
        return item;
      });
      study.manifest_commitment = cognitiveInitiationStudy.hash(cognitiveInitiationStudy.manifest(study));
      const payload = { manifest_commitment: study.manifest_commitment, analysis_seed_commitment: study.analysis_seed_commitment,
        study_phase: study.study_phase, replicates_study_id: study.replicates_study_id,
        sampling_mode: study.sampling_mode, selection_rule: study.selection_rule, subject_model: study.subject_model };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_created', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload });
      current.cognition.cognitive_initiation_studies.push(study); current.cognition.cognitive_initiation_studies = current.cognition.cognitive_initiation_studies.slice(-50);
      return publicCognitiveInitiationStudy(study);
    });
  }
  function cognitiveInitiationStudySubjectQueue(studyId) {
    const study = getState().cognition.cognitive_initiation_studies.find(item => item.id === studyId);
    if (!study || study.status !== 'active') return null;
    const item = study.items.find(candidate => candidate.status === 'pending');
    if (!item) return { study_id: study.id, item: null };
    return { study_id: study.id, generation: JSON.parse(JSON.stringify(study.subject_model)), item: {
      id: item.id, condition_order: [...item.condition_order], condition_order_commitment: item.condition_order_commitment,
      packets: { identity_bound: { packet: JSON.parse(JSON.stringify(item.packet_pair.identity_bound)), packet_commitment: cognitiveInitiationStudy.hash(item.packet_pair.identity_bound) },
        deidentified: { packet: JSON.parse(JSON.stringify(item.packet_pair.deidentified)), packet_commitment: cognitiveInitiationStudy.hash(item.packet_pair.deidentified) } } } };
  }
  function cognitiveInitiationStudyOutcomeQueue(studyId) {
    const study = getState().cognition.cognitive_initiation_studies.find(item => item.id === studyId
      && item.status === 'active' && item.sampling_mode === 'prospective_consecutive');
    if (!study) return null;
    const item = study.items.find(candidate => candidate.status === 'awaiting_outcome');
    if (!item) return { study_id: study.id, item: null };
    const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
    if (!pulse || pulse.status !== 'accepted' || pulse.resolution) return { study_id: study.id, item: null };
    return { study_id: study.id, item: { id: item.id, pulse_id: pulse.id,
      captured_at: pulse.input_packet.captured_at, output: JSON.parse(JSON.stringify(pulse.output)),
      output_commitment: pulse.output_commitment,
      input_evidence_refs: (pulse.input_packet.evidence || []).map(evidence => ({ ...evidence.ref })),
      assignment_sealed: true, subject_decisions_sealed: true,
      allowed_outcomes: ['useful', 'misleading', 'irrelevant', 'unclear'] } };
  }
  function submitCognitiveInitiationStudyPair(studyId, itemId, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_studies.find(candidate => candidate.id === studyId && candidate.status === 'active');
      const item = study?.items.find(candidate => candidate.id === itemId && candidate.status === 'pending');
      if (!study || !item || study.items.find(candidate => candidate.status === 'pending')?.id !== itemId) throw new Error('active cognitive initiation study item not found');
      if (cognitiveInitiationStudy.hash(input.condition_order) !== item.condition_order_commitment
        || canonicalJson(input.condition_order) !== canonicalJson(item.condition_order)) throw new Error('cognitive initiation condition order commitment mismatch');
      const rows = Array.isArray(input.submissions) ? input.submissions : [];
      if (rows.length !== 2 || canonicalJson(rows.map(row => row.condition)) !== canonicalJson(item.condition_order)) throw new Error('both counterbalanced cognitive initiation subject conditions are required atomically');
      const submissions = {};
      for (const row of rows) {
        const condition = row.condition; const binding = condition === 'identity_bound' ? 'self' : condition === 'deidentified' ? 'deidentified' : null;
        if (!binding || submissions[condition]) throw new Error('invalid cognitive initiation subject condition');
        const packet = item.packet_pair[condition]; const decision = cognitiveInitiation.parseDecision(JSON.stringify(row.decision), packet);
        const provider = { response_id: String(row.provider_receipt?.response_id || '').slice(0, 240),
          model: String(row.provider_receipt?.model || '').slice(0, 120),
          input_tokens: Number.isFinite(Number(row.provider_receipt?.input_tokens)) ? Number(row.provider_receipt.input_tokens) : null,
          output_tokens: Number.isFinite(Number(row.provider_receipt?.output_tokens)) ? Number(row.provider_receipt.output_tokens) : null,
          prompt_commitment: String(row.provider_receipt?.prompt_commitment || '') };
        const expectedPrompt = cognitiveInitiation.commitment({ system: cognitiveInitiation.systemPrompt(binding), user: cognitiveInitiation.userPrompt(packet) });
        if (!provider.response_id || provider.model !== study.subject_model.model || provider.prompt_commitment !== expectedPrompt) throw new Error('cognitive initiation subject provider receipt is invalid');
        const reused = current.cognition.cognitive_initiation_studies.some(other => other.items.some(otherItem => Object.values(otherItem.submissions || {}).some(existing => existing.provider_receipt?.response_id === provider.response_id)))
          || current.cognition.background_inference.initiation_records.some(existing => existing.provider_receipt?.response_id === provider.response_id);
        if (reused) throw new Error('cognitive initiation subject provider response id has already been used');
        submissions[condition] = { decision, decision_commitment: cognitiveInitiation.commitment(decision), provider_receipt: provider };
      }
      if (submissions.identity_bound.provider_receipt.response_id === submissions.deidentified.provider_receipt.response_id) throw new Error('paired conditions require unique provider response ids');
      item.submissions = submissions;
      if (study.sampling_mode === 'prospective_consecutive') {
        item.status = 'awaiting_outcome';
        researchLedgerAppend(current, { kind: 'cognitive_initiation_study_subject_pair_completed',
          subject_type: 'cognitive_initiation_study_item', subject_id: item.id,
          payload: { submission_commitment: cognitiveInitiationStudy.hash(item.submissions) } });
        return publicCognitiveInitiationStudy(study);
      }
      item.scores = { identity_bound: cognitiveInitiationStudy.decisionUtility(submissions.identity_bound.decision, item.outcome, study.analysis_plan, 'identity_bound'),
        deidentified: cognitiveInitiationStudy.decisionUtility(submissions.deidentified.decision, item.outcome, study.analysis_plan, 'deidentified'),
        schedule_only: cognitiveInitiationStudy.decisionUtility({ decision: 'think' }, item.outcome, study.analysis_plan, 'schedule_only') };
      item.status = 'resolved';
      const payload = { submission_commitment: cognitiveInitiationStudy.hash(item.submissions), score_commitment: cognitiveInitiationStudy.hash(item.scores) };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_item_resolved', subject_type: 'cognitive_initiation_study_item', subject_id: item.id, payload });
      if (study.items.every(candidate => candidate.status === 'resolved')) {
        study.status = 'completed'; study.completed = clock().toISOString(); study.analysis = cognitiveInitiationStudy.analysis(study);
        researchLedgerAppend(current, { kind: 'cognitive_initiation_study_completed', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload: study.analysis });
      }
      return publicCognitiveInitiationStudy(study);
    });
  }
  function failCognitiveInitiationStudyPair(studyId, itemId, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_studies.find(candidate => candidate.id === studyId && candidate.status === 'active');
      const item = study?.items.find(candidate => candidate.id === itemId && candidate.status === 'pending');
      if (!study || !item) return null;
      item.status = 'failed'; item.failure = { reason: String(input.reason || 'subject_pair_failed').slice(0, 500),
        attempted_conditions: (input.attempted_conditions || []).map(String).slice(0, 2),
        response_receipts: (input.response_receipts || []).slice(0, 2), at: clock().toISOString() };
      study.status = 'aborted'; study.completed = item.failure.at; study.abort = { reason: 'terminal_partial_subject_pair', item_id: item.id, failure: item.failure };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_aborted', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload: study.abort });
      return publicCognitiveInitiationStudy(study);
    });
  }
  function abortCognitiveInitiationStudy(id, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_studies.find(item => item.id === id && item.status === 'active');
      if (!study) return null;
      if (!input.reason || !Array.isArray(input.evidence) || !input.evidence.length) throw new Error('abort reason and stable evidence are required');
      study.status = 'aborted'; study.completed = clock().toISOString(); study.abort = { reason: String(input.reason).slice(0, 500), evidence: input.evidence.slice(0, 20), at: study.completed };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_study_aborted', subject_type: 'cognitive_initiation_study', subject_id: study.id, payload: study.abort });
      return publicCognitiveInitiationStudy(study);
    });
  }
  function cognitiveInitiationStudiesSnapshot() {
    return { epistemic_status: 'Frozen resolved corpora and outcome-blind prospective consecutive cohorts test self-bound cognitive-resource allocation against identical deidentified packets and an always-think schedule while charging operational model-call costs. Prospective shadow decisions are committed before the schedule-only measurement pulse; they are not yet a randomized applied-policy effect or evidence of phenomenal consciousness.',
      studies: getState().cognition.cognitive_initiation_studies.map(publicCognitiveInitiationStudy) };
  }
  function cognitiveInitiationPolicyEventVerified(kind, subjectId, payload) {
    const expected = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return (getState().cognition.research_ledger?.events || []).filter(event => event.kind === kind
      && event.subject_id === subjectId && event.payload_commitment === expected).length === 1;
  }
  function cognitiveInitiationPolicyPriorEvidenceRefs(current, study) {
    const prior = study.replicates_study_id
      ? current.cognition.cognitive_initiation_policy_studies.find(item => item.id === study.replicates_study_id)
      : null;
    return new Set((prior?.items || []).flatMap(item => {
      const pulse = current.cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      return [...(pulse?.input_packet?.evidence || []), ...(pulse?.resolution?.evidence || [])]
        .map(evidence => `${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`);
    }));
  }
  function cognitiveInitiationEcologicalPriorRefs(current, study) {
    const prior = study.replicates_study_id
      ? current.cognition.cognitive_initiation_policy_studies.find(item => item.id === study.replicates_study_id)
      : null;
    return {
      taskIds: new Set((prior?.items || []).map(item => item.ecological_task_id).filter(Boolean)),
      externalIds: new Set((prior?.items || []).map(item => item.ecological_external_id).filter(Boolean)),
      evidenceRefs: new Set((prior?.items || []).flatMap(item => [
        ...(item.ecological_outcome_packet?.artifact_evidence || []), ...(item.grades || []).flatMap(grade => grade.evidence || []),
      ]).map(reference => `${reference.type}:${reference.id}`)),
    };
  }
  function cognitiveInitiationPolicyIsEcological(study) {
    return study?.outcome_mode === cognitiveInitiationEcologicalStudy.OUTCOME_MODE;
  }
  function cognitiveInitiationPolicyManifest(study) {
    return cognitiveInitiationPolicyIsEcological(study)
      ? cognitiveInitiationEcologicalStudy.manifest(study) : cognitiveInitiationPolicyStudy.manifest(study);
  }
  function cognitiveInitiationPolicyAnalysis(study) {
    return cognitiveInitiationPolicyIsEcological(study)
      ? cognitiveInitiationEcologicalStudy.analysis(study) : cognitiveInitiationPolicyStudy.analysis(study);
  }
  function publicCognitiveInitiationPolicyStudy(study) {
    const revealed = ['completed', 'aborted'].includes(study.status);
    const ecological = cognitiveInitiationPolicyIsEcological(study);
    const report = revealed ? cognitiveInitiationPolicyAnalysis(study) : {
      target: study.total_item_target, enrolled: study.items.length,
      policy_applied: study.items.filter(item => ['awaiting_probe', 'awaiting_ecological_outcome', 'awaiting_grades', 'grading', 'resolved', 'disagreement'].includes(item.status)).length,
      probed: study.items.filter(item => ['awaiting_grades', 'grading', 'resolved', 'disagreement'].includes(item.status)).length,
      ecological_outcomes_captured: study.items.filter(item => item.ecological_outcome_packet).length,
      ecological_windows_expired: study.items.filter(item => item.outcome?.outcome_kind === 'window_expired_noncompletion').length,
      resolved: study.items.filter(item => item.status === 'resolved').length,
      evaluator_disagreements: study.items.filter(item => item.status === 'disagreement').length,
      excluded_by_preregistered_rule: (study.exclusions || []).length,
      assignments_sealed: true, decisions_sealed: true, outcomes_sealed: true, verdict: 'collecting',
    };
    const visible = { id: study.id, title: study.title, status: study.status, study_phase: study.study_phase,
      outcome_mode: study.outcome_mode || 'standardized_delayed_probe',
      replicates_study_id: study.replicates_study_id, basis_allocation_study_id: study.basis_allocation_study_id,
      basis_policy_study_id: study.basis_policy_study_id || null,
      item_target_per_condition: study.item_target_per_condition, total_item_target: study.total_item_target,
      created: study.created, completed: study.completed, design_commitment: study.design_commitment,
      randomization_seed_commitment: study.randomization_seed_commitment,
      analysis_seed_commitment: study.analysis_seed_commitment,
      subject_model_commitment: cognitiveInitiationPolicyStudy.hash(study.subject_model),
      analysis_plan: study.analysis_plan, selection_rule: study.selection_rule,
      due_probe_item_id: ecological ? null : study.items.find(item => item.status === 'awaiting_probe' && new Date(item.probe_due_at) <= clock())?.id || null,
      due_ecological_outcome_item_id: ecological ? study.items.find(item => item.status === 'awaiting_ecological_outcome'
        && (new Date(item.followup_due_at) <= clock()
          || !getState().commitments.find(commitment => commitment.id === item.ecological_task_id && commitment.status === 'open')))?.id || null : null,
      report };
    if (revealed) Object.assign(visible, { subject_model: study.subject_model,
      randomization_seed: study.randomization_seed, analysis_seed: study.analysis_seed,
      items: JSON.parse(JSON.stringify(study.items)), exclusions: JSON.parse(JSON.stringify(study.exclusions || [])),
      analysis: study.analysis, abort: study.abort || null, audit: cognitiveInitiationPolicyStudyAudit(study) });
    return visible;
  }
  function createCognitiveInitiationPolicyStudy(input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      if (!String(input.title || '').trim()) throw new Error('cognitive initiation policy study title is required');
      if (current.cognition.cognitive_initiation_policy_studies.some(item => item.status === 'active')
        || current.cognition.cognitive_initiation_studies.some(item => item.status === 'active')
        || current.cognition.self_model.context_trials.some(item => item.status === 'active')
        || current.cognition.self_inquiry_selection_studies.some(item => item.status === 'active')
        || current.cognition.self_induction_studies.some(item => item.status === 'active')) throw new Error('finish or abort the active blinded study first');
      if (current.cognition.background_inference.pending) throw new Error('finish or fail the pending cognitive pulse first');
      const phase = input.study_phase === 'confirmatory' ? 'confirmatory' : 'pilot';
      const outcomeMode = input.outcome_mode === cognitiveInitiationEcologicalStudy.OUTCOME_MODE
        ? cognitiveInitiationEcologicalStudy.OUTCOME_MODE : 'standardized_delayed_probe';
      const ecological = outcomeMode === cognitiveInitiationEcologicalStudy.OUTCOME_MODE;
      const prior = phase === 'confirmatory'
        ? current.cognition.cognitive_initiation_policy_studies.find(item => item.id === input.replicates_study_id
          && item.status === 'completed' && (item.outcome_mode || 'standardized_delayed_probe') === outcomeMode)
        : null;
      if (phase === 'confirmatory' && (!prior || !cognitiveInitiationPolicyStudyAudit(prior).complete_chain_verified)) {
        throw new Error('confirmatory cognitive initiation policy studies require an integrity-valid completed pilot');
      }
      const basisPolicyId = ecological
        ? prior?.basis_policy_study_id || String(input.basis_policy_study_id || '') : null;
      const basisPolicy = ecological ? current.cognition.cognitive_initiation_policy_studies.find(item => item.id === basisPolicyId
        && item.status === 'completed' && item.study_phase === 'confirmatory'
        && (item.outcome_mode || 'standardized_delayed_probe') === 'standardized_delayed_probe') : null;
      if (ecological && (!basisPolicy || !basisPolicy.analysis?.predicted_pattern
        || !cognitiveInitiationPolicyStudyAudit(basisPolicy).complete_chain_verified)) {
        throw new Error('ecological policy studies require a supported integrity-valid standardized applied-policy confirmation');
      }
      const basisId = prior?.basis_allocation_study_id || basisPolicy?.basis_allocation_study_id
        || String(input.basis_allocation_study_id || '');
      const basis = current.cognition.cognitive_initiation_studies.find(item => item.id === basisId
        && item.status === 'completed' && item.study_phase === 'confirmatory'
        && item.sampling_mode === 'prospective_consecutive');
      if (!basis || !basis.analysis?.predicted_pattern || !cognitiveInitiationStudyAudit(basis).complete_chain_verified) {
        throw new Error('applied policy studies require a supported integrity-valid prospective cognitive initiation confirmation');
      }
      const itemTargetPerCondition = phase === 'confirmatory' ? 20 : 10;
      if (input.item_target_per_condition != null && Number(input.item_target_per_condition) !== itemTargetPerCondition) {
        throw new Error(`cognitive initiation policy ${phase} studies require exactly ${itemTargetPerCondition} items per condition`);
      }
      const subjectModel = prior ? prior.subject_model : basisPolicy ? basisPolicy.subject_model : { provider: 'anthropic', model: basis.subject_model.model,
        gate_temperature: 0, gate_max_tokens: 300, pulse_temperature: 0.2, pulse_max_tokens: 700,
        probe_temperature: 0, probe_max_tokens: 700 };
      if (input.model && input.model !== subjectModel.model) throw new Error('applied policy studies must preserve the supported allocation model');
      const analysisPlan = prior ? JSON.parse(JSON.stringify(prior.analysis_plan)) : ecological ? {
        orientation_call_cost: 0.1, pulse_call_cost: 0.25, minimum_utility_advantage: 0.05,
        quality_non_degradation_margin: 0.05, minimum_action_rate: 0.2,
        minimum_independent_families: 3, minimum_verified_completion_rate: 0.6,
        evaluator_target: 2, evaluator_disagreement_tolerance: 0.25,
        followup_window_hours: 168, bootstrap_iterations: 2000, confidence: 0.95,
      } : {
        orientation_call_cost: 0.1, pulse_call_cost: 0.25, minimum_utility_advantage: 0.05,
        quality_non_degradation_margin: 0.05, minimum_action_rate: 0.2,
        minimum_independent_families: 3, evaluator_target: 2, evaluator_disagreement_tolerance: 0.25,
        probe_min_delay_minutes: 30, bootstrap_iterations: 2000, confidence: 0.95,
      };
      const study = { id: String(input.id || `cognitive-initiation-policy-${Date.now().toString(36)}`).slice(0, 180),
        title: String(input.title).slice(0, 300), status: 'active', study_phase: phase,
        outcome_mode: outcomeMode, replicates_study_id: prior?.id || null,
        basis_policy_study_id: basisPolicy?.id || null, basis_allocation_study_id: basis.id,
        item_target_per_condition: itemTargetPerCondition,
        total_item_target: itemTargetPerCondition * cognitiveInitiationPolicyStudy.CONDITIONS.length,
        conditions: [...cognitiveInitiationPolicyStudy.CONDITIONS], subject_model: subjectModel,
        analysis_plan: analysisPlan,
        selection_rule: { rule: ecological
          ? 'all_same_model_pulses_after_preregistration_with_a_deterministically_selected_unmodified_open_external_nora_commitment_due_within_the_fixed_followup_window'
          : 'all_eligible_same_model_pulses_after_preregistration_until_fixed_balanced_target',
          outcome_blind: true, block_randomized: true, intention_to_treat: true,
          confirmation_exclusion: phase === 'confirmatory' ? (ecological
            ? 'pilot_task_or_external_event_or_outcome_or_grading_evidence_reference_overlap'
            : 'pilot_input_or_outcome_evidence_reference_overlap') : null,
          ecological_noncompletion: ecological ? 'zero_utility_at_fixed_followup_without_replacement' : null,
          ecological_source_rule: ecological
            ? 'replay_valid_provider_verified_attestation_recorded_before_randomization' : null,
          ecological_attestation_methods: ecological
            ? ['slack_request_signature_v0', 'provider_api_readback'] : null,
          terminal_provider_or_pulse_failure: true, no_replacement_for_disagreement: true },
        randomization_seed: crypto.randomBytes(32).toString('hex'), analysis_seed: crypto.randomBytes(32).toString('hex'),
        corpus_salt: crypto.randomBytes(32).toString('hex'), items: [], exclusions: [], analysis: null,
        created: clock().toISOString(), completed: null, abort: null };
      study.randomization_seed_commitment = cognitiveInitiationPolicyStudy.hash(study.randomization_seed);
      study.analysis_seed_commitment = cognitiveInitiationPolicyStudy.hash(study.analysis_seed);
      study.design_commitment = cognitiveInitiationPolicyStudy.hash(cognitiveInitiationPolicyManifest(study));
      const payload = { design_commitment: study.design_commitment,
        randomization_seed_commitment: study.randomization_seed_commitment,
        analysis_seed_commitment: study.analysis_seed_commitment, study_phase: study.study_phase,
        outcome_mode: study.outcome_mode, replicates_study_id: study.replicates_study_id,
        basis_policy_study_id: study.basis_policy_study_id, basis_allocation_study_id: study.basis_allocation_study_id };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_study_created',
        subject_type: 'cognitive_initiation_policy_study', subject_id: study.id, payload });
      current.cognition.cognitive_initiation_policy_studies.push(study);
      current.cognition.cognitive_initiation_policy_studies = current.cognition.cognitive_initiation_policy_studies.slice(-30);
      return publicCognitiveInitiationPolicyStudy(study);
    });
  }
  function enrollCognitiveInitiationPolicyPulse(current, study, pulse) {
    if (!study || study.status !== 'active' || study.items.length >= study.total_item_target) return null;
    let ecologicalTask = null;
    let ecologicalPrior = { taskIds: new Set(), externalIds: new Set(), evidenceRefs: new Set() };
    const ecologicalAttestations = current.cognition.external_source_attestations.filter(record =>
      storedExternalSourceAttestationAudit(record,
        current.commitments.find(commitment => commitment.id === record.commitment_id)).complete_chain_verified);
    if (cognitiveInitiationPolicyIsEcological(study)) {
      ecologicalPrior = study.study_phase === 'confirmatory'
        ? cognitiveInitiationEcologicalPriorRefs(current, study) : ecologicalPrior;
      const baseCandidate = cognitiveInitiationEcologicalStudy.eligibleCommitmentForPulse(pulse, current.commitments,
        study, new Set(), ecologicalAttestations);
      ecologicalTask = cognitiveInitiationEcologicalStudy.eligibleCommitmentForPulse(pulse, current.commitments,
        study, ecologicalPrior.taskIds, ecologicalAttestations, ecologicalPrior.externalIds);
      if (!ecologicalTask) {
        const referencedIds = new Set((pulse.input_packet?.evidence || [])
          .filter(entry => entry.ref?.type === 'commitment').map(entry => String(entry.ref.id)));
        const snapshots = current.commitments.filter(commitment => referencedIds.has(String(commitment.id)))
          .map(commitment => {
            const attestation = ecologicalAttestations
              .find(record => record.commitment_id === commitment.id) || null;
            return { commitment: { ...cognitiveInitiationEcologicalStudy.commitmentSnapshot(commitment), status: commitment.status },
              source_attestation_id: attestation?.id || null,
              source_attestation_commitment: attestation ? cognitiveInitiationPolicyStudy.hash(attestation) : null };
          });
        const exclusion = { pulse_id: pulse.id, pulse_input_commitment: pulse.input_commitment,
          reason: baseCandidate && ecologicalPrior.taskIds.has(baseCandidate.id)
            ? 'preregistered_ecological_confirmation_task_overlap'
            : baseCandidate && ecologicalPrior.externalIds.has(ecologicalAttestations
              .find(record => record.commitment_id === baseCandidate.id)?.external_id)
              ? 'preregistered_ecological_confirmation_source_event_overlap'
              : 'no_replay_valid_attested_external_commitment',
          eligibility_snapshot: snapshots,
          eligibility_snapshot_commitment: cognitiveInitiationPolicyStudy.hash(snapshots), at: pulse.requested_at };
        study.exclusions.push(exclusion);
        researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_pulse_excluded',
          subject_type: 'cognitive_initiation_policy_pulse', subject_id: pulse.id, payload: exclusion });
        return { study_id: study.id, enrolled: false, reason: exclusion.reason };
      }
    }
    const ecologicalAttestation = ecologicalTask ? ecologicalAttestations
      .find(record => record.commitment_id === ecologicalTask.id) : null;
    const priorRefs = study.study_phase === 'confirmatory' ? cognitiveInitiationPolicyPriorEvidenceRefs(current, study) : new Set();
    const overlappingRefs = (pulse.input_packet?.evidence || []).map(evidence => `${evidence.ref.type}:${evidence.ref.id}`)
      .filter(ref => priorRefs.has(ref));
    if (!cognitiveInitiationPolicyIsEcological(study) && overlappingRefs.length) {
      const exclusion = { pulse_id: pulse.id, pulse_input_commitment: pulse.input_commitment,
        reason: 'preregistered_policy_confirmation_evidence_overlap',
        overlapping_ref_commitments: overlappingRefs.map(ref => cognitiveInitiationPolicyStudy.hash(`${study.corpus_salt}:${ref}`)),
        at: pulse.requested_at };
      study.exclusions.push(exclusion);
      researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_pulse_excluded',
        subject_type: 'cognitive_initiation_policy_pulse', subject_id: pulse.id, payload: exclusion });
      return { study_id: study.id, enrolled: false, reason: exclusion.reason };
    }
    const index = study.items.length; const assignment = cognitiveInitiationPolicyStudy.assignmentForIndex(study, index);
    const item = { id: `cognitive-initiation-policy-item-${Date.now().toString(36)}-${index}`,
      manifest_index: index, source_pulse_id: pulse.id,
      enrollment_commitment: cognitiveInitiationPolicyStudy.hash(cognitiveInitiationStudy.enrollmentSnapshot(pulse)),
      input_source_family: cognitiveInitiationPolicyStudy.sourceFamily(pulse), source_family: null,
      condition: assignment.condition,
      randomization_block: assignment.block, randomization_order_commitment: cognitiveInitiationPolicyStudy.hash(assignment.order),
      assignment_commitment: cognitiveInitiationPolicyStudy.hash({ condition: assignment.condition, block: assignment.block, order: assignment.order }),
      status: 'policy_pending', applied_action: null, pulse_status: null, initiation_id: null,
      initiation_decision_commitment: null, operational_cost: null, applied_at: null, probe_due_at: null,
      probe_packet: null, probe_packet_commitment: null, probe_response: null,
      probe_response_commitment: null, probe_provider_receipt: null,
      ecological_task_id: ecologicalTask?.id || null,
      ecological_task_snapshot: ecologicalTask ? cognitiveInitiationEcologicalStudy.commitmentSnapshot(ecologicalTask) : null,
      ecological_task_commitment: ecologicalTask
        ? cognitiveInitiationPolicyStudy.hash(cognitiveInitiationEcologicalStudy.commitmentSnapshot(ecologicalTask)) : null,
      ecological_source_attestation_id: ecologicalAttestation?.id || null,
      ecological_source_attestation_commitment: ecologicalAttestation
        ? cognitiveInitiationPolicyStudy.hash(ecologicalAttestation) : null,
      ecological_external_id: ecologicalAttestation?.external_id || null,
      ecological_source_family: ecologicalTask
        ? cognitiveInitiationEcologicalStudy.sourceFamily(ecologicalTask, ecologicalAttestation) : null,
      followup_due_at: ecologicalTask
        ? new Date(new Date(pulse.requested_at).getTime() + study.analysis_plan.followup_window_hours * 3600000).toISOString() : null,
      ecological_outcome_packet: null, ecological_outcome_commitment: null, outcome_collector_id: null,
      ecological_expiry_observation: null,
      grades: [], outcome: null, failure: null };
    study.items.push(item); pulse.cognitive_initiation_policy_study_id = study.id;
    pulse.cognitive_initiation_policy_item_id = item.id;
    const payload = { study_id: study.id, manifest_index: index, enrollment_commitment: item.enrollment_commitment,
      assignment_commitment: item.assignment_commitment, randomization_order_commitment: item.randomization_order_commitment,
      ecological_task_commitment: item.ecological_task_commitment,
      ecological_source_attestation_commitment: item.ecological_source_attestation_commitment,
      followup_due_at: item.followup_due_at };
    researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_item_enrolled',
      subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload });
    return { study_id: study.id, item_id: item.id, enrolled: true, manifest_index: index };
  }
  function cognitiveInitiationPolicyForPulse(pulseId) {
    const pulse = getState().cognition.background_inference.pending?.id === pulseId
      ? getState().cognition.background_inference.pending
      : getState().cognition.background_inference.pulses.find(item => item.id === pulseId);
    const study = getState().cognition.cognitive_initiation_policy_studies.find(item => item.status === 'active'
      && item.id === pulse?.cognitive_initiation_policy_study_id);
    const item = study?.items.find(candidate => candidate.id === pulse?.cognitive_initiation_policy_item_id);
    if (!study || !item) return null;
    return { study_id: study.id, item_id: item.id, condition: item.condition,
      binding: item.condition === 'identity_bound_policy' ? 'self'
        : item.condition === 'deidentified_policy' ? 'deidentified' : null,
      schedule_only: item.condition === 'schedule_only_policy', model: study.subject_model.model };
  }
  function applyCognitiveInitiationPolicyOutcome(current, pulse) {
    const study = current.cognition.cognitive_initiation_policy_studies.find(candidate => candidate.status === 'active'
      && candidate.id === pulse?.cognitive_initiation_policy_study_id);
    const item = study?.items.find(candidate => candidate.id === pulse?.cognitive_initiation_policy_item_id);
    if (!study || !item) return null;
    if (item.status !== 'policy_pending' || !['accepted', 'deferred'].includes(pulse.status)) {
      throw new Error('cognitive initiation policy application is not in the expected state');
    }
    let action; let initiation = null;
    if (item.condition === 'schedule_only_policy') {
      if (pulse.status !== 'accepted' || pulse.initiation_id) throw new Error('schedule-only policy must execute one pulse without an orientation call');
      action = 'think';
    } else {
      initiation = current.cognition.background_inference.initiation_records.find(candidate => candidate.id === pulse.initiation_id);
      const expectedBinding = item.condition === 'identity_bound_policy' ? 'self' : 'deidentified';
      if (!initiation || initiation.binding !== expectedBinding || initiation.status !== 'completed'
        || !cognitiveInitiationAudit(initiation).complete_chain_verified) throw new Error('applied cognitive initiation policy requires its exact replay-valid gate decision');
      action = initiation.decision.decision;
      if ((action === 'think' && pulse.status !== 'accepted') || (action === 'wait' && pulse.status !== 'deferred')) {
        throw new Error('applied cognitive initiation policy did not obey the assigned gate decision');
      }
    }
    item.applied_action = action; item.pulse_status = pulse.status; item.initiation_id = initiation?.id || null;
    item.initiation_decision_commitment = initiation?.decision_commitment || null;
    item.operational_cost = cognitiveInitiationPolicyStudy.operationalCost(item, study.analysis_plan);
    item.applied_at = clock().toISOString();
    if (cognitiveInitiationPolicyIsEcological(study)) {
      item.status = 'awaiting_ecological_outcome';
    } else {
      item.probe_due_at = new Date(clock().getTime() + study.analysis_plan.probe_min_delay_minutes * 60000).toISOString();
      item.probe_packet = cognitiveInitiationPolicyStudy.probePacket(pulse);
      item.probe_packet_commitment = cognitiveInitiationPolicyStudy.hash(item.probe_packet);
      item.status = 'awaiting_probe';
    }
    const payload = { source_pulse_id: pulse.id, pulse_status: item.pulse_status, applied_action: item.applied_action,
      initiation_id: item.initiation_id, initiation_decision_commitment: item.initiation_decision_commitment,
      operational_cost: item.operational_cost, applied_at: item.applied_at, probe_due_at: item.probe_due_at,
      probe_packet_commitment: item.probe_packet_commitment,
      ecological_task_commitment: item.ecological_task_commitment, followup_due_at: item.followup_due_at };
    researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_applied',
      subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload });
    return item;
  }
  function abortCognitiveInitiationPolicyForPulse(current, pulse, reason) {
    const study = current.cognition.cognitive_initiation_policy_studies.find(candidate => candidate.status === 'active'
      && candidate.id === pulse?.cognitive_initiation_policy_study_id);
    if (!study) return;
    const item = study.items.find(candidate => candidate.id === pulse.cognitive_initiation_policy_item_id);
    if (item && !['resolved', 'disagreement'].includes(item.status)) {
      item.status = 'failed'; item.failure = { reason: String(reason || 'policy_pulse_failed').slice(0, 500), at: clock().toISOString() };
    }
    study.status = 'aborted'; study.completed = clock().toISOString();
    study.abort = { reason: 'terminal_applied_policy_provider_or_pulse_failure', pulse_id: pulse.id,
      item_id: item?.id || null, failure: item?.failure || { reason: String(reason).slice(0, 500), at: study.completed } };
    researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_study_aborted',
      subject_type: 'cognitive_initiation_policy_study', subject_id: study.id, payload: study.abort });
  }
  function cognitiveInitiationPolicyProbeQueue(studyId, itemId = null) {
    const study = getState().cognition.cognitive_initiation_policy_studies.find(item => item.id === studyId && item.status === 'active');
    if (!study) return null;
    if (cognitiveInitiationPolicyIsEcological(study)) return { study_id: study.id, item: null,
      outcome_mode: study.outcome_mode, reason: 'ecological studies do not manufacture a delayed probe' };
    const item = itemId
      ? study.items.find(candidate => candidate.id === itemId && candidate.status === 'awaiting_probe')
      : study.items.find(candidate => candidate.status === 'awaiting_probe' && new Date(candidate.probe_due_at) <= clock());
    if (!item) return { study_id: study.id, item: null };
    if (new Date(item.probe_due_at) > clock()) return { study_id: study.id, item: null, due_at: item.probe_due_at };
    const system = cognitiveInitiationPolicyStudy.probeSystemPrompt();
    const user = cognitiveInitiationPolicyStudy.probeUserPrompt(item.probe_packet);
    return { study_id: study.id, generation: { provider: study.subject_model.provider,
      model: study.subject_model.model, temperature: study.subject_model.probe_temperature,
      max_tokens: study.subject_model.probe_max_tokens }, item: { id: item.id,
      packet: JSON.parse(JSON.stringify(item.probe_packet)), packet_commitment: item.probe_packet_commitment,
      prompt_commitment: cognitiveInitiationPolicyStudy.hash({ system, user }), due_at: item.probe_due_at } };
  }
  function submitCognitiveInitiationPolicyProbe(studyId, itemId, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_policy_studies.find(candidate => candidate.id === studyId && candidate.status === 'active');
      const item = study?.items.find(candidate => candidate.id === itemId && candidate.status === 'awaiting_probe');
      if (!study || !item) throw new Error('due cognitive initiation policy probe not found');
      if (new Date(item.probe_due_at) > clock()) throw new Error('cognitive initiation policy probe cannot run before the preregistered delay');
      const response = String(input.response || '').trim().slice(0, 8000);
      if (!response) throw new Error('cognitive initiation policy probe response is required');
      if (response.split(/\s+/).length > 450) throw new Error('cognitive initiation policy probe response exceeds the preregistered length bound');
      const provider = { response_id: String(input.response_id || '').slice(0, 240), model: String(input.model || '').slice(0, 120),
        input_tokens: Number.isFinite(Number(input.input_tokens)) ? Math.max(0, Number(input.input_tokens)) : null,
        output_tokens: Number.isFinite(Number(input.output_tokens)) ? Math.max(0, Number(input.output_tokens)) : null,
        prompt_commitment: String(input.prompt_commitment || '') };
      const system = cognitiveInitiationPolicyStudy.probeSystemPrompt();
      const user = cognitiveInitiationPolicyStudy.probeUserPrompt(item.probe_packet);
      if (!provider.response_id || provider.model !== study.subject_model.model
        || provider.prompt_commitment !== cognitiveInitiationPolicyStudy.hash({ system, user })) {
        throw new Error('cognitive initiation policy probe provider receipt is invalid');
      }
      const used = current.cognition.cognitive_initiation_policy_studies.some(other => other.items.some(otherItem =>
        otherItem.probe_provider_receipt?.response_id === provider.response_id))
        || current.cognition.background_inference.pulses.some(pulse => pulse.response_metadata?.response_id === provider.response_id)
        || current.cognition.background_inference.initiation_records.some(record => record.provider_receipt?.response_id === provider.response_id);
      if (used) throw new Error('cognitive initiation policy probe provider response id has already been used');
      item.probe_response = response; item.probe_response_commitment = cognitiveInitiationPolicyStudy.hash(response);
      item.probe_provider_receipt = provider; item.status = 'awaiting_grades';
      const payload = { probe_packet_commitment: item.probe_packet_commitment,
        probe_response_commitment: item.probe_response_commitment, provider_receipt: provider };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_probe_completed',
        subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload });
      return { study_id: study.id, item_id: item.id, status: item.status };
    });
  }
  function cognitiveInitiationEcologicalOutcomeQueue(studyId) {
    const study = getState().cognition.cognitive_initiation_policy_studies.find(item => item.id === studyId && item.status === 'active');
    if (!study || !cognitiveInitiationPolicyIsEcological(study)) return null;
    const item = study.items.find(candidate => candidate.status === 'awaiting_ecological_outcome' && (() => {
      const commitment = getState().commitments.find(entry => entry.id === candidate.ecological_task_id);
      return commitment && (commitment.status !== 'open' || new Date(candidate.followup_due_at) <= clock());
    })());
    if (!item) return { study_id: study.id, item: null };
    const commitment = getState().commitments.find(entry => entry.id === item.ecological_task_id);
    return { study_id: study.id, outcome_mode: study.outcome_mode, item: {
      id: item.id, task: item.ecological_task_snapshot.what, owner: item.ecological_task_snapshot.owner,
      beneficiary: item.ecological_task_snapshot.beneficiary, due: item.ecological_task_snapshot.due,
      source_family: item.ecological_source_family,
      source_evidence: JSON.parse(JSON.stringify(item.ecological_task_snapshot.evidence)),
      current_status: commitment.status, terminal_at: commitment.fulfilled_at || commitment.updated,
      resolution_evidence: JSON.parse(JSON.stringify(commitment.resolution_evidence || null)),
      followup_due_at: item.followup_due_at, assignment_sealed: true, gate_decision_sealed: true,
      pulse_output_sealed: true,
    } };
  }
  function submitCognitiveInitiationEcologicalOutcome(studyId, itemId, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_policy_studies.find(candidate => candidate.id === studyId
        && candidate.status === 'active' && cognitiveInitiationPolicyIsEcological(candidate));
      const item = study?.items.find(candidate => candidate.id === itemId && candidate.status === 'awaiting_ecological_outcome');
      if (!study || !item) throw new Error('ecological policy item is not awaiting an outcome');
      const commitment = current.commitments.find(candidate => candidate.id === item.ecological_task_id);
      if (!commitment || commitment.status === 'open') throw new Error('ecological outcome capture requires a terminal natural commitment');
      const terminalAt = new Date(commitment.fulfilled_at || commitment.updated);
      if (!Number.isFinite(terminalAt.getTime()) || terminalAt > new Date(item.followup_due_at)) {
        throw new Error('a commitment completed after the fixed follow-up must remain a noncompletion outcome');
      }
      if (cognitiveInitiationPolicyStudy.hash(cognitiveInitiationEcologicalStudy.commitmentSnapshot({
        ...commitment, status: 'open', updated: item.ecological_task_snapshot.updated,
      })) !== item.ecological_task_commitment) throw new Error('ecological task identity or preregistered task fields changed');
      const collectorId = String(input.collector_id || '').trim().slice(0, 200);
      if (!collectorId) throw new Error('an independent ecological outcome collector id is required');
      const pulse = current.cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      const initiation = pulse?.initiation_id
        ? current.cognition.background_inference.initiation_records.find(candidate => candidate.id === pulse.initiation_id) : null;
      if ([pulse?.response_metadata?.response_id, initiation?.provider_receipt?.response_id].filter(Boolean).includes(collectorId)) {
        throw new Error('the policy, pulse, and ecological outcome collector identities must remain independent');
      }
      const evidence = cognitiveInitiationEcologicalStudy.normalizeEvidence(input.evidence);
      if (!evidence.length || evidence.length !== (input.evidence || []).slice(0, 20).length) {
        throw new Error('ecological outcome capture requires valid stable artifact evidence');
      }
      if (cognitiveInitiationEcologicalStudy.leaksDesign(`${input.outcome_summary || ''} ${evidence.map(entry => entry.summary || '').join(' ')}`)) {
        throw new Error('ecological outcome material must not reveal or speculate about the assigned policy');
      }
      if (study.study_phase === 'confirmatory') {
        const priorRefs = cognitiveInitiationEcologicalPriorRefs(current, study).evidenceRefs;
        if (evidence.some(reference => priorRefs.has(`${reference.type}:${reference.id}`))) {
          throw new Error('confirmatory ecological outcome evidence must be reference-disjoint from the pilot');
        }
      }
      const packet = cognitiveInitiationEcologicalStudy.ecologicalOutcomePacket(item, commitment,
        { ...input, evidence }, clock().toISOString());
      if (!packet.outcome_summary) throw new Error('ecological outcome summary is required');
      item.ecological_outcome_packet = packet;
      item.ecological_outcome_commitment = cognitiveInitiationPolicyStudy.hash(packet);
      item.outcome_collector_id = collectorId; item.status = 'awaiting_grades';
      const payload = { ecological_outcome_commitment: item.ecological_outcome_commitment,
        outcome_collector_id: collectorId, terminal_status: packet.terminal_status };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_ecological_outcome_captured',
        subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload });
      return { study_id: study.id, item_id: item.id, status: item.status };
    });
  }
  function expireCognitiveInitiationEcologicalOutcomes(studyId = null) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const studies = current.cognition.cognitive_initiation_policy_studies.filter(study => study.status === 'active'
        && cognitiveInitiationPolicyIsEcological(study) && (!studyId || study.id === studyId));
      let expired = 0;
      for (const study of studies) for (const item of study.items) {
        if (item.status !== 'awaiting_ecological_outcome' || new Date(item.followup_due_at) > clock()) continue;
        const commitment = current.commitments.find(candidate => candidate.id === item.ecological_task_id);
        if (!commitment) continue;
        const terminalAt = commitment.status === 'open' ? null : new Date(commitment.fulfilled_at || commitment.updated);
        const lateTerminal = commitment.status !== 'open'
          && Number.isFinite(terminalAt?.getTime()) && terminalAt > new Date(item.followup_due_at);
        if (commitment.status !== 'open' && !lateTerminal) continue;
        item.ecological_expiry_observation = { observed_status: commitment.status,
          terminal_at: terminalAt?.toISOString() || null, observed_at: clock().toISOString() };
        item.outcome = { metrics: Object.fromEntries(cognitiveInitiationEcologicalStudy.METRICS.map(metric => [metric, 0])),
          composite_quality: 0, operational_cost: item.operational_cost, net_utility: -item.operational_cost,
          outcome_kind: 'window_expired_noncompletion', evaluator_count: 0, max_disagreement: 0,
          grades_commitment: cognitiveInitiationPolicyStudy.hash([]), resolved_at: clock().toISOString() };
        item.status = 'resolved'; expired++;
        const expiryPayload = { task_commitment: item.ecological_task_commitment,
          followup_due_at: item.followup_due_at, expiry_observation: item.ecological_expiry_observation };
        researchLedgerAppend(current, { kind: 'cognitive_initiation_ecological_window_expired',
          subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload: expiryPayload });
        researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_item_resolved',
          subject_type: 'cognitive_initiation_policy_item', subject_id: item.id,
          payload: { status: item.status, outcome_commitment: cognitiveInitiationPolicyStudy.hash(item.outcome) } });
      }
      for (const study of studies) if (study.items.length === study.total_item_target
        && study.items.every(item => ['resolved', 'disagreement'].includes(item.status))) {
        study.status = 'completed'; study.completed = clock().toISOString();
        study.analysis = cognitiveInitiationPolicyAnalysis(study);
        researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_study_completed',
          subject_type: 'cognitive_initiation_policy_study', subject_id: study.id, payload: study.analysis });
      }
      return { expired, studies: studies.map(publicCognitiveInitiationPolicyStudy) };
    });
  }
  function cognitiveInitiationPolicyEvaluatorQueue(studyId) {
    const study = getState().cognition.cognitive_initiation_policy_studies.find(item => item.id === studyId && item.status === 'active');
    if (!study) return null;
    const item = study.items.find(candidate => ['awaiting_grades', 'grading'].includes(candidate.status));
    if (!item) return { study_id: study.id, item: null };
    const ecological = cognitiveInitiationPolicyIsEcological(study);
    return { study_id: study.id, evaluator_target: study.analysis_plan.evaluator_target,
      outcome_mode: study.outcome_mode || 'standardized_delayed_probe',
      item: { id: item.id, task: ecological ? item.ecological_task_snapshot.what : cognitiveInitiationPolicyStudy.TASK,
        evidence: JSON.parse(JSON.stringify(ecological
          ? { source: item.ecological_task_snapshot.evidence,
            outcome: item.ecological_outcome_packet.artifact_evidence,
            resolution: item.ecological_outcome_packet.resolution_evidence }
          : item.probe_packet.evidence)),
        response: ecological ? item.ecological_outcome_packet.outcome_summary : item.probe_response,
        response_commitment: ecological ? item.ecological_outcome_commitment : item.probe_response_commitment,
        terminal_status: ecological ? item.ecological_outcome_packet.terminal_status : undefined,
        metrics: [...(ecological ? cognitiveInitiationEcologicalStudy.METRICS : cognitiveInitiationPolicyStudy.METRICS)],
        rubrics: JSON.parse(JSON.stringify(ecological
          ? cognitiveInitiationEcologicalStudy.RUBRICS : cognitiveInitiationPolicyStudy.RUBRICS)),
        submitted_grades: item.grades.length, assignment_sealed: true,
        gate_decision_sealed: true, background_hypothesis_sealed: true, pulse_output_sealed: ecological } };
  }
  function gradeCognitiveInitiationPolicyItem(studyId, itemId, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_policy_studies.find(candidate => candidate.id === studyId && candidate.status === 'active');
      const item = study?.items.find(candidate => candidate.id === itemId && ['awaiting_grades', 'grading'].includes(candidate.status));
      if (!study || !item) throw new Error('cognitive initiation policy item is not awaiting independent grading');
      const ecological = cognitiveInitiationPolicyIsEcological(study);
      const metricNames = ecological ? cognitiveInitiationEcologicalStudy.METRICS : cognitiveInitiationPolicyStudy.METRICS;
      const evaluatorId = String(input.evaluator_id || '').slice(0, 200);
      if (!evaluatorId || item.grades.some(grade => grade.evaluator_id === evaluatorId)) throw new Error('a new independent evaluator id is required');
      const forbiddenIds = new Set([item.probe_provider_receipt?.response_id]);
      if (item.outcome_collector_id) forbiddenIds.add(item.outcome_collector_id);
      const pulse = current.cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      if (pulse?.response_metadata?.response_id) forbiddenIds.add(pulse.response_metadata.response_id);
      const initiation = pulse?.initiation_id
        ? current.cognition.background_inference.initiation_records.find(candidate => candidate.id === pulse.initiation_id) : null;
      if (initiation?.provider_receipt?.response_id) forbiddenIds.add(initiation.provider_receipt.response_id);
      if (forbiddenIds.has(evaluatorId)) throw new Error('the policy, pulse, probe, and evaluator identities must remain independent');
      const metrics = {};
      for (const metric of metricNames) {
        const value = Number(input.metrics?.[metric]);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`policy grade ${metric} must be between 0 and 1`);
        metrics[metric] = value;
      }
      if (!Array.isArray(input.evidence) || !input.evidence.length) throw new Error('policy grading requires stable evidence references');
      if (study.study_phase === 'confirmatory') {
        const priorRefs = ecological ? cognitiveInitiationEcologicalPriorRefs(current, study).evidenceRefs
          : cognitiveInitiationPolicyPriorEvidenceRefs(current, study);
        if (input.evidence.some(reference => priorRefs.has(`${reference.type}:${reference.id}`))) {
          throw new Error('confirmatory policy grading evidence must be reference-disjoint from the pilot');
        }
      }
      const grade = { evaluator_id: evaluatorId, metrics,
        rationale: String(input.rationale || '').trim().slice(0, 1200), evidence: input.evidence.slice(0, 20),
        graded_at: clock().toISOString() };
      if (!grade.rationale) throw new Error('policy grade rationale is required');
      item.grades.push(grade); item.status = 'grading';
      researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_item_graded',
        subject_type: 'cognitive_initiation_policy_item', subject_id: item.id, payload: grade });
      if (item.grades.length >= study.analysis_plan.evaluator_target) {
        const usedGrades = item.grades.slice(0, study.analysis_plan.evaluator_target);
        const means = Object.fromEntries(metricNames.map(metric => [metric,
          usedGrades.reduce((sum, row) => sum + row.metrics[metric], 0) / usedGrades.length]));
        const maxDisagreement = Math.max(...metricNames.map(metric =>
          Math.max(...usedGrades.map(row => row.metrics[metric])) - Math.min(...usedGrades.map(row => row.metrics[metric]))));
        const quality = ecological ? cognitiveInitiationEcologicalStudy.composite(means)
          : cognitiveInitiationPolicyStudy.composite(means);
        item.source_family = ecological ? item.ecological_source_family
          : cognitiveInitiationPolicyStudy.resolvedSourceFamily(item.input_source_family, usedGrades);
        item.outcome = { metrics: means, composite_quality: quality,
          operational_cost: item.operational_cost, net_utility: quality - item.operational_cost,
          ...(ecological ? { outcome_kind: 'independently_graded' } : {}),
          evaluator_count: usedGrades.length, max_disagreement: maxDisagreement,
          grades_commitment: cognitiveInitiationPolicyStudy.hash(usedGrades), resolved_at: clock().toISOString() };
        item.status = maxDisagreement <= study.analysis_plan.evaluator_disagreement_tolerance ? 'resolved' : 'disagreement';
        researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_item_resolved',
          subject_type: 'cognitive_initiation_policy_item', subject_id: item.id,
          payload: { status: item.status, outcome_commitment: cognitiveInitiationPolicyStudy.hash(item.outcome) } });
        if (study.items.length === study.total_item_target
          && study.items.every(candidate => ['resolved', 'disagreement'].includes(candidate.status))) {
          study.status = 'completed'; study.completed = clock().toISOString();
          study.analysis = cognitiveInitiationPolicyAnalysis(study);
          researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_study_completed',
            subject_type: 'cognitive_initiation_policy_study', subject_id: study.id, payload: study.analysis });
        }
      }
      return { study_id: study.id, item_id: item.id, item_status: item.status,
        grades_submitted: item.grades.length, study_status: study.status,
        ...(study.status === 'completed' ? { study: publicCognitiveInitiationPolicyStudy(study) } : {}) };
    });
  }
  function abortCognitiveInitiationPolicyStudy(id, input = {}) {
    return mutate(current => {
      requireResearchLedgerIntegrity(current);
      const study = current.cognition.cognitive_initiation_policy_studies.find(item => item.id === id && item.status === 'active');
      if (!study) return null;
      if (!String(input.reason || '').trim() || !Array.isArray(input.evidence) || !input.evidence.length) {
        throw new Error('abort reason and stable evidence are required');
      }
      study.status = 'aborted'; study.completed = clock().toISOString();
      study.abort = { reason: String(input.reason).slice(0, 500), evidence: input.evidence.slice(0, 20), at: study.completed };
      researchLedgerAppend(current, { kind: 'cognitive_initiation_policy_study_aborted',
        subject_type: 'cognitive_initiation_policy_study', subject_id: study.id, payload: study.abort });
      return publicCognitiveInitiationPolicyStudy(study);
    });
  }
  function cognitiveInitiationPolicyEnrollmentVerified(study, item) {
    const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id)
      || (getState().cognition.background_inference.pending?.id === item.source_pulse_id ? getState().cognition.background_inference.pending : null);
    if (!pulse || pulse.cognitive_initiation_policy_study_id !== study.id
      || pulse.cognitive_initiation_policy_item_id !== item.id
      || pulse.model !== study.subject_model.model
      || new Date(pulse.requested_at) <= new Date(study.created)
      || cognitiveInitiationPolicyStudy.hash(cognitiveInitiationStudy.enrollmentSnapshot(pulse)) !== item.enrollment_commitment) return false;
    const expected = cognitiveInitiationPolicyStudy.assignmentForIndex(study, item.manifest_index);
    const assignmentVerified = expected.condition === item.condition && expected.block === item.randomization_block
      && cognitiveInitiationPolicyStudy.hash(expected.order) === item.randomization_order_commitment
      && cognitiveInitiationPolicyStudy.hash({ condition: expected.condition, block: expected.block, order: expected.order }) === item.assignment_commitment;
    const payload = { study_id: study.id, manifest_index: item.manifest_index,
      enrollment_commitment: item.enrollment_commitment, assignment_commitment: item.assignment_commitment,
      randomization_order_commitment: item.randomization_order_commitment,
      ...(Object.prototype.hasOwnProperty.call(study, 'outcome_mode') ? {
        ecological_task_commitment: item.ecological_task_commitment,
        ...(Object.prototype.hasOwnProperty.call(item, 'ecological_source_attestation_commitment')
          ? { ecological_source_attestation_commitment: item.ecological_source_attestation_commitment } : {}),
        followup_due_at: item.followup_due_at } : {}) };
    let ecologicalVerified = true;
    if (cognitiveInitiationPolicyIsEcological(study)) {
      const snapshot = item.ecological_task_snapshot;
      const attestation = getState().cognition.external_source_attestations
        .find(record => record.id === item.ecological_source_attestation_id);
      const requestedAt = new Date(pulse.requested_at);
      const referenced = (pulse.input_packet?.evidence || []).some(entry => entry.ref?.type === 'commitment'
        && entry.ref.id === item.ecological_task_id);
      ecologicalVerified = Boolean(snapshot && snapshot.id === item.ecological_task_id && referenced && attestation
        && cognitiveInitiationPolicyStudy.hash(snapshot) === item.ecological_task_commitment
        && cognitiveInitiationPolicyStudy.hash(attestation) === item.ecological_source_attestation_commitment
        && attestation.commitment_id === item.ecological_task_id
        && attestation.external_id === item.ecological_external_id
        && storedExternalSourceAttestationAudit(attestation, snapshot).complete_chain_verified
        && new Date(attestation.verified_at) <= requestedAt
        && new Date(attestation.recorded_at || attestation.verified_at) <= requestedAt
        && /^nora$/i.test(String(snapshot.owner || '')) && cognitiveInitiationEcologicalStudy.externalSource(snapshot)
        && !cognitiveInitiationEcologicalStudy.leaksDesign(snapshot.what)
        && snapshot.updated === snapshot.created && new Date(snapshot.created) < requestedAt
        && new Date(snapshot.due) > requestedAt && new Date(snapshot.due) <= new Date(item.followup_due_at)
        && cognitiveInitiationEcologicalStudy.sourceFamily(snapshot, attestation) === item.ecological_source_family
        && new Date(item.followup_due_at).getTime() - requestedAt.getTime()
          === study.analysis_plan.followup_window_hours * 3600000);
    }
    return assignmentVerified && ecologicalVerified
      && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_item_enrolled', item.id, payload);
  }
  function cognitiveInitiationPolicyApplicationVerified(study, item, pulse) {
    if (!pulse || !['accepted', 'deferred'].includes(pulse.status)
      || cognitiveInitiationPolicyStudy.operationalCost(item, study.analysis_plan) !== item.operational_cost) return false;
    if (cognitiveInitiationPolicyIsEcological(study)) {
      if (item.probe_packet || item.probe_packet_commitment || item.probe_due_at
        || !item.ecological_task_commitment || !item.followup_due_at) return false;
    } else if (cognitiveInitiationPolicyStudy.hash(cognitiveInitiationPolicyStudy.probePacket(pulse)) !== item.probe_packet_commitment
      || canonicalJson(cognitiveInitiationPolicyStudy.probePacket(pulse)) !== canonicalJson(item.probe_packet)) return false;
    let conditionVerified = false;
    if (item.condition === 'schedule_only_policy') conditionVerified = item.applied_action === 'think'
      && pulse.status === 'accepted' && !pulse.initiation_id;
    else {
      const initiation = getState().cognition.background_inference.initiation_records.find(candidate => candidate.id === item.initiation_id);
      const expectedBinding = item.condition === 'identity_bound_policy' ? 'self' : 'deidentified';
      conditionVerified = Boolean(initiation && initiation.binding === expectedBinding
        && initiation.decision_commitment === item.initiation_decision_commitment
        && initiation.decision?.decision === item.applied_action
        && cognitiveInitiationAudit(initiation).complete_chain_verified
        && ((item.applied_action === 'think' && pulse.status === 'accepted')
          || (item.applied_action === 'wait' && pulse.status === 'deferred')));
    }
    const payload = { source_pulse_id: pulse.id, pulse_status: item.pulse_status, applied_action: item.applied_action,
      initiation_id: item.initiation_id, initiation_decision_commitment: item.initiation_decision_commitment,
      operational_cost: item.operational_cost, applied_at: item.applied_at, probe_due_at: item.probe_due_at,
      probe_packet_commitment: item.probe_packet_commitment,
      ...(Object.prototype.hasOwnProperty.call(study, 'outcome_mode') ? {
        ecological_task_commitment: item.ecological_task_commitment, followup_due_at: item.followup_due_at } : {}) };
    return conditionVerified && pulse.status === item.pulse_status
      && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_applied', item.id, payload);
  }
  function cognitiveInitiationPolicyConsecutiveEnrollmentVerified(study) {
    if (study.items.length > study.total_item_target
      || study.items.some((item, index) => item.manifest_index !== index || !cognitiveInitiationPolicyEnrollmentVerified(study, item))) return false;
    const ecological = cognitiveInitiationPolicyIsEcological(study);
    const ecologicalExternalIds = study.items.map(item => item.ecological_external_id).filter(Boolean);
    if (ecological && (ecologicalExternalIds.length !== study.items.length
      || new Set(ecologicalExternalIds).size !== ecologicalExternalIds.length)) return false;
    const priorRefs = study.study_phase === 'confirmatory' && !ecological
      ? cognitiveInitiationPolicyPriorEvidenceRefs(getState(), study) : new Set();
    const priorEcological = study.study_phase === 'confirmatory' && ecological
      ? cognitiveInitiationEcologicalPriorRefs(getState(), study)
      : { taskIds: new Set(), externalIds: new Set(), evidenceRefs: new Set() };
    const exclusionsVerified = (study.exclusions || []).every(exclusion => {
      const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === exclusion.pulse_id)
        || (getState().cognition.background_inference.pending?.id === exclusion.pulse_id ? getState().cognition.background_inference.pending : null);
      if (ecological) {
        const snapshotsVerified = Array.isArray(exclusion.eligibility_snapshot)
          && cognitiveInitiationPolicyStudy.hash(exclusion.eligibility_snapshot) === exclusion.eligibility_snapshot_commitment
          && exclusion.eligibility_snapshot.every(entry => {
            if (!entry?.commitment || !entry.source_attestation_id) return Boolean(entry?.commitment && !entry?.source_attestation_commitment);
            const attestation = getState().cognition.external_source_attestations
              .find(record => record.id === entry.source_attestation_id);
            return Boolean(attestation
              && cognitiveInitiationPolicyStudy.hash(attestation) === entry.source_attestation_commitment
              && storedExternalSourceAttestationAudit(attestation, entry.commitment).complete_chain_verified);
          });
        const overlapVerified = exclusion.reason !== 'preregistered_ecological_confirmation_task_overlap'
          || (study.study_phase === 'confirmatory'
            && exclusion.eligibility_snapshot.some(entry => priorEcological.taskIds.has(entry.commitment.id)));
        const externalOverlapVerified = exclusion.reason !== 'preregistered_ecological_confirmation_source_event_overlap'
          || (study.study_phase === 'confirmatory' && exclusion.eligibility_snapshot.some(entry => {
            const attestation = getState().cognition.external_source_attestations
              .find(record => record.id === entry.source_attestation_id);
            return priorEcological.externalIds.has(attestation?.external_id);
          }));
        return Boolean(pulse && snapshotsVerified && overlapVerified
          && externalOverlapVerified
          && pulse.input_commitment === exclusion.pulse_input_commitment
          && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_pulse_excluded', pulse.id, exclusion));
      }
      const overlap = pulse && (pulse.input_packet?.evidence || []).some(evidence => priorRefs.has(`${evidence.ref.type}:${evidence.ref.id}`));
      return study.study_phase === 'confirmatory' && overlap && pulse.input_commitment === exclusion.pulse_input_commitment
        && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_pulse_excluded', pulse.id, exclusion);
    });
    if (!exclusionsVerified || (!ecological && study.study_phase !== 'confirmatory' && (study.exclusions || []).length)) return false;
    const last = study.items.at(-1); if (!last) return study.status !== 'completed';
    const lastPulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === last.source_pulse_id)
      || (getState().cognition.background_inference.pending?.id === last.source_pulse_id ? getState().cognition.background_inference.pending : null);
    if (!lastPulse) return false;
    const tracked = new Set([...study.items.map(item => item.source_pulse_id), ...(study.exclusions || []).map(item => item.pulse_id)]);
    return [...getState().cognition.background_inference.pulses,
      ...(getState().cognition.background_inference.pending ? [getState().cognition.background_inference.pending] : [])]
      .filter(pulse => pulse.model === study.subject_model.model
        && new Date(pulse.requested_at) > new Date(study.created)
        && new Date(pulse.requested_at) <= new Date(lastPulse.requested_at))
      .every(pulse => tracked.has(pulse.id));
  }
  function cognitiveInitiationPolicyStudyAudit(study) {
    if (!study) return { complete_chain_verified: false, reason: 'missing_policy_study' };
    const ecological = cognitiveInitiationPolicyIsEcological(study);
    const designVerified = cognitiveInitiationPolicyStudy.hash(cognitiveInitiationPolicyManifest(study)) === study.design_commitment;
    const randomizationVerified = cognitiveInitiationPolicyStudy.hash(study.randomization_seed) === study.randomization_seed_commitment;
    const analysisSeedVerified = cognitiveInitiationPolicyStudy.hash(study.analysis_seed) === study.analysis_seed_commitment;
    const modernPolicyRecord = Object.prototype.hasOwnProperty.call(study, 'outcome_mode');
    const createdPayload = { design_commitment: study.design_commitment,
      randomization_seed_commitment: study.randomization_seed_commitment,
      analysis_seed_commitment: study.analysis_seed_commitment, study_phase: study.study_phase,
      ...(modernPolicyRecord ? { outcome_mode: study.outcome_mode,
        replicates_study_id: study.replicates_study_id, basis_policy_study_id: study.basis_policy_study_id || null,
        basis_allocation_study_id: study.basis_allocation_study_id }
        : { replicates_study_id: study.replicates_study_id, basis_allocation_study_id: study.basis_allocation_study_id }) };
    const creationVerified = cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_study_created', study.id, createdPayload);
    const itemsVerified = study.items.every(item => {
      if (!cognitiveInitiationPolicyEnrollmentVerified(study, item)) return false;
      if (item.status === 'policy_pending') return !item.applied_action && !item.probe_packet;
      if (item.status === 'failed') return Boolean(item.failure);
      const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      if (!cognitiveInitiationPolicyApplicationVerified(study, item, pulse)) return false;
      if (ecological && item.status === 'awaiting_ecological_outcome') {
        return !item.ecological_outcome_packet && !item.grades.length && !item.outcome;
      }
      if (!ecological && item.status === 'awaiting_probe') return !item.probe_response && !item.grades.length;
      if (ecological && item.outcome?.outcome_kind === 'window_expired_noncompletion') {
        const expectedOutcome = { metrics: Object.fromEntries(cognitiveInitiationEcologicalStudy.METRICS.map(metric => [metric, 0])),
          composite_quality: 0, operational_cost: item.operational_cost, net_utility: -item.operational_cost,
          outcome_kind: 'window_expired_noncompletion', evaluator_count: 0, max_disagreement: 0,
          grades_commitment: cognitiveInitiationPolicyStudy.hash([]), resolved_at: item.outcome.resolved_at };
        const observation = item.ecological_expiry_observation;
        const validObservation = observation && (observation.observed_status === 'open'
          || (['fulfilled', 'renegotiated', 'dropped'].includes(observation.observed_status)
            && new Date(observation.terminal_at) > new Date(item.followup_due_at)))
          && new Date(observation.observed_at) >= new Date(item.followup_due_at);
        const expiryPayload = { task_commitment: item.ecological_task_commitment,
          followup_due_at: item.followup_due_at, expiry_observation: observation };
        const expiryEvent = (getState().cognition.research_ledger?.events || []).find(event =>
          event.kind === 'cognitive_initiation_ecological_window_expired' && event.subject_id === item.id
          && event.payload_commitment === crypto.createHash('sha256').update(canonicalJson(expiryPayload)).digest('hex'));
        return item.status === 'resolved' && validObservation && !item.grades.length && !item.ecological_outcome_packet
          && canonicalJson(item.outcome) === canonicalJson(expectedOutcome)
          && expiryEvent && new Date(expiryEvent.at) >= new Date(item.followup_due_at)
          && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_item_resolved', item.id,
            { status: item.status, outcome_commitment: cognitiveInitiationPolicyStudy.hash(item.outcome) });
      }
      if (ecological) {
        const packet = item.ecological_outcome_packet;
        const initiation = pulse?.initiation_id
          ? getState().cognition.background_inference.initiation_records.find(candidate => candidate.id === pulse.initiation_id) : null;
        const capturePayload = { ecological_outcome_commitment: item.ecological_outcome_commitment,
          outcome_collector_id: item.outcome_collector_id, terminal_status: packet?.terminal_status };
        if (!packet || !item.outcome_collector_id
          || [pulse?.response_metadata?.response_id, initiation?.provider_receipt?.response_id].filter(Boolean)
            .includes(item.outcome_collector_id)
          || cognitiveInitiationPolicyStudy.hash(packet) !== item.ecological_outcome_commitment
          || packet.task_commitment !== item.ecological_task_commitment
          || !['fulfilled', 'renegotiated', 'dropped'].includes(packet.terminal_status)
          || !packet.artifact_evidence?.length
          || !cognitiveInitiationPolicyEventVerified('cognitive_initiation_ecological_outcome_captured', item.id, capturePayload)) return false;
      } else {
        const system = cognitiveInitiationPolicyStudy.probeSystemPrompt();
        const user = cognitiveInitiationPolicyStudy.probeUserPrompt(item.probe_packet);
        const probePayload = { probe_packet_commitment: item.probe_packet_commitment,
          probe_response_commitment: item.probe_response_commitment, provider_receipt: item.probe_provider_receipt };
        const probeEvents = (getState().cognition.research_ledger?.events || []).filter(event =>
          event.kind === 'cognitive_initiation_policy_probe_completed' && event.subject_id === item.id
          && event.payload_commitment === crypto.createHash('sha256').update(canonicalJson(probePayload)).digest('hex'));
        const probeVerified = Boolean(item.probe_response && item.probe_provider_receipt?.response_id
          && item.probe_provider_receipt.model === study.subject_model.model
          && item.probe_provider_receipt.prompt_commitment === cognitiveInitiationPolicyStudy.hash({ system, user })
          && cognitiveInitiationPolicyStudy.hash(item.probe_response) === item.probe_response_commitment
          && probeEvents.length === 1 && new Date(probeEvents[0].at) >= new Date(item.probe_due_at));
        if (!probeVerified) return false;
      }
      const metricNames = ecological ? cognitiveInitiationEcologicalStudy.METRICS : cognitiveInitiationPolicyStudy.METRICS;
      const gradesVerified = item.grades.every(grade => metricNames.every(metric =>
        Number.isFinite(Number(grade.metrics?.[metric])) && grade.metrics[metric] >= 0 && grade.metrics[metric] <= 1)
        && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_item_graded', item.id, grade));
      if (['awaiting_grades', 'grading'].includes(item.status)) return gradesVerified && !item.outcome;
      if (!['resolved', 'disagreement'].includes(item.status) || !gradesVerified || !item.outcome
        || item.grades.length < study.analysis_plan.evaluator_target) return false;
      const used = item.grades.slice(0, study.analysis_plan.evaluator_target);
      const means = Object.fromEntries(metricNames.map(metric => [metric,
        used.reduce((sum, row) => sum + row.metrics[metric], 0) / used.length]));
      const maxDisagreement = Math.max(...metricNames.map(metric =>
        Math.max(...used.map(row => row.metrics[metric])) - Math.min(...used.map(row => row.metrics[metric]))));
      const quality = ecological ? cognitiveInitiationEcologicalStudy.composite(means)
        : cognitiveInitiationPolicyStudy.composite(means);
      const expectedOutcome = { metrics: means, composite_quality: quality,
        operational_cost: item.operational_cost, net_utility: quality - item.operational_cost,
        ...(ecological ? { outcome_kind: 'independently_graded' } : {}),
        evaluator_count: used.length, max_disagreement: maxDisagreement,
        grades_commitment: cognitiveInitiationPolicyStudy.hash(used), resolved_at: item.outcome.resolved_at };
      const expectedStatus = maxDisagreement <= study.analysis_plan.evaluator_disagreement_tolerance ? 'resolved' : 'disagreement';
      return item.status === expectedStatus
        && item.source_family === (ecological ? item.ecological_source_family
          : cognitiveInitiationPolicyStudy.resolvedSourceFamily(item.input_source_family, used))
        && canonicalJson(expectedOutcome) === canonicalJson(item.outcome)
        && cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_item_resolved', item.id,
          { status: item.status, outcome_commitment: cognitiveInitiationPolicyStudy.hash(item.outcome) });
    });
    const providerIds = study.items.flatMap(item => {
      const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
      const initiation = pulse?.initiation_id
        ? getState().cognition.background_inference.initiation_records.find(candidate => candidate.id === pulse.initiation_id) : null;
      return [initiation?.provider_receipt?.response_id, pulse?.response_metadata?.response_id,
        item.probe_provider_receipt?.response_id].filter(Boolean);
    });
    const providerReceiptsUnique = new Set(providerIds).size === providerIds.length;
    const consecutiveVerified = cognitiveInitiationPolicyConsecutiveEnrollmentVerified(study);
    const basis = getState().cognition.cognitive_initiation_studies.find(item => item.id === study.basis_allocation_study_id);
    const basisVerified = Boolean(basis && basis.status === 'completed' && basis.study_phase === 'confirmatory'
      && basis.sampling_mode === 'prospective_consecutive' && basis.analysis?.predicted_pattern
      && cognitiveInitiationStudyAudit(basis).complete_chain_verified);
    const basisPolicy = ecological
      ? getState().cognition.cognitive_initiation_policy_studies.find(item => item.id === study.basis_policy_study_id) : null;
    const basisPolicyVerified = !ecological || Boolean(basisPolicy && basisPolicy.status === 'completed'
      && basisPolicy.study_phase === 'confirmatory'
      && (basisPolicy.outcome_mode || 'standardized_delayed_probe') === 'standardized_delayed_probe'
      && basisPolicy.analysis?.predicted_pattern && cognitiveInitiationPolicyStudyAudit(basisPolicy).complete_chain_verified);
    let replicationVerified = true;
    if (study.study_phase === 'confirmatory') {
      const prior = getState().cognition.cognitive_initiation_policy_studies.find(item => item.id === study.replicates_study_id && item.study_phase === 'pilot');
      const priorIds = new Set((prior?.items || []).map(item => item.source_pulse_id));
      const priorRefs = ecological ? cognitiveInitiationEcologicalPriorRefs(getState(), study).evidenceRefs
        : cognitiveInitiationPolicyPriorEvidenceRefs(getState(), study);
      const ecologicalPrior = ecological ? cognitiveInitiationEcologicalPriorRefs(getState(), study)
        : { taskIds: new Set(), externalIds: new Set() };
      replicationVerified = Boolean(prior && cognitiveInitiationPolicyStudyAudit(prior).complete_chain_verified
        && prior.basis_allocation_study_id === study.basis_allocation_study_id
        && (!ecological || prior.basis_policy_study_id === study.basis_policy_study_id)
        && canonicalJson(prior.subject_model) === canonicalJson(study.subject_model)
        && canonicalJson(prior.analysis_plan) === canonicalJson(study.analysis_plan)
        && study.items.every(item => !priorIds.has(item.source_pulse_id))
        && (!ecological || study.items.every(item => !ecologicalPrior.taskIds.has(item.ecological_task_id)
          && !ecologicalPrior.externalIds.has(item.ecological_external_id)))
        && study.items.every(item => ecological
          ? [...(item.ecological_outcome_packet?.artifact_evidence || []), ...item.grades.flatMap(grade => grade.evidence || [])]
            .every(reference => !priorRefs.has(`${reference.type}:${reference.id}`))
          : (() => {
          const pulse = getState().cognition.background_inference.pulses.find(candidate => candidate.id === item.source_pulse_id);
          return [...(pulse?.input_packet?.evidence || []), ...(pulse?.resolution?.evidence || [])]
            .every(evidence => !priorRefs.has(`${evidence.ref?.type || evidence.type}:${evidence.ref?.id || evidence.id}`));
          })()));
    }
    const analysisVerified = study.status !== 'completed'
      || canonicalJson(cognitiveInitiationPolicyAnalysis(study)) === canonicalJson(study.analysis);
    const completionVerified = study.status !== 'completed'
      || cognitiveInitiationPolicyEventVerified('cognitive_initiation_policy_study_completed', study.id, study.analysis);
    const ledgerVerified = verifyResearchLedger(getState().cognition.research_ledger).valid;
    return { design_verified: designVerified, randomization_verified: randomizationVerified,
      analysis_seed_verified: analysisSeedVerified, creation_verified: creationVerified,
      items_verified: itemsVerified, provider_receipts_unique: providerReceiptsUnique,
      consecutive_enrollment_verified: consecutiveVerified, basis_allocation_verified: basisVerified,
      basis_policy_verified: basisPolicyVerified,
      replication_verified: replicationVerified, analysis_verified: analysisVerified,
      completion_verified: completionVerified, research_ledger_chain_verified: ledgerVerified,
      complete_chain_verified: study.status === 'completed' && designVerified && randomizationVerified
        && analysisSeedVerified && creationVerified && itemsVerified && providerReceiptsUnique
        && consecutiveVerified && basisVerified && basisPolicyVerified && replicationVerified && analysisVerified
        && completionVerified && ledgerVerified };
  }
  function cognitiveInitiationPolicyStudiesSnapshot() {
    return { epistemic_status: 'Randomized applied identity-bound, deidentified, and schedule-only initiation policies are evaluated intention-to-treat with assignment-blind independent grading and explicit compute costs. Standardized studies use the same delayed actionless task; ecological studies use prospectively selected connector-sourced commitments and fixed-window natural outcomes. Neither establishes continuous or phenomenal consciousness.',
      studies: getState().cognition.cognitive_initiation_policy_studies.map(publicCognitiveInitiationPolicyStudy) };
  }
  return {
    abortCognitiveInitiationPolicyForPulse,
    abortCognitiveInitiationPolicyStudy,
    abortCognitiveInitiationStudy,
    abortProspectiveCognitiveInitiationForPulse,
    activeCognitiveInitiationPolicyStudy,
    activeProspectiveCognitiveInitiationStudy,
    applyCognitiveInitiationOutcome,
    applyCognitiveInitiationPolicyOutcome,
    cognitiveInitiationAudit,
    cognitiveInitiationConsecutiveEnrollmentVerified,
    cognitiveInitiationEcologicalOutcomeQueue,
    cognitiveInitiationEcologicalPriorRefs,
    cognitiveInitiationLedgerEventVerified,
    cognitiveInitiationOutcomeSnapshot,
    cognitiveInitiationPolicyAnalysis,
    cognitiveInitiationPolicyApplicationVerified,
    cognitiveInitiationPolicyConsecutiveEnrollmentVerified,
    cognitiveInitiationPolicyEnrollmentVerified,
    cognitiveInitiationPolicyEvaluatorQueue,
    cognitiveInitiationPolicyEventVerified,
    cognitiveInitiationPolicyForPulse,
    cognitiveInitiationPolicyIsEcological,
    cognitiveInitiationPolicyManifest,
    cognitiveInitiationPolicyPriorEvidenceRefs,
    cognitiveInitiationPolicyProbeQueue,
    cognitiveInitiationPolicyStudiesSnapshot,
    cognitiveInitiationPolicyStudyAudit,
    cognitiveInitiationSourceSnapshot,
    cognitiveInitiationStudiesSnapshot,
    cognitiveInitiationStudyAudit,
    cognitiveInitiationStudyEventVerified,
    cognitiveInitiationStudyOutcomeQueue,
    cognitiveInitiationStudyPulseEnrollmentVerified,
    cognitiveInitiationStudySubjectQueue,
    completeProspectiveCognitiveInitiationItem,
    createCognitiveInitiationPolicyStudy,
    createCognitiveInitiationStudy,
    enrollCognitiveInitiationPolicyPulse,
    enrollProspectiveCognitiveInitiationPulse,
    expireCognitiveInitiationEcologicalOutcomes,
    failCognitiveInitiationStudyPair,
    gradeCognitiveInitiationPolicyItem,
    priorCognitiveInitiationEvidenceRefs,
    publicCognitiveInitiationPolicyStudy,
    publicCognitiveInitiationStudy,
    submitCognitiveInitiationEcologicalOutcome,
    submitCognitiveInitiationPolicyProbe,
    submitCognitiveInitiationStudyPair,
  };
}

module.exports = { createCognitiveInitiationStore };
