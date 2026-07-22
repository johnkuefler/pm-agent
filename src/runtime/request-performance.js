'use strict';

const { performance } = require('node:perf_hooks');

function normalizePath(req) {
  const route = req.route?.path;
  if (route) return `${req.baseUrl || ''}${route}` || '/';
  return String(req.path || req.originalUrl || '/').split('?')[0]
    .replace(/\/[a-z0-9_-]{16,}(?=\/|$)/gi, '/:id');
}

function createRequestPerformanceMonitor({ slowMs = 1000, maxRoutes = 100,
  maxSlowEvents = 50, deadlineMs = 45000, longDeadlineMs = 120000,
  clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const routes = new Map();
  const recentSlow = [];
  const recentDeadlines = [];
  const active = new Map();
  let activeRequests = 0;
  let deadlineExceeded = 0;
  let sequence = 0;

  function deadlineFor(req) {
    const path = String(req.path || req.originalUrl || '/').split('?')[0];
    if (req.method === 'GET' && path === '/runtime-activity/events') return null;
    if (path === '/admin/drive/upload-artifact'
      || path.startsWith('/process-metacognition-studies')
      || /\/(?:subject-pair|subject|probe|evaluate)$/.test(path)) return longDeadlineMs;
    return deadlineMs;
  }

  function middleware(req, res, next) {
    const startedAt = performance.now();
    const id = ++sequence;
    const terminalMs = deadlineFor(req);
    const controller = new AbortController();
    req.deadlineSignal = controller.signal;
    activeRequests += 1;
    active.set(id, { id, method: req.method, path: normalizePath(req), startedAt,
      deadline_ms: terminalMs });
    let finished = false;
    let deadlineTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (deadlineTimer) clearTimer(deadlineTimer);
      active.delete(id);
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
    req.once?.('aborted', () => {
      if (!controller.signal.aborted) controller.abort(new Error('request client disconnected'));
    });
    if (terminalMs != null) {
      deadlineTimer = setTimer(() => {
        if (finished) return;
        const path = normalizePath(req);
        const event = { method: req.method, path, deadline_ms: terminalMs,
          elapsed_ms: Math.round(performance.now() - startedAt), at: clock().toISOString() };
        deadlineExceeded += 1;
        recentDeadlines.push(event);
        while (recentDeadlines.length > maxSlowEvents) recentDeadlines.shift();
        if (!controller.signal.aborted) {
          const error = new Error(`request exceeded ${terminalMs}ms server deadline`);
          error.code = 'REQUEST_DEADLINE_EXCEEDED';
          controller.abort(error);
        }
        console.error(`Request deadline exceeded ${req.method} ${path}: ${event.elapsed_ms}ms`);
        if (!res.headersSent && !res.writableEnded) {
          res.status(504).json({ error: 'request exceeded the server deadline',
            code: 'REQUEST_DEADLINE_EXCEEDED', retryable: true });
        } else if (!res.writableEnded) {
          res.destroy?.(controller.signal.reason);
        }
      }, terminalMs);
      deadlineTimer.unref?.();
    }
    next();
  }

  function snapshot() {
    const now = performance.now();
    return { protocol_version: 1, slow_threshold_ms: slowMs, active_requests: activeRequests,
      routes: [...routes.values()].sort((left, right) => right.max_ms - left.max_ms),
      active: [...active.values()].map(item => ({ id: item.id, method: item.method,
        path: item.path, age_ms: Math.round(now - item.startedAt), deadline_ms: item.deadline_ms })),
      request_deadline_ms: deadlineMs, long_request_deadline_ms: longDeadlineMs,
      deadline_exceeded: deadlineExceeded,
      recent_deadline_exceeded: [...recentDeadlines].reverse(),
      recent_slow_requests: [...recentSlow].reverse() };
  }

  return { middleware, snapshot };
}

module.exports = { createRequestPerformanceMonitor, normalizePath };
