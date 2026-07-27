const test = require('node:test');
const assert = require('node:assert/strict');

const { readServerSource, sourceRegion } = require('../helpers/server-source');
const { meetingTurnDecision } = require('../../src/intelligence/policy');

// Why this route exists at all. In a group the contribution score is the final authority, and a
// question that does not name her scores 40 against a threshold of 50. Not "usually declined":
// arithmetically impossible to pass. This pins that, so if someone later retunes the weights and
// makes the score sufficient on its own, this fails and the extra probe route can be reconsidered.
test('an unnamed group question cannot pass the score on its own', () => {
  const decision = meetingTurnDecision({
    candidate: true, named: false, directQuestion: true, oneOnOne: false,
    humansTalkingToEachOther: false, continuation: false, uniqueKnowledge: false,
  });
  assert.equal(decision.shouldSpeak, false);
  assert.ok(decision.score < decision.threshold, `${decision.score} should be under ${decision.threshold}`);
});

test('being named still carries a group turn without any probe', () => {
  const decision = meetingTurnDecision({
    candidate: true, named: true, directQuestion: true, oneOnOne: false,
    humansTalkingToEachOther: false, continuation: false, uniqueKnowledge: false,
  });
  assert.equal(decision.shouldSpeak, true);
});

const handler = sourceRegion('function maybeTriggerVoiceResponse', 'function buildNoraQueueTaskTool');

test('a declined group question is routed to the answer probe', () => {
  assert.match(handler, /looksLikeQuestion\(userText\)[\s\S]{0,160}answeringQuestion: true/,
    'an unnamed question in a group must reach the probe rather than fall straight to silence');
});

// The gate is deliberately biased toward silence, and this route must not change that: she speaks
// only on a non-PASS verdict, and never over a handoff, a 1:1, or while muted.
test('the answer probe stays behind the same silence guards', () => {
  const route = handler.slice(handler.indexOf('answer probe') - 600, handler.indexOf('answer probe'));
  for (const guard of ['!session.muted', '!session.oneOnOne', '!soloHuman', '!handoff']) {
    assert.ok(route.includes(guard), `${guard} must still gate the answer probe`);
  }
});

const probe = sourceRegion('function maybeVolunteerProbe', 'function resumePendingVoiceTurn');

test('answering a question skips the cue word and the interjection cooldown', () => {
  assert.match(probe, /!answeringQuestion && !VOLUNTEER_CUE\.test/,
    'a real question is its own invitation; requiring a PM cue word drops most of them');
  assert.match(probe, /!answeringQuestion && session\.lastVolunteerSpokeAt/,
    'the five-minute silence is for uninvited interjections, not for answering someone');
});

test('the two probes stay distinguishable end to end', () => {
  assert.match(probe, /nora_probe: answeringQuestion \? 'room_question' : 'volunteer'/);
  const source = readServerSource();
  assert.match(source, /probeKind === 'volunteer' \|\| probeKind === 'room_question'/,
    'the verdict handler must claim both probes, or an answer would leak into the transcript');
  assert.match(source, /if \(!answering\) s\.lastVolunteerSpokeAt = Date\.now\(\)/,
    'answering a question must not arm the interjection cooldown and mute her for five minutes');
});
