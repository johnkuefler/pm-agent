'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30 * 1000;
const DEFAULT_PROJECTION_FAILURE_RETRY_MS = 30 * 1000;
const DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS = 30 * 60 * 1000;
const DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS = 3 * 60 * 1000;

const PERSISTED_PROJECTION_PROTOCOL_VERSION = 2;

function projectionBuildIdentity(env = process.env) {
  return String(env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA
    || 'unversioned-local').slice(0, 200);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function configureCpuDutyCycle(child, env = process.env) {
  if (process.platform === 'win32') {
    return { mode: 'priority_only_windows', burst_ms: null, period_ms: null, release: () => {} };
  }
  const periodMs = boundedNumber(env.NORA_RESEARCH_CPU_PERIOD_MS, 200, 100, 1000);
  const burstMs = Math.min(periodMs / 2,
    boundedNumber(env.NORA_RESEARCH_CPU_BURST_MS, 40, 5, 50));
  let timer = null;
  let released = false;
  let stopped = false;
  const schedule = (fn, delay) => {
    timer = setTimeout(fn, delay);
    timer.unref?.();
  };
  const resume = () => {
    if (released || child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGCONT'); stopped = false; } catch { return; }
    schedule(stop, burstMs);
  };
  const stop = () => {
    if (released || child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGSTOP'); stopped = true; } catch { return; }
    schedule(resume, periodMs - burstMs);
  };
  try {
    child.kill('SIGSTOP');
    stopped = true;
    schedule(resume, periodMs - burstMs);
  } catch (error) {
    throw new Error(`research status CPU duty-cycle isolation unavailable: ${error.message}`);
  }
  return {
    mode: 'low_priority_duty_cycle', burst_ms: burstMs, period_ms: periodMs,
    release: () => {
      released = true;
      if (timer) clearTimeout(timer);
      if (stopped && child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGCONT'); } catch { /* process may have exited */ }
      }
    },
  };
}

function createLowPriorityResearchProcess(workerPath, workerData, { cpuDutyCycle = false } = {}) {
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
  let cpuBudget = { mode: 'priority_only', burst_ms: null, period_ms: null, release: () => {} };
  if (cpuDutyCycle) {
    try { cpuBudget = configureCpuDutyCycle(child); }
    catch (error) { child.kill(); throw error; }
  }
  child.research_isolation = 'low_priority_child_process';
  child.research_priority = os.getPriority(child.pid);
  child.research_cpu_budget = {
    mode: cpuBudget.mode, burst_ms: cpuBudget.burst_ms, period_ms: cpuBudget.period_ms,
  };
  child.research_release_cpu_budget = cpuBudget.release;
  child.terminate = async () => {
    child.research_release_cpu_budget?.();
    if (child.exitCode == null && child.signalCode == null) child.kill();
    return child.exitCode;
  };
  child.send(workerData, error => {
    if (error) child.emit('error', error);
  });
  return child;
}

function createSerializedResearchWorkerFactory({
  maximumConcurrent = 1,
  workerPath = path.join(__dirname, 'research-status-worker.js'),
  createWorker = options => createLowPriorityResearchProcess(workerPath, options.workerData,
    { cpuDutyCycle: true }),
} = {}) {
  const maximum = Math.max(1, Math.min(2, Number(maximumConcurrent) || 1));
  const queue = [];
  let active = 0;
  let started = 0;
  let completed = 0;
  let cancelledBeforeStart = 0;

  function pump() {
    while (active < maximum && queue.length) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      active += 1;
      started += 1;
      let child;
      let settled = false;
      const settle = (event, value) => {
        if (settled) return;
        settled = true;
        active = Math.max(0, active - 1);
        completed += 1;
        entry.proxy.emit(event, value);
        setImmediate(pump);
      };
      try {
        child = createWorker(entry.options);
        entry.child = child;
        entry.proxy.research_isolation = child.research_isolation || 'serialized_projection_worker';
        entry.proxy.research_priority = child.research_priority;
        entry.proxy.research_cpu_budget = child.research_cpu_budget || null;
        entry.proxy.research_release_cpu_budget = () => child.research_release_cpu_budget?.();
        child.once('message', message => settle('message', message));
        child.once('error', error => settle('error', error));
        child.once('exit', code => settle('exit', code));
      } catch (error) {
        settle('error', error);
      }
    }
  }

  function factory(options) {
    const proxy = new EventEmitter();
    const entry = { options, proxy, child: null, cancelled: false };
    proxy.research_isolation = 'serialized_projection_queue';
    proxy.research_priority = null;
    proxy.research_cpu_budget = { mode: 'serialized_low_priority_queue' };
    proxy.research_release_cpu_budget = () => entry.child?.research_release_cpu_budget?.();
    proxy.terminate = async () => {
      if (entry.child) return entry.child.terminate?.();
      if (!entry.cancelled) {
        entry.cancelled = true;
        cancelledBeforeStart += 1;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        setImmediate(() => proxy.emit('exit', 1));
      }
      return 1;
    };
    queue.push(entry);
    setImmediate(pump);
    return proxy;
  }
  factory.status = () => ({
    protocol_version: 1,
    maximum_concurrent: maximum,
    active,
    queued: queue.filter(entry => !entry.cancelled).length,
    started,
    completed,
    cancelled_before_start: cancelledBeforeStart,
  });
  return factory;
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
        worker.research_release_cpu_budget?.();
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
          cpu_budget: worker.research_cpu_budget || null,
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
      cpu_budget: current?.cpu_budget || null,
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

function projectionEnvelopePayload(envelope) {
  return {
    protocol_version: envelope.protocol_version,
    build_identity: envelope.build_identity,
    projection: envelope.projection,
    serialized: envelope.serialized,
    source_revision: envelope.source_revision,
    source_access_fingerprint: envelope.source_access_fingerprint,
    generated_at: envelope.generated_at,
    completed_at: envelope.completed_at,
  };
}

function projectionCommitment(envelope) {
  return crypto.createHash('sha256').update(JSON.stringify(projectionEnvelopePayload(envelope))).digest('hex');
}

function createPersistedProjectionEnvelope(snapshot, projection) {
  const serialized = String(snapshot?.serialized || '');
  if (!['research_status', 'self_model', 'cognition'].includes(projection) || !serialized) {
    throw new Error('persisted research projection requires a supported projection and serialized value');
  }
  JSON.parse(serialized);
  const completedAt = snapshot.completed_at || new Date(snapshot.completed_at_ms || Date.now()).toISOString();
  if (!Number.isFinite(new Date(completedAt).getTime())) {
    throw new Error('persisted research projection requires a valid completion time');
  }
  const envelope = {
    protocol_version: PERSISTED_PROJECTION_PROTOCOL_VERSION,
    build_identity: snapshot.build_identity || projectionBuildIdentity(),
    projection,
    serialized,
    source_revision: Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : null,
    source_access_fingerprint: snapshot.experimental_access_fingerprint || null,
    generated_at: snapshot.generated_at || completedAt,
    completed_at: completedAt,
  };
  envelope.content_commitment = projectionCommitment(envelope);
  return envelope;
}

function verifyPersistedProjectionEnvelope(envelope, projection,
  { requireCurrentBuild = true, allowLegacyProtocol = false } = {}) {
  const protocolValid = envelope?.protocol_version === PERSISTED_PROJECTION_PROTOCOL_VERSION
    || (allowLegacyProtocol && envelope?.protocol_version === 1);
  const buildValid = !requireCurrentBuild
    || envelope?.build_identity === projectionBuildIdentity();
  if (!envelope || !protocolValid || !buildValid
    || envelope.projection !== projection || typeof envelope.serialized !== 'string'
    || envelope.content_commitment !== projectionCommitment(envelope)) return false;
  try { JSON.parse(envelope.serialized); }
  catch { return false; }
  return Number.isFinite(new Date(envelope.completed_at).getTime());
}

function createResearchProjectionCache({ projection, store, getDreams = () => [], getWants = () => [],
  getPredictions = () => [],
  now = () => new Date(), maxAgeMs = 60 * 60 * 1000,
  minRefreshIntervalMs = 15 * 60 * 1000,
  failureRetryMs = DEFAULT_PROJECTION_FAILURE_RETRY_MS,
  maxFailureRetryMs = DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS,
  refreshTimeoutMs = DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS,
  workerPath = path.join(__dirname, 'research-status-worker.js'),
  createWorker = options => createLowPriorityResearchProcess(workerPath, options.workerData,
    { cpuDutyCycle: true }),
  shouldDeferRefresh = () => false, loadPersisted = async () => null,
  savePersisted = async () => {} } = {}) {
  if (!['research_status', 'self_model', 'cognition'].includes(projection)) {
    throw new Error('research projection cache requires research_status, self_model, or cognition');
  }
  if (!store || typeof store.snapshot !== 'function' || typeof store.snapshotRevision !== 'function') {
    throw new Error('research projection cache requires a snapshot-capable intelligence store');
  }
  const serializedField = projection === 'self_model' ? 'self_model_serialized' : 'serialized';
  let current = null;
  let inFlight = null;
  let activeWorker = null;
  let hydrationPromise = null;
  let hydrationAttempted = false;
  let lastRefreshStartedAt = 0;
  let lastRefreshSucceededAt = 0;
  let lastRefreshFailedAt = 0;
  let nextRefreshEligibleAt = 0;
  let consecutiveFailures = 0;
  let lastRefreshError = null;
  let preemptions = 0;
  let lastPreemption = null;
  let lastPersistenceError = null;
  const persistenceWrites = new Set();
  const workerPreemptions = new WeakMap();

  function deferredError() {
    const error = new Error(`${projection} refresh deferred for interactive priority`);
    error.code = 'interactive_priority_deferred';
    return error;
  }

  async function hydrate() {
    if (hydrationAttempted) return current;
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = Promise.resolve().then(loadPersisted).then(envelope => {
      const currentBuildVerified = verifyPersistedProjectionEnvelope(envelope, projection);
      const staleBuildVerified = !currentBuildVerified && verifyPersistedProjectionEnvelope(
        envelope, projection, { requireCurrentBuild: false, allowLegacyProtocol: true });
      const currentAccessFingerprint = typeof store.experimentalAccessFingerprint === 'function'
        ? store.experimentalAccessFingerprint() : null;
      const staleBuildAccessSafe = staleBuildVerified
        && envelope.source_access_fingerprint === currentAccessFingerprint;
      if (!currentBuildVerified && !staleBuildAccessSafe) return null;
      const completedAtMs = new Date(envelope.completed_at).getTime();
      current = {
        serialized: envelope.serialized,
        build_identity: envelope.build_identity || null,
        build_stale: !currentBuildVerified,
        experimental_access_fingerprint: envelope.source_access_fingerprint,
        revision: envelope.source_revision,
        generated_at: envelope.generated_at,
        compute_ms: 0,
        capture_ms: 0,
        isolation: 'persisted_verified_projection',
        priority: null,
        cpu_budget: { mode: 'no_compute_restart_hydration', burst_ms: 0, period_ms: 0 },
        completed_at_ms: completedAtMs,
        persisted: true,
      };
      return current;
    }).catch(error => {
      lastPersistenceError = `hydrate: ${String(error.message || error).slice(0, 300)}`;
      return null;
    }).finally(() => {
      hydrationAttempted = true;
      hydrationPromise = null;
    });
    return hydrationPromise;
  }

  function capture() {
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
      throw new Error('research projection cache requires a valid clock');
    }
    const started = process.hrtime.bigint();
    const revision = store.snapshotRevision();
    const workerData = {
      projection,
      revision,
      experimental_access_fingerprint: typeof store.experimentalAccessFingerprint === 'function'
        ? store.experimentalAccessFingerprint() : null,
      observed_at: observedAt.toISOString(),
      state: store.snapshot(),
      dreams: JSON.parse(JSON.stringify(getDreams() || [])),
      wants: JSON.parse(JSON.stringify(getWants() || [])),
      predictions: projection === 'cognition'
        ? JSON.parse(JSON.stringify(getPredictions() || [])) : [],
      operational_environment: typeof store.operationalEnvironmentSnapshot === 'function'
        ? store.operationalEnvironmentSnapshot() : {},
    };
    return { workerData, capture_ms: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  async function refresh({ force = false } = {}) {
    await hydrate();
    if (inFlight) return inFlight;
    if (shouldDeferRefresh()) throw deferredError();
    const startedAt = Date.now();
    if (consecutiveFailures > 0 && startedAt < nextRefreshEligibleAt) {
      const error = new Error(`${projection} refresh is in failure backoff`);
      error.code = 'projection_failure_backoff';
      error.retry_after_ms = nextRefreshEligibleAt - startedAt;
      throw error;
    }
    if (!force && current && startedAt < nextRefreshEligibleAt) return current;
    lastRefreshStartedAt = startedAt;
    const { workerData, capture_ms } = capture();
    const operation = new Promise((resolve, reject) => {
      const worker = createWorker({ workerData });
      activeWorker = worker;
      let settled = false;
      const timeout = setTimeout(() => {
        const error = new Error(`${projection} worker exceeded ${refreshTimeoutMs}ms refresh timeout`);
        error.code = 'projection_refresh_timeout';
        worker.terminate?.().catch?.(() => {});
        finish(error);
      }, Math.max(100, Number(refreshTimeoutMs) || DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS));
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.research_release_cpu_budget?.();
        worker.removeAllListeners();
        if (activeWorker === worker) activeWorker = null;
        if (error) reject(error); else resolve(value);
      };
      worker.once('message', message => {
        if (message?.error) return finish(new Error(message.error));
        if (message?.projection !== projection || !message?.[serializedField]
          || Number(message.revision) !== Number(workerData.revision)) {
          return finish(new Error('research projection worker returned an invalid snapshot'));
        }
        current = {
          serialized: message[serializedField],
          build_identity: projectionBuildIdentity(),
          build_stale: false,
          experimental_access_fingerprint: workerData.experimental_access_fingerprint,
          revision: workerData.revision,
          generated_at: message.generated_at,
          compute_ms: Number(message.compute_ms) || 0,
          capture_ms,
          isolation: worker.research_isolation || 'injected_worker',
          priority: Number.isFinite(Number(worker.research_priority)) ? Number(worker.research_priority) : null,
          cpu_budget: worker.research_cpu_budget || null,
          completed_at_ms: Date.now(),
          persisted: false,
        };
        try {
          const envelope = createPersistedProjectionEnvelope(current, projection);
          const write = Promise.resolve().then(() => savePersisted(envelope)).catch(error => {
            lastPersistenceError = `save: ${String(error.message || error).slice(0, 300)}`;
          }).finally(() => persistenceWrites.delete(write));
          persistenceWrites.add(write);
        } catch (error) {
          lastPersistenceError = `serialize: ${String(error.message || error).slice(0, 300)}`;
        }
        return finish(null, current);
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => {
        const preemptedBy = workerPreemptions.get(worker);
        if (!settled && preemptedBy) {
          const error = new Error(`${projection} worker preempted by ${preemptedBy}`);
          error.code = 'interactive_preemption';
          return finish(error);
        }
        if (!settled) finish(new Error(code === 0
          ? `${projection} worker exited before returning a snapshot`
          : `${projection} worker exited with code ${code}`));
      });
    });
    inFlight = operation.then(value => {
      lastRefreshSucceededAt = Date.now();
      nextRefreshEligibleAt = lastRefreshSucceededAt + Math.max(0, Number(minRefreshIntervalMs) || 0);
      consecutiveFailures = 0;
      lastRefreshError = null;
      return value;
    }, error => {
      lastRefreshFailedAt = Date.now();
      consecutiveFailures += 1;
      const baseRetryMs = Math.max(1, Number(failureRetryMs) || DEFAULT_PROJECTION_FAILURE_RETRY_MS);
      const maximumRetryMs = Math.max(baseRetryMs,
        Number(maxFailureRetryMs) || DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS);
      const retryDelayMs = Math.min(maximumRetryMs,
        baseRetryMs * (2 ** Math.min(10, consecutiveFailures - 1)));
      nextRefreshEligibleAt = lastRefreshFailedAt + retryDelayMs;
      lastRefreshError = {
        code: error.code || 'projection_refresh_failure',
        message: String(error.message || error).slice(0, 500),
        at: new Date(lastRefreshFailedAt).toISOString(),
        retry_in_ms: retryDelayMs,
      };
      throw error;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function get({ requireCurrentExperimentalAccess = false, requireCurrentRevision = false,
    waitForCold = true, waitForRequiredRefresh = true } = {}) {
    await hydrate();
    const revision = store.snapshotRevision();
    const accessFingerprint = typeof store.experimentalAccessFingerprint === 'function'
      ? store.experimentalAccessFingerprint() : null;
    const accessChanged = Boolean(current && requireCurrentExperimentalAccess
      && current.experimental_access_fingerprint !== accessFingerprint);
    const revisionChanged = Boolean(current && current.revision !== revision);
    const buildChanged = current?.build_stale === true;
    if (accessChanged || (requireCurrentRevision && (revisionChanged || buildChanged))) {
      if (!waitForRequiredRefresh) {
        if (consecutiveFailures > 0 && Date.now() < nextRefreshEligibleAt) {
          const error = new Error(`${projection} refresh is in failure backoff`);
          error.code = 'projection_failure_backoff';
          error.retry_after_ms = nextRefreshEligibleAt - Date.now();
          throw error;
        }
        if (!inFlight && !shouldDeferRefresh()) refresh({ force: true }).catch(() => {});
        const error = new Error(`${projection} required projection refresh in progress`);
        error.code = 'required_projection_refreshing';
        throw error;
      }
      const value = await refresh({ force: true });
      const latestFingerprint = typeof store.experimentalAccessFingerprint === 'function'
        ? store.experimentalAccessFingerprint() : null;
      if (requireCurrentExperimentalAccess
        && value.experimental_access_fingerprint !== latestFingerprint) {
        throw new Error('experimental access state changed during projection generation');
      }
      if (requireCurrentRevision && value.revision !== store.snapshotRevision()) {
        throw new Error('intelligence state changed during projection generation');
      }
      return { ...value, cache_state: accessChanged ? 'seal-refresh' : 'revision-refresh', stale: false };
    }
    if (!current) {
      if (consecutiveFailures > 0 && Date.now() < nextRefreshEligibleAt) {
        const error = new Error(`${projection} refresh is in failure backoff`);
        error.code = 'projection_failure_backoff';
        error.retry_after_ms = nextRefreshEligibleAt - Date.now();
        throw error;
      }
      if (!waitForCold) {
        if (!inFlight && !shouldDeferRefresh()) refresh({ force: true }).catch(() => {});
        const error = new Error(`${projection} cold projection refresh in progress`);
        error.code = 'cold_projection_refreshing';
        throw error;
      }
      const value = await refresh({ force: true });
      return { ...value, cache_state: 'cold', stale: value.revision !== store.snapshotRevision() };
    }
    const ageMs = Date.now() - current.completed_at_ms;
    const ageExpired = ageMs > maxAgeMs;
    const stale = revisionChanged || ageExpired;
    if ((buildChanged || ageExpired) && !inFlight && !shouldDeferRefresh()
      && Date.now() >= nextRefreshEligibleAt) {
      refresh({ force: buildChanged }).catch(() => {});
    }
    return { ...current,
      cache_state: buildChanged ? 'stale-build-refreshing'
        : current.persisted ? 'persisted' : (stale ? 'stale' : 'fresh'),
      stale: stale || buildChanged };
  }

  function status() {
    return {
      projection,
      ready: Boolean(current),
      in_flight: Boolean(inFlight),
      revision: current?.revision ?? null,
      current_revision: store.snapshotRevision(),
      generated_at: current?.generated_at || null,
      build_identity: current?.build_identity || null,
      current_build_identity: projectionBuildIdentity(),
      build_stale: current?.build_stale || false,
      age_ms: current ? Math.max(0, Date.now() - current.completed_at_ms) : null,
      compute_ms: current?.compute_ms ?? null,
      capture_ms: current?.capture_ms ?? null,
      isolation: current?.isolation || null,
      priority: current?.priority ?? null,
      cpu_budget: current?.cpu_budget || null,
      persisted: current?.persisted || false,
      persistence_error: lastPersistenceError,
      last_refresh_started_at: lastRefreshStartedAt
        ? new Date(lastRefreshStartedAt).toISOString() : null,
      last_refresh_succeeded_at: lastRefreshSucceededAt
        ? new Date(lastRefreshSucceededAt).toISOString() : null,
      last_refresh_failed_at: lastRefreshFailedAt
        ? new Date(lastRefreshFailedAt).toISOString() : null,
      next_refresh_eligible_at: nextRefreshEligibleAt
        ? new Date(nextRefreshEligibleAt).toISOString() : null,
      consecutive_failures: consecutiveFailures,
      refresh_error: lastRefreshError,
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
    try { await inFlight; } catch { /* worker failure already surfaced */ }
    await Promise.allSettled([...persistenceWrites]);
  }

  return { get, refresh, status, preempt, close, hydrate };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MIN_REFRESH_INTERVAL_MS,
  DEFAULT_PROJECTION_FAILURE_RETRY_MS,
  DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS,
  DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS,
  PERSISTED_PROJECTION_PROTOCOL_VERSION,
  projectionBuildIdentity,
  createLowPriorityResearchProcess,
  createSerializedResearchWorkerFactory,
  createResearchStatusCache,
  createResearchProjectionCache,
  createPersistedProjectionEnvelope,
  verifyPersistedProjectionEnvelope,
};
