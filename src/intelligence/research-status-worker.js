'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createIntelligenceStore } = require('./store');

async function build(workerInput) {
  const started = process.hrtime.bigint();
  const observedAt = new Date(workerInput.observed_at);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('research status worker requires a valid observation time');
  const store = createIntelligenceStore({
    filePath: null,
    db: {},
    isDbReady: () => false,
    clock: () => new Date(observedAt),
    getDreams: () => workerInput.dreams || [],
    getWants: () => workerInput.wants || [],
    getOperationalEnvironment: () => workerInput.operational_environment || {},
    initialState: workerInput.state,
    // The parent captures this state directly from the already-hydrated live store at an exact
    // revision. Replaying every migration and normalization in the low-priority child turned a
    // production self-model refresh into a multi-minute job. Mutations preserve the same store
    // invariants, so the projection worker can adopt the trusted snapshot exactly as the other
    // internal intelligence projection worker does.
    trustedNormalizedInitialState: true,
  });
  await store.init();
  const projection = workerInput.projection || 'combined';
  if (!['combined', 'research_status', 'self_model', 'cognition'].includes(projection)) {
    throw new Error(`unsupported research projection: ${projection}`);
  }
  const report = ['combined', 'research_status'].includes(projection)
    ? store.consciousnessResearchStatus() : null;
  const selfModel = ['combined', 'self_model'].includes(projection)
    ? store.selfModelSnapshot() : null;
  const cognition = projection === 'cognition'
    ? store.cognitionSnapshot(workerInput.predictions || []) : null;
  const computeMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    projection,
    revision: workerInput.revision,
    generated_at: report?.generated_at || observedAt.toISOString(),
    compute_ms: computeMs,
    ...(report ? { serialized: JSON.stringify(report) } : {}),
    ...(selfModel ? { self_model_serialized: JSON.stringify(selfModel) } : {}),
    ...(cognition ? { serialized: JSON.stringify(cognition) } : {}),
  };
}

function failure(error) {
  return { error: String(error.stack || error.message || error).slice(0, 4000) };
}

if (parentPort) {
  build(workerData).then(message => parentPort.postMessage(message),
    error => parentPort.postMessage(failure(error)));
} else if (typeof process.send === 'function') {
  process.once('message', input => {
    build(input).then(message => process.send(message, () => process.disconnect()),
      error => process.send(failure(error), () => process.disconnect()));
  });
}

module.exports = { build, failure };
