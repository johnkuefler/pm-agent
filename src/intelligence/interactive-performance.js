'use strict';

const PROTOCOL_VERSION = 1;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BUDGET_MS = Object.freeze({
  slack: 8000,
  'zoom-chat': 6000,
  realtime: 2000,
});

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
  prediction: 'Human-facing cognition can stay within channel-specific first-delivery budgets when extra provider-round research is excluded from interactive paths.',
  intervention: 'Slack, Zoom chat, and realtime voice permit context-only cognition inline but quarantine any study arm that adds provider rounds or materially expands generation.',
  controls: 'Scheduled and explicitly non-interactive study surfaces retain access to the quarantined interventions; ordinary tool use remains available when the work itself requires it.',
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

module.exports = {
  PROTOCOL_VERSION,
  BUDGET_MS,
  protocol,
  isLatencyTaxedIntervention,
  allowsInlineIntervention,
  assess,
  summarize,
};
