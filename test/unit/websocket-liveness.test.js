'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { createWebSocketLivenessMonitor } = require('../../src/runtime/websocket-liveness');
const { createResponseWatchdogMonitor } = require('../../src/runtime/response-watchdog');

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

test('response watchdog releases a realtime turn that never reaches a terminal event', () => {
  let now = new Date('2026-07-23T12:00:00.000Z');
  let tick;
  let recovered = 0;
  const watchdog = createResponseWatchdogMonitor({
    clock: () => now,
    setTimer: fn => { tick = fn; return { unref() {} }; },
    clearTimer() {},
  });
  const owner = {};
  watchdog.arm(owner, {
    timeoutMs: 20000,
    label: 'meeting response (bot-1)',
    onTimeout: () => { recovered += 1; },
  });
  now = new Date('2026-07-23T12:00:20.000Z');
  tick();
  const snapshot = watchdog.snapshot();
  assert.equal(recovered, 1);
  assert.equal(snapshot.active_count, 0);
  assert.equal(snapshot.timed_out, 1);
  assert.equal(snapshot.recent_timeouts[0].label, 'meeting response (bot-1)');
});

test('response watchdog completion and rearming make late timers harmless', () => {
  const timers = [];
  const watchdog = createResponseWatchdogMonitor({
    setTimer: fn => {
      timers.push(fn);
      return { unref() {} };
    },
    // Deliberately leave callbacks runnable to prove generation ownership, not timer cancellation,
    // prevents an old response from timing out the replacement.
    clearTimer() {},
  });
  const owner = {};
  let recovered = 0;
  watchdog.arm(owner, { timeoutMs: 20000, onTimeout: () => { recovered += 1; } });
  watchdog.arm(owner, { timeoutMs: 20000, onTimeout: () => { recovered += 1; } });
  timers[0]();
  assert.equal(recovered, 0);
  assert.equal(watchdog.snapshot().active_count, 1);
  assert.equal(watchdog.finish(owner), true);
  timers[1]();
  assert.equal(recovered, 0);
  assert.equal(watchdog.snapshot().completed, 1);
});

test('response watchdog follows response progress instead of truncating a long healthy answer', () => {
  let now = new Date('2026-07-23T12:00:00.000Z');
  const timers = [];
  const watchdog = createResponseWatchdogMonitor({
    clock: () => now,
    setTimer: fn => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimer() {},
  });
  const owner = {};
  let recovered = 0;
  watchdog.arm(owner, { timeoutMs: 20000, onTimeout: () => { recovered += 1; } });
  now = new Date('2026-07-23T12:00:19.000Z');
  assert.equal(watchdog.touch(owner), true);
  timers[0]();
  assert.equal(recovered, 0, 'the pre-progress timer no longer owns the response');
  assert.equal(watchdog.snapshot().active[0].age_ms, 0);
  now = new Date('2026-07-23T12:00:39.000Z');
  timers[1]();
  assert.equal(recovered, 1, 'twenty seconds without further progress is terminal');
});

test('meeting response watchdog is tied to the current provider socket', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /voiceResponseWatchdog\.arm\(openaiWs,[\s\S]{0,500}session\.openaiWs === openaiWs/,
    'the timeout callback must prove that it still owns the live session');
  assert.match(server, /voiceResponseWatchdog\.finish\(previous, 'cancelled'\)/,
    'reconnect must retire the previous response timer');
  assert.match(server, /response\.done[\s\S]{0,250}s\.openaiWs !== openaiWs\) return/,
    'a late terminal event from an old provider socket must not release a newer response');
});
