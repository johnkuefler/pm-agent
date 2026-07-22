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
  'experienceStreamSnapshot',
  'expectationForecastRuntimeSnapshot',
]);

parentPort.on('message', async ({ id, state, method, args }) => {
  const started = performance.now();
  try {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported intelligence projection: ${method}`);
    const context = args?.__context || {};
    const methodArgs = { ...(args || {}) };
    delete methodArgs.__context;
    const store = createIntelligenceStore({ filePath: null, db: {},
      isDbReady: () => false, initialState: state,
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
    await store.init();
    const value = store[method](methodArgs);
    parentPort.postMessage({ id, value, compute_ms: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
