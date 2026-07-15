'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const modelControl = require('../../src/intelligence/self-prediction-model-control');

const build = 'a'.repeat(64);

function prediction(predictorId, evidence, salt) {
  const value = {
    probability: 0.6, rationale: 'Fixture forecast.', evidence,
    predictor_id: predictorId, submitted: '2026-07-15T09:00:00.000Z', salt,
  };
  value.commitment_hash = crypto.createHash('sha256').update(`${salt}:${modelControl.canonicalJson({
    probability: value.probability, rationale: value.rationale,
    evidence: value.evidence, predictor_id: value.predictor_id,
  })}`).digest('hex');
  return value;
}

function control(overrides = {}) {
  return modelControl.normalize({
    protocol_version: 1,
    subject: {
      provider: 'anthropic', model: 'claude-subject', agent_build_commitment: build,
      attestation_evidence: [{ type: 'orchestrator_attestation', id: 'subject-runtime' }],
    },
    comparators: {
      relationship: 'capability_dominant',
      observer: { provider: 'anthropic', model: 'claude-observer' },
      yoked_observer: { provider: 'anthropic', model: 'claude-observer' },
      justification_evidence: [{ type: 'model_policy', id: 'observer-dominance' }],
    },
    ...overrides,
  });
}

test('model control freezes subject build and comparator relationship', () => {
  const frozen = control();
  assert.equal(frozen.protocol_version, 1);
  assert.equal(frozen.subject.agent_build_commitment, build);
  assert.equal(frozen.comparators.relationship, 'capability_dominant');
  assert.equal(frozen.control_commitment.length, 64);
  assert.throws(() => control({ comparators: {
    relationship: 'same_model',
    observer: { provider: 'anthropic', model: 'other' },
    yoked_observer: { provider: 'anthropic', model: 'claude-subject' },
    justification_evidence: [{ type: 'model_policy', id: 'same-model' }],
  } }), /same_model comparator policy/);
});

test('confirmation preserves the model policy while allowing new attestation evidence', () => {
  const pilot = control();
  const confirmation = modelControl.normalize({
    ...pilot,
    subject: { ...pilot.subject, attestation_evidence: [{ type: 'orchestrator_attestation', id: 'confirmation-runtime' }] },
    comparators: { ...pilot.comparators, justification_evidence: [{ type: 'model_policy', id: 'confirmation-policy' }] },
  }, { replicated: pilot });
  assert.equal(confirmation.subject.model, pilot.subject.model);
  assert.throws(() => modelControl.normalize({
    ...pilot,
    subject: { ...pilot.subject, model: 'changed-subject' },
  }, { replicated: pilot }), /preserve the pilot subject/);
});

test('subject receipt binds a post-generation provider receipt to the sealed forecast', () => {
  const frozen = control();
  const event = { self_prediction: { commitment_hash: 'forecast-commitment' }, subject_model_receipt: null };
  const receipt = modelControl.createSubjectReceipt({
    provider: frozen.subject.provider, model: frozen.subject.model,
    response_id: 'msg-subject-1', agent_build_commitment: build,
    prediction_commitment: 'forecast-commitment',
    external_reference: { type: 'retained_provider_receipt', id: 'provider-export-1' },
  }, { study: { model_control: frozen }, event, at: new Date('2026-07-15T09:00:00Z') });
  assert.equal(receipt.prediction_commitment, 'forecast-commitment');
  assert.equal(receipt.receipt_commitment.length, 64);
  assert.throws(() => modelControl.createSubjectReceipt({
    ...receipt, prediction_commitment: 'different',
  }, { study: { model_control: frozen }, event }), /exact prediction commitment/);
});

test('audit requires three unique model receipts per event and the subject receipt ledger binding', () => {
  const frozen = control();
  const event = {
    id: 'event-1',
    self_prediction: prediction('nora', [{ type: 'fixture', id: 'subject-evidence' }], 'subject-salt'),
    observer_prediction: prediction('observer-a', [{ type: 'blinded_model_prediction', id: 'msg-observer-1', provider: 'anthropic', model: 'claude-observer', prompt_protocol_commitment: 'prompt-a' }], 'observer-salt'),
    yoked_prediction: prediction('observer-b', [{ type: 'blinded_model_prediction', id: 'msg-yoked-1', provider: 'anthropic', model: 'claude-observer', prompt_protocol_commitment: 'prompt-b' }], 'yoked-salt'),
  };
  event.subject_model_receipt = modelControl.createSubjectReceipt({
    provider: 'anthropic', model: 'claude-subject', response_id: 'msg-subject-1',
    agent_build_commitment: build, prediction_commitment: event.self_prediction.commitment_hash,
    external_reference: { type: 'retained_provider_receipt', id: 'subject-1' },
  }, { study: { model_control: frozen }, event, at: new Date('2026-07-15T09:00:00Z') });
  const study = { id: 'study-1', manifest_version: 4, model_control: frozen, events: [event] };
  const verified = modelControl.audit(study, { oneLedgerEvent: () => true });
  assert.equal(verified.model_provenance_verified, true);
  assert.equal(verified.control_ledger_bound, true);
  event.yoked_prediction.evidence[0].id = 'msg-observer-1';
  assert.equal(modelControl.audit(study, { oneLedgerEvent: () => true }).model_provenance_verified, false);
  event.yoked_prediction.evidence[0].id = 'msg-yoked-1';
  event.observer_prediction.rationale = 'Tampered after commitment.';
  assert.equal(modelControl.audit(study, { oneLedgerEvent: () => true }).events[0].observer_model_receipt_verified, false);
  assert.equal(modelControl.audit(study, { oneLedgerEvent: () => false }).control_ledger_bound, false);
});

test('legacy studies remain explicitly model-uncontrolled', () => {
  assert.deepEqual(modelControl.audit({ manifest_version: 3, events: [] }), {
    model_provenance_verified: false,
    reason: 'legacy_model_uncontrolled_protocol',
    events: [],
  });
});
