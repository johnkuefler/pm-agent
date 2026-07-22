'use strict';

const { performance } = require('node:perf_hooks');

function normalizePath(req) {
  const route = req.route?.path;
  if (route) return `${req.baseUrl || ''}${route}` || '/';
  return String(req.path || req.originalUrl || '/').split('?')[0]
    .replace(/\/[a-z0-9_-]{16,}(?=\/|$)/gi, '/:id');
}

function createRequestPerformanceMonitor({ slowMs = 1000, maxRoutes = 100,
  maxSlowEvents = 50, clock = () => new Date() } = {}) {
  const routes = new Map();
  const recentSlow = [];
  let activeRequests = 0;

  function middleware(req, res, next) {
    const startedAt = performance.now();
    activeRequests += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests = Math.max(0, activeRequests - 1);
      const durationMs = performance.now() - startedAt;
      const contentType = String(res.getHeader?.('Content-Type') || '').toLowerCase();
      const streaming = contentType.includes('text/event-stream');
      const path = normalizePath(req);
      const key = `${req.method} ${path}`;
      const previous = routes.get(key) || { method: req.method, path, count: 0,
        slow_count: 0, streaming_count: 0, last_ms: 0, max_ms: 0, mean_ms: 0, last_status: null,
        last_completed_at: null };
      previous.count += 1;
      previous.streaming_count += Number(streaming);
      previous.slow_count += Number(!streaming && durationMs >= slowMs);
      previous.last_ms = Math.round(durationMs);
      previous.max_ms = Math.max(previous.max_ms, Math.round(durationMs));
      previous.mean_ms = Math.round(((previous.mean_ms * (previous.count - 1)) + durationMs) / previous.count);
      previous.last_status = res.statusCode;
      previous.last_completed_at = clock().toISOString();
      routes.delete(key);
      routes.set(key, previous);
      while (routes.size > maxRoutes) routes.delete(routes.keys().next().value);
      if (!streaming && durationMs >= slowMs) {
        recentSlow.push({ method: req.method, path, duration_ms: Math.round(durationMs),
          status: res.statusCode, completed_at: previous.last_completed_at });
        while (recentSlow.length > maxSlowEvents) recentSlow.shift();
        console.warn(`Slow request ${req.method} ${path}: ${Math.round(durationMs)}ms (${res.statusCode})`);
      }
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }

  function snapshot() {
    return { protocol_version: 1, slow_threshold_ms: slowMs, active_requests: activeRequests,
      routes: [...routes.values()].sort((left, right) => right.max_ms - left.max_ms),
      recent_slow_requests: [...recentSlow].reverse() };
  }

  return { middleware, snapshot };
}

module.exports = { createRequestPerformanceMonitor, normalizePath };
