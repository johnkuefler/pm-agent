'use strict';

const crypto = require('node:crypto');

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function headerValue(headers, current, legacy) {
  return String(headers?.[current] || headers?.[legacy] || '').trim();
}

function verifyRecallWebhookRequest({ headers = {}, rawBody, secrets = [], now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = {}) {
  const usableSecrets = [...new Set(secrets.filter(secret =>
    typeof secret === 'string' && secret.startsWith('whsec_')))];
  if (!usableSecrets.length) throw new Error('Recall verification secret is missing');
  const messageId = headerValue(headers, 'webhook-id', 'svix-id');
  const messageTimestamp = headerValue(headers, 'webhook-timestamp', 'svix-timestamp');
  const messageSignatures = headerValue(headers, 'webhook-signature', 'svix-signature');
  if (!messageId || !messageTimestamp || !messageSignatures) {
    throw new Error('Recall verification headers are missing');
  }
  const timestampSeconds = Number(messageTimestamp);
  const nowSeconds = new Date(now).getTime() / 1000;
  if (!Number.isFinite(timestampSeconds) || !Number.isFinite(nowSeconds)
    || Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new Error('Recall webhook timestamp is outside the verification window');
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const signatures = messageSignatures.split(' ').map(item => item.split(','))
    .filter(([version, signature]) => version === 'v1' && signature);
  for (const secret of usableSecrets) {
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expected = crypto.createHmac('sha256', key)
      .update(`${messageId}.${messageTimestamp}.${payload}`).digest();
    for (const [, signature] of signatures) {
      const received = Buffer.from(signature, 'base64');
      if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) {
        return true;
      }
    }
  }
  throw new Error('Recall webhook signature does not match');
}

function createRecallWebhookVerificationMiddleware({ getSecrets, logger = console,
  allowUntilConfigured = true, now = () => new Date() } = {}) {
  return function verifyRecallWebhook(req, res, next) {
    const secrets = (typeof getSecrets === 'function' ? getSecrets() : [])
      .filter(Boolean);
    if (!secrets.length && allowUntilConfigured) return next();
    try {
      verifyRecallWebhookRequest({ headers: req.headers, rawBody: req.rawBody,
        secrets, now: now() });
      return next();
    } catch (error) {
      logger.warn?.(`Rejected unverified Recall webhook at ${req.path || req.url}: ${error.message}`);
      return res.status(401).json({ error: 'Recall webhook verification failed' });
    }
  };
}

module.exports = { DEFAULT_TOLERANCE_SECONDS, verifyRecallWebhookRequest,
  createRecallWebhookVerificationMiddleware };
