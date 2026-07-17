'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30 * 1000;

function createResearchStatusCache({ store, getDreams = () => [], getWants = () => [],
  now = () => new Date(), maxAgeMs = DEFAULT_MAX_AGE_MS,
  minRefreshIntervalMs = DEFAULT_MIN_REFRESH_INTERVAL_MS,
  workerPath = path.join(__dirname, 'research-status-worker.js'),
  createWorker = options => new Worker(workerPath, options) } = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.snapshotRevision !== 'function') {
    throw new Error('research status cache requires a snapshot-capable intelligence store');
  }
  let current = null;
  let inFlight = null;
  let activeWorker = null;
  let lastRefreshStartedAt = 0;

  function capture() {
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
      throw new Error('research status cache requires a valid clock');
    }
    const started = process.hrtime.bigint();
    const revision = store.snapshotRevision();
    const workerData = {
      revision,
      observed_at: observedAt.toISOString(),
      state: store.snapshot(),
      dreams: JSON.parse(JSON.stringify(getDreams() || [])),
      wants: JSON.parse(JSON.stringify(getWants() || [])),
      operational_environment: typeof store.operationalEnvironmentSnapshot === 'function'
        ? store.operationalEnvironmentSnapshot() : {},
    };
    return { workerData, capture_ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    const startedAt = Date.now();
    if (!force && current && startedAt - lastRefreshStartedAt < minRefreshIntervalMs) {
      return Promise.resolve(current);
    }
    lastRefreshStartedAt = startedAt;
    const { workerData, capture_ms } = capture();
    inFlight = new Promise((resolve, reject) => {
      const worker = createWorker({ workerData });
      activeWorker = worker;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        worker.removeAllListeners();
        if (activeWorker === worker) activeWorker = null;
        if (error) reject(error); else resolve(value);
      };
      worker.once('message', message => {
        if (message?.error) return finish(new Error(message.error));
        if (!message?.serialized || Number(message.revision) !== Number(workerData.revision)) {
          return finish(new Error('research status worker returned an invalid snapshot'));
        }
        current = {
          serialized: message.serialized,
          revision: workerData.revision,
          generated_at: message.generated_at,
          compute_ms: Number(message.compute_ms) || 0,
          capture_ms,
          completed_at_ms: Date.now(),
        };
        return finish(null, current);
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => {
        if (!settled) finish(new Error(code === 0
          ? 'research status worker exited before returning a snapshot'
          : `research status worker exited with code ${code}`));
      });
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function get() {
    const revision = store.snapshotRevision();
    const ageMs = current ? Date.now() - current.completed_at_ms : Infinity;
    const stale = Boolean(current && (current.revision !== revision || ageMs > maxAgeMs));
    if (!current) {
      const value = await refresh({ force: true });
      return { ...value, cache_state: 'cold', stale: value.revision !== store.snapshotRevision() };
    }
    if (stale && !inFlight && Date.now() - lastRefreshStartedAt >= minRefreshIntervalMs) {
      refresh().catch(() => {});
    }
    return { ...current, cache_state: stale ? 'stale' : 'fresh', stale };
  }

  function status() {
    return {
      ready: Boolean(current),
      in_flight: Boolean(inFlight),
      revision: current?.revision ?? null,
      current_revision: store.snapshotRevision(),
      generated_at: current?.generated_at || null,
      age_ms: current ? Math.max(0, Date.now() - current.completed_at_ms) : null,
      compute_ms: current?.compute_ms ?? null,
      capture_ms: current?.capture_ms ?? null,
    };
  }

  async function close() {
    const worker = activeWorker;
    if (worker && typeof worker.terminate === 'function') {
      try { await worker.terminate(); } catch { /* worker may have completed concurrently */ }
    }
    try { await inFlight; } catch { /* worker failure already surfaced to the caller */ }
  }

  return { get, refresh, status, close };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MIN_REFRESH_INTERVAL_MS,
  createResearchStatusCache,
};
