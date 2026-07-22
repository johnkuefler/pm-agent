'use strict';

const { parentPort } = require('node:worker_threads');

// Deliberately accepts work without replying. The serializer recovery test verifies that a
// wedged worker is terminated and cannot poison later persistence revisions.
parentPort.on('message', () => {});
