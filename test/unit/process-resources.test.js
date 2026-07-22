'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessResourceMonitor } = require('../../src/runtime/process-resources');

test('process resource monitor rotates bounded event-loop windows and closes cleanly', () => {
  let now = Date.parse('2026-07-22T20:00:00.000Z');
  let intervalCallback = null;
  let cleared = false;
  let enabled = 0;
  let disabled = 0;
  let resets = 0;
  const histogram = {
    mean: 20e6, max: 80e6,
    percentile: percentile => ({ 50: 15e6, 95: 35e6, 99: 60e6 }[percentile]),
    enable: () => { enabled += 1; }, disable: () => { disabled += 1; },
    reset: () => { resets += 1; },
  };
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const monitor = createProcessResourceMonitor({
    intervalMs: 60000, monitorFactory: () => histogram,
    performanceImpl: { eventLoopUtilization: previous => previous
      ? { utilization: 0.25 } : { utilization: 0.1 } },
    memoryUsage: () => ({ rss: 256 * 1024 ** 2, heapUsed: 100 * 1024 ** 2,
      heapTotal: 150 * 1024 ** 2, external: 10 * 1024 ** 2, arrayBuffers: 5 * 1024 ** 2 }),
    heapStatistics: () => ({ heap_size_limit: 1000 * 1024 ** 2 }),
    constrainedMemory: () => 512 * 1024 ** 2,
    resourceUsage: () => ({ userCPUTime: 500000, systemCPUTime: 200000, maxRSS: 300 * 1024 }),
    uptime: () => 120.5, now: () => now,
    setIntervalFn: callback => { intervalCallback = callback; return timer; },
    clearIntervalFn: value => { assert.equal(value, timer); cleared = true; },
  });

  monitor.start();
  assert.equal(enabled, 1);
  assert.equal(timer.unrefCalled, true);
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.memory.rss_mb, 256);
  assert.equal(snapshot.memory.heap_utilization, 0.1);
  assert.equal(snapshot.memory.constrained_rss_utilization, 0.5);
  assert.equal(snapshot.event_loop.current_window.p99_ms, 60);

  now += 60000;
  intervalCallback();
  snapshot = monitor.snapshot();
  assert.equal(snapshot.event_loop.last_complete_window.p99_ms, 60);
  assert.equal(snapshot.event_loop.last_complete_window.event_loop_utilization, 0.25);
  assert.equal(resets, 1);
  monitor.close();
  assert.equal(cleared, true);
  assert.equal(disabled, 1);
  assert.equal(monitor.snapshot().ready, false);
});
