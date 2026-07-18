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
  });
  await store.init();
  const report = store.consciousnessResearchStatus();
  const selfModel = store.selfModelSnapshot();
  const computeMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    revision: workerInput.revision,
    generated_at: report.generated_at || observedAt.toISOString(),
    compute_ms: computeMs,
    serialized: JSON.stringify(report),
    self_model_serialized: JSON.stringify(selfModel),
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
