'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const {
  decodeSecret,
  signatureCandidates,
  verifyRecallRequest,
} = require('../../src/integrations/recall-request-verification');

function secret(seed) {
  return `whsec_${Buffer.from(seed).toString('base64')}`;
}

function signedRequest({
  body = { event: 'bot.transcription', data: { bot_id: 'bot-1' } },
  signingSecret = secret('recall-primary-secret'),
  webhookId = 'msg_123',
  timestamp = 1_700_000_000,
  headerFamily = 'webhook',
} = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const key = decodeSecret(signingSecret);
  const signature = crypto.createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.${rawBody.toString('utf8')}`)
    .digest('base64');
  const headers = headerFamily === 'svix'
    ? { 'svix-id': webhookId, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` }
    : { 'webhook-id': webhookId, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
  return { headers, rawBody, signingSecret, now: new Date(timestamp * 1000) };
}

test('Recall verification accepts an exact signed raw body', () => {
  const request = signedRequest();
  const result = verifyRecallRequest({
    headers: request.headers,
    rawBody: request.rawBody,
    secrets: [request.signingSecret],
    now: request.now,
  });
  assert.equal(result.valid, true);
  assert.equal(result.cryptographically_verified, true);
  assert.equal(result.webhook_id, 'msg_123');
  assert.equal(result.matched_secret_index, 0);
});

test('Recall verification accepts legacy Svix headers and rotated signatures', () => {
  const oldSecret = secret('recall-old-secret');
  const currentSecret = secret('recall-current-secret');
  const request = signedRequest({ signingSecret: oldSecret, headerFamily: 'svix' });
  request.headers['svix-signature'] = `v1,${Buffer.from('incorrect').toString('base64')} ${request.headers['svix-signature']}`;
  const result = verifyRecallRequest({
    headers: request.headers,
    rawBody: request.rawBody,
    secrets: [currentSecret, oldSecret],
    now: request.now,
  });
  assert.equal(result.valid, true);
  assert.equal(result.matched_secret_index, 1);
  assert.deepEqual(signatureCandidates(request.headers['svix-signature']).map(item => item.version), ['v1', 'v1']);
});

test('Recall verification rejects tampering, stale requests, and missing raw bodies', () => {
  const request = signedRequest();
  assert.equal(verifyRecallRequest({
    headers: request.headers,
    rawBody: Buffer.from('{}'),
    secrets: request.signingSecret,
    now: request.now,
  }).reason, 'signature_mismatch');
  assert.equal(verifyRecallRequest({
    headers: request.headers,
    rawBody: request.rawBody,
    secrets: request.signingSecret,
    now: new Date(request.now.getTime() + 301_000),
  }).reason, 'missing_or_stale_signature');
  assert.equal(verifyRecallRequest({
    headers: request.headers,
    secrets: request.signingSecret,
    now: request.now,
  }).reason, 'raw_body_unavailable');
});

test('Recall verification fails closed without a secret except for an explicit development override', () => {
  const request = signedRequest();
  assert.deepEqual(verifyRecallRequest({
    headers: request.headers,
    rawBody: request.rawBody,
    secrets: [],
    now: request.now,
  }), {
    valid: false,
    cryptographically_verified: false,
    reason: 'verification_secret_unavailable',
    webhook_id: null,
  });
  assert.equal(verifyRecallRequest({
    headers: request.headers,
    rawBody: request.rawBody,
    secrets: [],
    now: request.now,
    allowUnsigned: true,
  }).valid, true);
});
