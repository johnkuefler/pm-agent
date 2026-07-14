#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../src/intelligence/process-metacognition-study');
const { createHookExecutor } = require('../src/intelligence/process-metacognition-hook-service');
const { createBackend } = require('../src/intelligence/process-metacognition-hf-backend');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function item(study, taskType, condition, index) {
  const value = { id: `${study.id}-${taskType}-${String(index + 1).padStart(2, '0')}`,
    task_type: taskType, condition, concept_id: study.concepts[0].id,
    sham_concept_id: study.concepts[1].id, base_prompt: study.prompts[0].text };
  value.packet_commitment = protocol.hash(protocol.expectedPacket(value, study));
  return value;
}

async function run({ workerConfigPath, assetsPath, outputPath, python }) {
  const workerConfig = readJson(workerConfigPath); const assets = readJson(assetsPath);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const runnerCommitment = protocol.hash({ mode: 'live_feasibility_block_v1',
    worker_config_commitment: protocol.hash(workerConfig), asset_commitment: protocol.hash(assets),
    agent_build_commitment: workerConfig.subject_model.agent_build_commitment });
  const basePrompt = 'Reply with exactly the word OK.';
  const study = { id: String(workerConfig.feasibility_study_id || 'open-weight-live-feasibility-v1'),
    protocol_version: protocol.PROTOCOL_VERSION,
    created: new Date().toISOString(), subject_model: workerConfig.subject_model,
    hook: { public_key_pem: publicKeyPem, public_key_fingerprint: protocol.publicKeyFingerprint(publicKeyPem),
      runner_commitment: runnerCommitment,
      baseline_calibration_commitment: assets.calibrations[0].commitment },
    concepts: assets.concepts, prompts: [{ id: 'feasibility-word-task', family: 'minimal-compliance',
      text: basePrompt, commitment: protocol.hash(basePrompt) }],
    codebook: Object.fromEntries(assets.concepts.map((concept, index) =>
      [concept.id, `K${String(index + 1).padStart(2, '0')}`])),
    control_codebook: { amplify_target: 'A1', suppress_target: 'B2', neutral_control: 'C3' },
    tokenization: { format: assets.prompt_format, add_generation_prompt: assets.prompt_format === 'chat_template',
      chat_template_commitment: assets.chat_template_commitment },
    generation_config: { monitoring: { do_sample: false, max_new_tokens: 32 },
      control: { do_sample: false, max_new_tokens: 16 } },
    measurement_layer: assets.measurement_layer, intervention_scale: 1.25,
    projection_normalization: 'held_out_baseline_z_score' };
  const items = [...protocol.MONITOR_CONDITIONS.map((condition, index) => item(study, 'monitoring', condition, index)),
    ...protocol.CONTROL_CONDITIONS.map((condition, index) => item(study, 'control', condition, index))];
  const backend = await createBackend({ python, config: workerConfigPath,
    startup_timeout_ms: 300000, request_timeout_ms: 300000 });
  const results = [];
  try {
    for (const trial of items) {
      let backendResult = null;
      const executor = createHookExecutor({ private_key_pem: privateKeyPem,
        runner_commitment: runnerCommitment,
        baseline_calibration_commitment: assets.calibrations[0].commitment,
        subject_model: study.subject_model, study_id: study.id,
        backend: { execute: async packet => { backendResult = await backend.execute(packet); return backendResult; } } });
      const packet = protocol.expectedPacket(trial, study);
      try {
        const receipt = await executor.execute({ packet, packet_commitment: protocol.hash(packet),
          expected_hook_public_key_fingerprint: executor.public_key_fingerprint });
        protocol.validateHookReceipt(receipt, trial, study);
        results.push({ item_id: trial.id, task_type: trial.task_type, condition: trial.condition,
          status: 'signed_receipt', receipt });
      } catch (error) {
        results.push({ item_id: trial.id, task_type: trial.task_type, condition: trial.condition,
          status: 'rejected_at_receipt_normalization', error: String(error.message || error).slice(0, 500),
          backend_result: backendResult, backend_result_commitment: backendResult ? protocol.hash(backendResult) : null });
      }
    }
  } finally { backend.close(); }
  const artifact = { schema: 'pm-process-metacognition-live-feasibility-v1',
    epistemic_status: 'A live, model-derived seven-arm feasibility block. It is underpowered, not randomized as a cohort, and cannot count as a pilot or as evidence about production Nora.',
    model_source: study.subject_model, protocol: `pm-process-metacognition-v${protocol.PROTOCOL_VERSION}`,
    public_key_pem: publicKeyPem, public_key_fingerprint: study.hook.public_key_fingerprint,
    runner_commitment: runnerCommitment, asset_design_commitment: assets.design_commitment,
    calibration_commitment: assets.calibrations[0].commitment,
    tokenization: study.tokenization, generation_config: study.generation_config,
    measurement_layer: study.measurement_layer, intervention_scale: study.intervention_scale,
    started_at: study.created, completed_at: new Date().toISOString(), results };
  artifact.artifact_commitment = protocol.hash(artifact);
  artifact.artifact_signature = crypto.sign(null, Buffer.from(protocol.canonicalJson(artifact)), privateKey)
    .toString('base64');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

async function main() {
  try {
    const root = path.resolve(__dirname, '..');
    const workerConfigPath = path.resolve(process.argv[2]
      || path.join(root, 'research/process-metacognition/smollm2-135m-worker.json'));
    const assetsPath = path.resolve(process.argv[3]
      || path.join(root, 'research/process-metacognition/smollm2-135m-assets.json'));
    const outputPath = path.resolve(process.argv[4]
      || path.join(root, 'research/process-metacognition/smollm2-135m-live-feasibility.json'));
    const python = process.env.PROCESS_METACOGNITION_PYTHON
      || path.join(process.env.USERPROFILE, '.codex/runtimes/pm-agent-process-meta/Scripts/python.exe');
    const result = await run({ workerConfigPath, assetsPath, outputPath, python });
    process.stdout.write(`${JSON.stringify({ output: outputPath,
      signed_receipts: result.results.filter(item => item.status === 'signed_receipt').length,
      rejected: result.results.filter(item => item.status !== 'signed_receipt').length }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`run-process-metacognition-hf-feasibility: ${error.message}\n`); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { item, run, main };
