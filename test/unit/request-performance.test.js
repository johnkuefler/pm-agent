'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const { createRequestPerformanceMonitor, normalizePath } = require('../../src/runtime/request-performance');

test('request performance monitor records bounded normalized route timings', async () => {
  const monitor = createRequestPerformanceMonitor({ slowMs: 0, maxRoutes: 2, maxSlowEvents: 2 });
  const req = { method: 'PATCH', path: '/tasks/task-1234567890123456',
    originalUrl: '/tasks/task-1234567890123456?secret=nope' };
  const res = new EventEmitter();
  res.statusCode = 200;
  monitor.middleware(req, res, () => {});
  res.emit('finish');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.active_requests, 0);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].path, '/tasks/:id');
  assert.equal(snapshot.recent_slow_requests.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test('route templates take precedence over concrete ids', () => {
  assert.equal(normalizePath({ route: { path: '/:id' }, baseUrl: '/tasks' }),
    '/tasks/:id');
});

test('intentional event streams do not become false slow-request alarms', () => {
  const monitor = createRequestPerformanceMonitor({ slowMs: 0 });
  const req = { method: 'GET', path: '/runtime-activity/events' };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.getHeader = name => name.toLowerCase() === 'content-type'
    ? 'text/event-stream; charset=utf-8' : undefined;
  monitor.middleware(req, res, () => {});
  res.emit('close');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.routes[0].streaming_count, 1);
  assert.equal(snapshot.routes[0].slow_count, 0);
  assert.deepEqual(snapshot.recent_slow_requests, []);
});

test('ordinary API requests receive a terminal deadline and abort signal', async () => {
  const monitor = createRequestPerformanceMonitor({ slowMs: 1000, deadlineMs: 10 });
  const req = new EventEmitter();
  req.method = 'POST';
  req.path = '/tasks/task-1234567890123456';
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.writableEnded = true; res.emit('finish'); };
  monitor.middleware(req, res, () => {});
  assert.equal(req.deadlineSignal.aborted, false);
  assert.equal(monitor.snapshot().active[0].deadline_ms, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(req.deadlineSignal.aborted, true);
  assert.equal(req.deadlineSignal.reason.code, 'REQUEST_DEADLINE_EXCEEDED');
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.retryable, true);
  assert.equal(monitor.snapshot().active_requests, 0);
  assert.equal(monitor.snapshot().deadline_exceeded, 1);
});

test('event streams are explicitly excluded from terminal request deadlines', () => {
  let timerCreated = false;
  const monitor = createRequestPerformanceMonitor({
    deadlineMs: 10,
    setTimer: () => { timerCreated = true; return { unref() {} }; },
  });
  const req = new EventEmitter();
  req.method = 'GET';
  req.path = '/runtime-activity/events';
  const res = new EventEmitter();
  res.statusCode = 200;
  monitor.middleware(req, res, () => {});
  assert.equal(timerCreated, false);
  assert.equal(monitor.snapshot().active[0].deadline_ms, null);
  res.emit('close');
});

test('a genuinely hung Express handler returns a retryable 504', async () => {
  const monitor = createRequestPerformanceMonitor({ deadlineMs: 15 });
  const app = express();
  app.use(monitor.middleware);
  app.get('/hang-forever', () => {});
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/hang-forever`);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: 'request exceeded the server deadline',
      code: 'REQUEST_DEADLINE_EXCEEDED',
      retryable: true,
    });
    assert.equal(monitor.snapshot().active_requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
