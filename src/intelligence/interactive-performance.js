'use strict';

const PROTOCOL_VERSION = 2;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BUDGET_MS = Object.freeze({
  slack: 8000,
  'zoom-chat': 6000,
  realtime: 2000,
});
const INTERACTIVE_QUIET_WINDOW_MS = 15000;
const activeInteractiveLeases = new Map();
const activeBackgroundLeases = new Map();
let leaseSequence = 0;
let lastInteractiveAt = 0;
let lastInteractiveSurface = null;
let backgroundPreemptions = 0;
let backgroundDeferrals = 0;

// These interventions add a provider round trip, materially increase the main
// generation budget, or otherwise hold a response after the first answer exists.
// They remain available to scheduled/non-interactive research surfaces.
const INLINE_LATENCY_TAXED_INTERVENTIONS = new Set([
  'endogenous_attention_selection',
  'prospective_output_monitor',
  'prospective_output_calibration_access',
  'provider_reasoning_regulation',
  'reasoning_self_regulation',
]);

const protocol = Object.freeze({
  protocol_version: PROTOCOL_VERSION,
  prediction: 'Human-facing cognition can stay within channel-specific first-delivery budgets when extra provider-round research is excluded from interactive paths and background inference yields to live work.',
  intervention: 'Slack, Zoom chat, and realtime voice permit context-only cognition inline, quarantine response-taxing study arms, preempt background provider inference, and hold the background lane through a short post-interaction quiet window.',
  controls: 'Scheduled research retains the quarantined interventions through one serialized, preemptible provider lane; ordinary live tool use remains available when the requested work itself requires it.',
  outcome: 'First delivered Slack message, Zoom chat message, or first realtime audio measured from the accepted interaction trigger.',
  minimum_samples_per_surface: 20,
  falsifier: 'A surface has at least 20 recent observations and its p95 first-delivery latency remains above budget, or the firewall suppresses the one main response needed to do the requested work.',
});

function isLatencyTaxedIntervention(intervention, selfModelProtocolVersion = 1) {
  if (INLINE_LATENCY_TAXED_INTERVENTIONS.has(intervention)) return true;
  return intervention === 'self_model_access' && Number(selfModelProtocolVersion) === 2;
}

function allowsInlineIntervention({ latencyCritical = false, intervention = null,
  selfModelProtocolVersion = 1 } = {}) {
  return !latencyCritical || !isLatencyTaxedIntervention(intervention, selfModelProtocolVersion);
}

function assess(surface, latencyMs) {
  const budgetMs = BUDGET_MS[surface] || null;
  const measured = Math.max(0, Number(latencyMs) || 0);
  return {
    surface,
    latency_ms: Math.round(measured),
    budget_ms: budgetMs,
    within_budget: budgetMs ? measured <= budgetMs : null,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  return Math.round(ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]);
}

function summarize(traces = [], now = Date.now()) {
  const eligible = traces.filter(item => item?.action === 'response_latency'
    && item.outcome && BUDGET_MS[item.outcome.surface]
    && Number.isFinite(Number(item.outcome.latency_ms))
    && (!item.at || now - new Date(item.at).getTime() <= WINDOW_MS));
  const surfaces = {};
  for (const surface of Object.keys(BUDGET_MS)) {
    const samples = eligible.filter(item => item.outcome.surface === surface)
      .map(item => Number(item.outcome.latency_ms));
    const within = samples.filter(value => value <= BUDGET_MS[surface]).length;
    surfaces[surface] = {
      budget_ms: BUDGET_MS[surface],
      samples: samples.length,
      within_budget: within,
      within_budget_rate: samples.length ? within / samples.length : null,
      p50_ms: percentile(samples, 0.5),
      p95_ms: percentile(samples, 0.95),
      gate: samples.length < protocol.minimum_samples_per_surface ? 'collecting'
        : percentile(samples, 0.95) <= BUDGET_MS[surface] ? 'passing' : 'failing',
    };
  }
  const sampleCount = eligible.length;
  const withinCount = eligible.filter(item => item.outcome.within_budget === true).length;
  return {
    protocol,
    window_hours: WINDOW_MS / (60 * 60 * 1000),
    samples: sampleCount,
    within_budget: withinCount,
    within_budget_rate: sampleCount ? withinCount / sampleCount : null,
    surfaces,
  };
}

// Intelligence work is deliberately preemptible. Slack and realtime calls own the foreground;
// scheduled reflection/research may use a single provider lane only while that foreground is
// quiet. Starting a human-facing interaction aborts the current background provider request.
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
      lease.controller.abort(new Error(`background intelligence preempted by ${surface}`));
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
    return { allowed: false, label: String(label || 'background'), reason,
      retry_after_ms: reason === 'interactive_cooldown' ? quietRemaining : null };
  }
  const token = `background-${++leaseSequence}`;
  const controller = new AbortController();
  const record = { label: String(label || 'background'), controller, started_at: checkedAt,
    preempted: false, preempted_by: null };
  activeBackgroundLeases.set(token, record);
  let released = false;
  return {
    allowed: true, token, label: record.label, signal: controller.signal,
    wasPreempted: () => record.preempted || controller.signal.aborted,
    preemptedBy: () => record.preempted_by,
    release() {
      if (released) return;
      released = true;
      activeBackgroundLeases.delete(token);
    },
  };
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
    active_interactions: activeInteractiveLeases.size,
    active_surfaces: surfaces,
    background_provider_in_flight: activeBackgroundLeases.size,
    background_labels: [...activeBackgroundLeases.values()].map(item => item.label),
    quiet_remaining_ms: Math.max(0, (lastInteractiveAt + INTERACTIVE_QUIET_WINDOW_MS) - Number(now)),
    last_interactive_surface: lastInteractiveSurface,
    background_preemptions: backgroundPreemptions,
    background_deferrals: backgroundDeferrals,
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
}

module.exports = {
  PROTOCOL_VERSION,
  BUDGET_MS,
  INTERACTIVE_QUIET_WINDOW_MS,
  protocol,
  isLatencyTaxedIntervention,
  allowsInlineIntervention,
  assess,
  summarize,
  beginInteractive,
  beginBackground,
  prioritySnapshot,
  resetPriorityGateForTest,
};
