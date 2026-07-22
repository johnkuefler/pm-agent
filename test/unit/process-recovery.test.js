'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProcessRecovery } = require('../../src/runtime/process-recovery');

const quietLogger = { log() {}, error() {} };

test('fatal process recovery drains once and exits nonzero with the original cause', async () => {
  let stops = 0;
  const exits = [];
  const cleared = [];
  const recovery = createProcessRecovery({
    stop: async () => { stops += 1; },
    exit: code => exits.push(code), logger: quietLogger,
    setTimer: () => 42, clearTimer: timer => cleared.push(timer), now: () => 1000,
  });
  const first = recovery.requestShutdown('unhandledRejection', { fatal: true, error: new Error('boom') });
  const duplicate = recovery.requestShutdown('uncaughtException', { fatal: true, error: new Error('later') });
  assert.equal(first, duplicate);
  await first;
  assert.equal(stops, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(cleared, [42]);
  assert.equal(recovery.snapshot().state, 'completed');
  assert.equal(recovery.snapshot().error.message, 'boom');
  assert.equal(recovery.snapshot().duplicate_requests, 1);
});

test('signal recovery exits cleanly after a successful bounded drain', async () => {
  const exits = [];
  const phases = [];
  const recovery = createProcessRecovery({ stop: async () => {}, exit: code => exits.push(code),
    beforeStop: state => phases.push(state.reason), logger: quietLogger,
    setTimer: () => 7, clearTimer() {} });
  await recovery.requestShutdown('SIGTERM');
  assert.deepEqual(phases, ['SIGTERM']);
  assert.deepEqual(exits, [0]);
  assert.equal(recovery.snapshot().fatal, false);
});

test('a hung fatal drain is forcibly terminated at its deadline', () => {
  let force = null;
  const exits = [];
  const recovery = createProcessRecovery({ stop: () => new Promise(() => {}),
    exit: code => exits.push(code), logger: quietLogger,
    setTimer: callback => { force = callback; return 9; }, clearTimer() {}, fatalTimeoutMs: 12000 });
  recovery.requestShutdown('uncaughtException', { fatal: true, error: new Error('wedged') });
  force();
  assert.deepEqual(exits, [1]);
  assert.equal(recovery.snapshot().state, 'forced_exit');
  assert.equal(recovery.snapshot().forced, true);
});

test('installed handlers route process signals and rejected promises through one coordinator', async () => {
  const target = new EventEmitter();
  const exits = [];
  const recovery = createProcessRecovery({ stop: async () => {}, exit: code => exits.push(code),
    logger: quietLogger, setTimer: () => 4, clearTimer() {} });
  const remove = recovery.install(target);
  target.emit('unhandledRejection', new Error('async escaped'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
  assert.equal(recovery.snapshot().reason, 'unhandledRejection');
  remove();
  assert.equal(target.listenerCount('uncaughtException'), 0);
});
