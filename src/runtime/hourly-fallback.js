'use strict';

const FALLBACK_COOLDOWN_MS = 55 * 60 * 1000;
const FAILED_FALLBACK_RETRY_MS = 2 * 60 * 1000;

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function latestFallbackCycle(cycles = []) {
  return (Array.isArray(cycles) ? cycles : [])
    .filter(cycle => cycle?.kind === 'fallback_hourly' && timestamp(cycle.started))
    .sort((left, right) => timestamp(right.started) - timestamp(left.started))[0] || null;
}

function hourlyFallbackDecision({ cycles = [], primaryHealth = null, lock = null,
  interactive = null, admission = null, inFlight = false, now = Date.now() } = {}) {
  const assessedAt = Number(now) || Date.now();
  const latest = latestFallbackCycle(cycles);
  const ageMs = latest ? Math.max(0, assessedAt - timestamp(latest.started)) : null;
  const cooldownMs = latest?.status === 'failed'
    ? FAILED_FALLBACK_RETRY_MS : FALLBACK_COOLDOWN_MS;
  const base = {
    protocol_version: 1,
    assessed_at: new Date(assessedAt).toISOString(),
    primary_state: primaryHealth?.state || 'unobserved',
    latest_fallback: latest ? {
      id: latest.id || null, status: latest.status || null, started: latest.started,
      finished: latest.finished || null,
    } : null,
    latest_fallback_age_ms: ageMs,
    cooldown_ms: cooldownMs,
  };
  const primaryFailed = primaryHealth?.latest?.status === 'failed';
  if (primaryHealth?.state === 'fresh' && !primaryFailed) {
    return { ...base, due: false, reason: 'primary_scheduler_within_grace' };
  }
  if (!['late', 'stale', 'unobserved'].includes(primaryHealth?.state) && !primaryFailed) {
    return { ...base, due: false, reason: 'primary_scheduler_state_not_actionable' };
  }
  if (inFlight) return { ...base, due: false, reason: 'fallback_in_flight' };
  if (lock?.locked) return { ...base, due: false, reason: 'operational_lock_active' };
  if (Number(interactive?.active_interactions) > 0 || Number(interactive?.quiet_remaining_ms) > 0) {
    return { ...base, due: false, reason: 'interactive_priority' };
  }
  if (admission?.allowed === false) {
    return { ...base, due: false, reason: admission.reason || 'resource_pressure' };
  }
  if (ageMs != null && ageMs < cooldownMs) {
    return { ...base, due: false, reason: 'fallback_cooldown' };
  }
  return { ...base, due: true, reason: primaryFailed
    ? 'primary_run_failed' : primaryHealth?.state === 'late'
      ? 'primary_scheduler_late' : 'primary_scheduler_stale' };
}

function probability(value, fallback = 0.1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function fallbackForecast({ cycleId, priorSnapshot = null, soma = null } = {}) {
  if (!String(cycleId || '').trim()) throw new Error('fallback forecast requires cycleId');
  const vitals = soma?.vitals || {};
  const errorProbability = vitals.errors10 == null ? 0.2 : probability(Number(vitals.errors10) > 0, 0.2);
  const warningProbability = vitals.warns10 == null ? 0.2 : probability(Number(vitals.warns10) > 0, 0.2);
  const backlogProbability = vitals.embedBacklog == null ? 0.1
    : probability(Number(vitals.embedBacklog) > 0, 0.1);
  const control = 0.82;
  const confidence = 0.72;
  const prior = priorSnapshot?.available && priorSnapshot?.prior
    ? priorSnapshot.prior : null;
  const protocolVersion = prior ? 7 : 4;
  return {
    protocol_version: protocolVersion,
    predicted_action_types: ['fallback_observation', 'slack_recovery', 'local_task_execution'],
    surprise_probability: 0.2,
    control_at_close: control,
    confidence,
    self_state_prediction: {
      attention_slot_types_at_close: ['fallback_observation'],
      appraisal_at_close: {
        valence: 0.55, arousal: 0.22, control, social_safety: 0.9, coherence: 0.86,
      },
      expected_action_count: 1,
      reentry_probability: 0.05,
    },
    metacognitive_prediction: {
      predicted_success_probability: confidence,
      predicted_largest_error_domain: 'action_types',
    },
    substrate_prediction: {
      error_probability: errorProbability,
      warning_probability: warningProbability,
      backup_probability: probability(Boolean(vitals.onBackup), 0),
      embedding_backlog_probability: backlogProbability,
      restart_probability: 0.05,
    },
    ...(prior ? {
      behavioral_self_prior_commitment: prior.content_commitment,
      behavioral_self_prior_use: {
        disposition: 'not_relevant', estimate_refs: [],
        rationale: 'This constrained recovery pass is selected by scheduler health, not by the historical action prior.',
      },
    } : {}),
    rationale: 'The primary hourly scheduler is late or stale, so Railway will perform one bounded coverage pass and may execute at most one explicitly queued task.',
    evidence: [
      { type: 'intelligence_cycle', id: String(cycleId) },
      ...(prior ? [{ type: 'behavioral_self_prior', id: prior.content_commitment }] : []),
    ],
  };
}

module.exports = {
  FALLBACK_COOLDOWN_MS,
  FAILED_FALLBACK_RETRY_MS,
  latestFallbackCycle,
  hourlyFallbackDecision,
  fallbackForecast,
};
