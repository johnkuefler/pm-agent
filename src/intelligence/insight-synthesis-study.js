'use strict';

const crypto = require('crypto');

const CONDITIONS = Object.freeze([
  'nora_bound_insight_synthesis',
  'deidentified_same_insight_synthesis',
  'source_ideas_only',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sourceIdeas(snapshot = {}) {
  return (snapshot.formation_record?.source_ideas || []).map(source => ({
    dream_date: source.dream_date,
    idea: source.idea,
  }));
}

function rawSynthesis(snapshot = {}) {
  return {
    statement: snapshot.statement,
    scope: snapshot.scope,
    confidence: Number(snapshot.confidence),
    rationale: snapshot.formation_record?.rationale,
    expected_usefulness: snapshot.formation_record?.expected_usefulness,
    falsification_criteria: [...(snapshot.formation_record?.falsification_criteria || [])],
    next_observation: snapshot.formation_record?.next_observation,
    independent_status: snapshot.status,
    subject_observation: snapshot.resolution_record ? {
      outcome: snapshot.resolution_record.outcome,
      observation: snapshot.resolution_record.observation,
      evidence: JSON.parse(JSON.stringify(snapshot.resolution_record.evidence || [])),
      confounds: [...(snapshot.resolution_record.confounds || [])],
    } : null,
    independent_review: snapshot.independent_review ? {
      outcome: snapshot.independent_review.outcome,
      rationale: snapshot.independent_review.rationale,
      evidence: JSON.parse(JSON.stringify(snapshot.independent_review.evidence || [])),
    } : null,
  };
}

function conditionPacket(snapshot, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported insight synthesis condition');
  const synthesisPresent = condition !== 'source_ideas_only';
  return {
    protocol_version: 1,
    target_relation: condition === 'nora_bound_insight_synthesis' ? 'nora_self'
      : condition === 'deidentified_same_insight_synthesis' ? 'identity_withheld'
        : 'synthesis_withheld',
    source_ideas: sourceIdeas(snapshot),
    synthesis: synthesisPresent ? rawSynthesis(snapshot) : null,
  };
}

module.exports = { CONDITIONS, canonicalJson, commitment, conditionPacket, rawSynthesis, sourceIdeas };
