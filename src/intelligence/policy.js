'use strict';

const { clamp } = require('./models');

function assessUncertainty({ memories = [], externallyChanging = false, highStakes = false } = {}) {
  const active = memories.filter(Boolean);
  const confidence = active.length
    ? active.reduce((sum, item) => sum + clamp(item.confidence ?? 0.85), 0, active.length) / active.length
    : 0.35;
  const disputed = active.some(item => item.status === 'disputed' || (item.contradicted_by || []).length);
  const stale = active.some(item => item.last_verified && Date.now() - new Date(item.last_verified).getTime() > 30 * 86400000);
  const verify = highStakes || disputed || (externallyChanging && (confidence < 0.9 || stale));
  return {
    confidence: Number(confidence.toFixed(2)),
    verify,
    disclose: disputed || confidence < 0.75 || stale,
    reasons: [highStakes && 'high stakes', disputed && 'conflicting evidence', stale && 'stale evidence', !active.length && 'no supporting memory'].filter(Boolean),
  };
}

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

function initiativeDecision({ value = 0.5, urgency = 0.5, confidence = 0.8, interruptionCost = 0.5, recentlyIgnored = false, reversible = true, budgetRemaining = 0 } = {}) {
  const score = value * 35 + urgency * 25 + confidence * 20 + (reversible ? 10 : 0) - interruptionCost * 30 - (recentlyIgnored ? 25 : 0);
  return {
    score: Math.round(score),
    threshold: 35,
    allowed: budgetRemaining > 0 && score >= 35,
    reason: budgetRemaining <= 0 ? 'initiative budget exhausted' : score < 35 ? 'expected value does not justify interruption' : 'worth the interruption',
  };
}

function detectRepairNeed({ priorClaim, newEvidence, priorConfidence = 0.8 } = {}) {
  if (!priorClaim || !newEvidence) return { needed: false, severity: 'none' };
  const normalized = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const changed = normalized(priorClaim) !== normalized(newEvidence);
  return {
    needed: changed,
    severity: changed && priorConfidence >= 0.8 ? 'explicit' : changed ? 'light' : 'none',
    guidance: changed ? 'Correct the record plainly, name what changed, give the current evidence, and do not over-apologize.' : null,
  };
}

function reasoningGuidance() {
  return `[Grounding and repair]
Before making a factual claim or commitment, quietly distinguish what you know, what you infer, what may have changed, and the cost of being wrong. Verify changing or high-stakes facts when needed. If evidence conflicts, say so naturally. If you discover that something you said earlier is wrong or stale, repair it directly: name the correction, give the current answer and source, and keep moving. This should make you more honest and useful, never robotic or timid.`;
}

module.exports = { assessUncertainty, detectRepairNeed, initiativeDecision, meetingTurnDecision, reasoningGuidance, scoreMeetingContribution };
