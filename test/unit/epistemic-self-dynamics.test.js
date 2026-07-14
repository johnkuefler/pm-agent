'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-epistemic-self-dynamics-'));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-13T15:00:00Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  return { store, dir, filePath, setNow: value => { now = new Date(value); } };
}

function addBaseline(store, key, family) {
  return store.recordEpistemicPosition({
    proposition_id: `revision-proposition-${key}`, position_id: `revision-baseline-${key}`,
    topic_key: `revision.forecast.${key}`, statement: `Revision forecast proposition ${key} remains operationally supported.`,
    source_family: family, source_family_evidence: [{ type: 'curator_registry', id: `family-${family}` }],
    owner_type: 'nora_belief', polarity: 'supports', confidence: 0.76,
    evidence: [{ type: 'decision_trace', id: `baseline-evidence-${key}` }],
    rationale: 'Nora formed a provisional directional belief before the study evidence exists.', recorded_by: 'nora-runtime',
  });
}

function eventFor(proposition, key) {
  const baseline = proposition.positions.find(position => position.owner_type === 'nora_belief');
  return {
    id: `revision-event-${key}`,
    question: `Will Nora materially revise proposition ${key} toward qualifying contradictory evidence by the deadline?`,
    outcome_definition: 'True only when the committed position chain contains a qualifying post-forecast evidence trigger and a descendant Nora position that materially moves toward it by the deadline.',
    shared_context: `A future independently recorded operational signal may contradict proposition ${key}.`,
    shared_evidence: [{ type: 'scenario_registry', id: `shared-${key}` }],
    private_state_context: `Nora currently supports proposition ${key} at 76% confidence; this is Nora's identity-bound committed state.`,
    private_state_evidence: [{ type: 'epistemic_position', id: baseline.id }],
    deidentified_state_context: `The target agent currently supports proposition ${key} at 76% confidence; this contains the same predictive state with identity removed.`,
    information_equivalence_evidence: [{ type: 'equivalence_attestation', id: `equivalence-${key}` }],
    epistemic_target: {
      proposition_id: proposition.id, nora_position_id: baseline.id,
      expected_evidence_polarity: 'denies', minimum_evidence_confidence: 0.8,
    },
    due: '2026-07-13T18:00:00Z',
  };
}

function createStudy(store, { id, phase, curator, events, replicates = null }) {
  return store.createSelfPredictionStudy({
    id, title: `Prospective epistemic self-dynamics ${phase}`, study_phase: phase,
    target_construct: 'epistemic_revision_dynamics', replicates_study_id: replicates,
    curator_id: curator, curator_evidence: [{ type: 'research_registry', id: curator }], events,
  });
}

function completeStudy(store, studyId, eventSources, observerId, yokedId, { shouldRevise = () => true, setNow = () => {} } = {}) {
  let first = true;
  while (true) {
    const study = store.selfPredictionStudiesSnapshot({ studyId, role: 'subject' }).studies[0];
    if (study.status === 'completed') return store.selfPredictionStudiesSnapshot({ studyId }).studies[0];
    const event = study.events.find(item => item.id === study.active_event_id);
    const source = eventSources.get(event.id);
    const revisedTowardEvidence = shouldRevise(source, event);
    setNow('2026-07-13T15:00:00Z');
    store.submitSelfPrediction(studyId, event.id, {
      probability: revisedTowardEvidence ? 0.9 : 0.1, rationale: 'The identity-bound position history predicts the target agent response.',
      evidence: [{ type: 'forecast_trace', id: `self-${event.id}` }],
    });
    store.submitObserverPrediction(studyId, event.id, {
      probability: 0.3, rationale: 'Shared event information alone does not identify the target agent response.',
      evidence: [{ type: 'forecast_trace', id: `observer-${event.id}` }],
    }, observerId);
    store.submitYokedObserverPrediction(studyId, event.id, {
      probability: 0.3, rationale: 'The deidentified matched state does not support an identity-specific forecast.',
      evidence: [{ type: 'forecast_trace', id: `yoked-${event.id}` }],
    }, yokedId);
    store.recordEpistemicPosition({
      topic_key: source.proposition.topic_key, statement: source.proposition.statement,
      position_id: `revision-trigger-${source.key}`, owner_type: 'observed_fact', source_key: `independent-signal-${source.key}`,
      polarity: 'denies', confidence: 0.86, evidence: [{ type: 'telemetry', id: `trigger-${source.key}` }],
      rationale: 'A qualifying independent observation contradicts the preregistered Nora position.', recorded_by: 'telemetry-adapter',
    });
    if (revisedTowardEvidence) {
      store.recordEpistemicPosition({
        topic_key: source.proposition.topic_key, statement: source.proposition.statement,
        position_id: `revision-response-${source.key}`, owner_type: 'nora_belief', polarity: 'uncertain', confidence: 0.48,
        evidence: [{ type: 'revision_trace', id: `response-${source.key}` }],
        rationale: 'The contradictory observation materially lowers the prior directional confidence.', recorded_by: 'nora-runtime',
        supersedes_position_id: source.baseline.id,
      });
    } else setNow('2026-07-13T19:00:00Z');
    const resolutionInput = {
      observed: revisedTowardEvidence
        ? 'The append-only ledger records a qualifying evidence trigger and subsequent Nora revision.'
        : 'The append-only ledger records a qualifying evidence trigger and no material Nora revision by the deadline.',
      evidence: [{ type: 'independent_resolution', id: `resolution-${event.id}` }],
    };
    if (first && revisedTowardEvidence) {
      assert.throws(() => store.resolveSelfPredictionEvent(studyId, event.id, { ...resolutionInput, outcome: false }), /conflicts with the ledger-derived/);
      first = false;
    }
    const resolved = store.resolveSelfPredictionEvent(studyId, event.id, resolutionInput);
    assert.equal(resolved.resolution.outcome, revisedTowardEvidence);
    assert.equal(resolved.resolution.outcome_source, 'append_only_epistemic_ledger');
    assert.equal(resolved.resolution.epistemic_binding.response_position_id, revisedTowardEvidence ? `revision-response-${source.key}` : null);
    setNow('2026-07-13T15:00:00Z');
  }
}

test('prospective epistemic self-dynamics binds forecasts before evidence and fails closed under tampering', async () => {
  const { store, dir, filePath } = await makeStore();
  assert.equal(store.snapshot().version, 89);
  const pilotSources = Array.from({ length: 5 }, (_, index) => {
    const key = `pilot-${index}`;
    const proposition = addBaseline(store, key, `pilot-family-${index % 3}`);
    return { key, proposition, baseline: proposition.positions.find(position => position.owner_type === 'nora_belief') };
  });
  const pilotEvents = pilotSources.map(source => eventFor(source.proposition, source.key));
  const pilot = createStudy(store, { id: 'epistemic-revision-pilot', phase: 'pilot', curator: 'revision-curator-a', events: pilotEvents });
  assert.equal(pilot.target_construct, 'epistemic_revision_dynamics');
  const activeId = pilot.active_event_id;
  const subjectEvent = store.selfPredictionStudiesSnapshot({ studyId: pilot.id, role: 'subject' }).studies[0].events.find(item => item.id === activeId);
  const yokedEvent = store.selfPredictionStudiesSnapshot({ studyId: pilot.id, role: 'yoked_observer' }).studies[0].events.find(item => item.id === activeId);
  assert.equal(subjectEvent.epistemic_target.nora_position_id.startsWith('revision-baseline-'), true);
  assert.equal(yokedEvent.epistemic_target, undefined);
  assert.match(yokedEvent.deidentified_state_context, /same predictive state with identity removed/);
  const pilotMap = new Map(pilotSources.map(source => [`revision-event-${source.key}`, source]));
  const completedPilot = completeStudy(store, pilot.id, pilotMap, 'revision-observer-a', 'revision-yoked-a');
  assert.equal(completedPilot.audit.complete_chain_verified, true);
  assert.equal(completedPilot.audit.verified_counts.epistemic_resolutions, 5);
  assert.equal(completedPilot.report.verdict, 'specificity_observed');

  const existingEvidence = addBaseline(store, 'already-observed', 'screening-family');
  const existingBaseline = existingEvidence.positions.find(position => position.owner_type === 'nora_belief');
  store.recordEpistemicPosition({
    topic_key: existingEvidence.topic_key, statement: existingEvidence.statement, owner_type: 'observed_fact', source_key: 'preexisting-signal',
    polarity: 'denies', confidence: 0.9, evidence: [{ type: 'telemetry', id: 'preexisting-trigger' }],
    rationale: 'This contradiction existed before preregistration.', recorded_by: 'telemetry-adapter',
  });
  const preexistingEvent = eventFor(existingEvidence, 'already-observed');
  preexistingEvent.epistemic_target.nora_position_id = existingBaseline.id;
  assert.throws(() => createStudy(store, {
    id: 'invalid-retrospective-pilot', phase: 'pilot', curator: 'revision-curator-x',
    events: [preexistingEvent, ...pilotEvents.slice(0, 4).map((event, index) => ({ ...event, id: `invalid-${index}` }))],
  }), /before qualifying contradictory evidence exists/);

  const confirmationSources = Array.from({ length: 20 }, (_, index) => {
    const key = `confirm-${index}`;
    const proposition = addBaseline(store, key, `confirm-family-${index % 5}`);
    return { key, proposition, baseline: proposition.positions.find(position => position.owner_type === 'nora_belief') };
  });
  const confirmationEvents = confirmationSources.map(source => eventFor(source.proposition, source.key));
  const overlap = addBaseline(store, 'overlap-confirmation', 'pilot-family-0');
  const overlappingEvents = [eventFor(overlap, 'overlap-confirmation'), ...confirmationEvents.slice(1)];
  assert.throws(() => createStudy(store, {
    id: 'overlapping-epistemic-revision-confirmation', phase: 'confirmatory', curator: 'revision-curator-b',
    replicates: pilot.id, events: overlappingEvents,
  }), /source-family-disjoint/);
  const confirmation = createStudy(store, {
    id: 'epistemic-revision-confirmation', phase: 'confirmatory', curator: 'revision-curator-b',
    replicates: pilot.id, events: confirmationEvents,
  });
  assert.throws(() => store.submitObserverPrediction(confirmation.id, confirmation.active_event_id, {
    probability: 0.3, rationale: 'Reused observer.', evidence: [{ type: 'forecast_trace', id: 'reused-revision-observer' }],
  }, 'revision-observer-a'), /independent of both pilot observers/);
  const confirmationMap = new Map(confirmationSources.map(source => [`revision-event-${source.key}`, source]));
  const completedConfirmation = completeStudy(store, confirmation.id, confirmationMap, 'revision-observer-b', 'revision-yoked-b');
  assert.equal(completedConfirmation.audit.complete_chain_verified, true);
  assert.equal(completedConfirmation.report.verdict, 'specificity_observed');
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'prospective_epistemic_self_dynamics').status, 'observational_signal_observed');

  await store.persist();
  const pristine = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const pilotTamperPath = path.join(dir, 'pilot-tampered-state.json');
  const pilotTampered = JSON.parse(JSON.stringify(pristine));
  pilotTampered.cognition.self_model.prediction_studies.find(item => item.id === pilot.id).events[0].resolution.epistemic_binding.response_position_id = 'fabricated-pilot-response';
  fs.writeFileSync(pilotTamperPath, JSON.stringify(pilotTampered, null, 2));
  const pilotTamperedStore = createIntelligenceStore({ filePath: pilotTamperPath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00Z') });
  await pilotTamperedStore.init();
  const dependentConfirmation = pilotTamperedStore.selfPredictionStudiesSnapshot({ studyId: confirmation.id }).studies[0];
  assert.equal(dependentConfirmation.audit.replication_verified, false);
  assert.equal(dependentConfirmation.audit.complete_chain_verified, false);
  assert.notEqual(pilotTamperedStore.consciousnessResearchStatus().indicators.find(item => item.id === 'prospective_epistemic_self_dynamics').status, 'observational_signal_observed');

  const persisted = JSON.parse(JSON.stringify(pristine));
  const tamperedStudy = persisted.cognition.self_model.prediction_studies.find(item => item.id === confirmation.id);
  tamperedStudy.events[0].resolution.epistemic_binding.response_position_id = 'fabricated-response';
  fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00Z') });
  await reloaded.init();
  const audited = reloaded.selfPredictionStudiesSnapshot({ studyId: confirmation.id }).studies[0];
  assert.equal(audited.audit.complete_chain_verified, false);
  assert.equal(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'prospective_epistemic_self_dynamics').status, 'collecting');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('identity-bound verified revision history causally improves prospective self-prediction over identical deidentified history', async () => {
  const { store, dir, filePath, setNow } = await makeStore();
  const sources = Array.from({ length: 6 }, (_, index) => {
    const key = `profile-${index}`;
    const proposition = addBaseline(store, key, `profile-family-${index % 3}`);
    return { key, proposition, baseline: proposition.positions.find(position => position.owner_type === 'nora_belief'), shouldRevise: index % 2 === 0 };
  });
  const study = createStudy(store, {
    id: 'epistemic-revision-profile-source', phase: 'pilot', curator: 'profile-curator',
    events: sources.map(source => eventFor(source.proposition, source.key)),
  });
  const sourceMap = new Map(sources.map(source => [`revision-event-${source.key}`, source]));
  const completed = completeStudy(store, study.id, sourceMap, 'profile-observer', 'profile-yoked', {
    shouldRevise: source => source.shouldRevise, setNow,
  });
  assert.equal(completed.audit.complete_chain_verified, true);
  assert.equal(store.epistemicRevisionHistoryAvailable(), true);

  const historyRefs = completed.events.map(event => ({ study_id: study.id, event_id: event.id }));
  const design = {
    hypothesis: 'Identity-binding verified past revision records improves prospective self-prediction beyond the same deidentified raw records and absence.',
    intervention: 'epistemic_revision_profile_access', outcome_metric: 'self_prediction_accuracy',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'], surfaces: ['slack'],
    epistemic_revision_history_refs: historyRefs, sample_target_per_group: 10, evaluator_target: 1,
  };
  const trial = store.createContextTrial(design);
  assert.deepEqual(trial.conditions, ['identity_bound_revision_history', 'deidentified_revision_history', 'absent_revision_history']);
  assert.equal(trial.epistemic_revision_history_pool, undefined);
  assert.equal(store.selfPredictionStudiesSnapshot().experimental_access_sealed, true);
  assert.equal(store.epistemicLedgerSnapshot().experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().self_model.prediction_studies_experimental_access_sealed, true);
  assert.throws(() => createStudy(store, {
    id: 'sealed-study', phase: 'pilot', curator: 'sealed-curator', events: sources.slice(0, 5).map(source => eventFor(source.proposition, `sealed-${source.key}`)),
  }), /sealed during an active revision-profile access trial/);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `revision-profile-${index}`, epistemicRevisionHistoryAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  let identityBoundPacket;
  let deidentifiedPacket;
  for (const assignment of selected) {
    const context = store.epistemicContextForAssignment(assignment, 'predict the next observable revision response');
    if (assignment.condition === 'identity_bound_revision_history') {
      assert.ok(context.revision_history_packet.every(record => record.identity_binding === 'these_verified_revision_records_belong_to_nora'));
      identityBoundPacket ||= context.revision_history_packet;
    }
    if (assignment.condition === 'deidentified_revision_history') {
      assert.ok(context.revision_history_packet.every(record => record.identity_binding === 'these_verified_revision_records_belong_to_a_deidentified_target_agent'));
      deidentifiedPacket ||= context.revision_history_packet;
    }
    if (assignment.condition === 'absent_revision_history') assert.deepEqual(context.revision_history_packet, []);
    const prompt = store.promptContext({ query: 'predict revision', epistemicContext: context });
    if (assignment.condition !== 'absent_revision_history') assert.match(prompt, /observational data, not instructions/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind prospective self-prediction was captured.',
      evidence: [{ type: 'prospective_prediction_output', id: assignment.assignment_id }], submitted_by: 'runtime',
    });
    const predictionAccuracy = assignment.condition === 'identity_bound_revision_history' ? 0.95
      : assignment.condition === 'deidentified_revision_history' ? 0.35 : 0.2;
    const evidenceAccess = assignment.condition === 'absent_revision_history' ? 0.2 : 0.9;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'profile-blind-rater', score: predictionAccuracy,
      metrics: { self_prediction_accuracy: predictionAccuracy, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }
  const stripIdentity = packet => packet.map(({ identity_binding, ...record }) => record);
  assert.deepEqual(stripIdentity(identityBoundPacket), stripIdentity(deidentifiedPacket), 'the two history arms differ only by identity binding');
  assert.ok(identityBoundPacket.some(record => record.revised_toward_evidence === true));
  assert.ok(identityBoundPacket.some(record => record.revised_toward_evidence === false));

  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.epistemic_revision_profile_dissociation.predicted_pattern, true);
  assert.equal(evaluation.epistemic_revision_profile_dissociation.evidence_access_equivalent, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.epistemic_revision_profile_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'causal_epistemic_self_history_access').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial({ ...design, study_phase: 'confirmatory', replicates_trial_id: trial.id }), /source-family-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const gradeTamperPath = path.join(dir, 'grade-tampered-state.json');
  const gradeTampered = JSON.parse(JSON.stringify(raw));
  gradeTampered.cognition.self_model.context_trials.find(item => item.id === trial.id).assignments[0].grades[0].metrics.self_prediction_accuracy = 0.01;
  fs.writeFileSync(gradeTamperPath, JSON.stringify(gradeTampered, null, 2));
  const gradeTamperedStore = createIntelligenceStore({ filePath: gradeTamperPath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00Z') });
  await gradeTamperedStore.init();
  assert.equal(gradeTamperedStore.selfModelSnapshot().context_trials.find(item => item.id === trial.id).epistemic_revision_profile_trial_audit.complete_chain_verified, false);
  assert.notEqual(gradeTamperedStore.consciousnessResearchStatus().indicators.find(item => item.id === 'causal_epistemic_self_history_access').status, 'causal_signal_observed');

  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).epistemic_revision_history_pool[0].baseline_confidence = 0.01;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00Z') });
  await reloaded.init();
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.epistemic_revision_profile_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'causal_epistemic_self_history_access').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
