'use strict';

const { parentPort } = require('node:worker_threads');

// Deliberately accepts work without replying. The projection recovery test verifies that a
// silent worker cannot leave forecasts and dashboard snapshots pending until process restart.
parentPort.on('message', () => {});
