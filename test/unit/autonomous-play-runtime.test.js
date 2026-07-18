'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NORA_TEST_MODE = '1';
const { __test } = require('../../server');

const MODEL = { provider: 'anthropic', model: 'claude-opus-4-8',
  agent_build_commitment: 'a'.repeat(64) };

test('playroom scheduler opens only a due, server-seeded session', () => {
  const inputs = [];
  const result = __test.runAutonomousPlaySchedulingRuntime({ at: new Date('2026-07-19T01:00:00Z'),
    store: { playroomAutomationPlan: () => ({ due: true, state: 'leisure_opportunity_due',
      pre_state: { stimulation_deficit: 0.7 } }),
    openAutonomousPlaySession: input => { inputs.push(input); return { session: {
      id: 'play-runtime-1', condition: 'assigned_play', status: 'active' } }; } } });
  assert.equal(result.ran, true);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].hidden_seed, /^[a-f0-9]{64}$/);
  assert.equal(inputs[0].pre_state.stimulation_deficit, 0.7);
});

test('playroom provider runtime commits one bounded Nora selection without tools', async () => {
  const item = { queue_kind: 'selection', protocol_version: 1, session_id: 'play-runtime-2',
    pre_state: { stimulation_deficit: 0.72, idle_minutes: 80 },
    activities: ['merge_grid', 'quiet'], request_commitment: 'b'.repeat(64),
    output_schema: { activity: 'merge_grid or quiet', rationale: 'sentence',
      predicted_satisfaction: '0 to 1', predicted_engagement: '0 to 1' }, model_control: MODEL };
  const commits = [];
  const store = { playroomAppraisalQueue: () => [], playroomTurnQueue: () => [],
    playroomSelectionQueue: () => [item],
    commitPlayroomSelection: (sessionId, input) => { commits.push({ sessionId, input });
      return { session: { status: 'active' } }; } };
  let calls = 0;
  const result = await __test.runAutonomousPlayRuntime({ force: true, store,
    post: async (_url, body, config) => {
      calls += 1;
      assert.equal(body.model, MODEL.model);
      assert.equal(body.temperature, undefined);
      assert.equal(body.tools, undefined);
      assert.match(body.system, /causal pilot/);
      assert.match(body.messages[0].content, /Quiet is a valid choice/);
      assert.equal(config.timeout, 30000);
      return { data: { id: 'play-provider-selection', model: MODEL.model, content: [{ type: 'text',
        text: JSON.stringify({ activity: 'merge_grid',
          rationale: 'I want a bounded strategy problem.', predicted_satisfaction: 0.64,
          predicted_engagement: 0.71 }) }] } };
    } });
  assert.equal(result.ran, true);
  assert.equal(result.queue_kind, 'selection');
  assert.equal(calls, 1);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].input.provider_receipt, { response_id: 'play-provider-selection',
    provider: MODEL.provider, model: MODEL.model,
    agent_build_commitment: MODEL.agent_build_commitment, request_commitment: item.request_commitment });
});

test('playroom runtime remains inert without a due action', async () => {
  const result = await __test.runAutonomousPlayRuntime({ force: true, store: {
    playroomAppraisalQueue: () => [], playroomTurnQueue: () => [], playroomSelectionQueue: () => [],
  }, post: async () => { throw new Error('provider should not be called'); } });
  assert.deepEqual(result, { ran: false, reason: 'no_due_playroom_action' });
});

