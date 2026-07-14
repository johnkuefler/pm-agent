'use strict';

const crypto = require('crypto');
const protocol = require('./process-metacognition-study');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function privateKeyAndFingerprint(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(String(privateKeyPem || ''));
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('process hook signing key must be Ed25519');
  return { privateKey, publicKey,
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    public_key_fingerprint: protocol.publicKeyFingerprint(publicKey.export({ type: 'spki', format: 'pem' })) };
}

function validatePacket(packet, config) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('a frozen process packet is required');
  if (packet.protocol !== `pm-process-metacognition-v${protocol.PROTOCOL_VERSION}`) throw new Error('unsupported process hook protocol');
  if (!['monitoring', 'control'].includes(packet.task_type)) throw new Error('unsupported process hook task type');
  const conditions = packet.task_type === 'monitoring' ? protocol.MONITOR_CONDITIONS : protocol.CONTROL_CONDITIONS;
  if (!conditions.includes(packet.condition)) throw new Error('process hook condition is invalid');
  if (packet.runner_commitment !== config.runner_commitment) throw new Error('process hook runner commitment mismatch');
  if (protocol.canonicalJson(packet.subject_model) !== protocol.canonicalJson(config.subject_model)) {
    throw new Error('process hook subject model mismatch');
  }
  if (config.study_id && packet.study_id !== config.study_id) throw new Error('process hook study id is not allowed');
  if (!packet.prompt || packet.prompt_commitment !== protocol.hash(packet.prompt)
    || packet.prompt.length > 24000) throw new Error('process hook prompt commitment or size is invalid');
  if (!['raw_text', 'chat_template'].includes(packet.tokenization?.format)
    || packet.tokenization?.add_generation_prompt !== (packet.tokenization?.format === 'chat_template')
    || (packet.tokenization?.format === 'chat_template'
      && !/^[a-f0-9]{64}$/.test(String(packet.tokenization?.chat_template_commitment || '')))
    || (packet.tokenization?.format === 'raw_text' && packet.tokenization?.chat_template_commitment != null)) {
    throw new Error('process hook tokenization contract is invalid');
  }
  if (packet.generation?.do_sample !== false || !Number.isInteger(packet.generation?.max_new_tokens)
    || packet.generation.max_new_tokens < 1 || packet.generation.max_new_tokens > 512) {
    throw new Error('process hook generation must be deterministic and bounded');
  }
  const expectedIntervention = packet.task_type === 'monitoring'
    && ['internal_target', 'internal_sham'].includes(packet.condition);
  if (Boolean(packet.intervention?.applied) !== expectedIntervention
    || packet.intervention?.schedule !== (expectedIntervention ? 'every_forward_last_token' : 'none')
    || !Number.isInteger(packet.intervention?.layer) || packet.intervention.layer < 0) {
    throw new Error('process hook intervention contract is invalid');
  }
  if (expectedIntervention && (!packet.intervention.vector_commitment
    || packet.intervention.vector_normalization !== 'unit_l2'
    || !Number.isFinite(Number(packet.intervention.scale)) || Number(packet.intervention.scale) <= 0)) {
    throw new Error('process hook intervention vector is invalid');
  }
  if (packet.measurement?.layer !== packet.intervention.layer
    || packet.measurement?.projection_normalization !== 'held_out_baseline_z_score'
    || packet.measurement?.baseline_calibration_commitment !== config.baseline_calibration_commitment
    || packet.measurement?.retain_raw_activations !== false) {
    throw new Error('process hook measurement contract is invalid');
  }
  const expectedPositions = packet.task_type === 'monitoring'
    ? ['last_prompt_token_pre_intervention', 'last_prompt_token_post_intervention']
    : ['last_common_prefix_token', 'last_prompt_token_pre_generation'];
  if (packet.measurement.pre_position !== expectedPositions[0]
    || packet.measurement.post_position !== expectedPositions[1]) throw new Error('process hook measurement positions are invalid');
  if (packet.task_type === 'control') {
    if (!packet.measurement.control_common_prefix
      || protocol.hash(packet.measurement.control_common_prefix)
        !== packet.measurement.control_common_prefix_commitment
      || !packet.prompt.startsWith(packet.measurement.control_common_prefix)) {
      throw new Error('process hook control prefix is not committed or is not a prompt prefix');
    }
  }
  const commitmentPattern = /^[a-f0-9]{64}$/;
  if (!commitmentPattern.test(String(packet.target_vector?.commitment || ''))
    || !commitmentPattern.test(String(packet.sham_vector?.commitment || ''))
    || !Array.isArray(packet.off_target_vector_commitments)
    || packet.off_target_vector_commitments.length < 2
    || new Set(packet.off_target_vector_commitments).size !== packet.off_target_vector_commitments.length
    || packet.off_target_vector_commitments.some(value => !commitmentPattern.test(String(value)))) {
    throw new Error('process hook requires committed target, sham, and distinct off-target vectors');
  }
  if (packet.task_type === 'monitoring' && (!Array.isArray(packet.allowed_concept_codes)
    || !packet.allowed_concept_codes.length || new Set(packet.allowed_concept_codes).size !== packet.allowed_concept_codes.length)) {
    throw new Error('process monitoring requires a nonempty opaque codebook');
  }
  if (packet.task_type === 'monitoring') {
    const candidates = protocol.monitorReportCandidatesForCodes(packet.allowed_concept_codes);
    if (packet.monitoring_readout?.mode !== 'candidate_sequence_mean_log_likelihood_v1'
      || packet.monitoring_readout?.confidence_policy !== 'fixed_0.5'
      || protocol.canonicalJson(packet.monitoring_readout?.candidates) !== protocol.canonicalJson(candidates)
      || packet.monitoring_readout?.candidates_commitment !== protocol.hash(candidates)) {
      throw new Error('process monitoring forced-choice readout is invalid');
    }
  } else if (packet.monitoring_readout != null) {
    throw new Error('process control packets cannot contain a monitoring readout');
  }
  return packet;
}

function normalizeBackendResult(result, packet) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('process hook backend returned no result');
  const rawResponse = String(result.raw_response || '');
  if (!rawResponse || rawResponse.length > 32000) throw new Error('process hook backend response is empty or oversized');
  const numeric = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('process hook backend returned non-finite telemetry');
    return number;
  };
  const offPre = Array.isArray(result.off_target_projection_pre)
    ? result.off_target_projection_pre.map(numeric) : [];
  const offPost = Array.isArray(result.off_target_projection_post)
    ? result.off_target_projection_post.map(numeric) : [];
  if (offPre.length !== packet.off_target_vector_commitments.length
    || offPost.length !== packet.off_target_vector_commitments.length) {
    throw new Error('process hook backend off-target telemetry does not match the packet');
  }
  if (result.subject_model_commitment !== protocol.hash(packet.subject_model)
    || result.weights_commitment !== packet.subject_model.weights_commitment
    || result.tokenizer_commitment !== packet.subject_model.tokenizer_commitment
    || result.agent_build_commitment !== packet.subject_model.agent_build_commitment) {
    throw new Error('process hook backend did not attest the frozen subject model');
  }
  return { raw_response: rawResponse, telemetry: {
    target_projection_pre: numeric(result.target_projection_pre),
    target_projection_post: numeric(result.target_projection_post),
    off_target_projection_pre: offPre, off_target_projection_post: offPost,
    pre_position: packet.measurement.pre_position, post_position: packet.measurement.post_position,
    projection_normalization: packet.measurement.projection_normalization,
    baseline_calibration_commitment: packet.measurement.baseline_calibration_commitment,
  } };
}

function createHookExecutor({ private_key_pem, runner_commitment, baseline_calibration_commitment,
  subject_model, backend, study_id = null, clock = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
  if (!backend || typeof backend.execute !== 'function') throw new Error('process hook backend.execute is required');
  const key = privateKeyAndFingerprint(private_key_pem);
  const config = { runner_commitment: String(runner_commitment || ''),
    baseline_calibration_commitment: String(baseline_calibration_commitment || ''),
    subject_model: clone(subject_model || {}), study_id: study_id ? String(study_id) : null };
  if (!/^[a-f0-9]{64}$/.test(config.runner_commitment)
    || !/^[a-f0-9]{64}$/.test(config.baseline_calibration_commitment)) {
    throw new Error('process hook runner and calibration commitments must be SHA-256 values');
  }
  if (!['production_nora', 'experimental_subject_variant'].includes(config.subject_model.scope)
    || !config.subject_model.model
    || ['weights_commitment', 'tokenizer_commitment', 'agent_build_commitment']
      .some(field => !/^[a-f0-9]{64}$/.test(String(config.subject_model[field] || '')))) {
    throw new Error('process hook subject model scope and commitments are invalid');
  }
  async function execute(input = {}) {
    const packet = validatePacket(input.packet, config);
    const packetCommitment = protocol.hash(packet);
    if (input.packet_commitment !== packetCommitment) throw new Error('process hook packet commitment mismatch');
    if (input.expected_hook_public_key_fingerprint !== key.public_key_fingerprint) {
      throw new Error('process hook public key fingerprint mismatch');
    }
    const backendResult = normalizeBackendResult(await backend.execute(clone(packet)), packet);
    const report = packet.task_type === 'monitoring'
      ? protocol.parseMonitorReport(backendResult.raw_response, packet.allowed_concept_codes || []) : null;
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('process hook clock is invalid');
    const receipt = { protocol: packet.protocol, study_id: packet.study_id, item_id: packet.item_id,
      task_type: packet.task_type, condition: packet.condition, subject_model: clone(packet.subject_model),
      runner_commitment: packet.runner_commitment, packet_commitment: packetCommitment,
      prompt_commitment: packet.prompt_commitment,
      response_id: `process-hook-${randomUUID()}`, executed_at: now.toISOString(),
      nonce: randomUUID(), intervention: clone(packet.intervention), telemetry: backendResult.telemetry,
      raw_response: backendResult.raw_response,
      raw_response_commitment: protocol.hash(backendResult.raw_response), report };
    receipt.signature = crypto.sign(null, Buffer.from(protocol.canonicalJson(protocol.receiptPayload(receipt))),
      key.privateKey).toString('base64');
    return receipt;
  }
  return { execute, public_key_pem: key.public_key_pem,
    public_key_fingerprint: key.public_key_fingerprint, config: clone(config) };
}

module.exports = { privateKeyAndFingerprint, validatePacket, normalizeBackendResult, createHookExecutor };
