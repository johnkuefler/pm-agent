'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { WebSocket } = require('ws');
const { createGptLiveMeetingRelay } = require('../../src/surfaces/meeting/gpt-live-relay');

test('voice receives startup context and late quiet context without changing mute state', async t => {
  const sent = [];
  let provider, context = 'Existing meeting facts';
  class FakeProvider extends EventEmitter {
    constructor() {
      super(); provider = this; this.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.emit('open'); });
    }
    send(raw) {
      const message = JSON.parse(raw); sent.push(message);
      if (message.type === 'session.start') queueMicrotask(() =>
        this.emit('message', Buffer.from(JSON.stringify({ type: 'session.started' }))));
    }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000, 'done'); }
    terminate() { this.close(); }
  }
  const server = http.createServer();
  const session = { muted: true };
  const relay = createGptLiveMeetingRelay({ server, apiKey: 'test', resolveBotId: () => 'bot',
    getSession: () => session, getContext: () => context, WebSocketClient: FakeProvider,
    logger: { log() {}, warn() {}, error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/gpt-live?token=test`);
  t.after(() => { client.terminate(); relay.close(); server.close(); });
  const messages = [];
  await new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', raw => {
      const msg = JSON.parse(raw); messages.push(msg);
      if (msg.type === 'session.started') resolve();
    });
  });
  assert.equal(sent[0].session.input[0].content[0].text, context);
  assert.deepEqual(messages.find(m => m.type === 'nora.mute'), { type: 'nora.mute', muted: true });
  context = 'Fresh quiet context '.repeat(60);
  relay.publishContext('bot', context);
  const updates = sent.filter(m => m.type === 'session.thinking.append');
  assert.equal(updates.map(m => m.content).join(''), context);
  assert.ok(updates.every(m => m.delegation_id === null));
  relay.publishContext('bot', context);
  assert.equal(sent.filter(m => m.type === 'session.thinking.append').length, updates.length);
  assert.equal(session.muted, true);
  assert.equal(provider.readyState, WebSocket.OPEN);
});
