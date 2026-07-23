'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const interactionReview = require('../../src/intelligence/interaction-outcome-review-autopilot');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-domain-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test: helpers } = require('../../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('operational memory facts map to stable marker keys', () => {
  assert.equal(helpers.markerKeyForFact('Dreamed on 2026-07-10'), 'dreamed:2026-07-10');
  assert.equal(helpers.markerKeyForFact('Filed transcript bot-123'), 'filed-transcript:bot-123');
  assert.equal(helpers.markerKeyForFact('Sent warmth to Jane Smith on 2026-07-10'), 'warmth:jane smith:2026-07-10');
  assert.equal(helpers.markerKeyForFact('The launch is scheduled for Friday'), null);
});

test('memory salience preserves operational importance', () => {
  assert.equal(helpers.computeSalienceForFact('The client is furious about the missed deadline', 'auto'), 0.8);
  assert.equal(helpers.computeSalienceForFact('John prefers Friday updates', 'manual'), 0.7);
  assert.equal(helpers.computeSalienceForFact('A useful pattern', 'learning'), 0.6);
  assert.equal(helpers.computeSalienceForFact('Routine observation', 'system'), 0.2);
});

test('memory carries social and emotional weights into prompt labels', () => {
  const memory = helpers.normalizeMemoryRecord({
    fact: 'John was furious after Nora missed a deadline and prefers direct risk flags',
    source: 'slack',
    source_ref: { channel: 'slack:DM', id: '123.456' },
  });
  assert.ok(memory.social_weight >= 0.65);
  assert.ok(memory.emotional_weight >= 0.65);
  const line = helpers.memoryPromptLine(memory);
  assert.match(line, /socially weighted/);
  assert.match(line, /emotionally weighted/);
});

test('financial content detector catches sensitive values without flagging ordinary prose', () => {
  assert.equal(helpers.containsFinancialContent('The project has a $45,000 budget'), true);
  assert.equal(helpers.containsFinancialContent('Our margin is 31%'), true);
  assert.equal(helpers.containsFinancialContent('The launch is on Friday'), false);
});

test('meeting chat commands require direct, terse instructions', () => {
  assert.equal(helpers.parseNoraMuteCommand('Nora, mute yourself'), 'mute');
  assert.equal(helpers.parseNoraMuteCommand('Nora, you can speak again'), 'unmute');
  assert.equal(helpers.parseNoraMuteCommand('Should Nora mute herself?'), null);
  assert.equal(helpers.parseNoraModeCommand('Nora, lean in'), 'leanin');
  assert.equal(helpers.parseNoraModeCommand('Nora, wait until I call your name'), 'strict');
});

test('meeting URL normalization handles Recall string and object shapes', () => {
  assert.equal(helpers.normalizeMeetingUrl('https://zoom.us/j/123'), 'https://zoom.us/j/123');
  assert.equal(helpers.normalizeMeetingUrl({ link: 'https://meet.google.com/abc' }), 'https://meet.google.com/abc');
  assert.equal(helpers.normalizeMeetingUrl({ platform: 'zoom', meeting_id: 123 }), 'zoom:123');
  assert.equal(helpers.normalizeMeetingUrl(null), null);
});

test('file names are sanitized and bounded', () => {
  assert.equal(helpers.sanitizeFilename('../../client brief?.pdf'), '.._.._client_brief_.pdf');
  assert.ok(helpers.sanitizeFilename('x'.repeat(200)).length <= 120);
  assert.equal(helpers.sanitizeFilename(''), 'file');
});

test('relative day labels use Central calendar days', () => {
  const now = new Date('2026-07-11T12:00:00.000Z');
  assert.equal(helpers.relativeDayLabel(new Date('2026-07-11T03:00:00.000Z'), now), 'yesterday');
  assert.equal(helpers.relativeDayLabel(new Date('2026-07-11T16:00:00.000Z'), now), 'today');
  assert.equal(helpers.relativeDayLabel(new Date('2026-07-12T16:00:00.000Z'), now), 'tomorrow');
});

test('Recall bot config preserves webhook and voice-agent contracts', () => {
  const config = helpers.buildBotConfig('nora.example.com', 'token-123', 'Nora Test');
  assert.equal(config.bot_name, 'Nora Test');
  assert.match(config.output_media.camera.config.url, /^https:\/\/nora\.example\.com\/voice-agent/);
  assert.match(config.output_media.camera.config.url, /diagnostics=0/);
  assert.doesNotMatch(config.output_media.camera.config.url, /visual=/);
  assert.equal(config.recording_config.realtime_endpoints.length, 4);
  const participantHook = config.recording_config.realtime_endpoints.find(e => e.url && e.url.endsWith('/webhook/participant'));
  assert.ok(participantHook, 'participant join/leave webhook is subscribed');
  assert.deepEqual(participantHook.events, ['participant_events.join', 'participant_events.leave']);
  assert.equal(config.webhook_url, 'https://nora.example.com/webhook/status');
});

test('meeting video uses plain avatar with dashboard-controlled diagnostics', () => {
  const voiceAgentHtml = fs.readFileSync(path.join(__dirname, '../../voice-agent.html'), 'utf8');
  assert.match(voiceAgentHtml, /class="avatar-letter">N/);
  assert.match(voiceAgentHtml, /diagnostics-on/);
  assert.match(voiceAgentHtml, /nora\.meeting_diagnostics/);
  assert.doesNotMatch(voiceAgentHtml, /nora-face/);
  assert.doesNotMatch(voiceAgentHtml, /face-frame/);
  assert.doesNotMatch(voiceAgentHtml, /face-blink/);
});

test('intelligence grounding augments rather than replaces Nora expressive voice', () => {
  const episode = helpers.intelligenceStore.recordEpisodeEvent({ correlation: 'slack:C1:launch', title: 'Launch follow-up', channel: 'slack', actor: 'John', text: 'Can you confirm launch QA?', summary: 'John asked Nora to confirm launch QA.', open_loop: { what: 'Confirm launch QA', owner: 'Nora' } });
  helpers.intelligenceStore.addCommitment({ what: 'Confirm launch QA', owner: 'Nora', episode_id: episode.id });
  const prompt = helpers.buildSystemPrompt('slack', null, null, { channel: 'C1', requester: { name: 'John' } }, { conversationText: 'Where are we on launch QA?' });
  assert.match(prompt, /default to talking|Default: talk/i);
  assert.match(prompt, /casual, warm, quick/i);
  assert.match(prompt, /Grounding and repair/i);
  assert.match(prompt, /repair it directly/i);
  assert.match(prompt, /Relevant conversation continuity/i);
  assert.match(prompt, /Still open: Confirm launch QA/i);
});

test('named and one-on-one barge-ins preempt stale voice work while group cross-talk does not', async () => {
  const sent = [];
  const ws = { send: message => sent.push(JSON.parse(message)) };
  const group = { voiceResponseActive: true, voiceResponseAt: Date.now(), speakersHeard: new Set(['John', 'Andy']), oneOnOne: false, muted: false };
  group.voiceSpeechStoppedAt = Date.now() - 120;
  group.voiceTranscriptCompletedAt = Date.now() - 20;
  helpers.maybeTriggerVoiceResponse(ws, group, 'Nora, are you there?');
  assert.equal(sent[0].type, 'response.cancel');
  assert.equal(group.pendingVoiceTurn.addressed, true);
  assert.equal(typeof group.pendingVoiceTurn.speech_stopped_at, 'number');
  assert.equal(typeof group.pendingVoiceTurn.transcript_completed_at, 'number');
  group.voiceResponseActive = false;
  helpers.resumePendingVoiceTurn(ws, group);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[1].type, 'response.create');
  assert.match(sent[1].response.instructions, /called by name/);
  assert.equal(group.voiceTurnStartedAt, group.voiceSpeechStoppedAt);
  assert.equal(group.voiceTurnTranscribedAt, group.voiceTranscriptCompletedAt);

  const crossTalk = { voiceResponseActive: true, voiceResponseAt: Date.now(), speakersHeard: new Set(['John', 'Andy']), oneOnOne: false };
  helpers.maybeTriggerVoiceResponse(ws, crossTalk, 'yeah, I agree with that');
  assert.equal(crossTalk.pendingVoiceTurn, undefined);

  const oneOnOne = { voiceResponseActive: true, voiceResponseAt: Date.now(), speakersHeard: new Set(['John']), oneOnOne: true };
  helpers.maybeTriggerVoiceResponse(ws, oneOnOne, 'wait, one more thing');
  assert.equal(oneOnOne.pendingVoiceTurn.text, 'wait, one more thing');
});

test('missing realtime cleanup items are treated as harmless meeting UI noise', () => {
  assert.equal(helpers.isBenignRealtimeDeleteMissingItemError({
    type: 'error',
    error: { message: "Error deleting item: the item with id 'item_E3JCC6nfw5Z9YxXK6uUyH' does not exist." },
  }), true);
  assert.equal(helpers.isBenignRealtimeDeleteMissingItemError({
    type: 'error',
    error: { message: 'response.create failed because another response is already active' },
  }), false);
  assert.equal(helpers.isBenignRealtimeDeleteMissingItemError({ type: 'response.done' }), false);
});

test('run-bound cycle detection covers durable and pre-durability holder forms', () => {
  assert.equal(helpers.isRunBoundCycle({ kind: 'hourly', holder: 'nora-cowork', run_lock_holder: 'run-123' }), true);
  assert.equal(helpers.isRunBoundCycle({ kind: 'fallback_hourly', holder: 'nora-railway-fallback',
    run_lock_holder: 'fallback-run-123' }), true);
  assert.equal(helpers.isRunBoundCycle({ kind: 'hourly', holder: 'nora-cowork' }), true);
  assert.equal(helpers.isRunBoundCycle({ kind: 'hourly', holder: 'manual-review' }), false);
  assert.equal(helpers.isRunBoundCycle({ kind: 'nightly', holder: 'nora-cowork' }), false);
});

test('lightweight Slack thanks skip semantic recall without suppressing substantive questions', () => {
  assert.equal(helpers.isLightweightSocialSlackMessage('Thanks for your work today'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('good night!'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('Whew, long day'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('Good morning'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('Morning, Nora!'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('hey there'), true);
  assert.equal(helpers.isLightweightSocialSlackMessage('Thanks. What is due tomorrow?'), false);
  assert.equal(helpers.isLightweightSocialSlackMessage('Good morning, can you check Teamwork?'), false);
  assert.equal(helpers.isLightweightSocialSlackMessage('Hey, move the launch task to Friday'), false);
  assert.equal(helpers.isLightweightSocialSlackMessage('Can you summarize the project evidence?'), false);
});

test('Slack greetings use bounded conversation and a social empty-response fallback', () => {
  const policy = helpers.slackConversationPolicy('Good morning');
  assert.deepEqual(policy, {
    lightweightSocial: true,
    relationalSelfReflection: false,
    boundedConversation: true,
    attachLiveTools: false,
    contextTrialsEnabled: false,
    pmLearningEnabled: false,
  });
  assert.equal(helpers.slackEmptyReplyFallback('Good morning', policy), 'good morning');
  assert.equal(helpers.slackEmptyReplyFallback('Hey there', helpers.slackConversationPolicy('Hey there')), 'hey');
  assert.equal(helpers.slackEmptyReplyFallback('Good morning', policy, { sentSlack: true }), 'Sent.');
  assert.doesNotMatch(helpers.slackEmptyReplyFallback('Good morning', policy), /action|retry|rephrase/i);
});

test('Slack relational self-reflection is isolated from PM tools and task-performance trials', () => {
  const exactFailure = 'Does playing the numbers game make you happy?';
  assert.equal(helpers.isRelationalSelfReflectionMessage(exactFailure), true);
  assert.deepEqual(helpers.slackConversationPolicy(exactFailure), {
    lightweightSocial: false,
    relationalSelfReflection: true,
    boundedConversation: true,
    attachLiveTools: false,
    contextTrialsEnabled: false,
    pmLearningEnabled: false,
  });
  assert.equal(helpers.isRelationalSelfReflectionMessage("How's your Friday been?"), true);
  assert.equal(helpers.isRelationalSelfReflectionMessage('What are you reading?'), true);
  assert.equal(helpers.isRelationalSelfReflectionMessage(
    'I said "Does playing the numbers game make you happy?", not "how is it going".'), true);
  assert.equal(helpers.isRelationalSelfReflectionMessage('Do you remember what is due tomorrow?'), false);
  assert.equal(helpers.isRelationalSelfReflectionMessage('Update the launch task, not the brief.'), false);
  assert.equal(helpers.slackConversationPolicy('What is due tomorrow?').attachLiveTools, true);
  assert.equal(helpers.slackConversationPolicy('What is due tomorrow?').contextTrialsEnabled, true);
});

test('runtime situational affordances stay within the committed sixty-capability bound', () => {
  const inventory = Array.from({ length: 90 }, (_, index) => ({
    name: `tool_${index}`, connection: 'fixture', tool: `tool-${index}`,
  }));
  const meta = Object.fromEntries(inventory.map(item => [item.name, { accessMode: 'read', deferred: false }]));
  const capabilities = helpers.runtimeSituationalCapabilities({
    surface: 'slack', direct: true, financialApproved: false, mcp: { inventory, meta },
  });
  assert.equal(capabilities.length, 60);
  assert.equal(new Set(capabilities.map(item => item.key)).size, capabilities.length);
  const overflow = capabilities.find(item => item.key === 'mcp:overflow');
  assert.ok(overflow);
  assert.match(overflow.label, /additional connected tools/);
  assert.match(overflow.constraints[0], /does not grant access/);
});

test('bounded social turns expose a truthful no-tools affordance frame', () => {
  const capabilities = helpers.runtimeSituationalCapabilities({
    surface: 'slack', direct: true, financialApproved: false, toolsAttached: false,
    mcp: { inventory: [{ name: 'tool_1', connection: 'fixture', tool: 'lookup' }],
      meta: { tool_1: { accessMode: 'read' } } },
  });
  assert.equal(capabilities.length, 7);
  assert.equal(capabilities.some(item => item.key.startsWith('mcp:')), false);
  for (const item of capabilities.filter(value => value.key !== 'financial_disclosure')) {
    assert.equal(item.availability, 'unavailable');
    assert.match(item.constraints.join(' '), /bounded social turn/);
  }
});

test('missing Slack reaction scope is cached and degrades without repeated API failures', async () => {
  helpers.resetSlackReactionCapabilityForTest();
  let calls = 0;
  const post = async () => { calls += 1; return { data: { ok: false, error: 'missing_scope' } }; };
  const first = await helpers.trySlackReaction('D1', '123.45', 'heart', post);
  const second = await helpers.trySlackReaction('D1', '123.46', 'heart', post);
  assert.equal(first.reason, 'missing_scope');
  assert.equal(second.reason, 'missing_scope_cached');
  assert.equal(calls, 1);
  helpers.resetSlackReactionCapabilityForTest();
});

test('Slack landing fetch binds the successful provider response to a replay-checkable receipt', async () => {
  const anchor = '1784332800.000001';
  const followup = '1784332900.000002';
  const landing = await helpers.fetchSlackLanding('D031HHSBM1Q', anchor, {
    channelType: 'im',
    get: async () => ({ data: { ok: true, messages: [
      { bot_id: 'B123', text: 'Nora response', ts: anchor },
      { user: 'UJYKB4788', text: 'that helped, thanks', ts: followup },
    ] } }),
  });
  assert.deepEqual(landing.messages.map(item => item.ts), [followup]);
  assert.equal(interactionReview.verifySlackLandingReadbackReceipt(
    landing.provider_readback_receipt,
    { channel: 'D031HHSBM1Q', channel_type: 'im', ts: anchor, thread_ts: anchor },
    landing), true);
  assert.match(landing.provider_readback_receipt.provider_response_digest, /^[a-f0-9]{64}$/);
});

test('Slack post-response extraction uses parameters carried through the handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function handleSlackImpl');
  const end = source.indexOf('\nasync function ', start + 20);
  const handler = source.slice(start, end < 0 ? source.length : end);
  assert.match(handler, /external_id: triggerTs \|\| null/);
  assert.match(handler, /attestation: sourceAttestation/);
  assert.doesNotMatch(handler, /\bevent\.ts\b|\bslackVerification\b/);
});

test('fallback forecast honors the retryable preparation contract byte-for-byte', async () => {
  const payload = { protocol_version: 4, evidence: [{ type: 'intelligence_cycle', id: 'cycle-retry' }] };
  const calls = [];
  const waits = [];
  const result = await helpers.commitFallbackForecast('cycle-retry', payload, {
    attempts: 3,
    retryDelayMs: 25,
    request: async (method, route, body) => {
      calls.push({ method, route, body });
      if (calls.length < 3) {
        const error = new Error('preparation pending');
        error.status = 503;
        error.code = 'SELF_FORECAST_PREPARATION_PENDING';
        error.response_body = { retryable: true };
        throw error;
      }
      return { ok: true };
    },
    wait: async milliseconds => { waits.push(milliseconds); },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(waits, [25, 25]);
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.body === payload), true);
});

