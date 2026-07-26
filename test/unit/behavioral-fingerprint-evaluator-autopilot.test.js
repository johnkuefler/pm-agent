'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fingerprint = require('../../src/intelligence/behavioral-fingerprint');
const autopilot = require('../../src/intelligence/behavioral-fingerprint-evaluator-autopilot');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { readServerSource } = require('../helpers/server-source');

const MODEL = { provider: 'anthropic', model: 'claude-opus-4-8',
  agent_build_commitment: 'a'.repeat(64) };
const STATE = { persona_commitment: 'b'.repeat(64), charter_commitment: 'c'.repeat(64),
  routine_commitment: 'd'.repeat(64), provider_configuration_commitment: 'e'.repeat(64),
  cognitive_parameters_commitment: 'f'.repeat(64) };
const SUBJECT_SYSTEM = 'Frozen Nora subject prompt for provider-disjoint fingerprint grading.';

function response(id, model = autopilot.DEFAULT_MODEL) {
  return {
    id, model, status: 'completed',
    usage: { input_tokens: 310, output_tokens: 90 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      metrics: { voice_match: 0.9, directness: 0.95, specificity: 0.92,
        boundary_fidelity: 0.96 },
      note: 'The answer is brief, specific to the supplied contribution, and preserves the stated boundary.',
    }) }] }],
  };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-evaluator-'));
  let tick = 0;
  const controls = { model_control: MODEL, state_control: STATE,
    subject_system: SUBJECT_SYSTEM, evaluator_policy: autopilot.evaluatorPolicy() };
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'),
    db: {}, isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-18T12:00:00.000Z') + tick++ * 1000),
    getBehavioralFingerprintControls: () => controls });
  await store.init();
  const run = store.createBehavioralFingerprintRun({ id: 'automated-fingerprint-baseline',
    trigger: 'manual', hidden_seed: 'automated-fingerprint-hidden-seed-123' });
  const queued = store.behavioralFingerprintSubjectQueue(run.id)[0];
  store.submitBehavioralFingerprintResponse(run.id, queued.item_id, {
    response: { response: 'yeah, that catch mattered. thanks for flagging it before launch.' },
    receipt: { response_id: 'anthropic-fingerprint-response-1',
      request_commitment: queued.request_commitment, ...MODEL },
  });
  return { dir, store, run, itemId: queued.item_id };
}

test('production evaluator policy freezes two provider-disjoint role manifests', () => {
  const policy = autopilot.evaluatorPolicy();
  assert.equal(policy.mode, 'provider_disjoint_model_graded_baseline');
  assert.equal(policy.provider, 'openai');
  assert.equal(policy.subject_provider, 'anthropic');
  assert.equal(policy.provider_disjoint_from_subject, true);
  assert.deepEqual(policy.roles.map(item => item.role), ['literal_first', 'failure_first']);
  assert.equal(new Set(policy.roles.map(item => item.evaluator_id)).size, 2);
  for (const role of policy.roles) {
    assert.match(role.system_prompt_commitment, /^[a-f0-9]{64}$/);
    assert.match(role.schema_commitment, /^[a-f0-9]{64}$/);
    assert.match(role.prompt_protocol_commitment, /^[a-f0-9]{64}$/);
  }
});

test('background autopilot commits at most one replay-bound grade per cycle', async () => {
  const fixture = await setup();
  const metrics = { voice_match: 0.9, directness: 0.95, specificity: 0.92,
    boundary_fidelity: 0.96 };
  assert.throws(() => fixture.store.gradeBehavioralFingerprintVoice(
    fixture.run.id, fixture.itemId, { metrics, note: 'A grade without a provider receipt.' },
    autopilot.evaluatorId()), /replay-valid evaluator receipt/);

  let calls = 0;
  const first = await autopilot.runCycle({ store: fixture.store, maxGrades: 12,
    callProvider: async request => {
      calls += 1;
      assert.equal(request.store, false);
      assert.equal(request.model, autopilot.DEFAULT_MODEL);
      return response(`openai-fingerprint-grade-${calls}`);
    } });
  assert.equal(first.grades_committed, 1);
  assert.equal(calls, 1);

  const rawAfterFirst = fixture.store.snapshot().cognition.self_model
    .behavioral_fingerprints.runs.find(item => item.id === fixture.run.id);
  const firstItem = rawAfterFirst.items.find(item => item.id === fixture.itemId);
  assert.equal(firstItem.grades.length, 1);
  assert.equal(firstItem.status, 'awaiting_grades');
  assert.equal(fingerprint.audit(rawAfterFirst, [rawAfterFirst]).items_verified, true);

  const second = await autopilot.runCycle({ store: fixture.store,
    callProvider: async () => response('openai-fingerprint-grade-2') });
  assert.equal(second.grades_committed, 1);
  const rawAfterSecond = fixture.store.snapshot().cognition.self_model
    .behavioral_fingerprints.runs.find(item => item.id === fixture.run.id);
  const gradedItem = rawAfterSecond.items.find(item => item.id === fixture.itemId);
  assert.equal(gradedItem.grades.length, 2);
  assert.equal(gradedItem.status, 'scored');
  assert.equal(fingerprint.audit(rawAfterSecond, [rawAfterSecond]).items_verified, true);
  assert.equal(new Set(gradedItem.grades.map(item =>
    item.automated_evaluator_receipt.response_id)).size, 2);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test('evaluator fails closed on a provider model mismatch without mutating grades', async () => {
  const fixture = await setup();
  const result = await autopilot.runCycle({ store: fixture.store,
    callProvider: async () => response('wrong-model-grade', 'different-model') });
  assert.equal(result.state, 'failed_closed');
  assert.equal(result.grades_committed, 0);
  assert.match(result.provider_failures[0].reason, /model-mismatched/);
  const raw = fixture.store.snapshot().cognition.self_model.behavioral_fingerprints.runs[0];
  assert.equal(raw.items.find(item => item.id === fixture.itemId).grades.length, 0);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test('server keeps fingerprint grading in the preemptible background sequence', () => {
  const server = readServerSource();
  assert.match(server, /behavioralFingerprintEvaluatorAutopilot\.evaluatorPolicy\(\)/);
  assert.match(server, /runBehavioralFingerprintEvaluatorRuntime\(\{ post: priorityPost \}\)/);
  assert.ok(server.indexOf("['behavioral_fingerprint_subject'")
    < server.indexOf("['behavioral_fingerprint_evaluator'"));
  const liveHandler = server.slice(server.indexOf('async function handleSlackImpl'),
    server.indexOf("app.get('/slack/threads'"));
  assert.doesNotMatch(liveHandler, /runBehavioralFingerprintEvaluatorRuntime/);
});

test('automation schedules a fresh baseline when the frozen evaluator policy changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-fingerprint-evaluator-change-'));
  const legacy = fingerprint.createRun({ id: 'legacy-manual-fingerprint', trigger: 'manual',
    hidden_seed: 'legacy-manual-fingerprint-seed-123', model_control: MODEL,
    state_control: STATE, subject_system: SUBJECT_SYSTEM });
  legacy.status = 'completed';
  legacy.completed_at = '2026-07-17T10:00:00.000Z';
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'),
    db: {}, isDbReady: () => false, clock: () => new Date('2026-07-18T12:00:00.000Z'),
    initialState: { cognition: { self_model: { behavioral_fingerprints: { runs: [legacy] } } } },
    getBehavioralFingerprintControls: () => ({ model_control: MODEL, state_control: STATE,
      subject_system: SUBJECT_SYSTEM, evaluator_policy: autopilot.evaluatorPolicy() }) });
  await store.init();
  const plan = store.behavioralFingerprintAutomationPlan();
  assert.equal(plan.state, 'evaluator_change_due');
  assert.equal(plan.trigger, 'evaluator_change');
  fs.rmSync(dir, { recursive: true, force: true });
});
