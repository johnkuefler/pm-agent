'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const performance = require('../../src/intelligence/interactive-performance');

test('interactive latency firewall quarantines only extra-round or expanded-generation studies', () => {
  for (const intervention of [
    'endogenous_attention_selection',
    'prospective_output_monitor',
    'prospective_output_calibration_access',
    'provider_reasoning_regulation',
    'reasoning_self_regulation',
  ]) {
    assert.equal(performance.allowsInlineIntervention({
      latencyCritical: true, intervention,
    }), false, `${intervention} must not tax a live response`);
  }
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: true, intervention: 'self_model_access', selfModelProtocolVersion: 2,
  }), false);
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: true, intervention: 'professional_viewpoint_access',
  }), true, 'context-only cognition remains available inline');
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: false, intervention: 'reasoning_self_regulation',
  }), true, 'scheduled research retains the full intervention');
});

test('latency evidence is assessed against frozen per-surface budgets without a composite consciousness score', () => {
  const now = Date.parse('2026-07-17T01:00:00.000Z');
  const traces = [
    ['slack', 7000], ['slack', 9000], ['zoom-chat', 4200], ['realtime', 1700],
  ].map(([surface, latency], index) => ({
    at: new Date(now - index * 1000).toISOString(), action: 'response_latency',
    outcome: performance.assess(surface, latency),
  }));
  traces.push({ at: new Date(now - 5000).toISOString(), action: 'response_latency',
    outcome: { ...performance.assess('slack', 30000), protocol_version: 2 } });
  const summary = performance.summarize(traces, now);
  assert.equal(summary.samples, 4);
  assert.equal(summary.excluded_legacy_samples, 1);
  assert.deepEqual(summary.observed_protocol_versions, { 2: 1, 3: 4 });
  assert.equal(summary.within_budget, 3);
  assert.equal(summary.surfaces.slack.p95_ms, 9000);
  assert.equal(summary.surfaces.slack.gate, 'collecting');
  assert.equal(summary.protocol.minimum_samples_per_surface, 20);
  assert.match(summary.protocol.falsifier, /p95 first-delivery latency remains above budget/);
  assert.doesNotMatch(JSON.stringify(summary), /consciousness score/i);
});

test('foreground interactions preempt one background provider lane and enforce a quiet window', () => {
  performance.resetPriorityGateForTest();
  const background = performance.beginBackground('nightly-reflection', { now: 100000 });
  assert.equal(background.allowed, true);
  assert.equal(performance.beginBackground('second-job', { now: 100001 }).reason,
    'background_provider_busy');

  const foreground = performance.beginInteractive('slack', { now: 100010 });
  assert.equal(background.signal.aborted, true);
  assert.equal(background.wasPreempted(), true);
  assert.equal(background.preemptedBy(), 'slack');
  assert.equal(performance.beginBackground('during-slack', { now: 100011 }).reason,
    'interactive_active');

  foreground.release({ now: 100020 });
  background.release();
  const cooldown = performance.beginBackground('too-soon', { now: 100021 });
  assert.equal(cooldown.reason, 'interactive_cooldown');
  const resumed = performance.beginBackground('after-quiet', {
    now: 100020 + performance.INTERACTIVE_QUIET_WINDOW_MS,
  });
  assert.equal(resumed.allowed, true);
  resumed.release();
  const snapshot = performance.prioritySnapshot(100020 + performance.INTERACTIVE_QUIET_WINDOW_MS);
  assert.equal(snapshot.maximum_background_provider_concurrency, 1);
  assert.equal(snapshot.background_preemptions, 1);
  assert.equal(snapshot.active_interactions, 0);
  performance.resetPriorityGateForTest();
});

test('live server opts into complete Slack trials but never globally enables second-pass monitoring', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /contextTrialsEnabled: true, latencyCritical: true/);
  assert.match(server, /const enabled = Boolean\(assignment\)/);
  assert.doesNotMatch(server, /NORA_PROSPECTIVE_OUTPUT_MONITOR_ENABLED/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'slack'/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'zoom-chat'/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'realtime'/);
  assert.match(server, /settleWithin\(retrieveSemanticMemories\(convText\), 900/,
    'optional semantic recall must lose quickly to the live reply path');
  assert.match(server, /const volatileIntelligenceContext = intelligenceContext \|\| ''/,
    'changing cognition must stay outside the stable provider-cache prefix');
  assert.match(server, /beginInteractive\('slack'\)/);
  assert.match(server, /beginInteractive\('zoom-chat'\)/);
  assert.match(server, /beginInteractive\('realtime'\)/);
  assert.match(server, /runBackgroundIntelligenceRuntime\(\{ trigger: 'five-minute-scheduler' \}\)/,
    'background intelligence must be serialized behind the foreground-priority lane');
  assert.match(server, /model: slackResponseModel\(query\)/,
    'typed Zoom chat must share the bounded fast-turn model policy');
});

test('Slack provider cache prefix stays stable while conversation and cognition tails change', () => {
  const { __test } = require('../../server');
  const first = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'John' } },
    { cacheSplit: true, conversationText: 'what did you do today', semanticMemories: [],
      latencyCritical: true });
  const second = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'Mallory' } },
    { cacheSplit: true, conversationText: 'what is at risk tomorrow', semanticMemories: [],
      latencyCritical: true });
  assert.equal(first.stable, second.stable,
    'person-, query-, broadcast-, and workspace-specific cognition must not bust the stable cache');
  assert.notEqual(first.volatile, second.volatile);
});

test('Slack uses a fast Claude path only for bounded conversational turns', async () => {
  const { __test } = require('../../server');
  assert.equal(__test.slackResponseModel('whatd you do today'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('thanks for your work today'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('what is due tomorrow for me?'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('Analyze the launch risks and build a mitigation plan.'),
    'claude-opus-4-8');
  assert.equal(__test.slackResponseModel('Why did the launch slip?'), 'claude-opus-4-8');
  assert.equal(__test.slackResponseModel('whatd you do today', 'proactive'), 'claude-opus-4-8');
  const fallback = await __test.settleWithin(new Promise(() => {}), 5, [], 'test lookup');
  assert.deepEqual(fallback, []);
});

test('scheduled intelligence defers without touching providers while a person has the foreground', async () => {
  performance.resetPriorityGateForTest();
  const foreground = performance.beginInteractive('realtime');
  const { __test } = require('../../server');
  let providerCalls = 0;
  const result = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'test', post: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  assert.equal(result.state, 'deferred_for_interactive_priority');
  assert.equal(result.reason, 'interactive_active');
  assert.equal(providerCalls, 0);
  foreground.release();
  performance.resetPriorityGateForTest();
});
