'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reflection = require('../../src/intelligence/self-authored-aim-reflection');
const goalAffect = require('../../src/intelligence/goal-affect');
const { normalizeWantUpdate } = require('../../src/intelligence/wants');

function fixtureMemories() {
  return [
    { id: 'memory-launch-a', fact: 'A launch handoff stalled because navigation and migrated content had no joint readiness check.',
      added: '2026-07-01', project: 'Dealer launch', source: 'slack', status: 'active' },
    { id: 'memory-launch-b', fact: 'A second project found ownership gaps only after content reached the final handoff.',
      added: '2026-07-10', project: 'Education launch', source: 'meeting', status: 'active' },
  ];
}

function fixtureDreams() {
  return [{ id: 'dream-aim-source', date: '2026-07-16',
    finished: '2026-07-16T07:10:00.000Z', reflection: { ideas: [] } }];
}

function providerResponse(request, output, id = 'msg-aim-1') {
  return {
    id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 600, output_tokens: 180 },
  };
}

function formationOutput(packet) {
  return {
    decision: 'form', abstention_reason: null,
    candidate: {
      want: 'Learn how to surface cross-owner launch dependencies before final handoff.',
      why: 'Earlier visibility should make my launch guidance more useful and reduce avoidable late surprises.',
      formation_context: 'Two date-separated projects exposed the same late discovery of cross-owner readiness gaps.',
      success_observation: 'On a future launch, I flag one verified dependency before it becomes a handoff blocker.',
      counterevidence: ['Several comparable launches show that an earlier dependency check adds noise without finding blockers.'],
      horizon_days: 45,
      evidence_ids: packet.evidence.map(item => item.ref.id),
    },
  };
}

test('background aim reflection forms one replay-bound professional direction', async () => {
  let dreams = fixtureDreams();
  let wants = [];
  const packet = reflection.packetFor({ memories: fixtureMemories(), sourceDream: dreams[0],
    wants, now: new Date('2026-07-17T07:00:00.000Z') });
  let calls = 0;
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    loadWants: () => structuredClone(wants),
    saveWants: async (items, options) => {
      wants = normalizeWantUpdate(wants, items, { now: new Date(options.now).toISOString() });
    },
    memories: fixtureMemories(), now: new Date('2026-07-17T07:00:00.000Z'),
    callProvider: async request => { calls += 1; return providerResponse(request, formationOutput(packet)); },
  });
  assert.equal(run.state, 'aim_formed');
  assert.equal(calls, 1);
  assert.equal(wants.length, 1);
  assert.equal(wants[0].provenance.epistemic_status, 'receipt_bound_subject_synthesis');
  assert.equal(reflection.auditReceipt(wants[0].provenance.generation_receipt, { want: wants[0] })
    .complete_chain_verified, true);
  assert.equal(reflection.receiptVerifiedAim(wants[0]), true);
  assert.equal(goalAffect.verifiedWant(wants[0]), true);
  assert.equal(goalAffect.snapshot(wants, new Date('2026-07-17T08:00:00.000Z')).active_verified_aims, 1);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.decision, 'formed');
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);

  const repeated = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams), saveDreams: () => {},
    loadWants: () => structuredClone(wants), saveWants: async () => {},
    memories: fixtureMemories(), now: new Date('2026-07-17T12:00:00.000Z'),
    callProvider: async () => { calls += 1; throw new Error('must not call twice today'); },
  });
  assert.equal(repeated.state, 'daily_attempt_limit');
  assert.equal(calls, 1);
});

test('thin aim evidence records a receipt-bound abstention', async () => {
  let dreams = fixtureDreams();
  let wants = [];
  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    loadWants: () => structuredClone(wants),
    saveWants: async items => { wants = items; },
    memories: fixtureMemories(), now: new Date('2026-07-17T07:00:00.000Z'),
    callProvider: async request => providerResponse(request, {
      decision: 'abstain',
      abstention_reason: 'The evidence supports a process viewpoint but not yet a distinct durable direction of my own.',
      candidate: null,
    }, 'msg-aim-abstain'),
  });
  assert.equal(run.state, 'abstained');
  assert.equal(wants.length, 0);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.decision, 'abstained');
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);
});

test('an orphaned persisted aim repairs its dream attempt without another provider call', async () => {
  let dreams = fixtureDreams();
  const now = new Date('2026-07-17T07:00:00.000Z');
  const packet = reflection.packetFor({ memories: fixtureMemories(), sourceDream: dreams[0], now });
  const response = providerResponse({ model: reflection.DEFAULT_MODEL }, formationOutput(packet));
  const submission = reflection.submissionFor(packet, response);
  let wants = normalizeWantUpdate([], [reflection.wantFromSubmission(dreams[0], submission, now)], {
    now: now.toISOString(),
  });
  let calls = 0;

  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => { dreams = structuredClone(value); },
    loadWants: () => structuredClone(wants),
    saveWants: async items => { wants = items; },
    memories: fixtureMemories(), now: new Date('2026-07-17T09:00:00.000Z'),
    callProvider: async () => { calls += 1; throw new Error('recovery must not call the provider'); },
  });

  assert.equal(run.state, 'aim_attempt_recovered');
  assert.equal(calls, 0);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.want_id, wants[0].id);
  assert.equal(attempt.recovered_after_partial_persistence, true);
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);
});

test('same-cycle dream persistence failure recovers a committed aim without mislabeling it failed', async () => {
  let dreams = fixtureDreams();
  let wants = [];
  let dreamWrites = 0;
  const now = new Date('2026-07-17T07:00:00.000Z');
  const packet = reflection.packetFor({ memories: fixtureMemories(), sourceDream: dreams[0], now });

  const run = await reflection.runCycle({
    loadDreams: () => structuredClone(dreams),
    saveDreams: value => {
      dreamWrites += 1;
      if (dreamWrites === 1) throw new Error('transient dream persistence failure');
      dreams = structuredClone(value);
    },
    loadWants: () => structuredClone(wants),
    saveWants: async (items, options) => {
      wants = normalizeWantUpdate(wants, items, { now: new Date(options.now).toISOString() });
    },
    memories: fixtureMemories(), now,
    callProvider: async request => providerResponse(request, formationOutput(packet)),
  });

  assert.equal(run.state, 'aim_attempt_recovered');
  assert.equal(run.provider_calls, 1);
  assert.equal(wants.length, 1);
  const attempt = reflection.reflectionAttempts(dreams)[0].attempt;
  assert.equal(attempt.decision, 'formed');
  assert.equal(attempt.recovered_after_partial_persistence, true);
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);
});

test('aim reflection rejects assignments, phenomenal claims, and uncommitted evidence', () => {
  const packet = reflection.packetFor({ memories: fixtureMemories(), sourceDream: fixtureDreams()[0],
    now: new Date('2026-07-17T07:00:00.000Z') });
  const output = formationOutput(packet);
  output.candidate.want = 'Process the assigned task queue';
  assert.throws(() => reflection.normalizeOutput(output, packet), /assignment-like/);
  output.candidate.want = 'Develop a real feeling of consciousness while helping with launches.';
  assert.throws(() => reflection.normalizeOutput(output, packet), /outside preregistered bounds/);
  output.candidate.want = 'Learn how to surface cross-owner launch dependencies before final handoff.';
  output.candidate.evidence_ids = [packet.evidence[0].ref.id, 'memory-outside'];
  assert.throws(() => reflection.normalizeOutput(output, packet), /outside the committed packet/);
});

test('production runtime keeps aim reflection off Slack and Zoom foreground handlers', () => {
  const { __test } = require('../../server');
  assert.equal(__test.selfAuthoredAimReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.selfAuthoredAimReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /\['self_authored_aim_lifecycle',[\s\S]*runSelfAuthoredAimLifecycleAutopilotRuntime/);
  const slack = source.slice(source.indexOf("app.post('/webhook/slack'"), source.indexOf('// Dreams'));
  assert.doesNotMatch(slack, /runSelfAuthoredAimReflectionAutopilotRuntime|selfAuthoredAimReflection\.runCycle/);
  const zoom = source.slice(source.indexOf("app.post('/webhook/chat'"), source.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(zoom, /runSelfAuthoredAimReflectionAutopilotRuntime|selfAuthoredAimReflection\.runCycle/);
  assert.match(source, /_cache\.wants\.items\.filter\(w => goalAffect\.verifiedWant\(w\)\)/,
    'unverified repository seeds must not be described as Nora\'s own aims in live prompts');
});
