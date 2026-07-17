'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createIntelligenceStore } = require('./store');

async function main() {
  const started = process.hrtime.bigint();
  const observedAt = new Date(workerData.observed_at);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('research status worker requires a valid observation time');
  const store = createIntelligenceStore({
    filePath: null,
    db: {},
    isDbReady: () => false,
    clock: () => new Date(observedAt),
    getDreams: () => workerData.dreams || [],
    getWants: () => workerData.wants || [],
    getOperationalEnvironment: () => workerData.operational_environment || {},
    initialState: workerData.state,
  });
  await store.init();
  const report = store.consciousnessResearchStatus();
  const computeMs = Number(process.hrtime.bigint() - started) / 1e6;
  parentPort.postMessage({
    revision: workerData.revision,
    generated_at: report.generated_at || observedAt.toISOString(),
    compute_ms: computeMs,
    serialized: JSON.stringify(report),
  });
}

main().catch(error => {
  parentPort.postMessage({ error: String(error.stack || error.message || error).slice(0, 4000) });
});
