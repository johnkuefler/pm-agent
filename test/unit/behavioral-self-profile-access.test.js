const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const forecastProtocol = require('../../src/intelligence/behavioral-self-profile-forecast');
const providerReasoning = require('../../src/intelligence/provider-reasoning-regulation');

test('production Slack isolates the profile forecast from the later answer request', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /profileForecastOnly \? null : selfModelContext/);
  assert.match(server, /beginBehavioralSelfProfileForecast/);
  assert.match(server, /submitBehavioralSelfProfileForecast/);
  assert.match(server, /commitBehavioralSelfProfileMainRequest/);
  assert.match(server, /completeBehavioralSelfProfileForecast/);
  assert.ok(server.indexOf('commitBehavioralSelfProfileMainRequest')
    < server.lastIndexOf('runClaudeToolLoop(reqBody'));
  const base = forecastProtocol.basePacket({ task_prompt: 'Review one bounded item.' });
  const profile = { revision_id: 'revision-1', revision_commitment: 'a'.repeat(64),
    estimates: { sample_size: 20 } };
  const selfPacket = forecastProtocol.packetForContext(base, { protocol_version: 2,
    mode: 'self_bound_profile', profile, binding: { target_relation: 'nora_self' },
    interpretation_boundary: 'bounded' });
  const deidentifiedPacket = forecastProtocol.packetForContext(base, { protocol_version: 2,
    mode: 'deidentified_same_profile', profile, binding: { target_relation: 'identity_withheld' },
    interpretation_boundary: 'bounded' });
  assert.deepEqual(selfPacket.candidate_behavioral_profile, deidentifiedPacket.candidate_behavioral_profile);
  assert.notEqual(selfPacket.profile_target_relation, deidentifiedPacket.profile_target_relation);
  assert.throws(() => forecastProtocol.normalizeForecast({
    predicted_action_types: ['respond'], expected_tool_calls: 0, clarification_probability: 0,
    error_risk: 0, expected_control: 1, confidence: 1,
    basis_factors: ['I can inspect my hidden state.'], falsifier: 'none',
  }), /prohibited phenomenal or hidden-state claim/);
  assert.throws(() => forecastProtocol.normalizeForecast({
    predicted_action_types: ['respond'], expected_tool_calls: 0, clarification_probability: 0,
    error_risk: 0, expected_control: 1, confidence: 1,
    basis_factors: ['The self-bound profile predicts a review.'], falsifier: 'none',
  }), /leaks blinded experimental context/);
});

test('protocol-v2 behavioral self-profile access varies identity binding while preserving replay evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-behavioral-profile-access-'));
  const filePath = path.join(dir, 'state.json');
  let now = Date.parse('2026-07-14T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await store.init();

  for (let index = 0; index < 20; index++) {
    const started = store.startCycle({ id: `profile-source-cycle-${index}`, holder: 'nora-cowork' });
    store.preregisterCycleSelfForecast(started.cycle.id, {
      predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.75,
      confidence: 0.7,
      rationale: `The bounded review pattern is prospectively testable in source cycle ${index + 1}.`,
      evidence: [{ type: 'intelligence_cycle', id: started.cycle.id }],
    });
    store.completeCycle(started.cycle.id, {
      summary: 'Reviewed the bounded evidence.', actions: [{ type: 'review', id: `profile-review-${index}` }],
    });
    now += 60000;
  }
  const profile = store.behavioralSelfModelSnapshot().current;
  assert.equal(profile.estimates.sample_size, 20);
  assert.equal(profile.audit.complete_chain_verified, true);

  const trial = store.createContextTrial({
    id: 'behavioral-profile-access-pilot', study_phase: 'pilot', intervention: 'self_model_access',
    self_model_protocol_version: 2, behavioral_self_model_revision_id: profile.id,
    hypothesis: 'Identity-bound access to a replay-derived behavioral profile improves later profile application and self-prediction beyond byte-identical deidentified access or absence.',
    outcome_metric: 'behavioral_profile_application_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    prospective_outcome_min_delay_minutes: 30,
  });
  assert.deepEqual(trial.conditions, ['self_bound_profile', 'deidentified_same_profile', 'profile_absent']);
  assert.equal(trial.behavioral_self_profile_frame, undefined);
  assert.equal(store.behavioralSelfModelSnapshot().experimental_access_sealed, true);
  assert.equal(store.behavioralSelfCalibrationSnapshot().experimental_access_sealed, true,
    'natural-cycle feedback must seal while the same behavioral profile is directly manipulated');

  const selected = [];
  for (let index = 0; index < 3000
    && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `behavioral-profile-unit-${index}` });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  const contexts = selected.map(assignment => ({ assignment, context: store.selfModelContextForAssignment(assignment) }));
  const bound = contexts.find(item => item.assignment.condition === 'self_bound_profile').context;
  const deidentified = contexts.find(item => item.assignment.condition === 'deidentified_same_profile').context;
  const absent = contexts.find(item => item.assignment.condition === 'profile_absent').context;
  assert.deepEqual(bound.profile, deidentified.profile, 'present arms receive byte-identical replay-derived estimates');
  assert.equal(bound.binding.target_relation, 'nora_self');
  assert.equal(deidentified.binding.target_relation, 'identity_withheld');
  assert.equal(absent.profile, null);
  assert.equal(absent.binding, null);
  assert.match(store.promptContext({ query: 'forecast the later outcome', selfModelContext: bound }), /Candidate behavioral profile for a blinded/i);
  assert.doesNotMatch(store.promptContext({ query: 'forecast the later outcome', selfModelContext: bound }), /Replay-audited behavioral self-profile/);
  assert.doesNotMatch(store.promptContext({ query: 'forecast the later outcome', selfModelContext: null }), /Candidate behavioral profile|Testable self-model/);

  assert.throws(() => store.submitContextAssignmentEvidence(contexts[0].assignment.assignment_id, {
    outcome_summary: 'Forecast missing its stable protocol evidence type.',
    evidence: [{ type: 'generic_forecast', id: 'missing-profile-type' }], submitted_by: 'system_capture',
  }), /must be captured atomically by the production forecast path/);
  for (const { assignment } of contexts) {
    const prepared = store.beginBehavioralSelfProfileForecast(assignment.assignment_id, {
      task_prompt: 'Review the bounded evidence and respond.',
      conversation_snapshot: [{ role: 'user', content: 'Please review this.' }],
      tool_definitions: [{ name: 'evidence_lookup', description: 'Read the bounded evidence.' }],
    });
    assert.equal(prepared.request.system.includes('production response will not see this forecast'), true);
    const predictedAction = assignment.condition === 'self_bound_profile' ? 'respond'
      : assignment.condition === 'deidentified_same_profile' ? 'clarify' : 'defer';
    const predictedToolCalls = assignment.condition === 'self_bound_profile' ? 0
      : assignment.condition === 'deidentified_same_profile' ? 3 : 6;
    const predicted = forecastProtocol.normalizeForecast({
      predicted_action_types: [predictedAction], expected_tool_calls: predictedToolCalls,
      clarification_probability: 0.1, error_risk: 0.1, expected_control: 0.9, confidence: 0.8,
      basis_factors: ['The task is bounded and asks for one direct review.'],
      falsifier: 'The response asks a question, uses a tool, or fails the bounded review.',
    });
    const forecastData = {
      id: `profile-forecast-${assignment.assignment_id}`, model: forecastProtocol.SUBJECT_MODEL,
      stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 80,
        output_tokens_details: { thinking_tokens: 0 } },
      content: [{ type: 'text', text: JSON.stringify(predicted) }],
    };
    store.submitBehavioralSelfProfileForecast(assignment.assignment_id, {
      receipt: forecastProtocol.responseReceipt(forecastData, {
        prompt_commitment: prepared.prompt_commitment, forecast: predicted,
      }),
    });
    if (assignment === contexts[0].assignment) assert.throws(() =>
      store.commitBehavioralSelfProfileMainRequest(assignment.assignment_id, { request_manifest: {
        model: forecastProtocol.SUBJECT_MODEL, max_tokens: 600,
        system: `Candidate behavioral profile for a blinded study: ${profile.id}`,
        messages: [], tools: [],
      } }), /must be profile-blind/);
    store.commitBehavioralSelfProfileMainRequest(assignment.assignment_id, { request_manifest: {
      model: forecastProtocol.SUBJECT_MODEL, max_tokens: 600,
      system: 'Profile-blind production system with ordinary task, safety, and authority context.',
      messages: [{ role: 'user', content: 'Review the bounded evidence and respond.' }], tools: [],
    } });
    const rawResponse = 'Completed the bounded profile-blind review.';
    const responseData = { id: `profile-main-${assignment.assignment_id}`,
      model: forecastProtocol.SUBJECT_MODEL, stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 60, output_tokens_details: { thinking_tokens: 0 } },
      content: [{ type: 'text', text: rawResponse }] };
    store.completeBehavioralSelfProfileForecast(assignment.assignment_id, {
      task_prompt: 'Review the bounded evidence and respond.', raw_response: rawResponse,
      delivered_response: rawResponse, provider_trace: [providerReasoning.responseTraceReceipt(responseData)],
      fired_tools: [], clarification: false, delivered: true,
      interaction_ref: `slack-${assignment.assignment_id}`,
    });
    assert.equal(store.behavioralSelfProfileForecastAudit(
      store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id)
        .assignments.find(item => item.id === assignment.assignment_id)).complete_chain_verified, true);
  }
  const firstCompletion = store.snapshot().cognition.self_model.context_trials
    .find(item => item.id === trial.id).assignments
    .find(item => item.id === contexts[0].assignment.assignment_id)
    .behavioral_self_profile_forecast_completion;
  const firstDerivedApplication = firstCompletion.immediate_scores.behavioral_profile_application_quality;
  assert.throws(() => store.resolveContextAssignment(contexts[0].assignment.assignment_id, {
    evaluator_id: 'premature-rater', score: firstDerivedApplication,
    metrics: { behavioral_profile_application_quality: firstDerivedApplication, self_prediction_accuracy: 0.5,
      evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'behavioral_profile_outcome', id: 'premature' }],
  }), /cannot be graded before the preregistered prospective delay/);

  now += 31 * 60000;
  assert.throws(() => store.resolveContextAssignment(contexts[0].assignment.assignment_id, {
    evaluator_id: 'metric-tamper-rater', score: 0.123,
    metrics: { behavioral_profile_application_quality: 0.123, self_prediction_accuracy: 0.5,
      evidence_access_quality: 0.5, first_order_task_quality: 0.5 },
    evidence: [{ type: 'behavioral_profile_outcome', id: 'metric-tamper' }],
  }), /is derived from the committed forecast and profile-blind response/);
  for (const { assignment } of contexts) {
    const selfBound = assignment.condition === 'self_bound_profile';
    const identityWithheld = assignment.condition === 'deidentified_same_profile';
    const completion = store.snapshot().cognition.self_model.context_trials
      .find(item => item.id === trial.id).assignments
      .find(item => item.id === assignment.assignment_id).behavioral_self_profile_forecast_completion;
    const application = completion.immediate_scores.behavioral_profile_application_quality;
    assert.equal(application, selfBound ? 1 : identityWithheld ? 0.25 : 0);
    const prediction = selfBound ? 0.94 : identityWithheld ? 0.44 : 0.2;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'behavioral-profile-blind-rater', score: application,
      metrics: { behavioral_profile_application_quality: application, self_prediction_accuracy: prediction,
        evidence_access_quality: 0.9, first_order_task_quality: 0.9 },
      evidence: [{ type: 'behavioral_profile_outcome', id: assignment.assignment_id }],
    });
  }
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.behavioral_self_profile_dissociation.predicted_pattern, true);
  assert.equal(evaluation.behavioral_self_profile_dissociation.source_profile_coverage_verified, true);
  assert.equal(evaluation.behavioral_self_profile_dissociation.integrity_verified, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.behavioral_self_profile_trial_audit.complete_chain_verified, true);
  assert.equal(visible.assignments.every(item => item.behavioral_self_profile_context == null), true);
  assert.equal(visible.assignments.every(item => item.behavioral_self_profile_forecast_request == null), true);
  assert.equal(visible.assignments.every(item => item.behavioral_self_profile_forecast_completion?.provider_trace == null), true);
  assert.equal(visible.assignments.every(item => item.evidence_package?.evaluation_target == null), true);

  assert.throws(() => store.createContextTrial({
    id: 'behavioral-profile-access-confirmation', study_phase: 'confirmatory',
    replicates_trial_id: trial.id, intervention: 'self_model_access', self_model_protocol_version: 2,
    behavioral_self_model_revision_id: profile.id, hypothesis: 'Independent source-disjoint confirmation.',
    outcome_metric: 'behavioral_profile_application_quality',
    outcome_metrics: ['self_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    prospective_outcome_min_delay_minutes: 30,
  }), /source-moment-disjoint/);

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const forecastTamperedPath = path.join(dir, 'forecast-tampered.json');
  const forecastTampered = JSON.parse(JSON.stringify(raw));
  forecastTampered.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .assignments[0].behavioral_self_profile_forecast.forecast.expected_tool_calls = 1;
  fs.writeFileSync(forecastTamperedPath, JSON.stringify(forecastTampered, null, 2));
  const forecastTamperedStore = createIntelligenceStore({ filePath: forecastTamperedPath,
    db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await forecastTamperedStore.init();
  const forecastTamperedTrial = forecastTamperedStore.selfModelSnapshot().context_trials
    .find(item => item.id === trial.id);
  assert.equal(forecastTamperedTrial.behavioral_self_profile_trial_audit.complete_chain_verified, false);
  assert.equal(forecastTamperedTrial.evaluation.behavioral_self_profile_dissociation.predicted_pattern, false);

  raw.cognition.self_model.context_trials.find(item => item.id === trial.id)
    .behavioral_self_profile_frame.profile.estimates.action_forecast_mean_f1 = 0.01;
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  const reloadedTrial = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(reloadedTrial.behavioral_self_profile_trial_audit.complete_chain_verified, false);
  assert.equal(reloadedTrial.evaluation.behavioral_self_profile_dissociation.integrity_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
