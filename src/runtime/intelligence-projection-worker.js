'use strict';

const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { createIntelligenceStore } = require('../intelligence/store');

const ALLOWED_METHODS = new Set([
  'developmentalSelfReflectionScheduleSnapshot',
  'developmentalSelfReflectionRuntimeSnapshot',
  'behavioralSelfForecastPriorSnapshot',
  'cycleSelfForecastRuntimePreparationSnapshot',
  'dashboardIntelligenceSummary',
  'dashboardIntelligenceOverview',
  'experienceStreamSnapshot',
  'expectationForecastRuntimeSnapshot',
  'stateFootprintSnapshot',
]);

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function stateFootprintSnapshot(state) {
  const cognition = state?.cognition || {};
  const cognitionSections = Object.entries(cognition).map(([key, value]) => ({
    key,
    bytes: jsonBytes(value),
    items: Array.isArray(value) ? value.length
      : value && typeof value === 'object'
        ? Object.values(value).filter(Array.isArray).reduce((sum, list) => sum + list.length, 0)
        : null,
  })).sort((left, right) => right.bytes - left.bytes);
  const rootSections = Object.entries(state || {}).filter(([key]) => key !== 'cognition')
    .map(([key, value]) => ({ key, bytes: jsonBytes(value),
      items: Array.isArray(value) ? value.length : null }))
    .sort((left, right) => right.bytes - left.bytes);
  return { total_bytes: jsonBytes(state), cognition_sections: cognitionSections,
    root_sections: rootSections };
}

parentPort.on('message', async ({ id, state, method, args }) => {
  const started = performance.now();
  try {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported intelligence projection: ${method}`);
    if (method === 'stateFootprintSnapshot') {
      return parentPort.postMessage({ id, value: stateFootprintSnapshot(state),
        compute_ms: performance.now() - started, init_ms: 0,
        projection_ms: performance.now() - started });
    }
    const context = args?.__context || {};
    const methodArgs = { ...(args || {}) };
    delete methodArgs.__context;
    const store = createIntelligenceStore({ filePath: null, db: {},
      isDbReady: () => false, initialState: state,
      trustedNormalizedInitialState: true,
      getDreams: () => context.dreams || [],
      getWants: () => context.wants || [],
      getInteractions: () => context.interactions || [],
      getCognitiveParameterRecord: commitment => {
        const parameterContext = context.cognitive_parameter_records || {};
        if (!commitment) return parameterContext.current;
        return (parameterContext.records || []).find(item => item.content_commitment === commitment)
          || parameterContext.current;
      },
    });
    const initStarted = performance.now();
    await store.init();
    const initMs = performance.now() - initStarted;
    const projectionStarted = performance.now();
    const value = store[method](methodArgs);
    const projectionMs = performance.now() - projectionStarted;
    parentPort.postMessage({ id, value, compute_ms: performance.now() - started,
      init_ms: initMs, projection_ms: projectionMs });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
