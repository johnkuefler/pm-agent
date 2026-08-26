const test = require('node:test');
const assert = require('node:assert/strict');

const interactivePerformance = require('../../src/runtime/interactive-performance');
const { readServerSource, sourceRegion } = require('../helpers/server-source');

const handler = sourceRegion('async function handleSlackImpl', 'async function getNoraBotUserId');

// A conversational turn and a turn that reads two calendars before booking a meeting are
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
// Slack used to be capped at four rounds, and running out mid-sequence is
// indistinguishable from the work being impossible. The write lives in the tail.
test('Slack gets enough tool rounds for calendar scheduling', () => {
  assert.match(handler, /runClaudeToolLoop\(reqBody, anthropicHeaders, toolExecutors, 6, \{/,
    'the Slack tool loop must cover multi-step calendar work');
  assert.doesNotMatch(handler, /runClaudeToolLoop\(reqBody, anthropicHeaders, toolExecutors, 4, \{/,
    'four rounds cannot cover a multi-attendee booking');
});

test('Slack extraction does not manufacture research tasks', () => {
  assert.doesNotMatch(handler, /extractResearchNeeds|slackResearchCouldHelp/);
});
