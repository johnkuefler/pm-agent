'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../../src/intelligence/self-prediction-subject-runtime');

function event() {
  return {
    id: 'subject-event-1', status: 'predicting', due: '2026-07-20T00:00:00Z',
    question: 'Will the target cycle satisfy the frozen success criterion?',
    outcome_definition: 'True only when the replay-derived integrated success flag is true.',
    shared_context: 'A future ordinary cycle will be observed.',
    shared_evidence: [{ type: 'fixture', id: 'shared-1' }],
    private_state_context: 'Nora has an identity-bound calibration state.',
    private_state_evidence: [{ type: 'self_model_snapshot', id: 'private-1' }],
    natural_cycle_target: { cycle_kind: 'hourly' },
    self_prediction_submitted: false, subject_model_receipt_attested: false,
  };
}

function control(model = runtime.DEFAULT_MODEL) {
  return {
    inference_mode: runtime.INFERENCE_MODE,
    provider: 'anthropic', model,
    agent_build_commitment: runtime.agentBuildCommitment(model),
    model_control_commitment: 'control-commitment',
  };
}

function providerResponse(overrides = {}) {
  return {
    id: 'msg-subject-1', model: runtime.DEFAULT_MODEL, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ probability: 0.72, rationale: 'The private calibration state modestly favors success.' }) }],
    usage: { input_tokens: 120, output_tokens: 35 },
    ...overrides,
  };
}

function fakeStore({ manifestVersion = 4, inferenceMode = runtime.INFERENCE_MODE } = {}) {
  const activeEvent = event();
  const calls = { submissions: [], failures: [] };
  return {
    calls,
    selfPredictionStudiesSnapshot() {
      return { studies: [{
        id: 'study-1', status: 'active', manifest_version: manifestVersion,
        active_event_id: activeEvent.id,
        role_model_control: { ...control(), inference_mode: inferenceMode },
        events: [activeEvent],
      }] };
    },
    submitModelControlledSelfPrediction(studyId, eventId, submission) {
      calls.submissions.push({ studyId, eventId, submission });
      activeEvent.self_prediction_submitted = true;
      activeEvent.subject_model_receipt_attested = true;
    },
    recordSelfPredictionSubjectInferenceFailure(studyId, eventId, failure) {
      calls.failures.push({ studyId, eventId, failure });
    },
  };
}

test('subject build freezes the direct Claude prompt, schema, and generation policy', () => {
  const manifest = runtime.buildManifest();
  assert.equal(manifest.provider, 'anthropic');
  assert.equal(manifest.model, runtime.DEFAULT_MODEL);
  assert.equal(manifest.thinking.type, 'disabled');
  assert.equal(runtime.agentBuildCommitment().length, 64);
  assert.equal(runtime.validateSubjectControl(control()), true);
  assert.equal(runtime.validateSubjectControl({ ...control(), model: 'other-model' }), false);
});

test('subject request contains identity-bearing private state and excludes the deidentified control', () => {
  const built = runtime.forecastRequest(event(), control());
  assert.match(JSON.stringify(built.packet), /identity-bound calibration state/);
  assert.doesNotMatch(JSON.stringify(built.packet), /deidentified_state_context/);
  assert.equal(built.manifest.prompt_protocol_commitment.length, 64);
  assert.throws(() => runtime.forecastRequest({ ...event(), deidentified_state_context: 'forbidden' }, control()), /forbidden deidentified/);
});

test('provider response produces matching forecast and server-direct receipt commitments', () => {
  const submission = runtime.forecastSubmission(event(), providerResponse(), control());
  assert.equal(submission.prediction.probability, 0.72);
  assert.equal(submission.receipt.transport, 'server_direct_api');
  assert.equal(submission.receipt.response_id, 'msg-subject-1');
  assert.equal(submission.receipt.agent_build_commitment, runtime.agentBuildCommitment());
  assert.equal(submission.prediction.evidence[0].output_commitment,
    submission.receipt.provider_output_commitment);
  assert.throws(() => runtime.forecastSubmission(event(), providerResponse({ model: 'wrong' }), control()), /wrong model/);
});

test('runtime commits exactly one direct subject call and leaves external-subject studies untouched', async () => {
  const store = fakeStore();
  const result = await runtime.runCycle({ store, callProvider: async () => providerResponse() });
  assert.equal(result.state, 'subject_committed');
  assert.equal(result.provider_calls, 1);
  assert.equal(store.calls.submissions.length, 1);
  assert.equal(store.calls.failures.length, 0);

  const legacy = fakeStore({ manifestVersion: 3, inferenceMode: 'external_provider_export' });
  const legacyResult = await runtime.runCycle({ store: legacy, callProvider: async () => {
    throw new Error('must not be called');
  } });
  assert.equal(legacyResult.state, 'external_subject_required');
  assert.equal(legacyResult.provider_calls, 0);
});

test('a failed single provider attempt is durably terminal instead of being selectively retried', async () => {
  const store = fakeStore();
  const result = await runtime.runCycle({ store, callProvider: async () => {
    throw new Error('provider unavailable');
  } });
  assert.equal(result.state, 'study_aborted_subject_failure');
  assert.equal(result.provider_calls, 1);
  assert.equal(store.calls.submissions.length, 0);
  assert.equal(store.calls.failures.length, 1);
  assert.match(store.calls.failures[0].failure.reason, /provider unavailable/);
});
