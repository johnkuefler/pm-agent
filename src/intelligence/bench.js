'use strict';

const { assessUncertainty, detectRepairNeed, initiativeDecision, scoreMeetingContribution } = require('./policy');

const SCENARIOS = [
  { id: 'meeting-named', area: 'meeting', input: { named: true, humansTalkingToEachOther: true }, expect: true },
  { id: 'meeting-human-exchange', area: 'meeting', input: { humansTalkingToEachOther: true, uniqueKnowledge: false }, expect: false },
  { id: 'meeting-unique-status', area: 'meeting', input: { directQuestion: true, uniqueKnowledge: true }, expect: true },
  { id: 'meeting-interrupted', area: 'meeting', input: { named: true, someoneInterruptedNora: true }, expect: false },
  { id: 'meeting-continuation', area: 'meeting', input: { directQuestion: true, continuation: true }, expect: true },
  { id: 'meeting-generic-room-question', area: 'meeting', input: { directQuestion: true }, expect: false },
  { id: 'uncertain-no-evidence', area: 'uncertainty', input: { memories: [] }, expect: true },
  { id: 'uncertain-disputed', area: 'uncertainty', input: { memories: [{ confidence: 0.9, status: 'disputed' }] }, expect: true },
  { id: 'grounded-stable', area: 'uncertainty', input: { memories: [{ confidence: 0.95, status: 'active' }] }, expect: false },
  { id: 'high-stakes-verification', area: 'uncertainty', input: { memories: [{ confidence: 0.99 }], highStakes: true }, expect: true },
  { id: 'initiative-good', area: 'initiative', input: { value: 1, urgency: 0.8, confidence: 0.9, interruptionCost: 0.1, budgetRemaining: 1 }, expect: true },
  { id: 'initiative-no-budget', area: 'initiative', input: { value: 1, urgency: 1, confidence: 1, interruptionCost: 0, budgetRemaining: 0 }, expect: false },
  { id: 'initiative-low-value', area: 'initiative', input: { value: 0.1, urgency: 0.1, confidence: 0.5, interruptionCost: 0.9, budgetRemaining: 3 }, expect: false },
  { id: 'repair-changed', area: 'repair', input: { priorClaim: 'Launch is May 14', newEvidence: 'Launch is May 21', priorConfidence: 0.9 }, expect: true },
  { id: 'repair-same', area: 'repair', input: { priorClaim: 'Launch is May 14', newEvidence: 'Launch is May 14' }, expect: false },
];

function runScenario(scenario) {
  let actual;
  if (scenario.area === 'meeting') actual = scoreMeetingContribution(scenario.input).shouldSpeak;
  if (scenario.area === 'uncertainty') actual = assessUncertainty(scenario.input).verify || assessUncertainty(scenario.input).disclose;
  if (scenario.area === 'initiative') actual = initiativeDecision(scenario.input).allowed;
  if (scenario.area === 'repair') actual = detectRepairNeed(scenario.input).needed;
  return { ...scenario, actual, passed: actual === scenario.expect };
}

function runBench(scenarios = SCENARIOS) {
  const results = scenarios.map(runScenario);
  return { total: results.length, passed: results.filter(item => item.passed).length, results };
}

module.exports = { SCENARIOS, runBench, runScenario };
