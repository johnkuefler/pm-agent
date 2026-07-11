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
  assert.equal(config.recording_config.realtime_endpoints.length, 3);
  assert.equal(config.webhook_url, 'https://nora.example.com/webhook/status');
});

