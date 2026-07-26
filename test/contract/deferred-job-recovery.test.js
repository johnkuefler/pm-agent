'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readServerSource } = require('../helpers/server-source');

const root = path.join(__dirname, '..', '..');
const server = readServerSource();
const database = fs.readFileSync(path.join(root, 'db.js'), 'utf8');

test('restart recovery never blindly replays an outcome-unknown connector side effect', () => {
  assert.doesNotMatch(server, /requeueRunningJobs/);
  assert.match(database,
    /async function interruptRunningJobs\(\)[\s\S]*status='interrupted'[\s\S]*WHERE status='running'[\s\S]*RETURNING \*/);
  assert.match(server,
    /recoverInterruptedDeferredJobs[\s\S]*db\.interruptRunningJobs\(\)[\s\S]*did not retry it and risk doing it twice/);
});

test('deferred connector worker is serialized, observable, and drained during shutdown', () => {
  assert.match(server,
    /createAdaptiveWorkerLoop\(\{[\s\S]*name: 'deferred-connector-worker'[\s\S]*bootstrap: recoverInterruptedDeferredJobs[\s\S]*tick: jobWorkerTick/);
  assert.match(server, /deferred_jobs:[\s\S]*loop: _jobWorkerLoop\?\.snapshot\(\)/);
  assert.match(server,
    /async function stop\(\)[\s\S]*_jobWorkerLoop\.drain\(\{ timeoutMs: 10000 \}\)[\s\S]*await db\.close/);
});
