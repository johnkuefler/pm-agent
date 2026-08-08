'use strict';

function parseExecutiveDecision(text) {
  const value = String(text || '').trim();
  const match = value.match(/\b(ef-case-[a-z0-9-]+)\b[\s:,-]*(approve|override|reject|defer)\b(?:[\s:,-]+([\s\S]+))?/i);
  if (!match) return null;
  return {
    case_id: match[1].toLowerCase(),
    decision: match[2].toLowerCase(),
    instruction: String(match[3] || '').trim().slice(0, 1600),
  };
}

async function handleExecutiveDecisionReply({ text, isDirectMessage, user, executiveUserId,
  channel, threadTs, runtime, postMessage }) {
  if (!isDirectMessage || !executiveUserId || user !== executiveUserId) return false;
  const decision = parseExecutiveDecision(text);
  if (!decision) return false;
  try {
    await runtime.decide(decision.case_id, decision);
    await postMessage(channel,
      `Recorded ${decision.decision} for ${decision.case_id}. I will carry it through and verify closure.`,
    threadTs);
  } catch (error) {
    await postMessage(channel, `I could not apply that decision: ${error.message}`, threadTs);
  }
  return true;
}

module.exports = { parseExecutiveDecision, handleExecutiveDecisionReply };
