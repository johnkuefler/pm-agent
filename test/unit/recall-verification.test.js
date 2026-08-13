'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyRecallWebhookRequest, createRecallWebhookVerificationMiddleware }
  = require('../../src/surfaces/meeting/recall-verification');

const secret = `whsec_${Buffer.from('recall-test-secret').toString('base64')}`;
const rawBody = Buffer.from('{"event":"bot.done"}');
const at = new Date('2026-08-13T03:00:00Z');
const timestamp = String(at.getTime() / 1000);

function signature(id = 'msg-1', body = rawBody) {
  return crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body.toString('utf8')}`).digest('base64');
}

test('Recall requests verify with current or legacy Svix headers', () => {
  assert.equal(verifyRecallWebhookRequest({
    headers: { 'webhook-id': 'msg-1', 'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature()}` }, rawBody, secrets: [secret], now: at,
  }), true);
  assert.equal(verifyRecallWebhookRequest({
    headers: { 'svix-id': 'msg-1', 'svix-timestamp': timestamp,
      'svix-signature': `v1,bad v1,${signature()}` }, rawBody, secrets: [secret], now: at,
  }), true);
});

test('tampered, unsigned, and stale Recall requests fail closed', () => {
  assert.throws(() => verifyRecallWebhookRequest({ headers: {}, rawBody,
    secrets: [secret], now: at }), /headers are missing/);
  assert.throws(() => verifyRecallWebhookRequest({
    headers: { 'webhook-id': 'msg-1', 'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature()}` }, rawBody: Buffer.from('tampered'),
    secrets: [secret], now: at,
  }), /does not match/);
  assert.throws(() => verifyRecallWebhookRequest({
    headers: { 'webhook-id': 'msg-1', 'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature()}` }, rawBody, secrets: [secret],
    now: new Date(at.getTime() + 301000),
  }), /outside the verification window/);
});

test('middleware preserves delivery until configured and rejects bad configured requests', () => {
  let advanced = 0;
  const response = { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  createRecallWebhookVerificationMiddleware({ getSecrets: () => [] })(
    { headers: {}, rawBody, path: '/webhook/status' }, response, () => { advanced += 1; });
  assert.equal(advanced, 1);
  createRecallWebhookVerificationMiddleware({ getSecrets: () => [secret],
    logger: { warn() {} }, now: () => at })(
    { headers: {}, rawBody, path: '/webhook/status' }, response, () => { advanced += 1; });
  assert.equal(advanced, 1);
  assert.equal(response.statusCode, 401);
});
