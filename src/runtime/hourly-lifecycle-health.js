'use strict';

const EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
// The Railway scheduler checks every five minutes. A fifteen-minute grace period absorbs normal
// trigger jitter while still covering one missed external run well before a second hour is lost.
const LATE_AFTER_MS = 75 * 60 * 1000;
const STALE_AFTER_MS = 130 * 60 * 1000;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hourlyLifecycleHealth(cycles = [], { now = Date.now() } = {}) {
  const assessedAt = Number(now) || Date.now();
  const cycleList = Array.isArray(cycles) ? cycles : [];
  const fallback = (Array.isArray(cycles) ? cycles : [])
    .filter(cycle => cycle?.kind === 'fallback_hourly' && timestamp(cycle.started))
    .sort((left, right) => timestamp(right.started) - timestamp(left.started));
  const latestFallback = fallback[0] || null;
  const fallbackAgeMs = latestFallback
    ? Math.max(0, assessedAt - timestamp(latestFallback.started)) : null;
  const fallbackFresh = fallbackAgeMs != null && fallbackAgeMs <= LATE_AFTER_MS
    && latestFallback.status !== 'failed';
  const fallbackProjection = {
    active: fallbackFresh,
    latest: latestFallback ? {
      id: latestFallback.id || null,
      status: latestFallback.status || null,
      started: latestFallback.started,
      finished: latestFallback.finished || null,
      failure_reason: latestFallback.recovery?.reason || latestFallback.failure_reason || null,
    } : null,
    age_ms: fallbackAgeMs,
  };
  const hourly = cycleList
    .filter(cycle => cycle?.kind === 'hourly' && timestamp(cycle.started))
    .sort((left, right) => timestamp(right.started) - timestamp(left.started));
  const latestExternal = hourly[0] || null;
  const externalAgeMs = latestExternal
    ? Math.max(0, assessedAt - timestamp(latestExternal.started)) : null;
  const externalState = externalAgeMs == null ? 'unobserved'
    : externalAgeMs > STALE_AFTER_MS ? 'stale'
      : externalAgeMs > LATE_AFTER_MS ? 'late' : 'fresh';
  let externalConsecutiveFailures = 0;
  for (const cycle of hourly) {
    if (cycle.status !== 'failed') break;
    externalConsecutiveFailures += 1;
  }
  const externalPrimary = {
    state: externalState,
    healthy: externalState === 'fresh' && latestExternal?.status !== 'failed',
    latest: latestExternal ? {
      id: latestExternal.id || null,
      status: latestExternal.status || null,
      started: latestExternal.started,
      finished: latestExternal.finished || null,
      failure_reason: latestExternal.recovery?.reason
        || latestExternal.failure_reason || null,
    } : null,
    age_ms: externalAgeMs,
    estimated_missed_runs: externalAgeMs == null
      ? null : Math.max(0, Math.floor(externalAgeMs / EXPECTED_INTERVAL_MS)),
    consecutive_failures: externalConsecutiveFailures,
  };
  const operational = [...hourly, ...fallback]
    .sort((left, right) => timestamp(right.started) - timestamp(left.started));
  const latest = operational[0] || null;
  const ageMs = latest ? Math.max(0, assessedAt - timestamp(latest.started)) : null;
  const state = ageMs == null ? 'unobserved'
    : ageMs > STALE_AFTER_MS ? 'stale'
      : ageMs > LATE_AFTER_MS ? 'late' : 'fresh';
  const recent = operational.filter(cycle =>
    assessedAt - timestamp(cycle.started) <= RECENT_WINDOW_MS);
  let consecutiveFailures = 0;
  for (const cycle of operational) {
    if (cycle.status !== 'failed') break;
    consecutiveFailures += 1;
  }
  const latestFailed = latest?.status === 'failed';
  const nativeEffective = latest?.kind === 'fallback_hourly';
  const triggerSource = nativeEffective
    ? 'railway_native_scheduler' : 'external_cowork_scheduler';
  const healthy = state === 'fresh' && !latestFailed;
  const estimatedMissedRuns = ageMs == null
    ? null : Math.max(0, Math.floor(ageMs / EXPECTED_INTERVAL_MS));
  return {
    protocol_version: 2,
    state,
    healthy,
    requires_external_attention: state === 'stale' || state === 'unobserved'
      || consecutiveFailures >= 2,
    trigger_source: triggerSource,
    expected_interval_ms: EXPECTED_INTERVAL_MS,
    late_after_ms: LATE_AFTER_MS,
    stale_after_ms: STALE_AFTER_MS,
    assessed_at: new Date(assessedAt).toISOString(),
    latest: latest ? {
      id: latest.id || null,
      status: latest.status || null,
      started: latest.started,
      finished: latest.finished || null,
      failure_reason: latest.recovery?.reason || latest.failure_reason || null,
      kind: latest.kind || null,
    } : null,
    external_primary: externalPrimary,
    fallback: fallbackProjection,
    operational_coverage: healthy
      ? nativeEffective ? 'native_primary' : 'external_primary'
      : 'uncovered',
    age_ms: ageMs,
    estimated_missed_runs: estimatedMissedRuns,
    recent_window_hours: RECENT_WINDOW_MS / 3600000,
    recent_runs: recent.length,
    recent_failures: recent.filter(cycle => cycle.status === 'failed').length,
    consecutive_failures: consecutiveFailures,
    message: state === 'unobserved'
      ? 'No durable hourly lifecycle has been observed.'
      : state === 'stale'
        ? `No operational hourly lifecycle has opened for about ${Math.round(ageMs / 60000)} minutes.`
      : state === 'late'
        ? 'The next operational hourly lifecycle is later than its normal grace window.'
        : latestFailed
          ? 'The latest operational hourly lifecycle failed, but scheduling remains within its cadence window.'
          : nativeEffective
            ? 'Railway native hourly coverage is arriving within its expected cadence window.'
            : 'The external hourly lifecycle is arriving within its expected cadence window.',
  };
}

module.exports = { hourlyLifecycleHealth, EXPECTED_INTERVAL_MS, LATE_AFTER_MS,
  STALE_AFTER_MS, RECENT_WINDOW_MS };
