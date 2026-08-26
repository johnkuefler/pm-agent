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
  // Top-level lifecycle health describes whichever operational scheduler most recently covered
  // the hour. Native scheduling must still inspect the legacy external source independently,
  // otherwise its own successful run would suppress every future native run.
  const externalPrimary = primaryHealth?.external_primary || primaryHealth || {};
  const base = {
    protocol_version: 1,
    assessed_at: new Date(assessedAt).toISOString(),
    primary_state: externalPrimary.state || 'unobserved',
    latest_fallback: latest ? {
      id: latest.id || null, status: latest.status || null, started: latest.started,
      finished: latest.finished || null,
    } : null,
    latest_fallback_age_ms: ageMs,
    cooldown_ms: cooldownMs,
  };
  const primaryFailed = externalPrimary.latest?.status === 'failed';
  if (externalPrimary.state === 'fresh' && !primaryFailed) {
    return { ...base, due: false, reason: 'primary_scheduler_within_grace' };
  }
  if (!['late', 'stale', 'unobserved'].includes(externalPrimary.state) && !primaryFailed) {
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
    ? 'primary_run_failed' : externalPrimary.state === 'late'
      ? 'primary_scheduler_late' : 'primary_scheduler_stale' };
}

module.exports = {
  FALLBACK_COOLDOWN_MS,
  FAILED_FALLBACK_RETRY_MS,
  latestFallbackCycle,
  hourlyFallbackDecision,
};
