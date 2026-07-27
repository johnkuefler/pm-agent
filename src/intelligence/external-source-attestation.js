'use strict';

const crypto = require('crypto');

const PROVIDERS = ['slack', 'meeting', 'gmail', 'email', 'teamwork'];
const SHA256 = /^[a-f0-9]{64}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  const payload = Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value : (typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function slackEventSnapshot(body = {}) {
  const event = body.event || {};
  return {
    provider: 'slack', delivery_event_id: body.event_id || null, team_id: body.team_id || null,
    event_time: body.event_time || null,
    event: { type: event.type || null, subtype: event.subtype || null, channel: event.channel || null,
      channel_type: event.channel_type || null, user: event.user || null, ts: event.ts || null,
      thread_ts: event.thread_ts || null, text_sha256: hash(String(event.text || '')),
      file_ids: (event.files || []).map(file => String(file.id || '')).filter(Boolean).sort() },
  };
}

function verifySlackRequest({
  body = {}, rawBody, timestamp, signature, signingSecret, now = new Date(), allowUnsigned = false,
} = {}) {
  if (!signingSecret) return { valid: Boolean(allowUnsigned), cryptographically_verified: false,
    reason: allowUnsigned ? 'signing_secret_unavailable_dev_override' : 'signing_secret_unavailable',
    attestation: null };
  const seconds = Number(timestamp); const nowDate = new Date(now);
  if (!Number.isFinite(seconds) || !signature || !rawBody || !Number.isFinite(nowDate.getTime())
    || Math.abs(nowDate.getTime() / 1000 - seconds) > 300) {
    return { valid: false, cryptographically_verified: false, reason: 'missing_or_stale_signature', attestation: null };
  }
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(`v0:${timestamp}:`); hmac.update(raw);
  const expected = `v0=${hmac.digest('hex')}`;
  if (!timingSafeEqual(expected, signature)) return { valid: false, cryptographically_verified: false,
    reason: 'signature_mismatch', attestation: null };
  const snapshot = slackEventSnapshot(body); const event = snapshot.event;
  if (!event.channel || !event.ts) return { valid: true, cryptographically_verified: true,
    reason: 'signed_non_event_payload', attestation: null };
  const verifiedAt = nowDate.toISOString();
  const receipt = { protocol_version: 1, verification_method: 'slack_request_signature_v0',
    request_timestamp: String(timestamp), raw_body_sha256: hash(raw), signature_sha256: hash(String(signature)),
    signing_key_fingerprint: hash(String(signingSecret)), delivery_event_id: snapshot.delivery_event_id,
    cryptographically_verified_at_ingress: true };
  const attestation = { id: `source-attestation-slack-${snapshot.delivery_event_id || event.ts}`,
    protocol_version: 1, status: 'provider_verified', provider: 'slack',
    verification_method: 'slack_request_signature_v0', external_id: event.ts,
    source_ref: { channel: `slack:${event.channel}`, id: event.ts, captured_at: verifiedAt },
    source_snapshot: snapshot, source_content_commitment: hash(snapshot), receipt,
    receipt_commitment: hash(receipt), verifier_id: 'pm-agent-slack-ingress', verified_at: verifiedAt };
  return { valid: true, cryptographically_verified: true, reason: null, attestation };
}

function commitmentSourceSnapshot(commitment) {
  return { commitment_id: commitment.id, what_sha256: hash(String(commitment.what || '')),
    created: commitment.created, evidence: commitment.evidence || null, task_id: commitment.task_id || null,
    episode_id: commitment.episode_id || null };
}

function normalizeProviderReadback(input, commitment, now = new Date()) {
  const provider = String(input.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error('unsupported external source attestation provider');
  const externalId = String(input.external_id || '').trim().slice(0, 500);
  if (!externalId || externalId !== String(commitment?.evidence?.id || '')) {
    throw new Error('source attestation external id must match the commitment evidence id');
  }
  const expectedChannel = String(commitment?.evidence?.channel || '').toLowerCase();
  if (!expectedChannel.startsWith(provider === 'email' ? 'email' : provider)) {
    throw new Error('source attestation provider must match the commitment evidence channel');
  }
  const verifierId = String(input.verifier_id || '').trim().slice(0, 200);
  const responseDigest = String(input.provider_response_digest || '').toLowerCase();
  const reference = input.external_reference || {};
  if (!verifierId || !SHA256.test(responseDigest)
    || !reference.type || (!reference.id && !reference.url)) {
    throw new Error('provider readback requires a verifier, SHA-256 response digest, and retained external reference');
  }
  const retrievedAt = new Date(input.retrieved_at); const nowDate = new Date(now);
  if (!Number.isFinite(retrievedAt.getTime()) || retrievedAt > nowDate) throw new Error('provider readback time is invalid');
  const sourceSnapshot = commitmentSourceSnapshot(commitment);
  const receipt = { protocol_version: 1, verification_method: 'provider_api_readback', provider,
    external_id: externalId, provider_response_digest: responseDigest,
    external_reference: { type: String(reference.type).slice(0, 100),
      ...(reference.id ? { id: String(reference.id).slice(0, 500) } : {}),
      ...(reference.url ? { url: String(reference.url).slice(0, 1000) } : {}) },
    retrieved_at: retrievedAt.toISOString() };
  return { id: String(input.id || `source-attestation-${provider}-${externalId}`).slice(0, 300),
    protocol_version: 1, status: 'provider_verified', provider,
    verification_method: 'provider_api_readback', external_id: externalId,
    source_ref: JSON.parse(JSON.stringify(commitment.evidence)), source_snapshot: sourceSnapshot,
    source_content_commitment: hash(sourceSnapshot), receipt, receipt_commitment: hash(receipt),
    verifier_id: verifierId, verified_at: nowDate.toISOString() };
}

function audit(attestation, commitment = null) {
  if (!attestation) return { complete_chain_verified: false, reason: 'missing_attestation' };
  const base = Boolean(attestation.protocol_version === 1 && attestation.status === 'provider_verified'
    && PROVIDERS.includes(attestation.provider) && attestation.external_id && attestation.verifier_id
    && Number.isFinite(new Date(attestation.verified_at).getTime())
    && hash(attestation.source_snapshot) === attestation.source_content_commitment
    && hash(attestation.receipt) === attestation.receipt_commitment);
  let methodVerified = false;
  if (attestation.verification_method === 'slack_request_signature_v0') {
    methodVerified = attestation.provider === 'slack'
      && attestation.receipt?.verification_method === 'slack_request_signature_v0'
      && attestation.receipt?.cryptographically_verified_at_ingress === true
      && SHA256.test(attestation.receipt?.raw_body_sha256 || '')
      && SHA256.test(attestation.receipt?.signature_sha256 || '')
      && SHA256.test(attestation.receipt?.signing_key_fingerprint || '')
      && attestation.source_snapshot?.event?.ts === attestation.external_id
      && String(attestation.source_ref?.id) === String(attestation.external_id)
      && String(attestation.source_ref?.channel || '').toLowerCase()
        === `slack:${String(attestation.source_snapshot?.event?.channel || '').toLowerCase()}`;
  } else if (attestation.verification_method === 'provider_api_readback') {
    methodVerified = attestation.receipt?.verification_method === 'provider_api_readback'
      && attestation.receipt?.provider === attestation.provider
      && attestation.receipt?.external_id === attestation.external_id
      && String(attestation.source_ref?.id) === String(attestation.external_id)
      && SHA256.test(attestation.receipt?.provider_response_digest || '')
      && Boolean(attestation.receipt?.external_reference?.type
        && (attestation.receipt.external_reference.id || attestation.receipt.external_reference.url));
  }
  let commitmentVerified = true;
  if (commitment) {
    commitmentVerified = String(attestation.source_ref?.channel || '').toLowerCase()
      === String(commitment.evidence?.channel || '').toLowerCase()
      && String(attestation.source_ref?.id) === String(commitment.evidence?.id);
    if (attestation.verification_method === 'provider_api_readback') commitmentVerified = commitmentVerified
      && hash(commitmentSourceSnapshot(commitment)) === attestation.source_content_commitment;
  }
  return { structure_verified: base, method_verified: methodVerified,
    commitment_binding_verified: commitmentVerified,
    complete_chain_verified: base && methodVerified && commitmentVerified };
}

function storedRecordPayload(record) {
  return { commitment_id: record?.commitment_id, provider: record?.provider,
    verification_method: record?.verification_method, external_id: record?.external_id,
    source_content_commitment: record?.source_content_commitment,
    receipt_commitment: record?.receipt_commitment, verifier_id: record?.verifier_id,
    attestation_commitment: hash(record) };
}

function auditStored(record, commitment, ledger = {}) {
  const base = commitment ? audit(record, commitment)
    : { ...audit(record), commitment_binding_verified: false, complete_chain_verified: false,
      reason: 'missing_bound_commitment' };
  const expected = hash(storedRecordPayload(record));
  const events = (ledger?.events || []).filter(event => event.kind === 'external_source_attestation_recorded'
    && event.subject_id === record?.id && event.payload_commitment === expected);
  const event = events[0] || null;
  const chronologyVerified = Boolean(event && Number.isFinite(new Date(record?.recorded_at).getTime())
    && new Date(record.recorded_at) >= new Date(record.verified_at)
    && new Date(event.at) >= new Date(record.recorded_at));
  return { ...base, ledger_binding_verified: events.length === 1,
    chronology_verified: chronologyVerified,
    complete_chain_verified: base.complete_chain_verified && events.length === 1 && chronologyVerified };
}

module.exports = { PROVIDERS, canonicalJson, hash, slackEventSnapshot, verifySlackRequest,
  commitmentSourceSnapshot, normalizeProviderReadback, audit, storedRecordPayload, auditStored };
