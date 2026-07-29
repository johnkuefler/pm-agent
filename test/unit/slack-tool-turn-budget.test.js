const test = require('node:test');
const assert = require('node:assert/strict');

const interactivePerformance = require('../../src/intelligence/interactive-performance');
const { acknowledgesMissingInformation, researchCouldHelp } = require('../../src/surfaces/slack/reply-intent');
const { readServerSource, sourceRegion } = require('../helpers/server-source');

const handler = sourceRegion('async function handleSlackImpl', 'async function getNoraBotUserId');

// A turn that answers from memory and a turn that reads two calendars before booking a meeting are
// different jobs. Holding both to 8 seconds logged every successful connector answer as a failure,
// at 10s to 22s. That is not log noise only: the gate feeds the reliability verdict and the
// self-improvement round, so a permanently failing Slack gate is standing pressure to get faster,
// and the cheapest way to be fast is to stop calling connectors.
test('a tool-using Slack turn is measured against a tool-turn budget', () => {
  const conversational = interactivePerformance.BUDGET_MS.slack;
  const toolTurn = interactivePerformance.BUDGET_MS['slack-tools'];
  assert.ok(toolTurn > conversational,
    `a tool turn needs a larger first-delivery budget than a chat reply; got ${toolTurn} vs ${conversational}`);
  // The observed successful scheduling turns ran 10s to 22s. All of them must score as within budget.
  for (const observed of [10148, 11133, 13407, 19254, 21690]) {
    assert.equal(interactivePerformance.assess('slack-tools', observed).within_budget, true,
      `${observed}ms was a successful connector answer and must not be scored over budget`);
  }
  // The conversational budget is unchanged, so an ordinary slow chat reply is still caught.
  assert.equal(interactivePerformance.assess('slack', 21690).within_budget, false);
});

test('the handler picks the surface from whether the turn carries tools', () => {
  assert.match(handler, /surface: attachLiveTools \? 'slack-tools' : 'slack'/,
    'both first-delivery call sites must budget by turn kind');
  assert.equal(handler.match(/surface: attachLiveTools \? 'slack-tools' : 'slack'/g).length, 2,
    'the reaction path and the reply path both record first delivery');
});

// Splitting the budget must not split the conversation. Anything reading traces by channel should
// still see one Slack thread rather than two half-populated ones.
test('a tool turn is budgeted separately but still traced as Slack', () => {
  assert.match(readServerSource(),
    /surface === 'slack-tools' \? 'slack' : surface/,
    'the trace channel must stay slack for a slack-tools surface');
});

// Booking a meeting is read one calendar per attendee, find the gap, create the event, confirm it.
// Slack was capped at four rounds while Zoom had six, and running out mid-sequence is
// indistinguishable from the work being impossible. The write lives in the tail.
test('Slack gets as many tool rounds as Zoom', () => {
  assert.match(handler, /runClaudeToolLoop\(reqBody, anthropicHeaders, toolExecutors, 6, \{/,
    'the Slack tool loop must not be tighter than the Zoom one');
  assert.doesNotMatch(handler, /runClaudeToolLoop\(reqBody, anthropicHeaders, toolExecutors, 4, \{/,
    'four rounds cannot cover a multi-attendee booking');
});

// The gap detector is a provider call whose own instructions exclude action requests and
// confidently answered questions. It ignored both on three consecutive scheduling turns and filed
// calendar availability as documentation homework. Research searches Drive and Confluence, so it
// can only help when what is missing is documentation.
test('a turn answered from live connectors does not queue documentation research', () => {
  assert.match(handler, /const researchCouldHelp = slackResearchCouldHelp\(firedTools, reply\)/,
    'live tool use must gate research extraction');
  // The three misfires from the log: calendar tools fired, she answered, research got queued anyway.
  assert.equal(researchCouldHelp(['list_calendars', 'list_events'],
    'Both open: before 7:15am CT, and 4:00 to 4:30pm CT.'), false);
  assert.equal(researchCouldHelp(['create_event'],
    'Booked, "john testing - ignore" tomorrow at 3:15 for 15 minutes.'), false);
  // A turn with no live read is still the detector's job to judge.
  assert.equal(researchCouldHelp([], 'That process is owned by the delivery team.'), true);
  // A live read that came up empty is a real documentation gap.
  assert.equal(researchCouldHelp(['search_drive'], "I couldn't find any brief for that."), true);
  assert.match(handler, /!isProactive && !conversationPolicy\.boundedConversation && researchCouldHelp/,
    'the gate has to be applied at the research call site, not just computed');
});

test('coming up empty is still a real documentation gap', () => {
  // These must keep queueing research: she consulted a live source and found nothing.
  for (const reply of [
    "I don't have the brief for that one.",
    "I couldn't find any records of that engagement.",
    'There is no documentation on that process yet.',
    "I'd have to ask Kinsey, that is not written down anywhere I can see.",
    "Nothing in Drive about the Q3 rebrand.",
    "I can't access that folder.",
  ]) {
    assert.equal(acknowledgesMissingInformation(reply), true, `should read as a gap: ${reply}`);
  }
  // These must not: she answered from a live read, and no amount of Drive searching helps.
  for (const reply of [
    'Both open: before 7:15am CT, and 4:00 to 4:30pm CT.',
    'Booked, "john testing - ignore" tomorrow at 3:15 for 15 minutes with a Zoom link.',
    'Kinsey is free after 4:00 and you are free after 3:15.',
    'That task is assigned to Brandee and due Friday.',
  ]) {
    assert.equal(acknowledgesMissingInformation(reply), false, `should not read as a gap: ${reply}`);
  }
});
