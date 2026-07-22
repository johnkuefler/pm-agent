'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const v8 = require('node:v8');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bytesToMb(value) { return Math.round((finite(value) / (1024 * 1024)) * 10) / 10; }
function nsToMs(value) { return Math.round((finite(value) / 1e6) * 10) / 10; }

function createProcessResourceMonitor({ intervalMs = 60000, resolutionMs = 20,
  monitorFactory = options => monitorEventLoopDelay(options), performanceImpl = performance,
  memoryUsage = () => process.memoryUsage(), heapStatistics = () => v8.getHeapStatistics(),
  resourceUsage = () => process.resourceUsage(), uptime = () => process.uptime(),
  constrainedMemory = () => process.constrainedMemory?.() || 0,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now } = {}) {
  const windowMs = Math.max(5000, Number(intervalMs) || 60000);
  let histogram = null;
  let timer = null;
  let startedAt = null;
  let windowStartedAt = null;
  let lastWindow = null;
  let previousElu = null;

  function eventLoopSnapshot(source = histogram, from = windowStartedAt, to = now()) {
    if (!source || !from) return null;
    return {
      started_at: new Date(from).toISOString(),
      completed_at: new Date(to).toISOString(),
      duration_ms: Math.max(0, to - from),
      mean_ms: nsToMs(source.mean),
      p50_ms: nsToMs(source.percentile?.(50)),
      p95_ms: nsToMs(source.percentile?.(95)),
      p99_ms: nsToMs(source.percentile?.(99)),
      max_ms: nsToMs(source.max),
    };
  }

  function rotate() {
    if (!histogram) return;
    const at = now();
    const loop = eventLoopSnapshot(histogram, windowStartedAt, at);
    const elu = previousElu && typeof performanceImpl.eventLoopUtilization === 'function'
      ? performanceImpl.eventLoopUtilization(previousElu) : null;
    lastWindow = { ...loop,
      event_loop_utilization: elu ? Math.round(finite(elu.utilization) * 10000) / 10000 : null };
    previousElu = typeof performanceImpl.eventLoopUtilization === 'function'
      ? performanceImpl.eventLoopUtilization() : null;
    histogram.reset?.();
    windowStartedAt = at;
  }

  function start() {
    if (histogram) return;
    histogram = monitorFactory({ resolution: Math.max(1, Number(resolutionMs) || 20) });
    histogram.enable?.();
    startedAt = now();
    windowStartedAt = startedAt;
    previousElu = typeof performanceImpl.eventLoopUtilization === 'function'
      ? performanceImpl.eventLoopUtilization() : null;
    timer = setIntervalFn(rotate, windowMs);
    timer?.unref?.();
  }

  function snapshot() {
    const memory = memoryUsage() || {};
    const heap = heapStatistics() || {};
    const usage = resourceUsage() || {};
    const heapLimit = finite(heap.heap_size_limit);
    const rssLimit = finite(constrainedMemory());
    const heapUsed = finite(memory.heapUsed);
    const rss = finite(memory.rss);
    const currentElu = typeof performanceImpl.eventLoopUtilization === 'function'
      ? performanceImpl.eventLoopUtilization() : null;
    return {
      protocol_version: 1,
      ready: Boolean(histogram),
      started_at: startedAt ? new Date(startedAt).toISOString() : null,
      uptime_seconds: Math.round(finite(uptime()) * 10) / 10,
      memory: {
        rss_mb: bytesToMb(rss), heap_used_mb: bytesToMb(heapUsed),
        heap_total_mb: bytesToMb(memory.heapTotal), external_mb: bytesToMb(memory.external),
        array_buffers_mb: bytesToMb(memory.arrayBuffers), heap_limit_mb: bytesToMb(heapLimit),
        heap_utilization: heapLimit > 0 ? Math.round((heapUsed / heapLimit) * 10000) / 10000 : null,
        constrained_rss_limit_mb: rssLimit > 0 ? bytesToMb(rssLimit) : null,
        constrained_rss_utilization: rssLimit > 0 ? Math.round((rss / rssLimit) * 10000) / 10000 : null,
      },
      cpu: {
        user_ms: Math.round(finite(usage.userCPUTime) / 1000),
        system_ms: Math.round(finite(usage.systemCPUTime) / 1000),
        max_rss_mb: Math.round((finite(usage.maxRSS) / 1024) * 10) / 10,
        event_loop_utilization: currentElu
          ? Math.round(finite(currentElu.utilization) * 10000) / 10000 : null,
      },
      event_loop: {
        window_ms: windowMs,
        current_window: eventLoopSnapshot(),
        last_complete_window: lastWindow ? { ...lastWindow } : null,
      },
    };
  }

  function close() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    histogram?.disable?.();
    histogram = null;
    previousElu = null;
  }

  return { start, rotate, snapshot, close };
}

module.exports = { createProcessResourceMonitor, bytesToMb, nsToMs };
