'use strict';

const PROTOCOL_VERSION = 14;
// Tool-using Slack turns get a separate budget because verified connector work takes longer than
// a conversational response.
const BUDGET_MS = Object.freeze({
  slack: 8000,
  'slack-tools': 30000,
});
// Prompt ceilings protect enough request and thread context for project and calendar work.
const PROMPT_BUDGET_CHARS = Object.freeze({
  slack: 115000,
  'slack-tools': 115000,
});
const INTERACTIVE_QUIET_WINDOW_MS = 15000;
const INTERACTIVE_ACTIVE_RETRY_MS = 30000;
const BACKGROUND_BUSY_RETRY_MS = 5000;
const activeInteractiveLeases = new Map();
const activeBackgroundLeases = new Map();
const backgroundIdleWaiters = new Set();
let leaseSequence = 0;
let lastInteractiveAt = 0;
let lastInteractiveSurface = null;
let backgroundPreemptions = 0;
let backgroundDeferrals = 0;
let backgroundBudgetCancellations = 0;

function assess(surface, latencyMs, { promptChars = null, stages = null } = {}) {
  const budgetMs = BUDGET_MS[surface] || null;
  const promptBudgetChars = PROMPT_BUDGET_CHARS[surface] || null;
  const measured = Math.max(0, Number(latencyMs) || 0);
  const measuredPromptChars = promptChars !== null && promptChars !== undefined && promptChars !== ''
    && Number.isFinite(Number(promptChars))
    ? Math.max(0, Math.round(Number(promptChars))) : null;
  const boundedStages = stages && typeof stages === 'object'
    ? Object.fromEntries(Object.entries(stages)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Math.max(0, Math.round(Number(value)))]))
    : {};
  return {
    protocol_version: PROTOCOL_VERSION,
    surface,
    latency_ms: Math.round(measured),
    budget_ms: budgetMs,
    within_budget: budgetMs ? measured <= budgetMs : null,
    prompt_chars: measuredPromptChars,
    prompt_budget_chars: promptBudgetChars,
    prompt_within_budget: measuredPromptChars === null || !promptBudgetChars
      ? null : measuredPromptChars <= promptBudgetChars,
    stages: boundedStages,
  };
}

// Human-facing work preempts the single scheduled provider lane.
function beginInteractive(surface, { now = Date.now() } = {}) {
  if (!Object.hasOwn(BUDGET_MS, surface)) throw new Error(`unknown interactive surface: ${surface}`);
  const token = `interactive-${++leaseSequence}`;
  const startedAt = Number(now) || Date.now();
  activeInteractiveLeases.set(token, { surface, started_at: startedAt });
  lastInteractiveAt = Math.max(lastInteractiveAt, startedAt);
  lastInteractiveSurface = surface;
  for (const lease of activeBackgroundLeases.values()) {
    if (!lease.controller.signal.aborted) {
      lease.preempted = true;
      lease.preempted_by = surface;
      backgroundPreemptions += 1;
      lease.controller.abort(new Error(`background work preempted by ${surface}`));
    }
  }
  let released = false;
  return {
    allowed: true, token, surface,
    release({ now: releasedAt = Date.now() } = {}) {
      if (released) return;
      released = true;
      activeInteractiveLeases.delete(token);
      lastInteractiveAt = Math.max(lastInteractiveAt, Number(releasedAt) || Date.now());
      lastInteractiveSurface = surface;
    },
  };
}

function beginBackground(label, { now = Date.now(), force = false } = {}) {
  const checkedAt = Number(now) || Date.now();
  const quietRemaining = Math.max(0, (lastInteractiveAt + INTERACTIVE_QUIET_WINDOW_MS) - checkedAt);
  let reason = null;
  if (!force && activeInteractiveLeases.size) reason = 'interactive_active';
  else if (!force && quietRemaining > 0) reason = 'interactive_cooldown';
  else if (!force && activeBackgroundLeases.size) reason = 'background_provider_busy';
  if (reason) {
    backgroundDeferrals += 1;
    const retryAfterMs = reason === 'interactive_cooldown' ? quietRemaining
      : reason === 'interactive_active' ? INTERACTIVE_ACTIVE_RETRY_MS
        : BACKGROUND_BUSY_RETRY_MS;
    return { allowed: false, label: String(label || 'background'), reason,
      retry_after_ms: retryAfterMs };
  }
  const token = `background-${++leaseSequence}`;
  const controller = new AbortController();
  const record = { label: String(label || 'background'), controller, started_at: checkedAt,
    preempted: false, preempted_by: null, stopped_reason: null };
  activeBackgroundLeases.set(token, record);
  let released = false;
  return {
    allowed: true, token, label: record.label, signal: controller.signal,
    wasPreempted: () => record.preempted,
    wasStopped: () => controller.signal.aborted,
    preemptedBy: () => record.preempted_by,
    stopReason: () => record.stopped_reason,
    cancel(reason = 'runtime_budget') {
      if (controller.signal.aborted) return false;
      record.stopped_reason = String(reason || 'runtime_budget').slice(0, 160);
      backgroundBudgetCancellations += 1;
      controller.abort(new Error(`background work cancelled: ${record.stopped_reason}`));
      return true;
    },
    release() {
      if (released) return;
      released = true;
      activeBackgroundLeases.delete(token);
      if (activeBackgroundLeases.size === 0) {
        for (const resolve of backgroundIdleWaiters) resolve(true);
        backgroundIdleWaiters.clear();
      }
    },
  };
}

function cancelBackground(reason = 'service_shutdown') {
  const boundedReason = String(reason || 'service_shutdown').slice(0, 160);
  let cancelled = 0;
  for (const lease of activeBackgroundLeases.values()) {
    if (lease.controller.signal.aborted) continue;
    lease.stopped_reason = boundedReason;
    lease.controller.abort(new Error(`background work cancelled: ${boundedReason}`));
    cancelled += 1;
  }
  backgroundBudgetCancellations += cancelled;
  return cancelled;
}

function waitForBackgroundIdle({ timeoutMs = 10000 } = {}) {
  if (activeBackgroundLeases.size === 0) return Promise.resolve(true);
  const boundedTimeoutMs = Math.max(1, Math.min(30000, Number(timeoutMs) || 10000));
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      backgroundIdleWaiters.delete(finish);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), boundedTimeoutMs);
    timer.unref?.();
    backgroundIdleWaiters.add(finish);
    if (activeBackgroundLeases.size === 0) finish(true);
  });
}

function prioritySnapshot(now = Date.now()) {
  const surfaces = {};
  for (const lease of activeInteractiveLeases.values()) {
    surfaces[lease.surface] = (surfaces[lease.surface] || 0) + 1;
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    foreground_priority: true,
    maximum_background_provider_concurrency: 1,
    interactive_quiet_window_ms: INTERACTIVE_QUIET_WINDOW_MS,
    interactive_active_retry_ms: INTERACTIVE_ACTIVE_RETRY_MS,
    background_busy_retry_ms: BACKGROUND_BUSY_RETRY_MS,
    active_interactions: activeInteractiveLeases.size,
    active_surfaces: surfaces,
    background_provider_in_flight: activeBackgroundLeases.size,
    background_labels: [...activeBackgroundLeases.values()].map(item => item.label),
    quiet_remaining_ms: Math.max(0, (lastInteractiveAt + INTERACTIVE_QUIET_WINDOW_MS) - Number(now)),
    last_interactive_surface: lastInteractiveSurface,
    background_preemptions: backgroundPreemptions,
    background_deferrals: backgroundDeferrals,
    background_budget_cancellations: backgroundBudgetCancellations,
  };
}

function resetPriorityGateForTest() {
  for (const lease of activeBackgroundLeases.values()) {
    if (!lease.controller.signal.aborted) lease.controller.abort();
  }
  activeInteractiveLeases.clear();
  activeBackgroundLeases.clear();
  leaseSequence = 0;
  lastInteractiveAt = 0;
  lastInteractiveSurface = null;
  backgroundPreemptions = 0;
  backgroundDeferrals = 0;
  backgroundBudgetCancellations = 0;
}

module.exports = {
  PROTOCOL_VERSION,
  BUDGET_MS,
  PROMPT_BUDGET_CHARS,
  INTERACTIVE_QUIET_WINDOW_MS,
  INTERACTIVE_ACTIVE_RETRY_MS,
  BACKGROUND_BUSY_RETRY_MS,
  assess,
  beginInteractive,
  beginBackground,
  cancelBackground,
  waitForBackgroundIdle,
  prioritySnapshot,
  resetPriorityGateForTest,
};
