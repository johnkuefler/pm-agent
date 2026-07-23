'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdaptiveWorkerLoop } = require('../../src/runtime/adaptive-worker-loop');

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  };
}

test('adaptive worker completes bootstrap before scheduling and never overlaps ticks', async () => {
  const clock = fakeClock();
  let releaseBootstrap;
  const bootstrapHeld = new Promise(resolve => { releaseBootstrap = resolve; });
  let releaseTick;
  const tickHeld = new Promise(resolve => { releaseTick = resolve; });
  let active = 0;
  let maximumActive = 0;
  const loop = createAdaptiveWorkerLoop({
    bootstrap: () => bootstrapHeld,
    tick: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await tickHeld;
      active -= 1;
    },
    nextDelayMs: () => 3000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const starting = loop.start();
  assert.equal(clock.timers.length, 0);
  releaseBootstrap();
  await starting;
  assert.equal(clock.timers[0].delay, 3000);
  clock.timers.shift().fn();
  await Promise.resolve();
  assert.equal(loop.snapshot().running, true);
  assert.equal(clock.timers.length, 0);
  releaseTick();
  await tickHeld;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximumActive, 1);
  assert.equal(clock.timers.length, 1);
});

test('adaptive worker close stops rescheduling and drain waits for active work', async () => {
  const clock = fakeClock();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const loop = createAdaptiveWorkerLoop({
    tick: () => held,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await loop.start();
  clock.timers.shift().fn();
  await Promise.resolve();
  loop.close();
  const draining = loop.drain({ timeoutMs: 5000 });
  release();
  assert.equal(await draining, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clock.timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(loop.snapshot().closed, true);
});

test('adaptive worker contains failures and uses the next backoff delay', async () => {
  const clock = fakeClock();
  let delay = 3000;
  const errors = [];
  const loop = createAdaptiveWorkerLoop({
    tick: async () => { delay = 6000; throw new Error('database unavailable'); },
    nextDelayMs: () => delay,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: error => errors.push(error.message),
  });
  await loop.start();
  clock.timers.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['database unavailable']);
  assert.equal(clock.timers[0].delay, 6000);
  assert.equal(loop.snapshot().failures, 1);
  assert.equal(loop.snapshot().consecutive_failures, 1);
});
