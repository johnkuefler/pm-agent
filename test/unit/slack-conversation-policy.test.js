'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isObviouslyNotForNora,
  slackEmptyReplyFallback,
  slackDeliverySegments,
  slackReplyRequestsSilence,
} = require('../../src/surfaces/slack/conversation-policy');

test('a verified live write fallback is provider-neutral', () => {
  assert.equal(slackEmptyReplyFallback('book it', {}, { wroteLive: true }),
    'Done, the requested change is verified.');
});

test('a channel message addressed to another teammate never reaches Nora', () => {
  assert.equal(isObviouslyNotForNora('<@UOTHER> can you confirm the product list?', 'UNORA'), true);
  assert.equal(isObviouslyNotForNora('<@UNORA> can you confirm the product list?', 'UNORA'), false);
});

test('a silence marker suppresses the entire draft instead of leaking internal reasoning', () => {
  assert.equal(slackReplyRequestsSilence(
    "I don't have a grounded fact to add.\n\n[silence]"), true);
  assert.equal(slackReplyRequestsSilence('Here is the verified launch date.'), false);
});

test('operational work is delivered once while bounded social replies may split', () => {
  assert.deepEqual(slackDeliverySegments('First result.<split>Second result.'),
    ['First result.\n\nSecond result.']);
  assert.deepEqual(slackDeliverySegments('hey<split>good morning',
    { boundedConversation: true }), ['hey', 'good morning']);
});
