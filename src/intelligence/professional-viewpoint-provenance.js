'use strict';

const crypto = require('node:crypto');
const epistemicLedger = require('./epistemic-ledger');
const professionalViewpointReflection = require('./professional-viewpoint-reflection');

const PROTOCOL_VERSION = 1;
const ATTESTED_BY = 'nora-platform:deterministic-legacy-viewpoint-provenance:v1';
const CLAIM_SCOPE = 'The legacy formation receipt committed stable evidence snapshots whose recorded channels can now be replay-mapped to one bounded source family. This attestation is post-hoc metadata only: it does not alter the viewpoint, validate its truth, establish source independence beyond the recorded channels, retroactively qualify earlier prompt exposures, or evidence consciousness.';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function formationPosition(proposition = {}) {
  return (proposition.positions || []).find(position => String(position?.recorded_by || '')
    .startsWith(professionalViewpointReflection.RECORDED_BY_PREFIX)) || null;
}

function deriveLegacyProvenance(proposition = {}) {
  if (proposition.proposition_kind !== 'professional_viewpoint'
    || proposition.source_family !== professionalViewpointReflection.LEGACY_SOURCE_FAMILY) return null;
  const position = formationPosition(proposition);
  const receipt = position?.generation_receipt;
  const candidate = receipt?.output?.candidate;
  if (!position || !candidate) return null;
  const receiptAudit = professionalViewpointReflection.auditReceipt(receipt, {
    topicKey: proposition.topic_key,
    statement: proposition.statement,
    position,
    sourceFamily: professionalViewpointReflection.LEGACY_SOURCE_FAMILY,
  });
  if (!receiptAudit.complete_chain_verified) return null;
  const evidenceById = new Map((receipt.source_packet?.evidence || [])
    .map(item => [cleanText(item?.ref?.id), item]).filter(([id]) => id));
  const evidenceIds = [...new Set((candidate.evidence_ids || []).map(id => cleanText(id)).filter(Boolean))];
  const selected = evidenceIds.map(id => evidenceById.get(id));
  if (selected.length < 2 || selected.some(item => !item || item.ref?.type !== 'memory'
    || !cleanText(item.source, 100) || cleanText(item.fact, 700).length < 12)) return null;
  const evidence = selected.map(item => {
    const source = cleanText(item.source, 100);
    const derivedFamily = professionalViewpointReflection.evidenceProvenanceFamily({ source });
    return {
      ref: { type: 'memory', id: cleanText(item.ref.id) },
      source,
      source_channel: professionalViewpointReflection.sourceChannel(source),
      derived_provenance_family: derivedFamily,
      source_snapshot_commitment: commitment(item),
    };
  });
  const families = [...new Set(evidence.map(item => item.derived_provenance_family))].sort();
  const derivedEvidenceFamily = families.length === 1
    ? families[0] : families.length > 1 ? 'cross_channel_work_memory' : null;
  if (!derivedEvidenceFamily) return null;
  return {
    viewpoint_id: proposition.id,
    legacy_source_family: proposition.source_family,
    derived_evidence_family: derivedEvidenceFamily,
    formation_position_id: position.id,
    formation_position_commitment: position.position_commitment,
    formation_receipt_commitment: receipt.receipt_commitment,
    evidence,
  };
}

function attestationPayload(attestation = {}) {
  const copy = JSON.parse(JSON.stringify(attestation));
  delete copy.attestation_commitment;
  return copy;
}

function attestationId(derived = {}) {
  return `professional-viewpoint-provenance-${commitment({
    viewpoint_id: derived.viewpoint_id,
    formation_position_commitment: derived.formation_position_commitment,
    formation_receipt_commitment: derived.formation_receipt_commitment,
  }).slice(0, 24)}`;
}

function createAttestation(proposition, now = new Date()) {
  const derived = deriveLegacyProvenance(proposition);
  if (!derived) throw new Error('legacy professional viewpoint does not have replay-valid attestable provenance');
  const observed = new Date(now);
  if (!Number.isFinite(observed.getTime())) throw new Error('viewpoint provenance attestation requires a valid time');
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    id: attestationId(derived),
    ...derived,
    attested_by: ATTESTED_BY,
    attested_at: observed.toISOString(),
    claim_scope: CLAIM_SCOPE,
  };
  return { ...payload, attestation_commitment: commitment(payload) };
}

function auditAttestation(attestation = {}, proposition = {}) {
  const derived = deriveLegacyProvenance(proposition);
  const checks = {
    protocol_verified: Number(attestation.protocol_version) === PROTOCOL_VERSION,
    content_commitment_verified: Boolean(attestation.attestation_commitment
      && commitment(attestationPayload(attestation)) === attestation.attestation_commitment),
    stable_id_verified: Boolean(derived && attestation.id === attestationId(derived)),
    formation_binding_verified: Boolean(derived
      && attestation.viewpoint_id === derived.viewpoint_id
      && attestation.legacy_source_family === derived.legacy_source_family
      && attestation.derived_evidence_family === derived.derived_evidence_family
      && attestation.formation_position_id === derived.formation_position_id
      && attestation.formation_position_commitment === derived.formation_position_commitment
      && attestation.formation_receipt_commitment === derived.formation_receipt_commitment
      && canonicalJson(attestation.evidence) === canonicalJson(derived.evidence)),
    boundary_verified: attestation.attested_by === ATTESTED_BY
      && attestation.claim_scope === CLAIM_SCOPE,
    time_verified: Number.isFinite(new Date(attestation.attested_at).getTime()),
  };
  return { ...checks, complete_chain_verified: Object.values(checks).every(Boolean) };
}

function eligibleForAttestation(proposition = {}) {
  return proposition.status === 'active'
    && epistemicLedger.auditProposition(proposition).complete_chain_verified
    && !proposition.source_family_provenance_attestation
    && Boolean(deriveLegacyProvenance(proposition));
}

module.exports = {
  PROTOCOL_VERSION, ATTESTED_BY, CLAIM_SCOPE,
  canonicalJson, commitment, cleanText, formationPosition, deriveLegacyProvenance,
  attestationPayload, attestationId, createAttestation, auditAttestation,
  eligibleForAttestation,
};
