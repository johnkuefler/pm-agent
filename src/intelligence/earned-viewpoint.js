'use strict';

const crypto = require('node:crypto');
const epistemicLedger = require('./epistemic-ledger');
const professionalViewpointReflection = require('./professional-viewpoint-reflection');
const professionalViewpointReappraisal = require('./professional-viewpoint-reappraisal');
const professionalViewpointProvenance = require('./professional-viewpoint-provenance');

const PROTOCOL_VERSION = 1;
const PROPOSITION_KIND = 'professional_viewpoint';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function referenceKey(reference) {
  return `${String(reference?.type || '').trim().toLowerCase()}:${String(reference?.id || reference?.url || '').trim()}`;
}

function distinctReferences(references = []) {
  return [...new Map(references.filter(reference => reference?.type && (reference.id || reference.url))
    .map(reference => [referenceKey(reference), clone(reference)])).values()];
}

function noraAuthored(recordedBy) {
  return /^nora(?:$|[-_:])/i.test(String(recordedBy || '').trim());
}

function currentNoraPosition(proposition) {
  const positions = epistemicLedger.currentPositions(proposition)
    .filter(position => position.owner_type === 'nora_belief');
  return positions.length === 1 ? positions[0] : null;
}

function eligibility(proposition, opts = {}) {
  const position = currentNoraPosition(proposition || {});
  const evidence = distinctReferences(position?.evidence);
  const sourceEvidence = distinctReferences(proposition?.source_family_evidence);
  const reflectionAuthored = String(position?.recorded_by || '')
    .startsWith(professionalViewpointReflection.RECORDED_BY_PREFIX);
  const reappraisalAuthored = String(position?.recorded_by || '')
    .startsWith(professionalViewpointReappraisal.RECORDED_BY_PREFIX);
  const formationPosition = (proposition?.positions || []).find(candidate =>
    String(candidate?.recorded_by || '').startsWith(professionalViewpointReflection.RECORDED_BY_PREFIX));
  const formationCandidate = formationPosition?.generation_receipt?.output?.candidate || null;
  const derivedSourceFamily = formationCandidate
    ? professionalViewpointReflection.sourceFamilyForCandidate(
      formationPosition.generation_receipt.source_packet, formationCandidate) : null;
  const formationReceiptAudit = formationPosition
    ? professionalViewpointReflection.auditReceipt(formationPosition.generation_receipt, {
      topicKey: proposition?.topic_key, statement: proposition?.statement,
      position: formationPosition, sourceFamily: proposition?.source_family,
    }) : null;
  const nativeSourceFamilyProvenanceVerified = Boolean(derivedSourceFamily
    && derivedSourceFamily === proposition?.source_family
    && formationReceiptAudit?.complete_chain_verified);
  const provenanceAttestation = proposition?.source_family_provenance_attestation || null;
  const provenanceAttestationAudit = provenanceAttestation
    ? professionalViewpointProvenance.auditAttestation(provenanceAttestation, proposition) : null;
  const attestationLedgerBound = Boolean(provenanceAttestationAudit?.complete_chain_verified
    && typeof opts.isProvenanceAttestationLedgerBound === 'function'
    && opts.isProvenanceAttestationLedgerBound(provenanceAttestation, proposition) === true);
  const sourceFamilyProvenanceVerified = nativeSourceFamilyProvenanceVerified
    || attestationLedgerBound;
  const generationReceiptAudit = reflectionAuthored
    ? professionalViewpointReflection.auditReceipt(position?.generation_receipt, {
      topicKey: proposition?.topic_key, statement: proposition?.statement, position,
      sourceFamily: proposition?.source_family,
    }) : reappraisalAuthored
      ? professionalViewpointReappraisal.auditReceipt(position?.generation_receipt,
        { proposition, position }) : null;
  const checks = {
    professional_viewpoint: proposition?.proposition_kind === PROPOSITION_KIND,
    active: proposition?.status === 'active',
    position_chain_verified: epistemicLedger.auditProposition(proposition || {}).complete_chain_verified,
    single_current_nora_position: Boolean(position),
    nora_authored: Boolean(position && noraAuthored(position.recorded_by)),
    subject_generation_receipt_verified: !reflectionAuthored && !reappraisalAuthored
      || generationReceiptAudit?.complete_chain_verified === true,
    source_family_binding_verified: !formationPosition || formationReceiptAudit?.complete_chain_verified === true,
    position_evidence_minimum_met: evidence.length >= 2,
    source_family_evidence_minimum_met: sourceEvidence.length >= 2,
  };
  return { eligible: Object.values(checks).every(Boolean), checks, position, evidence,
    source_evidence: sourceEvidence, generation_receipt_audit: generationReceiptAudit,
    formation_receipt_audit: formationReceiptAudit,
    provenance_attestation_audit: provenanceAttestationAudit,
    source_family_provenance_verified: sourceFamilyProvenanceVerified,
    source_family_provenance_method: nativeSourceFamilyProvenanceVerified
      ? 'formation_receipt' : attestationLedgerBound ? 'legacy_posthoc_attestation' : null };
}

function sourceCommitment(proposition) {
  return commitment(clone(proposition));
}

function statusFor(position) {
  if (position.polarity === 'uncertain') return 'questioning';
  return position.confidence >= 0.55 ? 'held' : 'forming';
}

function tendencyFor(status) {
  if (status === 'held') return 'apply_when_relevant_and_seek_disconfirmation';
  if (status === 'forming') return 'treat_as_working_hypothesis';
  return 'verify_before_using';
}

function viewpointFor(proposition, opts = {}) {
  const audit = eligibility(proposition, opts);
  if (!audit.eligible) return null;
  const position = audit.position;
  const status = statusFor(position);
  return {
    viewpoint_id: proposition.id,
    topic_key: proposition.topic_key,
    statement: proposition.statement,
    polarity: position.polarity,
    confidence: position.confidence,
    rationale: position.rationale,
    evidence: audit.evidence,
    source_family: proposition.source_family,
    source_family_provenance_verified: audit.source_family_provenance_verified,
    source_family_provenance_method: audit.source_family_provenance_method,
    formed_at: proposition.created,
    updated_at: proposition.updated,
    current_position_id: position.id,
    current_position_commitment: position.position_commitment,
    revision_count: (proposition.positions || []).filter(candidate => candidate.owner_type === 'nora_belief').length - 1,
    status,
    action_tendency: tendencyFor(status),
    source_commitment: sourceCommitment(proposition),
  };
}

function derive(propositions = [], observedAt = new Date(), opts = {}) {
  const observed = new Date(observedAt);
  if (!Number.isFinite(observed.getTime())) throw new Error('earned viewpoint projection requires a valid observation time');
  const professional = propositions.filter(proposition => proposition?.proposition_kind === PROPOSITION_KIND);
  const viewpoints = professional.map(proposition => viewpointFor(proposition, opts)).filter(Boolean)
    .sort((left, right) => left.viewpoint_id.localeCompare(right.viewpoint_id));
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    observed_at: observed.toISOString(),
    active_professional_viewpoint_count: professional.filter(item => item.status === 'active').length,
    retired_professional_viewpoint_count: professional.filter(item => item.status === 'retired').length,
    eligible_viewpoint_count: viewpoints.length,
    withheld_viewpoint_count: professional.filter(item => item.status === 'active').length - viewpoints.length,
    viewpoints,
  };
  return { ...payload, content_commitment: commitment(payload) };
}

function verify(record) {
  if (!record || Number(record.protocol_version) !== PROTOCOL_VERSION || !Array.isArray(record.viewpoints)) return false;
  const { content_commitment, ...payload } = record;
  return /^[a-f0-9]{64}$/.test(String(content_commitment || ''))
    && commitment(payload) === content_commitment;
}

function audit(record, propositions = [], opts = {}) {
  const contentCommitmentVerified = verify(record);
  let deterministicReplayVerified = false;
  if (contentCommitmentVerified) {
    try {
      deterministicReplayVerified = derive(propositions, record.observed_at, opts).content_commitment === record.content_commitment;
    } catch { deterministicReplayVerified = false; }
  }
  const sourceBindingsVerified = contentCommitmentVerified && record.viewpoints.every(viewpoint => {
    const proposition = propositions.find(item => item.id === viewpoint.viewpoint_id);
    return Boolean(proposition && sourceCommitment(proposition) === viewpoint.source_commitment
      && eligibility(proposition, opts).eligible);
  });
  return {
    content_commitment_verified: contentCommitmentVerified,
    source_bindings_verified: sourceBindingsVerified,
    deterministic_replay_verified: deterministicReplayVerified,
    complete_chain_verified: contentCommitmentVerified && sourceBindingsVerified && deterministicReplayVerified,
  };
}

function render(viewpoints = []) {
  return viewpoints.map(viewpoint => {
    const direction = viewpoint.polarity === 'supports' ? 'I currently lean toward'
      : viewpoint.polarity === 'denies' ? 'I currently lean against' : 'I am actively questioning';
    const refs = viewpoint.evidence.map(reference => `${reference.type}:${reference.id || reference.url}`).join(', ');
    return `- ${direction}: ${viewpoint.statement} (${Math.round(viewpoint.confidence * 100)}% confidence; ${viewpoint.status}).\n  Why: ${viewpoint.rationale}\n  Evidence: ${refs}.\n  Use: ${viewpoint.action_tendency.replaceAll('_', ' ')}.`;
  }).join('\n');
}

module.exports = {
  PROTOCOL_VERSION, PROPOSITION_KIND, audit, canonicalJson, commitment, derive,
  distinctReferences, eligibility, noraAuthored, render, sourceCommitment, verify, viewpointFor,
};
