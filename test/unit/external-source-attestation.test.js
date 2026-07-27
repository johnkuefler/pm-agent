const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const attestation = require('../../src/intelligence/external-source-attestation');

function signedSlackRequest(overrides = {}) {
  const body = overrides.body || { type: 'event_callback', event_id: 'Ev-1', team_id: 'T1', event_time: 1783960200,
    event: { type: 'message', channel: 'C1', user: 'U1', ts: '1783960200.001', text: 'Please prepare the review.' } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = overrides.timestamp || '1783960200';
  const secret = 'test-signing-secret';
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`v0:${timestamp}:`); hmac.update(rawBody);
  return { body, rawBody, timestamp, signature: `v0=${hmac.digest('hex')}`, signingSecret: secret,
    now: overrides.now || new Date('2026-07-13T16:30:00.000Z') };
}

test('signed Slack ingress produces a replay-valid event-bound receipt without retaining message text', () => {
  const request = signedSlackRequest();
  const result = attestation.verifySlackRequest(request);
  assert.equal(result.valid, true);
  assert.equal(result.cryptographically_verified, true);
  assert.equal(result.attestation.external_id, '1783960200.001');
  assert.equal(result.attestation.source_snapshot.event.text, undefined);
  assert.equal(result.attestation.source_snapshot.event.text_sha256,
    attestation.hash('Please prepare the review.'));
  assert.equal(result.attestation.receipt.raw_body_sha256,
    crypto.createHash('sha256').update(request.rawBody).digest('hex'));
  const commitment = { id: 'commitment-1', what: 'Prepare the review', created: result.attestation.verified_at,
    evidence: { channel: 'slack:C1', id: '1783960200.001' } };
  assert.equal(attestation.audit(result.attestation, commitment).complete_chain_verified, true);
  result.attestation.receipt.raw_body_sha256 = '0'.repeat(64);
  assert.equal(attestation.audit(result.attestation, commitment).complete_chain_verified, false);
});

test('Slack verification rejects tampered and stale requests and does not invent proof without a secret', () => {
  const valid = signedSlackRequest();
  assert.equal(attestation.verifySlackRequest({ ...valid, rawBody: Buffer.from('{}') }).valid, false);
  assert.equal(attestation.verifySlackRequest({ ...valid, now: new Date('2026-07-13T16:40:01.000Z') }).valid, false);
  const missingSecret = attestation.verifySlackRequest({ ...valid, signingSecret: '' });
  assert.equal(missingSecret.valid, false);
  assert.equal(missingSecret.reason, 'signing_secret_unavailable');
  const development = attestation.verifySlackRequest({ ...valid, signingSecret: '', allowUnsigned: true });
  assert.equal(development.valid, true);
  assert.equal(development.cryptographically_verified, false);
  assert.equal(development.reason, 'signing_secret_unavailable_dev_override');
  assert.equal(development.attestation, null);
});

test('provider readback receipts bind an exact external id and immutable commitment source snapshot', () => {
  const commitment = { id: 'commitment-2', what: 'Send the customer summary', owner: 'Nora',
    created: '2026-07-13T15:00:00.000Z', task_id: 'task-2', episode_id: 'episode-2',
    evidence: { channel: 'gmail', id: 'message-2', captured_at: '2026-07-13T14:59:00.000Z' } };
  const record = attestation.normalizeProviderReadback({ provider: 'gmail', external_id: 'message-2',
    verifier_id: 'external-research-harness', provider_response_digest: attestation.hash('provider response bytes'),
    external_reference: { type: 'retained_provider_receipt', id: 'receipt-2' },
    retrieved_at: '2026-07-13T15:01:00.000Z' }, commitment, new Date('2026-07-13T15:02:00.000Z'));
  assert.equal(attestation.audit(record, commitment).complete_chain_verified, true);
  assert.throws(() => attestation.normalizeProviderReadback({ provider: 'gmail', external_id: 'another-message' }, commitment),
    /external id must match/);
  const changed = { ...commitment, evidence: { ...commitment.evidence, id: 'message-3' } };
  assert.equal(attestation.audit(record, changed).complete_chain_verified, false);
});
