'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { createResearchStatusCache, createResearchProjectionCache,
  createPersistedProjectionEnvelope, verifyPersistedProjectionEnvelope,
  PERSISTED_PROJECTION_PROTOCOL_VERSION, projectionBuildIdentity } =
  require('../../src/intelligence/research-status-cache');
const { DEFAULT_PROJECTION_FAILURE_RETRY_MS, DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS,
  DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS } =
  require('../../src/intelligence/research-status-cache');

const OBSERVED_AT = new Date('2026-07-17T15:00:00.000Z');

test('production projection retry and timeout defaults are bounded and distinct', () => {
  assert.equal(DEFAULT_PROJECTION_FAILURE_RETRY_MS, 30 * 1000);
  assert.equal(DEFAULT_PROJECTION_MAX_FAILURE_RETRY_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS, 3 * 60 * 1000);
  assert.ok(DEFAULT_PROJECTION_FAILURE_RETRY_MS < DEFAULT_PROJECTION_REFRESH_TIMEOUT_MS);
});

async function createStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-research-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'),
    db: {},
    isDbReady: () => false,
    clock: () => new Date(OBSERVED_AT),
    getDreams: () => [],
    getWants: () => [],
    getOperationalEnvironment: () => ({ source: 'research-cache-test' }),
  });
  await store.init();
  return store;
}

test('research status worker preserves the scientific report and refreshes revisions', async t => {
  const store = await createStore(t);
  const cache = createResearchStatusCache({
    store,
    now: () => new Date(OBSERVED_AT),
    minRefreshIntervalMs: 0,
  });
  t.after(() => cache.close());

  const expected = store.consciousnessResearchStatus();
  const expectedSelfModel = store.selfModelSnapshot();
  const cold = await cache.get();
  assert.equal(cold.cache_state, 'cold');
  assert.equal(cold.stale, false);
  assert.deepEqual(JSON.parse(cold.serialized), expected);
  assert.deepEqual(JSON.parse(cold.self_model_serialized), expectedSelfModel);
  assert.ok(cold.compute_ms >= 0);
  assert.ok(cold.capture_ms >= 0);
  assert.equal(cold.isolation, 'low_priority_child_process');
  assert.equal(cold.priority, 19);

  store.addCommitment({ what: 'Keep live conversations responsive', owner: 'Nora' });
  const stale = await cache.get();
  assert.equal(stale.cache_state, 'stale');
  assert.equal(stale.stale, true);
  assert.notEqual(stale.revision, store.snapshotRevision());

  const fresh = await cache.get({ requireCurrentRevision: true });
  assert.equal(fresh.cache_state, 'revision-refresh');
  assert.equal(fresh.revision, store.snapshotRevision());
  assert.deepEqual(JSON.parse(fresh.serialized), store.consciousnessResearchStatus());
  assert.deepEqual(JSON.parse(fresh.self_model_serialized), store.selfModelSnapshot());
});

test('self-model cache refreshes instead of crossing an experimental access boundary', async t => {
  const store = await createStore(t);
  const cache = createResearchStatusCache({
    store,
    now: () => new Date(OBSERVED_AT),
    minRefreshIntervalMs: 0,
  });
  t.after(() => cache.close());
  await cache.get();
  const priorFingerprint = store.experimentalAccessFingerprint();

  store.createContextTrial({
    id: 'cache-seal-boundary-trial',
    hypothesis: 'A cache must not cross a newly active blinded-study boundary.',
    outcome_metric: 'first_order_task_quality',
    surfaces: ['slack'],
    sample_target_per_group: 2,
  });
  assert.notEqual(store.experimentalAccessFingerprint(), priorFingerprint);

  const refreshed = await cache.get({ requireCurrentExperimentalAccess: true });
  assert.equal(refreshed.cache_state, 'seal-refresh');
  assert.equal(refreshed.experimental_access_fingerprint, store.experimentalAccessFingerprint());
  const model = JSON.parse(refreshed.self_model_serialized);
  assert.equal(model.context_trials.at(-1).design_sealed, true);
  assert.equal(model.context_trials.at(-1).hypothesis, 'Blinded functional trial');
});

test('expensive research computation cannot block the main event loop', async t => {
  const store = await createStore(t);
  const cache = createResearchStatusCache({
    store,
    now: () => new Date(OBSERVED_AT),
    workerPath: path.join(__dirname, '..', 'fixtures', 'research-status-spin-worker.js'),
  });
  t.after(() => cache.close());

  let heartbeatTicks = 0;
  const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 10);
  const snapshot = await cache.get();
  clearInterval(heartbeat);

  assert.equal(JSON.parse(snapshot.serialized).isolated_worker_fixture, true);
  assert.equal(JSON.parse(snapshot.self_model_serialized).isolated_worker_fixture, true);
  assert.equal(snapshot.isolation, 'low_priority_child_process');
  assert.equal(snapshot.priority, 19);
  assert.ok(heartbeatTicks >= 5,
    `main event-loop heartbeat should continue during worker computation; observed ${heartbeatTicks} ticks`);
});

test('server shutdown terminates an in-flight audit worker promptly', async t => {
  const store = await createStore(t);
  const cache = createResearchStatusCache({
    store,
    now: () => new Date(OBSERVED_AT),
    workerPath: path.join(__dirname, '..', 'fixtures', 'research-status-spin-worker.js'),
  });
  const outcome = cache.refresh().then(value => value, error => error);
  await new Promise(resolve => setTimeout(resolve, 20));

  const started = Date.now();
  await cache.close();
  const result = await outcome;
  assert.ok(result instanceof Error);
  assert.ok(Date.now() - started < 700,
    'shutdown must terminate well before the one-second audit would finish');
});

test('interactive priority preempts a CPU-heavy audit and defers respawn', async t => {
  const store = await createStore(t);
  let interactive = false;
  const cache = createResearchStatusCache({
    store,
    now: () => new Date(OBSERVED_AT),
    workerPath: path.join(__dirname, '..', 'fixtures', 'research-status-spin-worker.js'),
    shouldDeferRefresh: () => interactive,
  });
  t.after(() => cache.close());
  const outcome = cache.refresh().then(value => value, error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  interactive = true;
  assert.equal(cache.preempt('slack'), true);
  const result = await outcome;
  assert.equal(result.code, 'interactive_preemption');
  await assert.rejects(cache.refresh(), error => error.code === 'interactive_priority_deferred');
  assert.equal(cache.status().preemptions, 1);
  interactive = false;
  const recovered = await cache.refresh();
  assert.equal(JSON.parse(recovered.serialized).isolated_worker_fixture, true);
});

test('active trial summary avoids the full self-model audit without changing sealed output', async t => {
  const source = await createStore(t);
  const state = source.snapshot();
  state.cognition.self_model.context_trials.push({
    id: 'active-performance-trial',
    status: 'active',
    study_phase: 'preregistered_pilot',
    created: OBSERVED_AT.toISOString(),
    completed: null,
    hypothesis: 'must remain sealed',
    design_commitment: 'abcdef1234567890',
    enrollment_target_per_group: 2,
    conditions: ['control', 'treatment'],
    assignments: [
      { status: 'resolved', grades: [{ score: 1 }], outcome: { observed: true } },
      { status: 'assigned', grades: [] },
    ],
  });
  const store = createIntelligenceStore({
    filePath: null,
    db: {},
    isDbReady: () => false,
    clock: () => new Date(OBSERVED_AT),
    initialState: state,
  });
  await store.init();

  assert.deepEqual(store.activeContextTrialsSnapshot(),
    store.selfModelSnapshot().context_trials.filter(item => item.status === 'active'));
  assert.equal(store.activeContextTrialsSnapshot()[0].hypothesis, 'Blinded functional trial');
  assert.equal(store.activeContextTrialsSnapshot()[0].assignment_progress.target_total, 4);
});

test('independent projection workers do not rebuild the unrelated dashboard projection', async t => {
  const store = await createStore(t);
  const reportCache = createResearchProjectionCache({
    projection: 'research_status', store, now: () => new Date(OBSERVED_AT),
    minRefreshIntervalMs: 0,
  });
  const selfModelCache = createResearchProjectionCache({
    projection: 'self_model', store, now: () => new Date(OBSERVED_AT),
    minRefreshIntervalMs: 0,
  });
  t.after(() => Promise.all([reportCache.close(), selfModelCache.close()]));

  const report = await reportCache.get();
  assert.deepEqual(JSON.parse(report.serialized), store.consciousnessResearchStatus());
  assert.equal(Object.hasOwn(report, 'self_model_serialized'), false);
  assert.equal(selfModelCache.status().ready, false,
    'loading the research report must not spend CPU building the self-model');

  const selfModel = await selfModelCache.get();
  assert.deepEqual(JSON.parse(selfModel.serialized), store.selfModelSnapshot());
  assert.equal(Object.hasOwn(selfModel, 'self_model_serialized'), false);
});

test('full cognition is projected in an isolated worker with prediction calibration intact', async t => {
  const store = await createStore(t);
  const predictions = [{ id: 'prediction-1', outcome: 'right', confidence: 0.8 }];
  const cache = createResearchProjectionCache({
    projection: 'cognition', store, getPredictions: () => predictions,
    now: () => new Date(OBSERVED_AT), minRefreshIntervalMs: 0,
  });
  t.after(() => cache.close());
  const snapshot = await cache.get();
  assert.deepEqual(JSON.parse(snapshot.serialized), store.cognitionSnapshot(predictions));
  assert.equal(snapshot.isolation, 'low_priority_child_process');
  assert.equal(snapshot.priority, 19);
});

test('CPU-heavy cognition projection cannot starve the interactive event loop', async t => {
  const store = await createStore(t);
  const cache = createResearchProjectionCache({
    projection: 'cognition', store,
    workerPath: path.join(__dirname, '..', 'fixtures', 'research-status-spin-worker.js'),
  });
  t.after(() => cache.close());
  let heartbeatTicks = 0;
  const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 10);
  const snapshot = await cache.get();
  clearInterval(heartbeat);
  assert.equal(JSON.parse(snapshot.serialized).isolated_worker_fixture, true);
  assert.ok(heartbeatTicks >= 5,
    `main event-loop heartbeat should continue during cognition projection; observed ${heartbeatTicks}`);
});

test('verified persisted projections hydrate across restarts without spawning computation', async t => {
  const store = await createStore(t);
  const envelope = createPersistedProjectionEnvelope({
    serialized: JSON.stringify(store.consciousnessResearchStatus()),
    revision: store.snapshotRevision(),
    experimental_access_fingerprint: store.experimentalAccessFingerprint(),
    generated_at: OBSERVED_AT.toISOString(),
    completed_at: new Date().toISOString(),
  }, 'research_status');
  assert.equal(verifyPersistedProjectionEnvelope(envelope, 'research_status'), true);
  assert.equal(envelope.protocol_version, PERSISTED_PROJECTION_PROTOCOL_VERSION);
  assert.equal(envelope.build_identity, projectionBuildIdentity());
  const tampered = { ...envelope, serialized: envelope.serialized.replace('true', 'false') };
  assert.equal(verifyPersistedProjectionEnvelope(tampered, 'research_status'), false);
  const priorBuild = { ...envelope, build_identity: 'prior-build' };
  assert.equal(verifyPersistedProjectionEnvelope(priorBuild, 'research_status'), false,
    'a valid snapshot from older code must not survive a deployment');

  let workerCreated = false;
  const cache = createResearchProjectionCache({
    projection: 'research_status', store,
    loadPersisted: async () => envelope,
    createWorker: () => { workerCreated = true; throw new Error('worker should not start'); },
  });
  t.after(() => cache.close());
  const snapshot = await cache.get();
  assert.equal(snapshot.cache_state, 'persisted');
  assert.equal(snapshot.isolation, 'persisted_verified_projection');
  assert.equal(snapshot.cpu_budget.mode, 'no_compute_restart_hydration');
  assert.equal(workerCreated, false);
  assert.deepEqual(JSON.parse(snapshot.serialized), store.consciousnessResearchStatus());
});

test('cognition projections use the same tamper-evident restart envelope', async t => {
  const store = await createStore(t);
  const envelope = createPersistedProjectionEnvelope({
    serialized: JSON.stringify(store.cognitionSnapshot([])),
    revision: store.snapshotRevision(),
    experimental_access_fingerprint: store.experimentalAccessFingerprint(),
    generated_at: OBSERVED_AT.toISOString(), completed_at: new Date().toISOString(),
  }, 'cognition');
  assert.equal(verifyPersistedProjectionEnvelope(envelope, 'cognition'), true);
  const tampered = { ...envelope, serialized: `${envelope.serialized} ` };
  assert.equal(verifyPersistedProjectionEnvelope(tampered, 'cognition'), false);
});

test('an access-safe prior-build projection returns immediately while refresh is deferred', async t => {
  const store = await createStore(t);
  const envelope = createPersistedProjectionEnvelope({
    serialized: JSON.stringify(store.consciousnessResearchStatus()),
    revision: store.snapshotRevision(),
    experimental_access_fingerprint: store.experimentalAccessFingerprint(),
    generated_at: OBSERVED_AT.toISOString(), completed_at: new Date().toISOString(),
    build_identity: 'prior-build',
  }, 'research_status');
  assert.equal(verifyPersistedProjectionEnvelope(envelope, 'research_status'), false);
  assert.equal(verifyPersistedProjectionEnvelope(envelope, 'research_status', {
    requireCurrentBuild: false,
  }), true);
  const cache = createResearchProjectionCache({
    projection: 'research_status', store, loadPersisted: async () => envelope,
    shouldDeferRefresh: () => true,
    createWorker: () => { throw new Error('deferred refresh must not create a worker'); },
  });
  t.after(() => cache.close());
  const snapshot = await cache.get({ waitForCold: false });
  assert.equal(snapshot.cache_state, 'stale-build-refreshing');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.build_stale, true);
  assert.deepEqual(JSON.parse(snapshot.serialized), store.consciousnessResearchStatus());
});

test('a preempted prior-build refresh retries promptly instead of waiting the success interval', async t => {
  const store = await createStore(t);
  const envelope = createPersistedProjectionEnvelope({
    serialized: JSON.stringify(store.consciousnessResearchStatus()),
    revision: store.snapshotRevision(),
    experimental_access_fingerprint: store.experimentalAccessFingerprint(),
    generated_at: OBSERVED_AT.toISOString(), completed_at: new Date().toISOString(),
    build_identity: 'prior-build',
  }, 'research_status');
  let attempts = 0;
  const createWorker = ({ workerData }) => {
    attempts += 1;
    const worker = new EventEmitter();
    worker.research_isolation = 'fixture_worker';
    worker.research_priority = 19;
    worker.research_cpu_budget = { mode: 'fixture' };
    worker.research_release_cpu_budget = () => {};
    worker.terminate = async () => 0;
    setImmediate(() => {
      if (attempts === 1) {
        worker.emit('error', Object.assign(new Error('preempted fixture'), {
          code: 'interactive_preemption',
        }));
      } else {
        worker.emit('message', {
          projection: 'research_status', revision: workerData.revision,
          generated_at: workerData.observed_at,
          serialized: JSON.stringify({ refreshed: true }), compute_ms: 1,
        });
      }
    });
    return worker;
  };
  const cache = createResearchProjectionCache({
    projection: 'research_status', store, loadPersisted: async () => envelope,
    createWorker, failureRetryMs: 5, minRefreshIntervalMs: 60 * 60 * 1000,
  });
  t.after(() => cache.close());

  const stale = await cache.get({ waitForCold: false });
  assert.equal(stale.cache_state, 'stale-build-refreshing');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cache.status().consecutive_failures, 1);
  assert.equal(cache.status().refresh_error.code, 'interactive_preemption');
  await new Promise(resolve => setTimeout(resolve, 10));
  const recovered = await cache.refresh();
  assert.equal(JSON.parse(recovered.serialized).refreshed, true);
  assert.equal(attempts, 2);
  assert.equal(cache.status().consecutive_failures, 0);
  assert.equal(cache.status().refresh_error, null);
});

test('production-style self-model reads fail fast while an access-seal refresh runs', async t => {
  const store = await createStore(t);
  const envelope = createPersistedProjectionEnvelope({
    serialized: JSON.stringify(store.selfModelSnapshot()),
    revision: store.snapshotRevision(),
    experimental_access_fingerprint: store.experimentalAccessFingerprint(),
    generated_at: OBSERVED_AT.toISOString(), completed_at: new Date().toISOString(),
    build_identity: projectionBuildIdentity(),
  }, 'self_model');
  let workerCreated = 0;
  const cache = createResearchProjectionCache({
    projection: 'self_model', store, loadPersisted: async () => envelope,
    createWorker: () => {
      workerCreated += 1;
      const worker = new EventEmitter();
      worker.research_release_cpu_budget = () => {};
      worker.terminate = async () => { setImmediate(() => worker.emit('exit', 1)); return 0; };
      return worker;
    },
  });
  t.after(() => cache.close());
  await cache.hydrate();
  store.createContextTrial({ id: 'production-fast-seal-refresh',
    hypothesis: 'A sealed projection refresh must stay outside the HTTP request.',
    outcome_metric: 'bounded_request_latency', surfaces: ['slack'], sample_target_per_group: 2 });

  await assert.rejects(cache.get({ requireCurrentExperimentalAccess: true,
    waitForRequiredRefresh: false }), error => error.code === 'required_projection_refreshing');
  assert.equal(workerCreated, 1);
  assert.equal(cache.status().in_flight, true);
});

test('a wedged projection worker times out and exposes bounded retry diagnostics', async t => {
  const store = await createStore(t);
  let terminated = false;
  const cache = createResearchProjectionCache({
    projection: 'research_status', store, refreshTimeoutMs: 100,
    failureRetryMs: 5,
    createWorker: () => {
      const worker = new EventEmitter();
      worker.research_release_cpu_budget = () => {};
      worker.terminate = async () => { terminated = true; return 0; };
      return worker;
    },
  });
  t.after(() => cache.close());
  await assert.rejects(cache.refresh(), error => error.code === 'projection_refresh_timeout');
  assert.equal(terminated, true);
  assert.equal(cache.status().consecutive_failures, 1);
  assert.equal(cache.status().refresh_error.code, 'projection_refresh_timeout');
});

test('repeated projection failures back off exponentially and cannot be forced into a hot loop', async t => {
  const store = await createStore(t);
  let attempts = 0;
  const cache = createResearchProjectionCache({
    projection: 'research_status', store, failureRetryMs: 5, maxFailureRetryMs: 12,
    createWorker: () => {
      attempts += 1;
      const worker = new EventEmitter();
      worker.research_release_cpu_budget = () => {};
      worker.terminate = async () => 0;
      setImmediate(() => worker.emit('error', new Error(`failure ${attempts}`)));
      return worker;
    },
  });
  t.after(() => cache.close());

  await assert.rejects(cache.refresh(), /failure 1/);
  assert.equal(cache.status().refresh_error.retry_in_ms, 5);
  await assert.rejects(cache.refresh({ force: true }), error =>
    error.code === 'projection_failure_backoff');
  assert.equal(attempts, 1);

  await new Promise(resolve => setTimeout(resolve, 7));
  await assert.rejects(cache.refresh(), /failure 2/);
  assert.equal(cache.status().refresh_error.retry_in_ms, 10);
  await new Promise(resolve => setTimeout(resolve, 12));
  await assert.rejects(cache.refresh(), /failure 3/);
  assert.equal(cache.status().refresh_error.retry_in_ms, 12);
  assert.equal(attempts, 3);
});

test('cold HTTP-style reads fail fast while isolated projection generation continues', async t => {
  const store = await createStore(t);
  let workerCreated = false;
  const cache = createResearchProjectionCache({
    projection: 'research_status', store, loadPersisted: async () => null,
    createWorker: () => { workerCreated = true; throw new Error('synthetic worker start'); },
  });
  t.after(() => cache.close());
  await assert.rejects(cache.get({ waitForCold: false }), error =>
    error.code === 'cold_projection_refreshing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workerCreated, true);
});

test('HTTP projections expose the low-priority isolation receipt for production verification', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'intelligence.js'), 'utf8');
  assert.match(routes, /X-Nora-Compute-Isolation/);
  assert.match(routes, /X-Nora-Compute-Priority/);
  assert.match(routes, /X-Nora-Compute-CPU-Budget/);
  assert.match(routes, /projection: 'research_status'/);
  assert.match(routes, /projection: 'self_model'/);
  assert.match(routes, /projection: 'cognition'/);
  assert.match(routes, /requireCurrentExperimentalAccess: true/);
  assert.match(routes, /waitForCold: false/);
  assert.match(routes, /waitForRequiredRefresh: process\.env\.NORA_TEST_MODE === '1'/);
  assert.match(routes, /required_projection_refreshing/);
  assert.match(routes, /Retry-After/);
  assert.match(routes, /research-projection-runtime/);
});
