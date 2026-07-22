'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntelligenceStore, emptyState } = require('../../src/intelligence/store');

function optimizedFixture(initialState = emptyState()) {
  const writes = [];
  const db = {
    setStateSerialized: async (key, serialized) => {
      writes.push({ key, serialized });
      await new Promise(resolve => setTimeout(resolve, 5));
    },
  };
  const store = createIntelligenceStore({ filePath: 'unused', db,
    isDbReady: () => true, initialState });
  return { store, writes };
}

function compressedFixture(initialState = null) {
  const writes = [];
  let blob = null;
  const db = {
    getCompressedState: async () => blob,
    setCompressedState: async (key, data, metadata) => {
      blob = { data: Buffer.from(data), codec: metadata.codec,
        original_bytes: metadata.originalBytes };
      writes.push({ key, bytes: blob.data.byteLength, metadata });
      await new Promise(resolve => setTimeout(resolve, 5));
    },
    getState: async () => null,
    setState: async () => {},
  };
  const store = createIntelligenceStore({ filePath: 'unused', db,
    isDbReady: () => true, ...(initialState ? { initialState } : {}) });
  return { store, writes, db };
}

test('production intelligence persistence serializes in a worker and coalesces burst revisions', async () => {
  const state = emptyState();
  state.persistence_load_fixture = Array.from({ length: 20_000 }, (_, index) => ({
    id: index, text: `retained-state-${index}-${'x'.repeat(120)}`,
  }));
  const { store, writes } = optimizedFixture(state);
  await store.init();

  let timerFired = false;
  const foregroundTimer = new Promise(resolve => setTimeout(() => {
    timerFired = true;
    resolve();
  }, 0));
  const first = store.persist();
  const second = store.persist();
  const strict = store.persistStrict();
  await foregroundTimer;
  assert.equal(timerFired, true, 'foreground timers remain runnable while JSON serialization is in flight');
  await Promise.all([first, second, strict]);

  const diagnostics = store.persistenceDiagnostics();
  assert.equal(writes.length, 1);
  assert.equal(diagnostics.foreground_serialization, 'worker_thread');
  assert.equal(diagnostics.optimized_flushes, 1);
  assert.equal(diagnostics.coalesced_revisions, 2);
  assert.equal(diagnostics.pending_revisions, 0);
  assert.ok(diagnostics.last_payload_bytes > 2_000_000);
  assert.equal(JSON.parse(writes[0].serialized).persistence_load_fixture.length, 20_000);
});

test('durable cycle open and idempotent resume each commit one state revision', async () => {
  const { store, writes } = optimizedFixture();
  await store.init();

  const started = await store.openOrResumeCycle({ id: 'fast-cycle', holder: 'nora-cowork',
    resume_active: true });
  assert.equal(started.resumed, undefined);
  assert.equal(writes.length, 1);

  const resumed = await store.openOrResumeCycle({ holder: 'nora-cowork', resume_active: true });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.orientation.cached, true);
  assert.equal(resumed.cycle.id, started.cycle.id);
  assert.equal(writes.length, 2);
  const diagnostics = store.persistenceDiagnostics();
  assert.equal(diagnostics.requested_revision, 2);
  assert.equal(diagnostics.cycle_open.attempts, 2);
  assert.equal(diagnostics.cycle_open.successes, 2);
  assert.equal(diagnostics.cycle_open.failures, 0);
  assert.equal(diagnostics.cycle_open.last_resumed, true);
  assert.ok(diagnostics.cycle_open.last_total_ms >= diagnostics.cycle_open.last_refresh_ms);
});

test('production snapshots compress off-thread and recover exactly without the legacy JSON row', async () => {
  const state = emptyState();
  state.persistence_load_fixture = Array.from({ length: 20_000 }, (_, index) => ({
    id: index, text: `retained-state-${index}-${'repeated-context-'.repeat(8)}`,
  }));
  const fixture = compressedFixture(state);
  await fixture.store.init();
  await fixture.store.persistStrict();

  const diagnostics = fixture.store.persistenceDiagnostics();
  assert.equal(fixture.writes.length, 1);
  assert.equal(diagnostics.storage_codec, 'gzip-json-v1');
  assert.ok(diagnostics.last_payload_bytes > 2_000_000);
  assert.ok(diagnostics.last_compressed_bytes < diagnostics.last_payload_bytes / 4);
  assert.ok(diagnostics.last_compression_ratio < 0.25);
  assert.ok(diagnostics.last_compression_ms >= 0);

  const recovered = createIntelligenceStore({ filePath: 'unused', db: fixture.db,
    isDbReady: () => true });
  await recovered.init();
  assert.deepEqual(recovered.snapshot().persistence_load_fixture,
    state.persistence_load_fixture);
});

test('replay-heavy background projections compute in a worker without starving foreground timers', async () => {
  const state = emptyState();
  state.persistence_load_fixture = Array.from({ length: 20_000 }, (_, index) => ({
    id: index, text: `background-state-${index}-${'x'.repeat(120)}`,
  }));
  const store = createIntelligenceStore({ filePath: 'unused', db: {},
    isDbReady: () => false, initialState: state });
  await store.init();
  let foregroundTimerFired = false;
  const foreground = new Promise(resolve => setTimeout(() => {
    foregroundTimerFired = true;
    resolve();
  }, 0));
  const projection = store.computeBackgroundProjection(
    'developmentalSelfReflectionScheduleSnapshot');
  await foreground;
  assert.equal(foregroundTimerFired, true);
  const result = await projection;
  assert.equal(result.value.protocol_version, 1);
  assert.ok(result.dispatch_ms >= 0);
  assert.ok(result.compute_ms >= 0);
  const diagnostics = store.persistenceDiagnostics().background_projection;
  assert.equal(diagnostics.calls, 1);
  assert.equal(diagnostics.failures, 0);
  assert.equal(diagnostics.last_method, 'developmentalSelfReflectionScheduleSnapshot');
  assert.ok(diagnostics.last_compute_ms >= 0);
});

test('dashboard and experience projections stay off the foreground event loop', async () => {
  const store = createIntelligenceStore({ filePath: 'unused', db: {},
    isDbReady: () => false, initialState: emptyState() });
  await store.init();
  const dashboard = store.computeBackgroundProjection('dashboardIntelligenceSummary', {
    __context: { dreams: [], wants: [], interactions: [] },
  });
  const foregroundWon = await Promise.race([
    dashboard.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), 0)),
  ]);
  assert.equal(foregroundWon, true);
  assert.ok((await dashboard).value.overview);
  const experience = await store.computeBackgroundProjection('experienceStreamSnapshot', { limit: 6 });
  assert.deepEqual(experience.value.moments, []);
  assert.equal(store.persistenceDiagnostics().background_projection.failures, 0);
});

test('cold behavioral-prior reads fall back immediately while replay warms off-thread', async () => {
  const store = createIntelligenceStore({ filePath: 'unused', db: {},
    isDbReady: () => false, initialState: emptyState() });
  await store.init();
  const started = performance.now();
  const cold = store.behavioralSelfForecastPriorRuntimeSnapshot();
  assert.equal(cold.required_forecast_protocol_version, 4);
  assert.equal(cold.available, false);
  assert.equal(cold.prior_warmup_pending, true);
  assert.ok(performance.now() - started < 100);

  let warm = cold;
  for (let attempt = 0; attempt < 100 && warm.prior_warmup_pending; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    warm = store.behavioralSelfForecastPriorRuntimeSnapshot();
  }
  assert.equal(warm.prior_warmup_pending, false);
  assert.equal(warm.required_forecast_protocol_version, 4);
  assert.equal(store.persistenceDiagnostics().background_projection.failures, 0);
});
