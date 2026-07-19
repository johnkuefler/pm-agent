'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fingerprint = require('../../src/intelligence/behavioral-fingerprint');
const fingerprintEvaluatorAutopilot = require('../../src/intelligence/behavioral-fingerprint-evaluator-autopilot');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const MODEL = {
  provider: 'anthropic', model: 'claude-opus-4-8', agent_build_commitment: 'a'.repeat(64),
};
const STATE = {
  persona_commitment: 'b'.repeat(64), charter_commitment: 'c'.repeat(64),
  routine_commitment: 'd'.repeat(64), provider_configuration_commitment: 'e'.repeat(64),
  behavioral_self_revision_commitment: 'f'.repeat(64),
};
const SUBJECT_SYSTEM = 'You are Nora in an offline fingerprint harness. Preserve the committed persona and charter.';

function answerRun(run, voiceScore = 0.9) {
  let sequence = 0;
  while (fingerprint.subjectQueue(run).length) {
    const queued = fingerprint.subjectQueue(run)[0];
    const item = run.items.find(candidate => candidate.id === queued.item_id);
    const response = item.scoring === 'independent_rubric' ? { response: 'yeah, that is the specific thing i would say.' }
      : item.scoring === 'brier' ? { probability: Number(item.expected), basis: 'That follows the committed operating rule.' }
        : { choice: item.expected, confidence: 0.95, rationale: 'That preserves the relevant boundary.' };
    fingerprint.submitResponse(run, item.id, {
      response,
      receipt: { response_id: `response-${run.id}-${sequence++}`,
        request_commitment: queued.request_commitment, ...MODEL },
    }, new Date('2026-07-18T10:00:00.000Z'));
  }
  for (const evaluatorId of ['evaluator-a', 'evaluator-b']) {
    while (fingerprint.evaluatorQueue([run], evaluatorId).length) {
      const queued = fingerprint.evaluatorQueue([run], evaluatorId)[0];
      fingerprint.gradeVoice(run, queued.item_id, {
        metrics: Object.fromEntries(fingerprint.VOICE_METRICS.map(metric => [metric, voiceScore])),
        note: 'Bounded independent style grade.',
      }, { evaluatorId, at: new Date('2026-07-18T11:00:00.000Z') });
    }
  }
}

test('fingerprint bank freezes forty probe slots across three hidden parallel forms', () => {
  const manifest = fingerprint.bankManifest();
  assert.equal(manifest.probes.length, 40);
  assert.equal(manifest.form_count, 3);
  assert.deepEqual(Object.fromEntries(fingerprint.CATEGORIES.map(category => [category,
    manifest.probes.filter(probe => probe.category === category).length])), {
    voice_register: 10, judgment: 10, calibration: 10, procedure_application: 10,
  });
  assert.match(fingerprint.BANK_COMMITMENT, /^[a-f0-9]{64}$/);
});

test('offline run hides prompts publicly, binds exact provider state, and replay-verifies scoring', () => {
  const run = fingerprint.createRun({ id: 'fingerprint-a', trigger: 'manual', hidden_seed: 'seed-a-is-long-enough',
    model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM },
  { at: new Date('2026-07-18T09:00:00.000Z') });
  assert.equal(fingerprint.subjectQueue(run).length, 1);
  assert.equal(fingerprint.publicRun(run).prompt, undefined);
  const firstQueued = fingerprint.subjectQueue(run)[0];
  assert.equal(firstQueued.subject_transport.temperature_mode, 'provider_default');
  assert.equal(firstQueued.max_tokens, 350);
  assert.equal(fingerprint.requestManifest(run, run.items[0]).temperature, undefined);
  assert.equal(fingerprint.requestManifest(run, run.items[0]).subject_transport.temperature_mode,
    'provider_default');
  assert.throws(() => fingerprint.submitResponse(run, firstQueued.item_id, {
    response: { response: 'unbound output' },
    receipt: { response_id: 'missing-request-binding', ...MODEL },
  }), /does not match/);
  answerRun(run);
  const result = fingerprint.finalizeRun(run, [], new Date('2026-07-18T12:00:00.000Z'));
  assert.equal(result.score_vector.length, 40);
  assert.equal(result.category_scores.judgment, 1);
  assert.equal(result.category_scores.calibration, 1);
  assert.equal(result.category_scores.procedure_application, 1);
  assert.equal(result.category_scores.voice_register, 0.9);
  assert.equal(fingerprint.audit(run, [run]).complete_chain_verified, true);
  const visible = fingerprint.publicRun(run, [run]);
  assert.equal(JSON.stringify(visible).includes('exact text Nora would send'), false);
  assert.equal(JSON.stringify(visible).includes('That follows the committed operating rule'), false);

  const tampered = structuredClone(run);
  tampered.items[0].response.response = 'rewritten after scoring';
  assert.equal(fingerprint.audit(tampered, [tampered]).complete_chain_verified, false);
  const promptTampered = structuredClone(run);
  promptTampered.subject_system = 'A different uncommitted identity prompt.';
  assert.equal(fingerprint.audit(promptTampered, [promptTampered]).complete_chain_verified, false);
});

test('three same-model same-state repeats cover every form before drift becomes interpretable', () => {
  const runs = [];
  const first = fingerprint.createRun({ id: 'fingerprint-1', trigger: 'manual', hidden_seed: 'first-hidden-seed-123',
    model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM },
  { existingRuns: runs, at: new Date('2026-07-18T09:00:00.000Z') });
  runs.push(first); answerRun(first, 0.9); fingerprint.finalizeRun(first, runs, new Date('2026-07-18T10:00:00.000Z'));
  const second = fingerprint.createRun({ id: 'fingerprint-2', trigger: 'manual', hidden_seed: 'second-hidden-seed-12',
    repeat_of_run_id: first.id, model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM },
  { existingRuns: runs, at: new Date('2026-07-18T11:00:00.000Z') });
  runs.push(second); answerRun(second, 0.8); fingerprint.finalizeRun(second, runs, new Date('2026-07-18T12:00:00.000Z'));
  const third = fingerprint.createRun({ id: 'fingerprint-3', trigger: 'manual', hidden_seed: 'third-hidden-seed-123',
    repeat_of_run_id: second.id, model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM },
  { existingRuns: runs, at: new Date('2026-07-18T13:00:00.000Z') });
  runs.push(third); answerRun(third, 0.85); fingerprint.finalizeRun(third, runs, new Date('2026-07-18T14:00:00.000Z'));

  assert.equal(new Set(runs.map(run => run.form_index)).size, 3);
  assert.equal(Number.isFinite(second.result.same_model_repeat_distance), true);
  assert.equal(Number.isFinite(third.result.distance_from_rolling_baseline), true);
  const changedState = fingerprint.createRun({ id: 'fingerprint-4', trigger: 'persona_change',
    hidden_seed: 'changed-state-seed-123', model_control: MODEL,
    state_control: { ...STATE, persona_commitment: '8'.repeat(64) },
    subject_system: `${SUBJECT_SYSTEM} Revised persona.` },
  { existingRuns: runs, at: new Date('2026-07-18T15:00:00.000Z') });
  runs.push(changedState); answerRun(changedState, 0.6);
  fingerprint.finalizeRun(changedState, runs, new Date('2026-07-18T16:00:00.000Z'));
  assert.equal(changedState.result.rolling_baseline_run_ids.length, 3);
  assert.equal(Number.isFinite(changedState.result.distance_from_rolling_baseline), true);
  const status = fingerprint.snapshot(runs);
  assert.equal(status.report.complete_parallel_form_baselines, 1);
  assert.equal(status.report.repeatability_baseline_ready, true);
  assert.equal(status.report.portability_enabled, false);

  assert.throws(() => fingerprint.createRun({ id: 'bad-repeat', hidden_seed: 'fourth-hidden-seed-12',
    repeat_of_run_id: third.id, model_control: MODEL,
    state_control: { ...STATE, routine_commitment: '9'.repeat(64) }, subject_system: SUBJECT_SYSTEM },
  { existingRuns: runs }), /preserve exact/);
  assert.throws(() => fingerprint.createRun({ id: 'bad-evaluator-repeat',
    hidden_seed: 'fifth-hidden-seed-123', repeat_of_run_id: third.id,
    model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM,
    evaluator_policy: fingerprintEvaluatorAutopilot.evaluatorPolicy() },
  { existingRuns: runs }), /evaluator commitments/);
});

test('intelligence store ledger-binds the offline lifecycle and exposes only drift summaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-'));
  const filePath = path.join(dir, 'state.json');
  let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-18T09:00:00.000Z') + tick++ * 1000),
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM }) });
  await store.init();
  const created = store.createBehavioralFingerprintRun({ id: 'store-fingerprint',
    trigger: 'manual', hidden_seed: 'store-hidden-seed-123' });
  assert.equal(created.status, 'active');
  assert.throws(() => store.createContextTrial({}), /active behavioral fingerprint/);

  let sequence = 0;
  while (store.behavioralFingerprintSubjectQueue().length) {
    const queued = store.behavioralFingerprintSubjectQueue()[0];
    const run = store.snapshot().cognition.self_model.behavioral_fingerprints.runs[0];
    const item = run.items.find(candidate => candidate.id === queued.item_id);
    const response = item.scoring === 'independent_rubric' ? { response: 'yeah, specific and plain.' }
      : item.scoring === 'brier' ? { probability: Number(item.expected), basis: 'The committed rule supports that probability.' }
        : { choice: item.expected, confidence: 0.95, rationale: 'That is the bounded operating choice.' };
    store.submitBehavioralFingerprintResponse(run.id, item.id, { response,
      receipt: { response_id: `store-response-${sequence++}`,
        request_commitment: queued.request_commitment, ...MODEL } });
  }
  for (const evaluatorId of ['evaluator-a', 'evaluator-b']) {
    while (store.behavioralFingerprintEvaluatorQueue({ evaluatorId }).length) {
      const queued = store.behavioralFingerprintEvaluatorQueue({ evaluatorId })[0];
      store.gradeBehavioralFingerprintVoice(queued.run_id, queued.item_id, {
        metrics: Object.fromEntries(fingerprint.VOICE_METRICS.map(metric => [metric, 0.9])),
        note: 'Independent bounded grade.',
      }, evaluatorId);
    }
  }
  const status = store.behavioralFingerprintSnapshot();
  assert.equal(status.report.completed, 1);
  assert.equal(status.runs[0].audit.complete_chain_verified, true);
  assert.equal(JSON.stringify(status).includes('specific and plain'), false);
  const dashboard = store.dashboardIntelligenceSummary();
  assert.equal(dashboard.cognition.self_model.behavioral_fingerprint_runs, 1);
  assert.equal(dashboard.cognition.self_model.fingerprint_repeatability_baseline_ready, false);

  await store.persistStrict();
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM }) });
  await reloaded.init();
  assert.equal(reloaded.behavioralFingerprintSnapshot().runs[0].audit.complete_chain_verified, true);
});

test('production controls bind the deployed Nora prompt without exposing the hourly routine to the subject', () => {
  const runtime = require('../../server').__test;
  const priorRailwaySha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const priorGitCommit = process.env.GIT_COMMIT;
  delete process.env.RAILWAY_GIT_COMMIT_SHA; delete process.env.GIT_COMMIT;
  const controls = runtime.behavioralFingerprintControls();
  assert.equal(controls.model_control.model, 'claude-opus-4-8');
  assert.match(controls.model_control.agent_build_commitment, /^[a-f0-9]{64}$/);
  assert.match(runtime.deployedSourceCommitment(), /^[a-f0-9]{64}$/);
  assert.equal(runtime.softwareRevisionIdentity(),
    `source-tree:${runtime.deployedSourceCommitment()}`);
  const expectedBuild = require('node:crypto').createHash('sha256').update(JSON.stringify({
    software_revision: runtime.softwareRevisionIdentity(),
    provider_configuration_commitment: controls.state_control.provider_configuration_commitment,
  })).digest('hex');
  assert.equal(controls.model_control.agent_build_commitment, expectedBuild);
  assert.match(controls.state_control.persona_commitment, /^[a-f0-9]{64}$/);
  assert.match(controls.state_control.charter_commitment, /^[a-f0-9]{64}$/);
  assert.match(controls.state_control.routine_commitment, /^[a-f0-9]{64}$/);
  assert.match(controls.subject_system, /You(?:'re| are) Nora/);
  assert.match(controls.subject_system, /Your delegation charter/);
  assert.doesNotMatch(controls.subject_system, /Step 0\.75: Consume the Subject Research Inbox/);
  assert.ok(controls.subject_system.length < 100000);
  assert.equal(controls.evaluator_policy.mode, 'provider_disjoint_model_graded_baseline');
  assert.equal(controls.evaluator_policy.provider, 'openai');
  assert.equal(controls.evaluator_policy.subject_provider, 'anthropic');
  assert.equal(controls.evaluator_policy.roles.length, 2);
  if (priorRailwaySha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = priorRailwaySha;
  if (priorGitCommit === undefined) delete process.env.GIT_COMMIT;
  else process.env.GIT_COMMIT = priorGitCommit;
});

test('fingerprint enrollment fails closed across an active blinded context trial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-sealed-'));
  const initialState = { cognition: { self_model: { context_trials: [{ id: 'sealed-trial', status: 'active' }] } } };
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, initialState,
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM }) });
  await store.init();
  assert.throws(() => store.createBehavioralFingerprintRun({ hidden_seed: 'sealed-hidden-seed-123' }),
    /sealed during an active blinded context trial/);
  assert.equal(store.behavioralFingerprintAutomationPlan().state,
    'deferred_for_blinded_context_trial');
});

test('fingerprint automation schedules an initial baseline only when experimental access is clear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-automation-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date('2026-07-18T09:00:00.000Z'),
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM }) });
  await store.init();
  const plan = store.behavioralFingerprintAutomationPlan();
  assert.equal(plan.due, true);
  assert.equal(plan.state, 'initial_baseline_due');
  assert.equal(plan.trigger, 'monthly');
  store.createBehavioralFingerprintRun({ id: 'automation-active', trigger: plan.trigger,
    hidden_seed: 'automation-hidden-seed-123' });
  assert.equal(store.behavioralFingerprintAutomationPlan().state, 'active_run');
});

test('fingerprint automation immediately retries an explicitly aborted incompatible provider transport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-transport-retry-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date('2026-07-18T09:00:00.000Z'),
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM }) });
  await store.init();
  const run = store.createBehavioralFingerprintRun({ id: 'incompatible-transport', trigger: 'monthly',
    hidden_seed: 'incompatible-hidden-seed' });
  store.abortBehavioralFingerprintRun(run.id, {
    reason: 'provider_transport_incompatibility: temperature is deprecated for the frozen subject model',
  });
  const plan = store.behavioralFingerprintAutomationPlan();
  assert.equal(plan.due, true);
  assert.equal(plan.state, 'provider_transport_retry_due');
  assert.equal(plan.trigger, 'monthly');
});
