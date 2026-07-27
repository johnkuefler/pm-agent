'use strict';

const crypto = require('crypto');

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function header(headers, primary, legacy) {
  return headers?.[primary]
    || headers?.[primary.toLowerCase()]
    || headers?.[legacy]
    || headers?.[legacy.toLowerCase()]
    || null;
}

function decodeSecret(secret) {
  const value = String(secret || '').trim();
  if (!value.startsWith('whsec_')) return null;
  try {
    const decoded = Buffer.from(value.slice('whsec_'.length), 'base64');
    return decoded.length ? decoded : null;
  } catch {
    return null;
  }
}

function signatureCandidates(value) {
  return String(value || '').trim().split(/\s+/).map(entry => {
    const separator = entry.indexOf(',');
    if (separator <= 0) return null;
    return {
      version: entry.slice(0, separator),
      signature: entry.slice(separator + 1),
    };
  }).filter(Boolean);
}

function safeEqualBase64(expected, provided) {
  try {
    const left = Buffer.from(String(expected || ''), 'base64');
    const right = Buffer.from(String(provided || ''), 'base64');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function verifyRecallRequest({
  headers = {},
  rawBody,
  secrets = [],
  now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  allowUnsigned = false,
} = {}) {
  const configuredSecrets = (Array.isArray(secrets) ? secrets : [secrets])
    .map(value => ({ value: String(value || '').trim(), key: decodeSecret(value) }))
    .filter(entry => entry.key);
  if (!configuredSecrets.length) {
    return {
      valid: Boolean(allowUnsigned),
      cryptographically_verified: false,
      reason: allowUnsigned ? 'verification_secret_unavailable_dev_override' : 'verification_secret_unavailable',
      webhook_id: null,
    };
  }

  const webhookId = header(headers, 'webhook-id', 'svix-id');
  const timestamp = header(headers, 'webhook-timestamp', 'svix-timestamp');
  const signature = header(headers, 'webhook-signature', 'svix-signature');
  const nowDate = new Date(now);
  const timestampSeconds = Number(timestamp);
  if (!webhookId || !signature || !Number.isFinite(timestampSeconds)
    || !Number.isFinite(nowDate.getTime())
    || Math.abs(nowDate.getTime() / 1000 - timestampSeconds) > Number(toleranceSeconds)) {
    return {
      valid: false,
      cryptographically_verified: false,
      reason: 'missing_or_stale_signature',
      webhook_id: webhookId || null,
    };
  }
  if (rawBody === undefined || rawBody === null) {
    return {
      valid: false,
      cryptographically_verified: false,
      reason: 'raw_body_unavailable',
      webhook_id: webhookId,
    };
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedPayload = `${webhookId}.${timestamp}.${payload}`;
  const candidates = signatureCandidates(signature).filter(entry => entry.version === 'v1');
  for (let secretIndex = 0; secretIndex < configuredSecrets.length; secretIndex += 1) {
    const expected = crypto.createHmac('sha256', configuredSecrets[secretIndex].key)
      .update(signedPayload)
      .digest('base64');
    if (candidates.some(entry => safeEqualBase64(expected, entry.signature))) {
      return {
        valid: true,
        cryptographically_verified: true,
        reason: null,
        webhook_id: webhookId,
        timestamp: new Date(timestampSeconds * 1000).toISOString(),
        matched_secret_index: secretIndex,
      };
    }
  }
  return {
    valid: false,
    cryptographically_verified: false,
    reason: 'signature_mismatch',
    webhook_id: webhookId,
  };
}

module.exports = {
  DEFAULT_TOLERANCE_SECONDS,
  decodeSecret,
  signatureCandidates,
  verifyRecallRequest,
};
