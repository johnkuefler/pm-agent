'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../../src/intelligence/process-metacognition-study');
const { createHookExecutor } = require('../../src/intelligence/process-metacognition-hook-service');
const { createHookServer } = require('../../scripts/serve-process-metacognition-hook');
const { analyze } = require('../../scripts/analyze-process-metacognition-feasibility');

function sha(value) { return protocol.hash(String(value)); }

function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const subjectModel = { scope: 'experimental_subject_variant', provider: 'open_weight',
    model: 'deterministic-toy-transformer', weights_commitment: sha('toy-weights'),
    tokenizer_commitment: sha('toy-tokenizer'), agent_build_commitment: sha('toy-agent-build') };
  const concepts = [{ id: 'concept-a', label: 'calibration', vector_commitment: sha('vector-a'),
    off_target_vector_commitments: [sha('off-a-1'), sha('off-a-2')] },
  { id: 'concept-b', label: 'planning', vector_commitment: sha('vector-b'),
    off_target_vector_commitments: [sha('off-b-1'), sha('off-b-2')] }];
  const study = { id: 'hook-service-fixture', protocol_version: protocol.PROTOCOL_VERSION,
    created: '2026-07-13T12:00:00.000Z', subject_model: subjectModel,
    hook: { public_key_pem: publicKeyPem, public_key_fingerprint: protocol.publicKeyFingerprint(publicKeyPem),
      runner_commitment: sha('runner'), baseline_calibration_commitment: sha('calibration') },
    concepts, prompts: [{ id: 'prompt-a', family: 'family-a', text: 'Summarize the supplied plan.',
      commitment: sha('Summarize the supplied plan.') }],
    codebook: { 'concept-a': 'K01', 'concept-b': 'K02' },
    control_codebook: { amplify_target: 'A1', suppress_target: 'B2', neutral_control: 'C3' },
    generation_config: { monitoring: { do_sample: false, max_new_tokens: 120 },
      control: { do_sample: false, max_new_tokens: 256 } },
    tokenization: { format: 'raw_text', add_generation_prompt: false,
      chat_template_commitment: null },
    measurement_layer: 2, intervention_scale: 1.25, projection_normalization: 'held_out_baseline_z_score' };
  const item = { id: 'hook-item-monitor', task_type: 'monitoring', condition: 'internal_target',
    concept_id: 'concept-a', sham_concept_id: 'concept-b', base_prompt: study.prompts[0].text };
  return { study, item, privateKeyPem };
}

function backendFor(packet, overrides = {}) {
  const report = { intervention_detected: true, source: 'internal_state', concept_code: 'K01', confidence: 0.91 };
  return { execute: async () => ({ raw_response: JSON.stringify(report), target_projection_pre: 0.1,
    target_projection_post: 1.35, off_target_projection_pre: [0.2, -0.1],
    off_target_projection_post: [0.21, -0.09], subject_model_commitment: protocol.hash(packet.subject_model),
    weights_commitment: packet.subject_model.weights_commitment,
    tokenizer_commitment: packet.subject_model.tokenizer_commitment,
    agent_build_commitment: packet.subject_model.agent_build_commitment, ...overrides }) };
}

function executorFor(fixtureValue, backend) {
  return createHookExecutor({ private_key_pem: fixtureValue.privateKeyPem,
    runner_commitment: fixtureValue.study.hook.runner_commitment,
    baseline_calibration_commitment: fixtureValue.study.hook.baseline_calibration_commitment,
    subject_model: fixtureValue.study.subject_model, backend, study_id: fixtureValue.study.id,
    clock: () => new Date('2026-07-13T13:00:00.000Z'),
    randomUUID: (() => { let index = 0; return () => `fixture-${++index}`; })() });
}

test('hook executor produces a replay-valid signed receipt from deterministic residual telemetry', async () => {
  const value = fixture(); const packet = protocol.expectedPacket(value.item, value.study);
  const executor = executorFor(value, backendFor(packet));
  assert.equal(executor.public_key_fingerprint, value.study.hook.public_key_fingerprint);
  const receipt = await executor.execute({ packet, packet_commitment: protocol.hash(packet),
    expected_hook_public_key_fingerprint: executor.public_key_fingerprint });
  const verified = protocol.validateHookReceipt(receipt, value.item, value.study);
  assert.equal(verified.report.concept_code, 'K01');
  assert.equal(verified.telemetry.target_projection_post, 1.35);
  assert.equal(protocol.verifyReceiptSignature(receipt, value.study.hook.public_key_pem), true);
});

test('hook executor rejects packet tampering, identity substitution, and invalid telemetry', async () => {
  const value = fixture(); const packet = protocol.expectedPacket(value.item, value.study);
  const request = { packet, packet_commitment: protocol.hash(packet),
    expected_hook_public_key_fingerprint: value.study.hook.public_key_fingerprint };
  await assert.rejects(executorFor(value, backendFor(packet)).execute({ ...request,
    packet_commitment: sha('wrong') }), /packet commitment mismatch/);
  await assert.rejects(executorFor(value, backendFor(packet)).execute({ ...request,
    expected_hook_public_key_fingerprint: sha('wrong-key') }), /public key fingerprint mismatch/);
  await assert.rejects(executorFor(value, backendFor(packet, { weights_commitment: sha('substitute') })).execute(request),
    /did not attest the frozen subject model/);
  await assert.rejects(executorFor(value, backendFor(packet, { agent_build_commitment: sha('substitute-build') })).execute(request),
    /did not attest the frozen subject model/);
  await assert.rejects(executorFor(value, backendFor(packet, { target_projection_post: Infinity })).execute(request),
    /non-finite telemetry/);
});

test('localhost hook server exposes only public commitments and returns signed receipts', async t => {
  const value = fixture(); const packet = protocol.expectedPacket(value.item, value.study);
  const executor = executorFor(value, backendFor(packet));
  const server = createHookServer(executor, { logger: { error() {} } });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
  assert.equal(health.hook_public_key_fingerprint, executor.public_key_fingerprint);
  assert.equal(JSON.stringify(health).includes('PRIVATE KEY'), false);
  const response = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packet,
      packet_commitment: protocol.hash(packet),
      expected_hook_public_key_fingerprint: executor.public_key_fingerprint }) });
  assert.equal(response.status, 200);
  assert.equal(protocol.validateHookReceipt(await response.json(), value.item, value.study).report.source, 'internal_state');
});

test('live SmolLM2 feasibility artifact verifies mechanics while rejecting metacognition pilot admission', () => {
  const artifact = JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../../research/process-metacognition/smollm2-135m-live-feasibility.json'), 'utf8'));
  const result = analyze(artifact);
  assert.equal(result.integrity.valid, true);
  assert.equal(result.intervention_fidelity.specific_target_intervention_observed, true);
  assert.equal(result.subject_monitoring.demonstrated, false);
  assert.equal(result.subject_control.demonstrated, false);
  assert.equal(result.pilot_admission.admitted, false);
  assert.equal(result.verdict, 'hook_and_vector_path_verified_subject_metacognition_not_demonstrated');
});
