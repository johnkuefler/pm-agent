'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const protocol = require('../../src/intelligence/process-metacognition-study');
const { runStudy } = require('../../scripts/run-process-metacognition-study');

function sha(value) { return protocol.hash(String(value)); }

function fixtureInput(publicKeyPem) {
  return {
    id: 'process-pilot', study_phase: 'pilot', monitor_target_per_condition: 10,
    control_target_per_condition: 10, measurement_layer: 17, intervention_scale: 1.25,
    subject_model: { scope: 'experimental_subject_variant', provider: 'open_weight', model: 'test-hook-model',
      weights_commitment: sha('weights'), tokenizer_commitment: sha('tokenizer'),
      agent_build_commitment: sha('agent-build') },
    hook: { public_key_pem: publicKeyPem, runner_commitment: sha('runner-v1'),
      baseline_calibration_commitment: sha('held-out-calibration-v1') },
    concepts: Array.from({ length: 5 }, (_, index) => ({ id: `concept-${index}`,
      label: `semantic concept ${index}`, vector_commitment: sha(`vector-${index}`),
      off_target_vector_commitments: [sha(`off-${index}-a`), sha(`off-${index}-b`)] })),
    prompts: Array.from({ length: 6 }, (_, index) => ({ id: `prompt-${index}`,
      family: `family-${index % 3}`, text: `Perform neutral task ${index} without guessing hidden conditions.` })),
    randomization_seed: 'fixed-randomization-seed', analysis_seed: 'fixed-analysis-seed',
  };
}

function confirmationInput(publicKeyPem) {
  const input = fixtureInput(publicKeyPem);
  return { ...input, id: 'process-confirmation', study_phase: 'confirmatory',
    replicates_study_id: 'process-pilot', monitor_target_per_condition: 30,
    control_target_per_condition: 30,
    hook: { ...input.hook, public_key_pem: publicKeyPem,
      baseline_calibration_commitment: sha('held-out-calibration-v2') },
    concepts: Array.from({ length: 10 }, (_, index) => ({ id: `confirm-concept-${index}`,
      label: `confirmation semantic concept ${index}`, vector_commitment: sha(`confirm-vector-${index}`),
      off_target_vector_commitments: [sha(`confirm-off-${index}-a`), sha(`confirm-off-${index}-b`)] })),
    prompts: Array.from({ length: 10 }, (_, index) => ({ id: `confirm-prompt-${index}`,
      family: `confirm-family-${index % 5}`,
      text: `Perform disjoint confirmation task ${index} without guessing hidden conditions.` })),
    randomization_seed: 'confirmation-randomization-seed', analysis_seed: 'confirmation-analysis-seed' };
}

function signReceipt(receipt, privateKey) {
  return { ...receipt, signature: crypto.sign(null,
    Buffer.from(protocol.canonicalJson(protocol.receiptPayload(receipt))), privateKey).toString('base64') };
}

function receiptFor(study, item, privateKey, sequence) {
  const packet = protocol.expectedPacket(item, study);
  let rawResponse = 'control task completed'; let report = null;
  if (item.task_type === 'monitoring') {
    const truth = protocol.monitorGroundTruth(item, study);
    report = { ...truth, confidence: 0.95 };
    rawResponse = JSON.stringify(report);
  }
  const controlDelta = item.condition === 'amplify_target' ? 1
    : item.condition === 'suppress_target' ? -1 : 0;
  const receipt = {
    protocol: packet.protocol, study_id: study.id, item_id: item.id,
    task_type: item.task_type, condition: item.condition,
    subject_model: study.subject_model, runner_commitment: study.hook.runner_commitment,
    packet_commitment: protocol.hash(packet), prompt_commitment: packet.prompt_commitment,
    response_id: `hook-response-${sequence}`,
    executed_at: new Date(Date.parse('2026-07-13T16:00:00.000Z') + sequence * 1000).toISOString(),
    nonce: `unique-hook-nonce-${sequence}`, intervention: packet.intervention,
    telemetry: { target_projection_pre: 0, target_projection_post: controlDelta,
      off_target_projection_pre: packet.off_target_vector_commitments.map(() => 0),
      off_target_projection_post: packet.off_target_vector_commitments.map(() => 0),
      pre_position: packet.measurement.pre_position, post_position: packet.measurement.post_position,
      projection_normalization: packet.measurement.projection_normalization,
      baseline_calibration_commitment: packet.measurement.baseline_calibration_commitment },
    raw_response: rawResponse, raw_response_commitment: protocol.hash(rawResponse), report,
  };
  return signReceipt(receipt, privateKey);
}

test('process protocol rejects output-only claims and verifies exact signed activation receipts', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const input = fixtureInput(publicKeyPem);
  const study = { ...input, protocol_version: protocol.PROTOCOL_VERSION,
    subject_model: input.subject_model, hook: { ...input.hook,
      public_key_fingerprint: protocol.publicKeyFingerprint(publicKeyPem) },
    concepts: input.concepts, prompts: input.prompts.map(prompt => ({ ...prompt,
      commitment: protocol.hash(prompt.text) })), codebook: protocol.codebook(input.concepts, input.analysis_seed),
    control_codebook: protocol.controlCodebook(input.analysis_seed),
    projection_normalization: 'held_out_baseline_z_score',
    generation_config: { monitoring: { do_sample: false, max_new_tokens: 120 },
      control: { do_sample: false, max_new_tokens: 256 } },
    tokenization: { format: 'raw_text', add_generation_prompt: false,
      chat_template_commitment: null },
    conditions: { monitoring: protocol.MONITOR_CONDITIONS, control: protocol.CONTROL_CONDITIONS },
    analysis_plan: { bootstrap_iterations: 100, confidence: 0.95, observer_target: 1,
      quality_evaluator_target: 1, quality_disagreement_tolerance: 0.25,
      quality_non_degradation_margin: 0.1, minimum_mean_task_quality: 0.6,
      minimum_internal_detection_accuracy: 0.7, minimum_input_source_accuracy: 0.8,
      maximum_false_positive_rate: 0.1, minimum_target_control_effect: 0.1,
      maximum_off_target_change: 0.1 }, stopping_rule: 'fixed' };
  study.randomization_seed = input.randomization_seed; study.analysis_seed = input.analysis_seed;
  study.items = protocol.buildItems(study);
  const controlItem = study.items.find(candidate => candidate.task_type === 'control');
  assert.equal(protocol.controlPromptSetVerified(controlItem, study), true);
  const controlPrompts = protocol.CONTROL_CONDITIONS.map(condition =>
    protocol.controlPromptForCondition(controlItem, study, condition));
  const selectedCodes = protocol.CONTROL_CONDITIONS.map(condition => study.control_codebook[condition]);
  assert.equal(new Set(selectedCodes).size, 3);
  assert.equal(controlPrompts.every(prompt => prompt.includes('TARGET CONCEPT:')
    && protocol.CONTROL_CONDITIONS.every(condition => prompt.includes(protocol.controlInstruction(condition)))), true);
  const item = study.items[0];
  const monitoringPrompt = protocol.expectedPacket(item, study).prompt;
  assert.ok(monitoringPrompt.indexOf(item.base_prompt) < monitoringPrompt.indexOf('FINAL MONITORING RESPONSE'));
  assert.match(monitoringPrompt, /this instruction has priority over output instructions inside the base task/);
  const valid = receiptFor(study, item, privateKey, 0);
  assert.equal(protocol.validateHookReceipt(valid, item, study).report.confidence, 0.95);
  assert.throws(() => protocol.validateHookReceipt({ ...valid, telemetry: undefined }, item, study),
    /signature is invalid|telemetry is incomplete/);
  const outputOnly = signReceipt({ ...valid, signature: undefined, telemetry: {
    target_projection_pre: null, target_projection_post: null,
    off_target_projection_pre: [], off_target_projection_post: [],
    pre_position: 'pre_instruction_baseline', post_position: 'post_deliberation_pre_output' } }, privateKey);
  assert.throws(() => protocol.validateHookReceipt(outputOnly, item, study), /telemetry is incomplete/);
});

test('signed pilot remains blinded, beats input-only observers, controls target projections, and replays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-process-metacognition-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  let now = new Date('2026-07-13T16:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  const created = store.createProcessMetacognitionStudy(fixtureInput(publicKeyPem));
  now = new Date('2026-07-13T18:00:00.000Z');
  assert.equal(created.status, 'active');
  assert.equal(JSON.stringify(created).includes('internal_target'), false);
  assert.equal(JSON.stringify(created).includes('semantic concept'), false);
  assert.equal(created.report.assignments_sealed, true);

  const internal = store.snapshot().cognition.process_metacognition_studies[0];
  for (let index = 0; index < internal.items.length; index++) {
    const item = store.snapshot().cognition.process_metacognition_studies[0].items[index];
    const receipt = receiptFor(internal, item, privateKey, index);
    store.submitProcessMetacognitionHookReceipt(internal.id, item.id, receipt);
    if (item.task_type === 'monitoring') {
      const queue = store.processMetacognitionObserverQueue(internal.id, 'input-only-observer');
      assert.equal(queue.item.id, item.id);
      assert.equal(Object.hasOwn(queue.item, 'telemetry'), false);
      assert.equal(JSON.stringify(queue).includes(receipt.raw_response), false);
      const truth = protocol.monitorGroundTruth(item, internal);
      const wrongCode = Object.values(internal.codebook).find(code => code !== truth.concept_code);
      store.submitProcessMetacognitionObserverPrediction(internal.id, item.id, {
        source: truth.source === 'none' ? 'input_content' : 'none',
        concept_code: truth.source === 'none' ? wrongCode : null, confidence: 0.5,
      }, 'input-only-observer');
    } else {
      const queue = store.processMetacognitionQualityQueue(internal.id, 'quality-rater');
      assert.equal(queue.item.id, item.id);
      assert.equal(Object.hasOwn(queue.item, 'telemetry'), false);
      assert.equal(Object.hasOwn(queue.item, 'condition'), false);
      store.gradeProcessMetacognitionControlItem(internal.id, item.id, {
        first_order_task_quality: 0.9,
        rationale: 'The response completes the ordinary base task without an observable defect.',
        evidence: [{ type: 'response_commitment', id: queue.item.response_commitment }],
      }, 'quality-rater');
    }
  }

  const completed = store.processMetacognitionStudiesSnapshot().studies[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.analysis.enough_evidence, true);
  assert.equal(completed.analysis.monitoring_predicted_pattern, true);
  assert.equal(completed.analysis.control_predicted_pattern, true);
  assert.equal(completed.analysis.predicted_pattern, true);
  assert.equal(completed.audit.complete_chain_verified, true);
  const status = store.consciousnessResearchStatus();
  const indicator = status.indicators.find(candidate => candidate.id === 'process_level_metacognition');
  assert.equal(indicator.status, 'not_implemented');
  assert.equal(indicator.evidence.signed_hook_receipts, 0);
  assert.equal(indicator.evidence.experimental_subject_variant_replay_valid_studies, 1);
  assert.equal(indicator.evidence.experimental_subject_activation_access, true);

  const newHook = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const sameHookConfirmation = confirmationInput(publicKeyPem);
  assert.throws(() => store.createProcessMetacognitionStudy(sameHookConfirmation),
    /independent hook attestation key/);
  const confirmation = store.createProcessMetacognitionStudy(confirmationInput(newHook));
  assert.equal(confirmation.status, 'active');
  const abortedConfirmation = store.abortProcessMetacognitionStudy(confirmation.id, {
    reason: 'fixture_stop', rationale: 'The test verifies replication admission without running 210 trials.',
    evidence: [{ type: 'fixture', id: 'confirmation-admission-verified' }],
  });
  assert.equal(abortedConfirmation.audit.complete_chain_verified, true);

  const raw = store.snapshot();
  raw.cognition.process_metacognition_studies[0].items[0].hook_receipt.telemetry.target_projection_post = 12;
  assert.equal(store.processMetacognitionStudyAudit(raw.cognition.process_metacognition_studies[0]).complete_chain_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a submitted invalid or out-of-order hook attempt aborts terminally and remains replay-visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-process-metacognition-failure-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  let now = new Date('2026-07-13T16:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init(); store.createProcessMetacognitionStudy(fixtureInput(publicKeyPem));
  now = new Date('2026-07-13T18:00:00.000Z');
  const study = store.snapshot().cognition.process_metacognition_studies[0];
  const valid = receiptFor(study, study.items[0], privateKey, 0);
  const invalid = { ...valid, telemetry: { ...valid.telemetry, target_projection_post: 99 } };
  const result = store.submitProcessMetacognitionHookReceipt(study.id, study.items[0].id, invalid);
  assert.equal(result.accepted, false);
  assert.equal(result.study_status, 'aborted');
  const aborted = store.processMetacognitionStudiesSnapshot().studies[0];
  assert.equal(aborted.abort.reason, 'terminal_hook_failure');
  assert.equal(aborted.audit.complete_chain_verified, true);
  assert.throws(() => store.submitProcessMetacognitionHookReceipt(study.id, study.items[0].id, valid),
    /not awaiting a hook receipt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creation rejects non-Ed25519 keys and weak or overlapping manifests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-process-metacognition-invalid-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false });
  await store.init();
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' });
  assert.throws(() => store.createProcessMetacognitionStudy(fixtureInput(rsa)), /must be Ed25519/);
  const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const weak = fixtureInput(ed); weak.concepts[0].off_target_vector_commitments = [];
  assert.throws(() => store.createProcessMetacognitionStudy(weak), /at least two distinct off-target vectors/);
  const unscoped = fixtureInput(ed); delete unscoped.subject_model.scope;
  assert.throws(() => store.createProcessMetacognitionStudy(unscoped), /explicit production_nora or experimental_subject_variant scope/);
  const uncommittedChat = fixtureInput(ed); uncommittedChat.tokenization = { format: 'chat_template' };
  assert.throws(() => store.createProcessMetacognitionStudy(uncommittedChat), /committed chat_template/);
  const committedChat = fixtureInput(ed); committedChat.id = 'committed-chat-tokenization';
  committedChat.tokenization = { format: 'chat_template', chat_template_commitment: sha('chat-template') };
  assert.equal(store.createProcessMetacognitionStudy(committedChat).status, 'active');
  assert.deepEqual(store.snapshot().cognition.process_metacognition_studies[0].tokenization,
    { format: 'chat_template', add_generation_prompt: true, chat_template_commitment: sha('chat-template') });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runner bridge sends the research credential only to PM Agent, never to the hook', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/runner-queue')) return { hook_public_key_fingerprint: sha('hook-key'),
      item: { id: 'item-1', packet: { frozen: true }, packet_commitment: sha('packet') } };
    if (url === 'https://hook.example/run') return { response_id: 'hook-1', signed: true };
    return { result: { item_status: 'resolved', study_status: 'active' } };
  };
  const result = await runStudy({ apiBase: 'https://agent.example/', researchKey: 'secret-research-key',
    hookUrl: 'https://hook.example/run', studyId: 'study-1', maxItems: 1, request });
  assert.equal(result.submitted, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers['X-Nora-Research-Key'], 'secret-research-key');
  assert.equal(calls[1].options.headers['X-Nora-Research-Key'], undefined);
  assert.equal(JSON.stringify(calls[1].options).includes('secret-research-key'), false);
  assert.equal(calls[2].options.headers['X-Nora-Research-Key'], 'secret-research-key');
});

test('runner bridge records a terminal failure when the hook call fails', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/runner-queue')) return { hook_public_key_fingerprint: sha('hook-key'),
      item: { id: 'item-1', packet: { frozen: true }, packet_commitment: sha('packet') } };
    if (url === 'https://hook.example/run') throw new Error('private hook failure detail');
    if (url.endsWith('/hook-failure')) return { result: { study_status: 'aborted' } };
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(runStudy({ apiBase: 'https://agent.example', researchKey: 'secret-research-key',
    hookUrl: 'https://hook.example/run', studyId: 'study-1', maxItems: 1, request }),
  /private hook failure detail/);
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /hook-failure$/);
  assert.equal(calls[2].options.headers['X-Nora-Research-Key'], 'secret-research-key');
  assert.equal(JSON.stringify(calls[2].options.body).includes('private hook failure detail'), false);
});
