'use strict';

const EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
const LATE_AFTER_MS = 90 * 60 * 1000;
const STALE_AFTER_MS = 150 * 60 * 1000;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hourlyLifecycleHealth(cycles = [], { now = Date.now() } = {}) {
  const assessedAt = Number(now) || Date.now();
  const hourly = (Array.isArray(cycles) ? cycles : [])
    .filter(cycle => cycle?.kind === 'hourly' && timestamp(cycle.started))
    .sort((left, right) => timestamp(right.started) - timestamp(left.started));
  const latest = hourly[0] || null;
  if (!latest) {
    return {
      protocol_version: 1,
      state: 'unobserved',
      healthy: false,
      requires_external_attention: true,
      trigger_source: 'external_cowork_scheduler',
      expected_interval_ms: EXPECTED_INTERVAL_MS,
      late_after_ms: LATE_AFTER_MS,
      stale_after_ms: STALE_AFTER_MS,
      assessed_at: new Date(assessedAt).toISOString(),
      latest: null,
      age_ms: null,
      estimated_missed_runs: null,
      message: 'No durable hourly lifecycle has been observed.',
    };
  }

  const ageMs = Math.max(0, assessedAt - timestamp(latest.started));
  const state = ageMs > STALE_AFTER_MS ? 'stale'
    : ageMs > LATE_AFTER_MS ? 'late' : 'fresh';
  const recent = hourly.filter(cycle => assessedAt - timestamp(cycle.started) <= RECENT_WINDOW_MS);
  let consecutiveFailures = 0;
  for (const cycle of hourly) {
    if (cycle.status !== 'failed') break;
    consecutiveFailures += 1;
  }
  const latestFailed = latest.status === 'failed';
  const estimatedMissedRuns = Math.max(0, Math.floor(ageMs / EXPECTED_INTERVAL_MS));
  return {
    protocol_version: 1,
    state,
    healthy: state === 'fresh' && !latestFailed,
    requires_external_attention: state === 'stale' || consecutiveFailures >= 2,
    trigger_source: 'external_cowork_scheduler',
    expected_interval_ms: EXPECTED_INTERVAL_MS,
    late_after_ms: LATE_AFTER_MS,
    stale_after_ms: STALE_AFTER_MS,
    assessed_at: new Date(assessedAt).toISOString(),
    latest: {
      id: latest.id || null,
      status: latest.status || null,
      started: latest.started,
      finished: latest.finished || null,
      failure_reason: latest.recovery?.reason || latest.failure_reason || null,
    },
    age_ms: ageMs,
    estimated_missed_runs: estimatedMissedRuns,
    recent_window_hours: RECENT_WINDOW_MS / 3600000,
    recent_runs: recent.length,
    recent_failures: recent.filter(cycle => cycle.status === 'failed').length,
    consecutive_failures: consecutiveFailures,
    message: state === 'stale'
      ? `The external hourly runner has not opened a cycle for about ${Math.round(ageMs / 60000)} minutes.`
      : state === 'late'
        ? 'The next hourly lifecycle is later than its normal grace window.'
        : latestFailed
          ? 'The latest hourly lifecycle failed, but the scheduler is still within its expected cadence window.'
          : 'The hourly lifecycle is arriving within its expected cadence window.',
  };
}

module.exports = { hourlyLifecycleHealth, EXPECTED_INTERVAL_MS, LATE_AFTER_MS,
  STALE_AFTER_MS, RECENT_WINDOW_MS };
