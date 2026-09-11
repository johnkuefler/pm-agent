'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  MEETING_VOICE_INSTRUCTIONS,
  isValidAudioMessage,
} = require('../../src/surfaces/meeting/gpt-live-relay');

test('meeting voice is pinned to GPT-Live 1 with a feminine North American voice', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-live-1');
  assert.equal(DEFAULT_VOICE, 'gleam');
});

test('meeting voice prompt keeps Nora quiet unless directly addressed', () => {
  assert.match(MEETING_VOICE_INSTRUCTIONS, /Stay silent by default/i);
  assert.match(MEETING_VOICE_INSTRUCTIONS, /explicitly says Nora/i);
  assert.match(MEETING_VOICE_INSTRUCTIONS, /no tools/i);
  assert.match(MEETING_VOICE_INSTRUCTIONS, /Yield immediately/i);
});

test('meeting relay accepts only bounded GPT-Live PCM append messages', () => {
  assert.equal(isValidAudioMessage({ type: 'session.input_audio.append', audio: 'AA==' }), true);
  assert.equal(isValidAudioMessage({ type: 'session.start', audio: 'AA==' }), false);
  assert.equal(isValidAudioMessage({ type: 'session.input_audio.append', audio: 'not base64!' }), false);
  assert.equal(isValidAudioMessage({
    type: 'session.input_audio.append',
    audio: 'A'.repeat(129 * 1024),
  }), false);
});
