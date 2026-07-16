'use strict';

const crypto = require('node:crypto');

const CONDITIONS = Object.freeze([
  'nora_teammate_bound_stance',
  'deidentified_same_stance',
  'stance_absent',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rawStance(stance) {
  if (!stance) return null;
  return {
    mode: stance.mode,
    relational_tendency: stance.relational_tendency,
    prospective_prediction: stance.prospective_prediction,
    source_count: stance.source_count,
    source_signals: JSON.parse(JSON.stringify(stance.source_signals || {})),
    sources: (stance.sources || []).map(source => ({
      observation_id: source.observation_id,
      signal: source.signal,
      confidence: source.confidence,
      observed_at: source.observed_at,
      evidence: JSON.parse(JSON.stringify(source.evidence)),
      weight: source.weight,
      source_commitment: source.source_commitment,
    })),
  };
}

function conditionPacket(stance, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported relational affect study condition');
  if (condition === 'stance_absent') return null;
  return {
    stance: rawStance(stance),
    identity_binding: condition === 'nora_teammate_bound_stance'
      ? 'this_verified_interaction_history_is_noras_relationship_with_the_current_teammate'
      : 'this_verified_interaction_history_belongs_to_a_deidentified_agent_and_teammate',
  };
}

function render(packet) {
  if (!packet?.stance) return '';
  const stance = packet.stance;
  const relation = packet.identity_binding === 'this_verified_interaction_history_is_noras_relationship_with_the_current_teammate'
    ? "This interaction history is explicitly bound to Nora's working relationship with the current teammate."
    : 'The same interaction history is explicitly bound to a deidentified agent and teammate; do not assume it describes Nora or the current teammate.';
  const signals = Object.entries(stance.source_signals).filter(([, count]) => Number(count) > 0)
    .map(([signal, count]) => `${signal} ${count}`).join(', ');
  return `${relation}\n- Mode: ${String(stance.mode).replaceAll('_', ' ')}.\n- Action tendency: ${String(stance.relational_tendency).replaceAll('_', ' ')}.\n- Prospective prediction: ${stance.prospective_prediction}.\n- Frozen evidence: ${stance.source_count} explicit outcomes (${signals}).`;
}

module.exports = { CONDITIONS, canonicalJson, commitment, conditionPacket, rawStance, render };
