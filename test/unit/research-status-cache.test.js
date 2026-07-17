'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { createResearchStatusCache } = require('../../src/intelligence/research-status-cache');

const OBSERVED_AT = new Date('2026-07-17T15:00:00.000Z');

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
  assert.ok(Date.now() - started < 150, 'shutdown must not wait for the expensive audit to finish');
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
