'use strict';

function scoreMeetingContribution(input = {}) {
  let score = 0;
  const reasons = [];
  if (input.named) { score += 110; reasons.push('addressed by name'); }
  if (input.directQuestion) { score += 40; reasons.push('direct question'); }
  if (input.oneOnOne) { score += 25; reasons.push('one-on-one'); }
  if (input.uniqueKnowledge) { score += 25; reasons.push('Nora has unique relevant knowledge'); }
  if (input.unresolvedDecision) { score += 15; reasons.push('decision is unresolved'); }
  if (input.continuation) { score += 20; reasons.push('continuing a conversation with Nora'); }
  if (input.repetition) { score += 10; reasons.push('discussion is looping'); }
  if (input.humansTalkingToEachOther) { score -= 55; reasons.push('humans are talking to each other'); }
  if (input.someoneInterruptedNora) { score -= 80; reasons.push('a person is speaking'); }
  if (input.lowConfidence) { score -= 25; reasons.push('confidence is low'); }
  const threshold = input.oneOnOne ? 25 : 50;
  return { score, threshold, shouldSpeak: score >= threshold, reasons };
}

function meetingTurnDecision(input = {}) {
  const policy = scoreMeetingContribution(input);
  return { ...policy, candidate: !!input.candidate, shouldSpeak: !!input.candidate && policy.shouldSpeak };
}

module.exports = { meetingTurnDecision, scoreMeetingContribution };
