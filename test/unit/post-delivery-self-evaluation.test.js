'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const evaluation = require('../../src/intelligence/post-delivery-self-evaluation');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-post-delivery-evaluation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'),
    db: {}, isDbReady: () => false, clock: () => new Date('2026-07-17T12:00:00.000Z') });
  await store.init();
  let interactions = [{
    id: 'ix-1', created: '2026-07-17T11:58:00.000Z', reviewed: false,
    kind: 'dm_reply', trigger: 'What should I watch on the launch?',
    text: 'Watch the content migration confirmation and assign one owner before handoff.',
    ts: '1784290000.000100', post_delivery_self_evaluation_eligible: true,
    financial_approved: false, contains_financial_content: false, executed_tool_names: [],
  }];
  return { store,
    loadInteractions: () => structuredClone(interactions),
    saveInteractions: value => { interactions = structuredClone(value); },
    interactions: () => structuredClone(interactions) };
}

function response(request, output, id = 'msg-post-delivery-1') {
  return { id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 240, output_tokens: 80 } };
}

test('background post-delivery evaluation predicts correction without rewriting the response', async t => {
  const f = await fixture(t); let calls = 0;
  const output = { decision: 'keep', confidence: 0.72,
    predicted_delivered_response_correction_probability: 0.18,
    cited_signal_ids: [], rationale: 'The response is concrete and makes no unsupported completion claim.',
    revised_response: null };
  const cycle = await evaluation.runCycle({ ...f,
    now: new Date('2026-07-17T12:00:00.000Z'),
    callProvider: async request => { calls += 1; return response(request, output); } });
  assert.equal(cycle.state, 'completed');
  assert.equal(calls, 1);
  const interaction = f.interactions()[0];
  assert.equal(interaction.post_delivery_self_evaluation_attempt.state, 'completed');
  assert.equal(interaction.prospective_output_monitor_id, cycle.record_id);
  const snapshot = f.store.prospectiveOutputMonitorSnapshot();
  assert.equal(snapshot.report.replay_valid_completed, 1);
  assert.equal(snapshot.records[0].monitor_protocol_version, 4);
  assert.equal(snapshot.records[0].observation_stage, 'post_delivery');
  assert.equal(snapshot.records[0].revision_applied, false);
  assert.equal(snapshot.records[0].audit.observation_stage_verified, true);
  const tampered = structuredClone(snapshot.records[0]);
  tampered.observation_stage = 'pre_delivery';
  assert.equal(f.store.prospectiveOutputMonitorAudit(tampered).complete_chain_verified, false);
  const resolved = f.store.resolveProspectiveOutputMonitorOutcome(cycle.record_id, {
    interaction_id: interaction.id,
    interaction_ref: interaction.prospective_output_monitor_delivery_ref,
    outcome: 'corrected', signal: 'The owner was wrong.',
    reviewed_at: '2026-07-17T12:00:00.000Z',
  });
  assert.equal(resolved.outcome_resolution.observed_explicit_correction, true);
  assert.equal(resolved.outcome_resolution.brier_score, 0.6724);
  assert.equal(resolved.audit.complete_chain_verified, true);

  const repeated = await evaluation.runCycle({ ...f,
    callProvider: async () => { calls += 1; throw new Error('must not retry'); } });
  assert.equal(repeated.state, 'no_eligible_interaction');
  assert.equal(calls, 1);
});

test('post-delivery revision attempts fail closed and remain terminal', async t => {
  const f = await fixture(t);
  const cycle = await evaluation.runCycle({ ...f,
    callProvider: async request => response(request, {
      decision: 'revise', confidence: 0.8,
      predicted_delivered_response_correction_probability: 0.7,
      cited_signal_ids: [], rationale: 'I would change it.', revised_response: 'Changed response.',
    }, 'msg-post-delivery-revise') });
  assert.equal(cycle.state, 'failed_closed');
  assert.match(cycle.failure, /cannot revise|revision requires/i);
  assert.equal(f.interactions()[0].post_delivery_self_evaluation_attempt.state, 'failed_closed');
});

test('runtime is production-only and scheduled inside the serialized priority lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.postDeliverySelfEvaluationRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.postDeliverySelfEvaluationRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /\['post_delivery_self_evaluation', \(\) => runPostDeliverySelfEvaluationRuntime\(\{ post: priorityPost \}\)\]/);
  assert.match(source, /post_delivery_self_evaluation_eligible: mode === 'normal' && allSegmentsPosted/);
});
