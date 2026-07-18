'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NORA_TEST_MODE = '1';
const { __test } = require('../../server');

function queuedItem() {
  return {
    run_id: 'fingerprint-runtime-1', item_id: 'fingerprint-runtime-1:item-01',
    system_prompt: 'Bound offline Nora subject prompt.',
    prompt: 'Write the exact short reply.', response_schema: { response: 'exact response' },
    request_commitment: 'a'.repeat(64),
    subject_transport: { protocol_version: 2, provider: 'anthropic', endpoint: 'messages',
      temperature_mode: 'provider_default', no_tools: true },
    max_tokens: 350,
    model_control: { provider: 'anthropic', model: 'claude-opus-4-8',
      agent_build_commitment: 'b'.repeat(64) },
  };
}

test('offline fingerprint runner commits exactly one provider-bound probe response', async () => {
  const queued = queuedItem();
  const submissions = [];
  const store = {
    behavioralFingerprintSubjectQueue: () => [queued, { ...queued, item_id: 'later-item' }],
    submitBehavioralFingerprintResponse: (runId, itemId, input) => {
      submissions.push({ runId, itemId, input });
      return { status: 'awaiting_grades', run_status: 'active' };
    },
  };
  let providerCalls = 0;
  const result = await __test.runBehavioralFingerprintSubjectRuntime({ force: true, store,
    post: async (_url, body, config) => {
      providerCalls += 1;
      assert.equal(body.model, queued.model_control.model);
      assert.equal(body.temperature, undefined);
      assert.equal(body.max_tokens, 350);
      assert.equal(body.system, queued.system_prompt);
      assert.deepEqual(body.tools, undefined);
      assert.equal(config.timeout, 30000);
      return { data: { id: 'provider-response-1', model: queued.model_control.model,
        content: [{ type: 'text', text: '{"response":"yeah, appreciate that."}' }] } };
    } });

  assert.equal(result.ran, true);
  assert.equal(providerCalls, 1);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].runId, queued.run_id);
  assert.equal(submissions[0].itemId, queued.item_id);
  assert.deepEqual(submissions[0].input.response, { response: 'yeah, appreciate that.' });
  assert.deepEqual(submissions[0].input.receipt, {
    response_id: 'provider-response-1', provider: 'anthropic', model: 'claude-opus-4-8',
    agent_build_commitment: 'b'.repeat(64), request_commitment: 'a'.repeat(64),
  });
});

test('offline fingerprint runner preserves the legacy explicit-zero transport for replay', async () => {
  const queued = queuedItem();
  delete queued.subject_transport;
  delete queued.max_tokens;
  const store = {
    behavioralFingerprintSubjectQueue: () => [queued],
    submitBehavioralFingerprintResponse: () => ({ status: 'awaiting_grades', run_status: 'active' }),
  };
  await __test.runBehavioralFingerprintSubjectRuntime({ force: true, store,
    post: async (_url, body) => {
      assert.equal(body.temperature, 0);
      return { data: { id: 'legacy-provider-response', model: queued.model_control.model,
        content: [{ type: 'text', text: '{"response":"legacy replay"}' }] } };
    } });
});

test('offline fingerprint runner is inert without a due probe', async () => {
  let providerCalls = 0;
  const result = await __test.runBehavioralFingerprintSubjectRuntime({ force: true,
    store: { behavioralFingerprintSubjectQueue: () => [] },
    post: async () => { providerCalls += 1; } });
  assert.deepEqual(result, { ran: false, reason: 'no_due_fingerprint_probe' });
  assert.equal(providerCalls, 0);
});

test('offline fingerprint runner rejects a provider/model mismatch before state mutation', async () => {
  const queued = queuedItem();
  let submissions = 0;
  await assert.rejects(__test.runBehavioralFingerprintSubjectRuntime({ force: true,
    store: { behavioralFingerprintSubjectQueue: () => [queued],
      submitBehavioralFingerprintResponse: () => { submissions += 1; } },
    post: async () => ({ data: { id: 'provider-response-2', model: 'different-model',
      content: [{ type: 'text', text: '{"response":"mismatch"}' }] } }) }),
  /does not match/);
  assert.equal(submissions, 0);
});

test('fingerprint scheduler creates only a server-seeded run when the store says it is due', () => {
  const created = [];
  const result = __test.runBehavioralFingerprintSchedulingRuntime({ store: {
    behavioralFingerprintAutomationPlan: () => ({ due: true,
      state: 'initial_baseline_due', trigger: 'monthly' }),
    createBehavioralFingerprintRun: input => { created.push(input); return { id: 'scheduled-run', status: 'active' }; },
  } });
  assert.equal(result.ran, true);
  assert.equal(result.run_id, 'scheduled-run');
  assert.equal(created.length, 1);
  assert.equal(created[0].trigger, 'monthly');
  assert.match(created[0].hidden_seed, /^[a-f0-9]{64}$/);
});

test('fingerprint scheduler preserves a sealed defer without creating a run', () => {
  let created = 0;
  const result = __test.runBehavioralFingerprintSchedulingRuntime({ store: {
    behavioralFingerprintAutomationPlan: () => ({ due: false,
      state: 'deferred_for_blinded_context_trial', active_run_id: null, next_check_after: null }),
    createBehavioralFingerprintRun: () => { created += 1; },
  } });
  assert.equal(result.ran, false);
  assert.equal(result.state, 'deferred_for_blinded_context_trial');
  assert.equal(created, 0);
});
