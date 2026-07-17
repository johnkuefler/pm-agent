'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const until = Date.now() + 180;
while (Date.now() < until) {
  // Deliberately occupy this worker to prove the HTTP event loop remains responsive.
}

parentPort.postMessage({
  revision: workerData.revision,
  generated_at: workerData.observed_at,
  compute_ms: 180,
  serialized: JSON.stringify({ no_composite_score: true, isolated_worker_fixture: true }),
  self_model_serialized: JSON.stringify({ isolated_worker_fixture: true }),
});
