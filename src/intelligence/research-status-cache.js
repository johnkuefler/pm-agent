'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30 * 1000;

function createLowPriorityResearchProcess(workerPath, workerData) {
  const child = fork(workerPath, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
    execArgv: [],
    env: { ...process.env, NORA_RESEARCH_STATUS_CHILD: '1' },
  });
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch (error) {
    child.kill();
    throw new Error(`research status priority isolation unavailable: ${error.message}`);
  }
  child.research_isolation = 'low_priority_child_process';
  child.research_priority = os.getPriority(child.pid);
  child.terminate = async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill();
    return child.exitCode;
  };
  child.send(workerData, error => {
    if (error) child.emit('error', error);
  });
  return child;
}

function createResearchStatusCache({ store, getDreams = () => [], getWants = () => [],
  now = () => new Date(), maxAgeMs = DEFAULT_MAX_AGE_MS,
  minRefreshIntervalMs = DEFAULT_MIN_REFRESH_INTERVAL_MS,
  workerPath = path.join(__dirname, 'research-status-worker.js'),
  createWorker = options => createLowPriorityResearchProcess(workerPath, options.workerData),
  shouldDeferRefresh = () => false } = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.snapshotRevision !== 'function') {
    throw new Error('research status cache requires a snapshot-capable intelligence store');
  }
  let current = null;
  let inFlight = null;
  let activeWorker = null;
  let lastRefreshStartedAt = 0;
  let preemptions = 0;
  let lastPreemption = null;
  const workerPreemptions = new WeakMap();

  function deferredError() {
    const error = new Error('research status refresh deferred for interactive priority');
    error.code = 'interactive_priority_deferred';
    return error;
  }

  function capture() {
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
      throw new Error('research status cache requires a valid clock');
    }
    const started = process.hrtime.bigint();
    const revision = store.snapshotRevision();
    const workerData = {
      revision,
      experimental_access_fingerprint: typeof store.experimentalAccessFingerprint === 'function'
        ? store.experimentalAccessFingerprint() : null,
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
    if (shouldDeferRefresh()) {
      if (current) return Promise.resolve(current);
      return Promise.reject(deferredError());
    }
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
        if (!message?.serialized || !message?.self_model_serialized
          || Number(message.revision) !== Number(workerData.revision)) {
          return finish(new Error('research status worker returned an invalid snapshot'));
        }
        current = {
          serialized: message.serialized,
          self_model_serialized: message.self_model_serialized,
          experimental_access_fingerprint: workerData.experimental_access_fingerprint,
          revision: workerData.revision,
          generated_at: message.generated_at,
          compute_ms: Number(message.compute_ms) || 0,
          capture_ms,
          isolation: worker.research_isolation || 'injected_worker',
          priority: Number.isFinite(Number(worker.research_priority))
            ? Number(worker.research_priority) : null,
          completed_at_ms: Date.now(),
        };
        return finish(null, current);
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => {
        const preemptedBy = workerPreemptions.get(worker);
        if (!settled && preemptedBy) {
          const error = new Error(`research status worker preempted by ${preemptedBy}`);
          error.code = 'interactive_preemption';
          return finish(error);
        }
        if (!settled) finish(new Error(code === 0
          ? 'research status worker exited before returning a snapshot'
          : `research status worker exited with code ${code}`));
      });
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function get({ requireCurrentExperimentalAccess = false, requireCurrentRevision = false } = {}) {
    const revision = store.snapshotRevision();
    const accessFingerprint = typeof store.experimentalAccessFingerprint === 'function'
      ? store.experimentalAccessFingerprint() : null;
    const accessChanged = Boolean(current && requireCurrentExperimentalAccess
      && current.experimental_access_fingerprint !== accessFingerprint);
    const revisionChanged = Boolean(current && requireCurrentRevision && current.revision !== revision);
    if (accessChanged || revisionChanged) {
      const value = await refresh({ force: true });
      const latestFingerprint = typeof store.experimentalAccessFingerprint === 'function'
        ? store.experimentalAccessFingerprint() : null;
      if (requireCurrentExperimentalAccess
        && value.experimental_access_fingerprint !== latestFingerprint) {
        throw new Error('experimental access state changed during snapshot generation');
      }
      if (requireCurrentRevision && value.revision !== store.snapshotRevision()) {
        throw new Error('intelligence state changed during snapshot generation');
      }
      return { ...value, cache_state: accessChanged ? 'seal-refresh' : 'revision-refresh', stale: false };
    }
    const ageMs = current ? Date.now() - current.completed_at_ms : Infinity;
    const stale = Boolean(current && (current.revision !== revision || ageMs > maxAgeMs));
    if (!current) {
      const value = await refresh({ force: true });
      const coldStale = value.revision !== store.snapshotRevision();
      if (requireCurrentRevision && coldStale) {
        throw new Error('intelligence state changed during snapshot generation');
      }
      return { ...value, cache_state: 'cold', stale: coldStale };
    }
    if (stale && !inFlight && !shouldDeferRefresh()
      && Date.now() - lastRefreshStartedAt >= minRefreshIntervalMs) {
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
      isolation: current?.isolation || null,
      priority: current?.priority ?? null,
      experimental_access_current: current ? current.experimental_access_fingerprint === (
        typeof store.experimentalAccessFingerprint === 'function'
          ? store.experimentalAccessFingerprint() : null) : null,
      preemptions,
      last_preemption: lastPreemption,
    };
  }

  function preempt(reason = 'interactive') {
    const worker = activeWorker;
    if (!worker) return false;
    const boundedReason = String(reason || 'interactive').slice(0, 80);
    workerPreemptions.set(worker, boundedReason);
    preemptions += 1;
    lastPreemption = { reason: boundedReason, at: new Date().toISOString() };
    worker.terminate().catch(() => {});
    return true;
  }

  async function close() {
    const worker = activeWorker;
    if (worker && typeof worker.terminate === 'function') {
      try { await worker.terminate(); } catch { /* worker may have completed concurrently */ }
    }
    try { await inFlight; } catch { /* worker failure already surfaced to the caller */ }
  }

  return { get, refresh, status, preempt, close };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MIN_REFRESH_INTERVAL_MS,
  createLowPriorityResearchProcess,
  createResearchStatusCache,
};
