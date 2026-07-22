'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { createWebSocketLivenessMonitor } = require('../../src/runtime/websocket-liveness');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.pings = 0;
    this.terminated = false;
    this.pingError = null;
  }
  ping(callback) { this.pings += 1; callback?.(this.pingError); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
}

test('heartbeat recycles a half-open WebSocket after one unanswered ping', () => {
  let tick;
  let now = new Date('2026-07-22T20:00:00.000Z');
  const warnings = [];
  const monitor = createWebSocketLivenessMonitor({
    intervalMs: 15000,
    clock: () => now,
    setTimer: fn => { tick = fn; return { unref() {} }; },
    clearTimer: () => {},
    logger: { warn: message => warnings.push(message) },
  });
  const socket = new FakeSocket();
  monitor.attach(socket, 'OpenAI realtime (test)');
  tick();
  assert.equal(socket.pings, 1);
  assert.equal(monitor.snapshot().active[0].awaiting_pong, true);
  socket.emit('pong');
  assert.equal(monitor.snapshot().active[0].awaiting_pong, false);
  tick();
  now = new Date('2026-07-22T20:00:30.000Z');
  tick();
  assert.equal(socket.terminated, true);
  assert.equal(monitor.snapshot().active_count, 0);
  assert.equal(monitor.snapshot().stale_terminations, 1);
  assert.equal(monitor.snapshot().recent_stale[0].reason, 'pong_timeout');
  assert.match(warnings[0], /became stale/);
});

test('ordinary socket traffic proves liveness even before a pong arrives', () => {
  let tick;
  const monitor = createWebSocketLivenessMonitor({
    setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer: () => {},
    logger: { warn() {} },
  });
  const socket = new FakeSocket();
  monitor.attach(socket, 'Recall voice relay (test)');
  tick();
  socket.emit('message', Buffer.from('audio'));
  tick();
  assert.equal(socket.terminated, false);
  assert.equal(socket.pings, 2);
});

test('meeting page reuses one microphone and reconnects with bounded backoff', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'voice-agent.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(html, /if \(micCaptureReady\) return;[\s\S]*if \(micCapturePromise\) return micCapturePromise;/,
    'a relay reconnect must not create another microphone pipeline');
  assert.match(html, /Relay WebSocket handshake timed out/,
    'the browser-side relay handshake must have a terminal timeout');
  assert.match(html, /Math\.min\(15000, 1000 \* \(2 \*\* Math\.min\(reconnectAttempt, 4\)\)\)/,
    'meeting reconnects must use bounded exponential backoff');
  assert.match(server, /sessions\[botId\]\.openaiWs === openaiWs/,
    'an older socket close must not clear a newer upstream connection');
  assert.match(server, /websocketLiveness\.attach\(openaiWs/,
    'the OpenAI realtime socket must be heartbeat-monitored');
});
