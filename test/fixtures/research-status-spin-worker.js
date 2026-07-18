'use strict';

const { parentPort, workerData } = require('node:worker_threads');

function run(input, send) {
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    // Deliberately occupy this worker to prove the HTTP event loop remains responsive.
  }

  send({
    revision: input.revision,
    generated_at: input.observed_at,
    compute_ms: 1000,
    serialized: JSON.stringify({ no_composite_score: true, isolated_worker_fixture: true }),
    self_model_serialized: JSON.stringify({ isolated_worker_fixture: true }),
  });
}

if (parentPort) run(workerData, message => parentPort.postMessage(message));
else if (typeof process.send === 'function') process.once('message', input => {
  run(input, message => process.send(message, () => process.disconnect()));
});
