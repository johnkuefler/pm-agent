'use strict';

const crypto = require('node:crypto');
const dreamInsight = require('./dream-insight');

const ALLOWED_SCOPES = new Set(['project', 'process', 'team']);
const PHENOMENAL_CLAIM = /\b(conscious(?:ness)?|sentien(?:t|ce)|qualia|phenomenal|subjective experience)\b/i;

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createCandidate({ dreams = [], input = {}, now = new Date(),
  provenanceClaim = 'submitted_as_nora_nightly_reflection', generationReceipt = null } = {}) {
  const statement = cleanText(input.statement, 1200);
  const rationale = cleanText(input.rationale, 1600);
  const expectedUsefulness = cleanText(input.expected_usefulness, 1200);
  const nextObservation = cleanText(input.next_observation, 1200);
  const falsificationCriteria = [...new Set((Array.isArray(input.falsification_criteria)
    ? input.falsification_criteria : []).map(value => cleanText(value, 600)).filter(Boolean))].slice(0, 8);
  const sourceRefs = Array.isArray(input.source_ideas) ? input.source_ideas.slice(0, 8) : [];
  const confidence = Number(input.confidence);
  if (statement.length < 20 || rationale.length < 20 || expectedUsefulness.length < 10
    || nextObservation.length < 10 || !falsificationCriteria.length) {
    throw new Error('statement, rationale, expected_usefulness, falsification_criteria, and next_observation are required');
  }
  if (PHENOMENAL_CLAIM.test(statement)) {
    throw new Error('dream insight candidates cannot assert phenomenal status');
  }
  if (!ALLOWED_SCOPES.has(input.scope)) throw new Error('dream insight scope must be project, process, or team');
  if (!Number.isFinite(confidence) || confidence < 0.1 || confidence > 0.7) {
    throw new Error('dream insight confidence must be between 0.1 and 0.7');
  }
  if (sourceRefs.length < 2) throw new Error('dream insights require ideas from at least two date-separated dream records');
  const sourceIdeas = sourceRefs.map(ref => {
    const dream = dreams.find(candidate => candidate.id === ref.dream_id);
    const index = Number(ref.idea_index);
    const idea = Number.isInteger(index) ? dream?.reflection?.ideas?.[index] : null;
    if (!dream || typeof idea !== 'string' || !idea.trim() || idea.length > 1600) {
      throw new Error('each source idea must resolve to an exact bounded stored dream idea');
    }
    return { dream_id: dream.id, dream_date: dream.date, idea_index: index, idea };
  });
  if (new Set(sourceIdeas.map(source => source.dream_id)).size !== sourceIdeas.length
    || new Set(sourceIdeas.map(source => source.dream_date)).size !== sourceIdeas.length) {
    throw new Error('dream insight sources must come from distinct dreams on distinct dates');
  }
  const existing = dreamInsight.dreamInsights(dreams).map(({ insight }) => insight);
  if (existing.filter(insight => insight.status === 'candidate').length >= 10) {
    throw new Error('at most ten open dream insight candidates are allowed');
  }
  if (existing.some(insight => insight.status === 'candidate'
    && cleanText(insight.statement, 1200).toLowerCase() === statement.toLowerCase())) {
    throw new Error('an open dream insight candidate already has this statement');
  }
  const formedAt = new Date(now).toISOString();
  const id = cleanText(input.id, 300)
    || `dream-insight-${new Date(now).getTime()}-${crypto.randomBytes(2).toString('hex')}`;
  if (existing.some(insight => insight.id === id)) throw new Error('dream insight id already exists');
  const formationRecord = {
    id, statement, scope: input.scope, confidence,
    rationale, expected_usefulness: expectedUsefulness,
    falsification_criteria: falsificationCriteria, next_observation: nextObservation,
    source_ideas: sourceIdeas, provenance_claim: cleanText(provenanceClaim, 160), formed_at: formedAt,
    ...(generationReceipt ? { generation_receipt_commitment: generationReceipt.receipt_commitment } : {}),
  };
  const insight = {
    id, statement: formationRecord.statement, scope: formationRecord.scope, confidence,
    status: 'candidate', formed_at: formedAt, formation_record: formationRecord,
    formation_commitment: dreamInsight.commitment(formationRecord),
    ...(generationReceipt ? { generation_receipt: JSON.parse(JSON.stringify(generationReceipt)) } : {}),
    resolution_record: null, resolution_commitment: null,
    independent_review: null, independent_review_commitment: null,
  };
  const anchor = sourceIdeas.map(source => dreams.find(dream => dream.id === source.dream_id))
    .sort((left, right) => new Date(right.finished || right.started || 0)
      - new Date(left.finished || left.started || 0))[0];
  anchor.reflection = anchor.reflection || {};
  anchor.reflection.insight_candidates = anchor.reflection.insight_candidates || [];
  anchor.reflection.insight_candidates.push(insight);
  return { insight, anchor, dreams };
}

module.exports = { ALLOWED_SCOPES, PHENOMENAL_CLAIM, cleanText, createCandidate };
