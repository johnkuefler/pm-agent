const test = require('node:test');
const assert = require('node:assert/strict');

const { readServerSource, sourceRegion } = require('../helpers/server-source');

const handler = sourceRegion('async function handleSlackImpl', 'function buildNoraQueueTaskTool');

// The bug this pins was invisible for weeks and cost every connector-backed Slack answer.
//
// boundedTerminalAt existed to let the hourly recovery sweep impose a shorter ceiling. It tested
// Number.isFinite(Number(terminalAtOverride)), and the parameter defaults to null on every ordinary
// turn. Number(null) is 0 and Number.isFinite(0) is true, so Math.min pinned the terminal to the
// epoch. slackRemainingMs() returned 0 forever and the 60s tool-turn budget never applied once.
//
// Simple replies still worked, because delivery has its own floor, which is exactly why this hid:
// only turns that needed a second provider round trip after a tool call came back empty.
test('a turn with no caller ceiling keeps its full budget', () => {
  const source = readServerSource();
  assert.match(source, /terminalAtOverride == null \|\| !Number\.isFinite\(override\) \|\| override <= 0/,
    'null and undefined must read as "no ceiling", and a non-positive override must not pin the terminal');
  assert.doesNotMatch(source,
    /const boundedTerminalAt = defaultTerminalAt => Number\.isFinite\(Number\(terminalAtOverride\)\)/,
    'the coercion that treated null as epoch 0 must not come back');
  assert.match(handler, /boundedSlackTerminalAt\(terminalAtOverride, def\)/,
    'the handler must delegate rather than reimplement the ceiling rule');
});

// Same logic, exercised rather than pattern-matched, because a regex cannot prove the arithmetic.
function boundedTerminalAt(terminalAtOverride, defaultTerminalAt) {
  const override = Number(terminalAtOverride);
  if (terminalAtOverride == null || !Number.isFinite(override) || override <= 0) return defaultTerminalAt;
  return Math.min(defaultTerminalAt, override);
}

test('the ceiling rules hold for every caller shape', () => {
  const now = 1_800_000_000_000;
  const full = now + 60000;
  assert.equal(boundedTerminalAt(null, full), full, 'an ordinary DM gets the whole tool-turn budget');
  assert.equal(boundedTerminalAt(undefined, full), full);
  assert.equal(boundedTerminalAt(0, full), full, 'epoch 0 is not a real deadline');
  assert.equal(boundedTerminalAt(NaN, full), full);
  assert.equal(boundedTerminalAt(-1, full), full);
  // The recovery sweep's shorter ceiling is the one case this mechanism exists for.
  assert.equal(boundedTerminalAt(now + 20000, full), now + 20000);
  assert.equal(boundedTerminalAt(full + 999999, full), full, 'a caller cannot extend past the default');
});

// A tool-using turn needs provider, then the tool call, then provider again. The floor alone cannot
// carry that, so the full budget reaching the tool loop is the thing that makes connectors work.
test('the tool loop receives the guaranteed window, and it is bigger than one round trip', () => {
  const source = readServerSource();
  assert.match(handler, /deadlineMs: modelBudgetMs/);
  assert.match(source, /const SLACK_TOOL_TURN_TERMINAL_MS = 60000/);
  assert.match(source, /const SLACK_MIN_MODEL_MS = (\d+)/);
  const floor = Number(source.match(/const SLACK_MIN_MODEL_MS = (\d+)/)[1]);
  const toolTurn = Number(source.match(/const SLACK_TOOL_TURN_TERMINAL_MS = (\d+)/)[1]);
  assert.ok(toolTurn > floor * 2,
    `a tool turn needs room for several provider round trips; ${toolTurn}ms vs a ${floor}ms floor`);
});
