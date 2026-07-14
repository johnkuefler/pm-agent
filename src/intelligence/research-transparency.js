'use strict';

const crypto = require('crypto');
const externalSourceAttestation = require('./external-source-attestation');

const PROTOCOL_VERSION = 1;
const SCOPE = 'research_ledger_and_external_source_provenance';

function canonicalJson(value) {
  return externalSourceAttestation.canonicalJson(value);
}

function hash(value) {
  return externalSourceAttestation.hash(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function verifyLedger(ledger = {}) {
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const breaks = [];
  let previousHash = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index] || {};
    const { hash: eventHash, ...base } = event;
    const expectedHash = hash(base);
    if (event.index !== index) breaks.push({ index, reason: 'index_mismatch' });
    if ((event.previous_hash || null) !== previousHash) breaks.push({ index, reason: 'previous_hash_mismatch' });
    if (eventHash !== expectedHash) breaks.push({ index, reason: 'event_hash_mismatch' });
    previousHash = eventHash || null;
  }
  const eventHashes = new Set(events.map(event => event.hash));
  const invalidAnchors = (Array.isArray(ledger.anchors) ? ledger.anchors : [])
    .filter(anchor => !anchor?.head_hash || !eventHashes.has(anchor.head_hash)
      || !anchor.external_reference?.type
      || (!anchor.external_reference.id && !anchor.external_reference.url));
  return { valid: breaks.length === 0 && invalidAnchors.length === 0,
    breaks, invalid_anchors: invalidAnchors.map(anchor => anchor?.id || null),
    event_count: events.length, head_hash: events.at(-1)?.hash || null };
}

function bundleContent(state = {}) {
  const ledger = clone(state.cognition?.research_ledger || { events: [], anchors: [] });
  const attestations = clone(state.cognition?.external_source_attestations || []);
  const commitmentIds = new Set(attestations.map(record => record.commitment_id));
  const commitments = clone((state.commitments || []).filter(commitment => commitmentIds.has(commitment.id)));
  return { protocol_version: PROTOCOL_VERSION, scope: SCOPE, state_version: state.version || null,
    ledger, source_provenance: { commitments, attestations },
    disclosure: { contains_commitment_text: true, contains_raw_provider_message_text: false,
      provider_secret_fields_included: false, external_references_may_be_sensitive: true,
      research_operator_review_required_before_publication: true },
    limitations: [
      'This bundle verifies the exported ledger chain and external-source provenance records, not every scientific outcome or phenomenal consciousness.',
      'A bundle cannot prove its own historical publication time or detect coordinated whole-history replacement unless an independent witness retains its commitment.',
      'Slack replay verifies the retained ingress-verification receipt; the raw signed body and signing secret are intentionally absent.',
      'Provider API readback remains only as strong as the externally retained response named by its reference.',
    ] };
}

function buildBundle(state = {}) {
  const content = bundleContent(state);
  return { ...content, bundle_commitment: hash(content) };
}

function verifyBundle(bundle = {}) {
  const { bundle_commitment: suppliedCommitment, ...content } = clone(bundle || {});
  const commitmentVerified = typeof suppliedCommitment === 'string' && hash(content) === suppliedCommitment;
  const protocolVerified = content.protocol_version === PROTOCOL_VERSION && content.scope === SCOPE;
  const ledger = verifyLedger(content.ledger);
  const commitments = content.source_provenance?.commitments || [];
  const attestations = content.source_provenance?.attestations || [];
  const commitmentMap = new Map(commitments.map(commitment => [commitment.id, commitment]));
  const duplicateCommitments = commitments.length !== commitmentMap.size;
  const attestationIds = attestations.map(record => record.id);
  const duplicateAttestations = new Set(attestationIds).size !== attestationIds.length;
  const attestationAudits = attestations.map(record => ({ id: record.id,
    ...externalSourceAttestation.auditStored(record, commitmentMap.get(record.commitment_id), content.ledger) }));
  const allAttestationsVerified = !duplicateCommitments && !duplicateAttestations
    && attestationAudits.every(audit => audit.complete_chain_verified);
  const attestationEventCount = (content.ledger?.events || [])
    .filter(event => event.kind === 'external_source_attestation_recorded').length;
  const complete = commitmentVerified && protocolVerified && ledger.valid
    && allAttestationsVerified;
  return { complete_chain_verified: complete, bundle_commitment_verified: commitmentVerified,
    protocol_verified: protocolVerified, ledger, source_provenance: {
      commitments: commitments.length, attestations: attestations.length,
      attestation_ledger_events: attestationEventCount,
      historical_attestation_events_not_exported: Math.max(0, attestationEventCount - attestations.length),
      duplicate_commitments: duplicateCommitments, duplicate_attestations: duplicateAttestations,
      all_attestations_verified: allAttestationsVerified, attestation_audits: attestationAudits } };
}

function publicKeyFingerprint(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function createWitnessReceipt(bundle, privateKey, input = {}) {
  const audit = verifyBundle(bundle);
  if (!audit.complete_chain_verified) throw new Error('refuse to witness an invalid research transparency bundle');
  if (!audit.ledger.head_hash) throw new Error('refuse to witness an empty research ledger');
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  const publicKey = crypto.createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('witness signing requires an Ed25519 private key');
  const verifiedAt = new Date(input.verified_at || new Date());
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error('witness verification time is invalid');
  const payload = { protocol_version: PROTOCOL_VERSION, receipt_type: 'research_transparency_witness',
    bundle_commitment: bundle.bundle_commitment, ledger_head_hash: audit.ledger.head_hash,
    verifier_id: String(input.verifier_id || '').trim().slice(0, 200),
    verified_at: verifiedAt.toISOString(), public_key_sha256: publicKeyFingerprint(publicKey) };
  if (!payload.verifier_id) throw new Error('witness verifier_id is required');
  return { payload, signature_algorithm: 'Ed25519',
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64') };
}

function verifyWitnessReceipt(bundle, receipt, publicKey) {
  const bundleAudit = verifyBundle(bundle);
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  const payload = receipt?.payload || {};
  const bindingVerified = payload.protocol_version === PROTOCOL_VERSION
    && payload.receipt_type === 'research_transparency_witness'
    && payload.bundle_commitment === bundle?.bundle_commitment
    && payload.ledger_head_hash === bundleAudit.ledger.head_hash
    && payload.public_key_sha256 === publicKeyFingerprint(key)
    && Boolean(payload.verifier_id) && Number.isFinite(new Date(payload.verified_at).getTime());
  let signatureVerified = false;
  try { signatureVerified = receipt?.signature_algorithm === 'Ed25519'
      && crypto.verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(receipt.signature || '', 'base64')); }
  catch { signatureVerified = false; }
  return { complete_chain_verified: bundleAudit.complete_chain_verified && bindingVerified && signatureVerified,
    bundle_verified: bundleAudit.complete_chain_verified, binding_verified: bindingVerified,
    signature_verified: signatureVerified, public_key_sha256: publicKeyFingerprint(key) };
}

module.exports = { PROTOCOL_VERSION, SCOPE, canonicalJson, hash, verifyLedger, bundleContent,
  buildBundle, verifyBundle, publicKeyFingerprint, createWitnessReceipt, verifyWitnessReceipt };
