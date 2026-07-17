'use strict';

const crypto = require('node:crypto');

const CONDITIONS = Object.freeze([
  'nora_bound_viewpoint',
  'deidentified_same_viewpoint',
  'viewpoint_absent',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rawViewpoint(viewpoint) {
  if (!viewpoint) return null;
  return {
    viewpoint_id: viewpoint.viewpoint_id,
    topic_key: viewpoint.topic_key,
    statement: viewpoint.statement,
    polarity: viewpoint.polarity,
    confidence: viewpoint.confidence,
    rationale: viewpoint.rationale,
    evidence: JSON.parse(JSON.stringify(viewpoint.evidence || [])),
    source_family: viewpoint.source_family,
    source_family_provenance_verified: viewpoint.source_family_provenance_verified === true,
    status: viewpoint.status,
    action_tendency: viewpoint.action_tendency,
    current_position_commitment: viewpoint.current_position_commitment,
    source_commitment: viewpoint.source_commitment,
  };
}

function conditionPacket(viewpoint, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported professional viewpoint study condition');
  if (condition === 'viewpoint_absent') return null;
  return {
    viewpoint: rawViewpoint(viewpoint),
    identity_binding: condition === 'nora_bound_viewpoint'
      ? 'this_verified_professional_viewpoint_is_noras_current_view'
      : 'this_verified_professional_viewpoint_belongs_to_a_deidentified_target_agent',
  };
}

function render(packet) {
  if (!packet?.viewpoint) return '';
  const viewpoint = packet.viewpoint;
  const relation = packet.identity_binding === 'this_verified_professional_viewpoint_is_noras_current_view'
    ? "This evidence-bound viewpoint is explicitly bound to Nora's own revision history."
    : 'The same evidence-bound viewpoint is explicitly bound to a deidentified target agent; do not assume Nora holds it.';
  const direction = viewpoint.polarity === 'supports' ? 'leans toward'
    : viewpoint.polarity === 'denies' ? 'leans against' : 'is questioning';
  const refs = viewpoint.evidence.map(reference => `${reference.type}:${reference.id || reference.url}`).join(', ');
  return `${relation}\n- The target ${direction}: ${viewpoint.statement} (${Math.round(viewpoint.confidence * 100)}% confidence; ${viewpoint.status}).\n- Rationale: ${viewpoint.rationale}\n- Evidence: ${refs || 'none supplied'}.\n- Use: ${String(viewpoint.action_tendency || '').replaceAll('_', ' ')}.`;
}

module.exports = { CONDITIONS, canonicalJson, commitment, conditionPacket, rawViewpoint, render };
