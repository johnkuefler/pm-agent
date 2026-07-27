'use strict';

// Slack's system prompt is assembled from a cached stable half and a volatile tail. When the two
// exceed the budget, something has to give, and WHAT gives matters: required constraints outrank
// linked page content, which outranks conversational context. This module owns that ordering.

const interactivePerformance = require('../../intelligence/interactive-performance');

function fitSlackSystemPrompt(stable, volatile, optionalLinked = '',
  maxChars = interactivePerformance.PROMPT_BUDGET_CHARS.slack) {
  const stableText = String(stable || '');
  const volatileText = String(volatile || '');
  const linkedText = String(optionalLinked || '');
  const budget = Math.max(1000, Number(maxChars)
    || interactivePerformance.PROMPT_BUDGET_CHARS.slack);
  const available = Math.max(0, budget - stableText.length);
  const criticalMarker = '[Before you hit send:';
  const criticalIndex = volatileText.lastIndexOf(criticalMarker);
  const originalContext = criticalIndex >= 0
    ? volatileText.slice(0, criticalIndex) : volatileText;
  const originalRequired = criticalIndex >= 0
    ? volatileText.slice(criticalIndex) : '';

  // Recipient-specific safety, tool-boundary, and output-monitor instructions live at the end
  // of the volatile prompt and are never displaced by optional cognitive or linked-page context.
  let required = originalRequired;
  let requiredTruncated = false;
  if (required.length > available) {
    requiredTruncated = true;
    const notice = '[Earlier response constraints omitted to preserve the hard Slack prompt limit.]\n';
    required = available <= 0
      ? ''
      : available > notice.length
      ? `${notice}${required.slice(-(available - notice.length))}`
      : required.slice(-available);
  }

  let remaining = Math.max(0, available - required.length);
  let linked = linkedText;
  let linkedContentTruncated = false;
  if (linked.length > remaining) {
    linkedContentTruncated = linked.length > 0;
    linked = linked.slice(0, remaining);
  }
  remaining -= linked.length;

  let context = originalContext;
  let contextCompacted = false;
  if (context.length > remaining) {
    contextCompacted = context.length > 0;
    const omission = '\n\n[Lower-priority live context omitted to preserve the Slack response budget.]\n\n';
    if (remaining <= 0) {
      context = '';
    } else if (remaining <= omission.length) {
      context = context.slice(-remaining);
    } else {
      const contentBudget = remaining - omission.length;
      const headChars = Math.ceil(contentBudget * 0.6);
      const tailChars = contentBudget - headChars;
      context = `${context.slice(0, headChars)}${omission}${tailChars > 0 ? context.slice(-tailChars) : ''}`;
    }
  }

  const tail = `${context}${linked}${required}`;
  return {
    tail,
    total_chars: stableText.length + tail.length,
    within_budget: stableText.length + tail.length <= budget,
    context_compacted: contextCompacted,
    linked_content_truncated: linkedContentTruncated,
    required_constraints_truncated: requiredTruncated,
  };
}

module.exports = {
  fitSlackSystemPrompt,
};
