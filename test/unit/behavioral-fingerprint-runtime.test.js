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
      assert.equal(body.temperature, 0);
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
