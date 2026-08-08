'use strict';

const crypto = require('crypto');

const ELIGIBLE_KINDS = new Set([
  'requested_delivery',
  'material_delivery',
  'new_risk',
  'decision_needed',
  'delivery_incident',
  'commitment_change',
]);

const PRIVATE_KINDS = new Set([
  'quiet_check',
  'routine_sync',
  'memory_maintenance',
  'idle_research',
  'internal_reflection',
  'prediction_scoring',
  'bookkeeping',
  'watchlist',
  'stale_metadata',
]);

function clean(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function clamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    type: clean(item?.type, 80),
    ref: clean(item?.ref || item?.id || item?.url, 1000),
  })).filter(item => item.type && item.ref).slice(0, 20);
}

function normalizeSignal(value = {}) {
  return {
    kind: clean(value.kind, 80).toLowerCase(),
    description: clean(value.description, 1200),
    severity: clean(value.severity, 40).toLowerCase(),
    materiality: clamp(value.materiality),
    new_information: Boolean(value.new_information),
    requested_by_recipient: Boolean(value.requested_by_recipient),
    recipient_needs_to_know: Boolean(value.recipient_needs_to_know),
    recipient_action: clean(value.recipient_action, 800),
    needed_by: value.needed_by ? clean(value.needed_by, 80) : '',
    evidence: normalizeEvidence(value.evidence),
  };
}

function signalEligibility(signal) {
  if (PRIVATE_KINDS.has(signal.kind)) return { eligible: false, reason: `${signal.kind} stays private` };
  if (!ELIGIBLE_KINDS.has(signal.kind)) return { eligible: false, reason: 'signal kind is not summary-worthy' };
  if (!signal.evidence.length) return { eligible: false, reason: 'signal has no stable evidence' };

  if (signal.kind === 'requested_delivery') {
    return signal.requested_by_recipient && signal.materiality >= 0.5
      ? { eligible: true, reason: 'verified requested work was delivered' }
      : { eligible: false, reason: 'requested delivery is not bound to a material recipient request' };
  }
  if (signal.kind === 'material_delivery') {
    return signal.materiality >= 0.75 && signal.recipient_needs_to_know
      ? { eligible: true, reason: 'verified external delivery materially changed the project' }
      : { eligible: false, reason: 'delivery does not require recipient awareness' };
  }
  if (signal.kind === 'new_risk') {
    return signal.new_information && ['high', 'critical'].includes(signal.severity) && Boolean(signal.recipient_action)
      ? { eligible: true, reason: 'a new high-impact risk needs a specific recipient action' }
      : { eligible: false, reason: 'risk can remain in the private control picture' };
  }
  if (signal.kind === 'decision_needed') {
    return signal.new_information && Boolean(signal.recipient_action)
      ? { eligible: true, reason: 'a new bounded decision is needed' }
      : { eligible: false, reason: 'no new bounded decision is needed' };
  }
  if (signal.kind === 'delivery_incident') {
    return signal.materiality >= 0.75 && Boolean(signal.recipient_action)
      ? { eligible: true, reason: 'a delivery-blocking incident needs recipient help' }
      : { eligible: false, reason: 'incident is recoverable without interrupting the recipient' };
  }
  return signal.new_information && Boolean(signal.recipient_action)
    ? { eligible: true, reason: 'a commitment must be renegotiated with the recipient' }
    : { eligible: false, reason: 'commitment state does not require recipient action' };
}

function evaluateRunSummary(input = {}) {
  const recipient = clean(input.recipient, 240);
  const explicitlyRequested = Boolean(input.explicitly_requested);
  const signals = Array.isArray(input.signals) ? input.signals.map(normalizeSignal).slice(0, 30) : [];
  const evaluated = signals.map(signal => ({ signal, ...signalEligibility(signal) }));
  const eligible = evaluated.filter(item => item.eligible).slice(0, 3);
  const privateWork = evaluated.filter(item => PRIVATE_KINDS.has(item.signal.kind)).length;

  if (explicitlyRequested) {
    return {
      allowed: true,
      classification: 'requested_summary',
      uses_human_budget: false,
      recipient,
      selected_signals: eligible.map(item => item.signal),
      reasons: ['the recipient explicitly requested a summary'],
      private_signal_count: privateWork,
    };
  }
  if (!recipient) {
    return {
      allowed: false,
      classification: 'suppressed',
      uses_human_budget: false,
      recipient: '',
      selected_signals: [],
      reasons: ['an unsolicited summary requires a named recipient'],
      private_signal_count: privateWork,
    };
  }
  if (!eligible.length) {
    const reasons = [...new Set(evaluated.map(item => item.reason))];
    return {
      allowed: false,
      classification: 'suppressed',
      uses_human_budget: false,
      recipient,
      selected_signals: [],
      reasons: reasons.length ? reasons : ['the run produced no material recipient-facing change'],
      private_signal_count: privateWork,
    };
  }

  const requestedOnly = eligible.every(item => item.signal.kind === 'requested_delivery'
    && item.signal.requested_by_recipient);
  const classification = requestedOnly ? 'requested_delivery'
    : eligible.some(item => ['new_risk', 'delivery_incident', 'commitment_change'].includes(item.signal.kind))
      ? 'escalation'
      : eligible.some(item => item.signal.kind === 'decision_needed') ? 'decision' : 'material_delivery';
  return {
    allowed: true,
    classification,
    uses_human_budget: !requestedOnly,
    recipient,
    selected_signals: eligible.map(item => item.signal),
    reasons: eligible.map(item => item.reason),
    private_signal_count: privateWork,
  };
}

function recordRunSummaryEvaluation(ledger = {}, input = {}, { now = new Date() } = {}) {
  const evaluation = evaluateRunSummary(input);
  const evaluatedAt = new Date(now).toISOString();
  const receipt = {
    id: `pm-summary-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    evaluated_at: evaluatedAt,
    allowed: evaluation.allowed,
    classification: evaluation.classification,
    recipient: evaluation.recipient,
    uses_human_budget: evaluation.uses_human_budget,
    selected_signal_count: evaluation.selected_signals.length,
    selected_signal_kinds: evaluation.selected_signals.map(item => item.kind),
    submitted_signal_kinds: Array.isArray(input.signals)
      ? input.signals.map(item => clean(item?.kind, 80).toLowerCase()).filter(Boolean).slice(0, 30) : [],
    private_signal_count: evaluation.private_signal_count,
    reasons: evaluation.reasons.slice(0, 10),
  };
  const current = {
    ...ledger,
    summary_evaluations: [...(Array.isArray(ledger.summary_evaluations)
      ? ledger.summary_evaluations : []), receipt].slice(-5000),
  };
  return { ledger: current, evaluation: { ...evaluation, receipt } };
}

module.exports = { ELIGIBLE_KINDS, PRIVATE_KINDS, evaluateRunSummary, recordRunSummaryEvaluation };
