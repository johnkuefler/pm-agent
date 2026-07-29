'use strict';

// How long a Slack turn is allowed to take, and who is allowed to shorten it.
//
// Only the hourly missed-mention recovery sweep passes a ceiling; it runs inside a larger runtime
// budget and must not overrun it. Every ordinary turn passes nothing and has to get the full
// allowance.
//
// That distinction was broken for weeks in a way nothing surfaced. The check read
// `Number.isFinite(Number(terminalAtOverride))`, and the parameter defaults to null on every
// ordinary turn. `Number(null)` is 0 and `Number.isFinite(0)` is true, so the override branch was
// always taken and `Math.min` pinned the terminal to the epoch. Every Slack turn ran with a deadline
// in 1970, the remaining-budget helper returned 0 forever, and the 60 second tool-turn budget never
// applied once.
//
// What made it invisible: delivery has its own floor, so short replies still landed and looked
// healthy. The model window collapsed to the minimum floor instead, which is enough for a single
// provider round trip and not enough for provider, tool call, provider again. So Nora could answer
// from memory all day and would reliably fail the moment a question needed a connector, returning an
// empty reply and the "I couldn't complete the action cleanly" apology.
//
// A non-positive or unparseable override is treated as absent rather than obeyed, because a deadline
// at or before the epoch is never a real instruction.
function boundedTerminalAt(terminalAtOverride, defaultTerminalAt) {
  const override = Number(terminalAtOverride);
  if (terminalAtOverride == null || !Number.isFinite(override) || override <= 0) return defaultTerminalAt;
  return Math.min(defaultTerminalAt, override);
}

module.exports = { boundedTerminalAt };
