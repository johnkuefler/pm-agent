'use strict';

// First-delivery measurement for every human-facing surface.
//
// This lives beside Slack because conversational and tool-using turns have different budgets.
//
// Two rules hold regardless of caller. Telemetry is strictly post-delivery, so a failure here can
// never turn a successful response into a failed one. And a surface with no budget is not measured
// at all rather than measured against zero.

const interactivePerformance = require('../runtime/interactive-performance');

function createInteractiveLatencyRecorder({ recordTrace }) {
  return function recordInteractiveResponseLatency({ surface, startedAt, stages = {},
    promptChars = null, interactionId = null, trigger = null, traceSink = null } = {}) {
    if (!startedAt || !interactivePerformance.BUDGET_MS[surface]) return null;
    const assessment = interactivePerformance.assess(surface, Date.now() - startedAt,
      { promptChars, stages });
    const boundedStages = assessment.stages;
    try {
      const traceInput = {
        // The surface names the budget; the channel names where the turn happened. A tool turn is
        // budgeted apart from a chat reply but is still one Slack conversation to anything reading
        // traces by channel, rather than two half-populated ones.
        channel: surface === 'slack-tools' ? 'slack' : surface,
        action: 'response_latency',
        decision: assessment.within_budget ? 'within_budget' : 'over_budget',
        confidence: 1,
        reasons: [
          `first delivery in ${assessment.latency_ms}ms`,
          `${surface} budget ${assessment.budget_ms}ms`,
          ...Object.entries(boundedStages).map(([key, value]) => `${key} ${value}ms`),
        ],
        interaction_id: interactionId,
        preview: trigger ? String(trigger).slice(0, 120) : String(assessment.latency_ms),
        outcome: assessment,
        at: new Date().toISOString(),
      };
      const trace = typeof traceSink === 'function' ? traceSink(traceInput) : recordTrace(traceInput);
      console.log(`⚡ ${surface} first delivery ${assessment.latency_ms}ms / ${assessment.budget_ms}ms (${assessment.within_budget ? 'within budget' : 'over budget'})`);
      return trace;
    } catch (error) {
      // Telemetry is strictly post-delivery and must never turn a successful response into a failure.
      console.warn(`interactive latency receipt failed for ${surface}: ${error.message}`);
      return null;
    }
  };
}

module.exports = { createInteractiveLatencyRecorder };
