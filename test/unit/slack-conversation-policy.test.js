'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isObviouslyNotForNora,
  proactiveSlackReplyShouldBeSilent,
  slackDeliverySegments,
  slackReplyRequestsSilence,
} = require('../../src/surfaces/slack/conversation-policy');

test('a channel message addressed to another teammate never reaches the proactive model', () => {
  assert.equal(isObviouslyNotForNora('<@UOTHER> can you confirm the product list?', 'UNORA'), true);
  assert.equal(isObviouslyNotForNora('<@UNORA> can you confirm the product list?', 'UNORA'), false);
});

test('a silence marker suppresses the entire draft instead of leaking internal reasoning', () => {
  assert.equal(slackReplyRequestsSilence(
    "I don't have a grounded fact to add.\n\n[silence]"), true);
  assert.equal(slackReplyRequestsSilence('Here is the verified launch date.'), false);
});

test('unsolicited absence claims and pass-the-buck replies stay silent', () => {
  assert.equal(proactiveSlackReplyShouldBeSilent(
    "The launch date isn't tracked in the task list."), true);
  assert.equal(proactiveSlackReplyShouldBeSilent(
    "I couldn't verify staging, so it is worth pinging the developer."), true);
  assert.equal(proactiveSlackReplyShouldBeSilent(
    'The signed launch brief sets go-live for August 28.'), false);
});

test('operational work is delivered once while bounded social replies may split', () => {
  assert.deepEqual(slackDeliverySegments('First result.<split>Second result.'),
    ['First result.\n\nSecond result.']);
  assert.deepEqual(slackDeliverySegments('hey<split>good morning',
    { boundedConversation: true }), ['hey', 'good morning']);
});
