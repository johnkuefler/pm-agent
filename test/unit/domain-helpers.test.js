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

test('Recall bot config is transcription-only', () => {
  const config = helpers.buildBotConfig('nora.example.com', 'Nora Test');
  assert.equal(config.bot_name, 'Nora Test');
  assert.deepEqual(config.output_media, {
    camera: { kind: 'webpage', config: { url: 'https://nora.example.com/voice-agent' } },
  });
  assert.equal(config.recording_config.video_separate_png, undefined);
  assert.equal(config.recording_config.include_bot_in_recording, undefined);
  assert.deepEqual(config.recording_config.realtime_endpoints, [{
    type: 'webhook',
    url: 'https://nora.example.com/webhook/transcript',
    events: ['transcript.data'],
  }]);
  assert.equal(config.webhook_url, 'https://nora.example.com/webhook/status');
});

test('meeting avatar is static and cannot speak or run client code', () => {
  const avatar = fs.readFileSync(path.join(__dirname, '../../meeting-avatar.html'), 'utf8');
  assert.match(avatar, /Transcribing this meeting/);
  assert.match(avatar, /class="avatar"[^>]*>N</);
  assert.doesNotMatch(avatar, /<script|<audio|<video|WebSocket|fetch\(/i);
});

test('the request-driven prompt preserves Nora concise PM voice', () => {
  const prompt = helpers.buildSystemPrompt({ channel: 'C1', requester: { name: 'John' } }, { conversationText: 'Where are we on launch QA?' });
  assert.match(prompt, /casual, warm, quick/i);
  assert.match(prompt, /project-management assistant/i);
  assert.match(prompt, /Answer the person's question first/i);
  assert.match(prompt, /current provider state/i);
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

