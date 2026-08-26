'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-domain-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test: helpers } = require('../../server');
const { readServerSource } = require('../helpers/server-source');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('financial content detector catches sensitive values without flagging ordinary prose', () => {
  assert.equal(helpers.containsFinancialContent('The project has a $45,000 budget'), true);
  assert.equal(helpers.containsFinancialContent('Our margin is 31%'), true);
  assert.equal(helpers.containsFinancialContent('The launch is on Friday'), false);
});

test('meeting chat commands require direct, terse instructions', () => {
  assert.equal(helpers.parseNoraMuteCommand('Nora, mute yourself'), 'mute');
  assert.equal(helpers.parseNoraMuteCommand('Nora, you can speak again'), 'unmute');
  assert.equal(helpers.parseNoraMuteCommand('Should Nora mute herself?'), null);
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

test('the request-driven prompt preserves Nora concise PM voice', () => {
  const prompt = helpers.buildSystemPrompt('slack', null, null, { channel: 'C1', requester: { name: 'John' } }, { conversationText: 'Where are we on launch QA?' });
  assert.match(prompt, /casual, warm, quick/i);
  assert.match(prompt, /project-management assistant/i);
  assert.match(prompt, /Answer the person's question first/i);
  assert.match(prompt, /current provider state/i);
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

test('lightweight Slack greetings stay bounded without suppressing substantive questions', () => {
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
    boundedConversation: true,
    attachLiveTools: false,
  });
  assert.equal(helpers.slackEmptyReplyFallback('Good morning', policy), 'good morning');
  assert.equal(helpers.slackEmptyReplyFallback('Hey there', helpers.slackConversationPolicy('Hey there')), 'hey');
  assert.equal(helpers.slackEmptyReplyFallback('Good morning', policy, { sentSlack: true }), 'Sent.');
  assert.doesNotMatch(helpers.slackEmptyReplyFallback('Good morning', policy), /action|retry|rephrase/i);
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
  assert.equal(capabilities.length, 8);
  assert.equal(capabilities.some(item => item.key.startsWith('mcp:')), false);
  // Every live tool is withheld, while replying to the current conversation remains available.
  const reply = capabilities.find(item => item.key === 'conversational_reply');
  assert.equal(reply.availability, 'available');
  const withheld = capabilities.filter(value =>
    !['financial_disclosure', 'conversational_reply'].includes(value.key));
  assert.equal(withheld.length, 6);
  for (const item of withheld) {
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

