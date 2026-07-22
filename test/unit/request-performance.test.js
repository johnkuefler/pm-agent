'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestPerformanceMonitor, normalizePath } = require('../../src/runtime/request-performance');

test('request performance monitor records bounded normalized route timings', async () => {
  const monitor = createRequestPerformanceMonitor({ slowMs: 0, maxRoutes: 2, maxSlowEvents: 2 });
  const req = { method: 'POST', path: '/intelligence/cycles/run-1234567890123456/self-forecast',
    originalUrl: '/intelligence/cycles/run-1234567890123456/self-forecast?secret=nope' };
  const res = new EventEmitter();
  res.statusCode = 200;
  monitor.middleware(req, res, () => {});
  res.emit('finish');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.active_requests, 0);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].path, '/intelligence/cycles/:id/self-forecast');
  assert.equal(snapshot.recent_slow_requests.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test('route templates take precedence over concrete ids', () => {
  assert.equal(normalizePath({ route: { path: '/cycles/:id' }, baseUrl: '/intelligence' }),
    '/intelligence/cycles/:id');
});
