'use strict';

const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { gzipSync } = require('node:zlib');

parentPort.on('message', ({ id, value, compress = false }) => {
  const started = performance.now();
  try {
    const json = JSON.stringify(value);
    const payloadBytes = Buffer.byteLength(json);
    if (compress) {
      const compressionStarted = performance.now();
      const compressed = gzipSync(json, { level: 3 });
      parentPort.postMessage({ id, compressed, payload_bytes: payloadBytes,
        compressed_bytes: compressed.byteLength,
        serialization_ms: compressionStarted - started,
        compression_ms: performance.now() - compressionStarted }, [compressed.buffer]);
      return;
    }
    parentPort.postMessage({ id, json, payload_bytes: payloadBytes,
      compressed_bytes: null, compression_ms: null,
      serialization_ms: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
