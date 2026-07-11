const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMemoryRecord, memoryIsActive, memoryPromptLine, normalizeCommitment } = require('../../src/intelligence/models');
const { assessUncertainty, detectRepairNeed, initiativeDecision, scoreMeetingContribution } = require('../../src/intelligence/policy');
const { runBench } = require('../../src/intelligence/bench');

test('Memory v2 enriches legacy facts without changing their text', () => {
  const memory = normalizeMemoryRecord({ fact: 'Launch is May 14', source: 'meeting', added: '2026-07-11' });
  assert.equal(memory.fact, 'Launch is May 14');
  assert.equal(memory.kind, 'fact');
  assert.equal(memory.status, 'active');
  assert.equal(memory.confidence, 0.85);
  assert.equal(memoryIsActive(memory), true);
});

test('Memory v2 infers non-factual kinds and exposes uncertainty only when useful', () => {
  const inference = normalizeMemoryRecord({ fact: 'The launch is probably moving', source: 'meeting' });
  assert.equal(inference.kind, 'inference');
  assert.match(memoryPromptLine(inference), /inference/);
  assert.match(memoryPromptLine({ fact: 'Confirmed', confidence: 0.95 }), /^- Confirmed$/);
});

test('expired and superseded memories stay out of active context', () => {
  assert.equal(memoryIsActive({ fact: 'Old', status: 'superseded' }), false);
  assert.equal(memoryIsActive({ fact: 'Expired', status: 'active', valid_until: '2020-01-01' }), false);
});

test('commitments preserve owner, beneficiary, evidence, and follow-up state', () => {
  const commitment = normalizeCommitment({ what: 'Send the recap', owner: 'Nora', beneficiary: 'John', evidence: { channel: 'slack', id: '1' } });
  assert.equal(commitment.status, 'open');
  assert.equal(commitment.follow_up, true);
  assert.equal(commitment.evidence.channel, 'slack');
});

test('uncertainty policy verifies disputed, changing, and high-stakes claims', () => {
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.9, status: 'disputed' }] }).verify, true);
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.99 }], highStakes: true }).verify, true);
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.98, status: 'active' }] }).verify, false);
});

test('meeting judgment speaks when addressed and yields to human exchanges', () => {
  assert.equal(scoreMeetingContribution({ named: true }).shouldSpeak, true);
  assert.equal(scoreMeetingContribution({ named: true, someoneInterruptedNora: true }).shouldSpeak, false);
  assert.equal(scoreMeetingContribution({ humansTalkingToEachOther: true }).shouldSpeak, false);
});

test('initiative requires both value and remaining social budget', () => {
  assert.equal(initiativeDecision({ value: 1, urgency: 1, confidence: 1, interruptionCost: 0, budgetRemaining: 1 }).allowed, true);
  assert.equal(initiativeDecision({ value: 1, urgency: 1, confidence: 1, interruptionCost: 0, budgetRemaining: 0 }).allowed, false);
});

test('repair policy distinguishes corrections from unchanged evidence', () => {
  assert.equal(detectRepairNeed({ priorClaim: 'May 14', newEvidence: 'May 21' }).needed, true);
  assert.equal(detectRepairNeed({ priorClaim: 'May 14', newEvidence: 'May 14' }).needed, false);
});

test('Nora Bench passes every grounded judgment scenario', () => {
  const report = runBench();
  assert.ok(report.total >= 12);
  assert.equal(report.passed, report.total, report.results.filter(item => !item.passed).map(item => item.id).join(', '));
});
