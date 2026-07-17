'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflection = require('../../src/intelligence/meeting-professional-reflection');
const { createIntelligenceStore, emptyState } = require('../../src/intelligence/store');

function transcriptInput(botId = 'bot-meeting-1') {
  return { botId, ended: '2026-07-17T16:21:00Z',
    meetingMeta: { title: 'Launch readiness', project: 'Launch' }, transcript: [
      { speaker: 'Nora', text: 'The remaining work sounds like implementation ownership.', timestamp: '2026-07-17T16:01:00Z' },
      { speaker: 'Kinsey', text: 'Implementation is complete; the unresolved item is ADA design approval.', timestamp: '2026-07-17T16:02:00Z' },
      { speaker: 'Mallory', text: 'Navigation confirmation is also holding the content move.', timestamp: '2026-07-17T16:03:00Z' },
      { speaker: 'Nora', text: 'I will treat approval and navigation as separate gates in the follow-up.', timestamp: '2026-07-17T16:04:00Z' },
    ] };
}

function snapshot() {
  return reflection.transcriptSnapshot(transcriptInput());
}

function output() {
  return { decision: 'record', abstention_reason: null, reflection: {
    statement: 'Launch follow-up should distinguish implementation completion from approval and navigation gates.',
    scope: 'coordination', confidence: 0.66,
    rationale: 'The discussion separated completed implementation from two unresolved gates that require different owners and evidence.',
    evidence_refs: [reflection.utteranceRef('bot-meeting-1', 1), reflection.utteranceRef('bot-meeting-1', 2)],
    limitation: 'The meeting did not establish whether either gate will change the committed delivery date.',
    falsification_criteria: ['A governing task shows implementation remains incomplete.', 'Both gates are already resolved.'],
    next_observation: 'Check the governing tasks for distinct owners and explicit approval or navigation confirmation.',
    expected_usefulness: 'This should prevent one broad escalation from obscuring the actual remaining decisions.',
  } };
}

function providerResponse(request, value = output()) {
  return { id: 'msg-meeting-reflection-1', model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(value) }],
    usage: { input_tokens: 600, output_tokens: 210 } };
}

async function storeFixture(t, configure = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-meeting-reflection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = emptyState();
  if (configure) configure(initial);
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, initialState: initial,
    clock: () => new Date('2026-07-17T16:22:00.000Z') });
  await store.init();
  return store;
}

test('meeting reflection binds a tentative PM interpretation to distinct speakers', () => {
  const packet = reflection.packetFor(snapshot());
  const normalized = reflection.normalizeOutput(output(), packet);
  assert.equal(normalized.reflection.confidence, 0.66);
  assert.equal(normalized.reflection.evidence_refs.length, 2);
  const request = reflection.requestFor(packet).request;
  assert.deepEqual(request.output_config.format.schema.properties.reflection.anyOf[0]
    .properties.evidence_refs.items.enum, packet.source.utterances.map(item => item.ref.id));
  const submission = reflection.submissionFor(packet, providerResponse(request));
  assert.equal(reflection.auditReceipt(submission.receipt).complete_chain_verified, true);
});

test('protocol-v1 receipts remain replay-valid after citation enums are introduced', () => {
  const source = snapshot();
  source.protocol_version = reflection.LEGACY_PROTOCOL_VERSION;
  const packet = reflection.packetFor(source);
  packet.protocol_version = reflection.LEGACY_PROTOCOL_VERSION;
  const request = reflection.requestFor(packet).request;
  assert.equal(request.output_config.format.schema.properties.reflection.anyOf[0]
    .properties.evidence_refs.items.enum, undefined);
  const submission = reflection.submissionFor(packet, providerResponse(request));
  assert.equal(submission.receipt.protocol_version, reflection.LEGACY_PROTOCOL_VERSION);
  assert.equal(reflection.auditReceipt(submission.receipt).complete_chain_verified, true);
});

test('transcript snapshot preserves the most recent utterances under its character budget', () => {
  const transcript = Array.from({ length: 30 }, (_, index) => ({
    speaker: index % 2 ? 'Kinsey' : 'Nora',
    text: `${String(index).padStart(2, '0')}-${'x'.repeat(1197)}`,
  }));
  const value = reflection.transcriptSnapshot({ botId: 'bounded-meeting',
    ended: '2026-07-17T16:21:00Z', transcript });
  assert.equal(value.utterances.at(-1).index, 29);
  assert.equal(value.utterances.at(-1).text.startsWith('29-'), true);
  assert.equal(value.utterances.reduce((sum, item) => sum + item.text.length, 0),
    reflection.MAX_TRANSCRIPT_CHARS);
});

test('null-ended Postgres transcripts require a quiet grace before inferred completion', () => {
  const now = new Date('2026-07-17T17:00:00Z');
  const docs = [
    { bot_id: 'still-live', ended: null, last_utterance_at: '2026-07-17T16:45:01Z' },
    { bot_id: 'quiet-complete', ended: null, last_utterance_at: '2026-07-17T16:20:00Z' },
    { bot_id: 'authoritative-complete', ended: '2026-07-17T16:55:00Z',
      last_utterance_at: '2026-07-17T16:54:00Z' },
  ];
  const eligible = reflection.eligibleMeetingDocs(docs, [], now);
  assert.deepEqual(eligible.map(item => item.bot_id),
    ['authoritative-complete', 'quiet-complete']);
  assert.equal(eligible[1].reflection_ended_at, '2026-07-17T16:20:00Z');
  assert.equal(eligible[1].inferred_completion, true);
});

test('meeting reflection rejects one-speaker, outside-packet, private-state, and overconfident claims', () => {
  const packet = reflection.packetFor(snapshot());
  const oneSpeaker = output();
  oneSpeaker.reflection.evidence_refs = [reflection.utteranceRef('bot-meeting-1', 0),
    reflection.utteranceRef('bot-meeting-1', 3)];
  assert.throws(() => reflection.normalizeOutput(oneSpeaker, packet), /distinct speakers/);
  const outside = output(); outside.reflection.evidence_refs[1] = 'meeting-utterance:outside:99';
  assert.throws(() => reflection.normalizeOutput(outside, packet), /outside the committed transcript/);
  const privateClaim = output(); privateClaim.reflection.statement = 'Kinsey does not care about the launch approval path.';
  assert.throws(() => reflection.normalizeOutput(privateClaim, packet), /private-state based/);
  const overconfident = output(); overconfident.reflection.confidence = 0.9;
  assert.throws(() => reflection.normalizeOutput(overconfident, packet), /overconfident/);
});

test('abstention is non-operative even when structured output contains filler', () => {
  const packet = reflection.packetFor(snapshot());
  assert.deepEqual(reflection.normalizeOutput({ decision: 'abstain',
    abstention_reason: 'The meeting evidence supports only routine factual continuity, not a distinct interpretation.',
    reflection: output().reflection }, packet), {
    decision: 'abstain',
    abstention_reason: 'The meeting evidence supports only routine factual continuity, not a distinct interpretation.',
    reflection: null,
  });
});

test('receipt replay detects transcript and output tampering', () => {
  const packet = reflection.packetFor(snapshot());
  const submission = reflection.submissionFor(packet,
    providerResponse(reflection.requestFor(packet).request));
  const transcriptTamper = structuredClone(submission.receipt);
  transcriptTamper.source_packet.source.utterances[1].text = 'Rewritten transcript evidence';
  assert.equal(reflection.auditReceipt(transcriptTamper).complete_chain_verified, false);
  const outputTamper = structuredClone(submission.receipt);
  outputTamper.output.reflection.confidence = 0.7;
  assert.equal(reflection.auditReceipt(outputTamper).complete_chain_verified, false);
});

test('attempt replay binds the provider receipt to the exact meeting and decision', () => {
  const packet = reflection.packetFor(snapshot());
  const submission = reflection.submissionFor(packet,
    providerResponse(reflection.requestFor(packet).request));
  const payload = { protocol_version: reflection.PROTOCOL_VERSION, id: 'meeting-reflection-1',
    bot_id: 'bot-meeting-1', decision: 'record', generation_receipt: submission.receipt,
    completed_at: '2026-07-17T16:22:00.000Z' };
  const attempt = { ...payload, attempt_commitment: reflection.commitment(payload) };
  assert.equal(reflection.auditAttempt(attempt).complete_chain_verified, true);
  const rebound = structuredClone(attempt); rebound.bot_id = 'another-meeting';
  assert.equal(reflection.auditAttempt(rebound).complete_chain_verified, false);
});

test('store persists only replay-valid attempts and exposes relevance-bounded tentative readback', async t => {
  const store = await storeFixture(t);
  const packet = reflection.packetFor(snapshot());
  const submission = reflection.submissionFor(packet,
    providerResponse(reflection.requestFor(packet).request));
  const recorded = store.recordMeetingProfessionalReflection({ bot_id: 'bot-meeting-1',
    output: submission.output, generation_receipt: submission.receipt });
  assert.equal(recorded.audit.complete_chain_verified, true);
  assert.deepEqual(store.meetingProfessionalReflectionSnapshot().report, {
    total: 1, recorded: 1, abstained: 0, failed_closed: 0, replay_verified: 1,
    replay_verified_reflections: 1, source_meetings: 1,
  });
  const livePacket = store.meetingProfessionalReflectionPacket('What is blocking launch navigation?');
  assert.equal(livePacket.length, reflection.MAX_PROMPT_REFLECTIONS);
  assert.ok(JSON.stringify(livePacket).length < 3600,
    'live prompt readback must remain bounded as the durable ledger grows');
  assert.equal(store.meetingProfessionalReflectionPacket('unrelated catering question').length, 0);
  const prompt = store.promptContext({ query: 'What is blocking launch navigation?', channel: 'slack' });
  assert.match(prompt, /Verified post-meeting professional reflections/);
  assert.match(prompt, /confidence 66%/);
  assert.match(prompt, /not facts, memories of private states/);
  const cognition = store.cognitionSnapshot();
  assert.equal(cognition.meeting_professional_reflection.report.replay_verified_reflections, 1);
  assert.equal(cognition.meeting_professional_reflection.details_sealed, true);
  assert.equal(cognition.meeting_professional_reflection.latest.generation_receipt, undefined);
  const dashboard = store.dashboardIntelligenceSummary();
  assert.equal(dashboard.cognition.reflection.replay_verified_meeting_reflections, 1);
  assert.equal(dashboard.cognition.reflection.meeting_reflection_source_meetings, 1);
  assert.match(dashboard.brain.reflection.evidence, /1 replay-verified meeting reflections/);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'transcript_bound_professional_reflection');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.replay_verified_reflections, 1);
  assert.throws(() => store.recordMeetingProfessionalReflection({ bot_id: 'bot-meeting-1',
    output: submission.output, generation_receipt: submission.receipt }), /already has/);
});

test('meeting reflection readback is sealed throughout any active context trial', async t => {
  const store = await storeFixture(t);
  const packet = reflection.packetFor(snapshot());
  const submission = reflection.submissionFor(packet,
    providerResponse(reflection.requestFor(packet).request));
  store.recordMeetingProfessionalReflection({ bot_id: 'bot-meeting-1',
    output: submission.output, generation_receipt: submission.receipt });
  const state = store.snapshot();
  state.cognition.self_model.context_trials.push({ id: 'active-trial', status: 'active',
    intervention: 'goal_access', assignments: [] });
  const sealed = createIntelligenceStore({ filePath: null, db: {}, isDbReady: () => false,
    initialState: state });
  await sealed.init();
  assert.deepEqual(sealed.meetingProfessionalReflectionPacket('launch navigation'), []);
  assert.doesNotMatch(sealed.promptContext({ query: 'launch navigation', channel: 'slack' }),
    /Verified post-meeting professional reflections/);
});

test('restart-durable backlog selects an unattempted completed transcript and records one result', async t => {
  const store = await storeFixture(t);
  const input = transcriptInput();
  const run = await reflection.runCycle({ store, now: new Date('2026-07-17T16:22:00Z'),
    listTranscripts: async () => [{ bot_id: input.botId, ended: input.ended }],
    loadTranscript: async () => ({ bot_id: input.botId, ended: input.ended,
      transcript: input.transcript, meetingMeta: input.meetingMeta }),
    callProvider: async request => providerResponse(request) });
  assert.equal(run.state, 'reflection_recorded');
  assert.equal(run.bot_id, input.botId);
  assert.equal(run.provider_calls, 1);
  let calls = 0;
  const second = await reflection.runCycle({ store, now: new Date('2026-07-17T16:23:00Z'),
    listTranscripts: async () => [{ bot_id: input.botId, ended: input.ended }],
    loadTranscript: async () => { calls += 1; return null; },
    callProvider: async () => { throw new Error('must not call'); } });
  assert.equal(second.state, 'no_eligible_completed_meeting');
  assert.equal(calls, 0, 'attempted meeting is filtered before transcript hydration');
});

test('provider failures are committed once while interactive preemption remains retryable', async t => {
  const store = await storeFixture(t);
  const input = transcriptInput('bot-failed-meeting');
  const args = { store, now: new Date('2026-07-17T16:22:00Z'),
    listTranscripts: async () => [{ bot_id: input.botId, ended: input.ended }],
    loadTranscript: async () => ({ bot_id: input.botId, ended: input.ended,
      transcript: input.transcript, meetingMeta: input.meetingMeta }) };
  const failed = await reflection.runCycle({ ...args,
    callProvider: async () => { throw new Error('provider returned malformed output'); } });
  assert.equal(failed.state, 'failed_closed');
  assert.ok(failed.attempt_commitment);
  const failedSnapshot = store.meetingProfessionalReflectionSnapshot();
  assert.equal(failedSnapshot.report.failed_closed, 1);
  assert.equal(failedSnapshot.attempts[0].audit.complete_chain_verified, true);
  let providerCalls = 0;
  const terminal = await reflection.runCycle({ ...args,
    callProvider: async () => { providerCalls += 1; } });
  assert.equal(terminal.state, 'no_eligible_completed_meeting');
  assert.equal(providerCalls, 0);

  const retryStore = await storeFixture(t);
  const canceled = Object.assign(new Error('background intelligence preempted by slack'),
    { code: 'ERR_CANCELED', name: 'CanceledError' });
  const preempted = await reflection.runCycle({ ...args, store: retryStore,
    callProvider: async () => { throw canceled; } });
  assert.equal(preempted.state, 'preempted_for_interactive_priority');
  assert.equal(retryStore.meetingProfessionalReflectionSnapshot().report.total, 0);
});

test('live runtime is scheduled only in the preemptible background lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.meetingProfessionalReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0' }).enabled, true);
  assert.equal(__test.meetingProfessionalReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1' }).enabled, false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /\['meeting_professional_reflection',[\s\S]*runMeetingProfessionalReflectionRuntime/);
  const slack = source.slice(source.indexOf("app.post('/webhook/slack'"), source.indexOf('// Dreams'));
  const zoom = source.slice(source.indexOf("app.post('/webhook/chat'"), source.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(slack, /runMeetingProfessionalReflectionRuntime/);
  assert.doesNotMatch(zoom, /runMeetingProfessionalReflectionRuntime/);
});
