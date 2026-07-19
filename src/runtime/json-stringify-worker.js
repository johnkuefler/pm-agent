'use strict';

const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');

parentPort.on('message', ({ id, value }) => {
  const started = performance.now();
  try {
    const json = JSON.stringify(value);
    parentPort.postMessage({ id, json, payload_bytes: Buffer.byteLength(json),
      serialization_ms: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
