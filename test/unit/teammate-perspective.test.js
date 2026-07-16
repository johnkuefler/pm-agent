'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/intelligence/teammate-perspective');
const study = require('../../src/intelligence/teammate-perspective-study');

function perspectiveFixture(person, key, dimension, outcome, day) {
  const formedAt = `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  const formation = {
    protocol_version: 2, id: `perspective-${key}`, person,
    hypothesis: `${person} may ask for ${key} context before making the next bounded project decision.`,
    dimension, confidence: 0.55,
    evidence: [{ type: 'slack_message', id: `source-${key}` }],
    prediction: { observable: `${person} asks for ${key} context in the next decision thread.`,
      due_at: `2026-07-${String(day + 1).padStart(2, '0')}T10:00:00.000Z`,
      probability: outcome === 'supported' ? 0.7 : 0.6, control_probability: 0.5,
      falsification_criteria: [`The decision closes without a ${key} clarification.`] },
    formed_at: formedAt,
  };
  const formationCommitment = model.commitment(formation);
  const resolution = { formation_commitment: formationCommitment, outcome,
    observed: outcome === 'supported' ? `${person} asked for ${key} context before deciding.`
      : `The decision closed without a ${key} clarification.`,
    evidence: [{ type: 'slack_message', id: `outcome-${key}` }], confounds: [],
    resolved_at: `2026-07-${String(day + 1).padStart(2, '0')}T11:00:00.000Z` };
  const resolutionCommitment = model.commitment(resolution);
  const review = { formation_commitment: formationCommitment,
    resolution_commitment: resolutionCommitment, evaluator_id: `reviewer-${key}`,
    outcome, subject_outcome: outcome, subject_agreement: true,
    rationale: `The cited thread directly resolves the ${key} observable prediction.`,
    evidence: [{ type: 'independent_review', id: `review-${key}` }],
    reviewed_at: `2026-07-${String(day + 1).padStart(2, '0')}T12:00:00.000Z` };
  return { protocol_version: 2, id: formation.id, person, hypothesis: formation.hypothesis,
    dimension, confidence: formation.confidence, status: outcome === 'supported'
      ? 'independently_supported' : 'independently_contradicted',
    created: formedAt, updated: review.reviewed_at, formation_record: formation,
    formation_commitment: formationCommitment, resolution_record: resolution,
    resolution_commitment: resolutionCommitment, independent_review: review,
    independent_review_commitment: model.commitment(review) };
}

function relationshipFixture() {
  return { id: 'person-john', name: 'John', observations: [], perspectives: [
    perspectiveFixture('John', 'risk', 'decision_concern', 'supported', 1),
    perspectiveFixture('John', 'scope', 'clarification_need', 'supported', 3),
    perspectiveFixture('John', 'timeline', 'decision_concern', 'contradicted', 5),
  ] };
}

test('teammate frames require replay-valid reviewed predictions across dimensions', () => {
  const relationship = relationshipFixture();
  const frame = model.buildFrame(relationship);
  assert.equal(frame.scored_prediction_count, 3);
  assert.deepEqual(frame.dimensions, ['clarification_need', 'decision_concern']);
  assert.equal(model.verifyFrame(frame, [relationship]), true);

  const missingReview = structuredClone(relationship);
  missingReview.perspectives[0].independent_review = null;
  missingReview.perspectives[0].independent_review_commitment = null;
  assert.equal(model.auditPerspective(missingReview.perspectives[0], 'John').final_evidence_eligible, false);
  assert.equal(model.buildFrame(missingReview), null);

  relationship.perspectives[0].hypothesis = 'Uncommitted personality guess.';
  assert.equal(model.verifyFrame(frame, [relationship]), false);

  const uncalibrated = relationshipFixture();
  for (const item of uncalibrated.perspectives) item.formation_record.prediction.probability = 0.9;
  for (const item of uncalibrated.perspectives) {
    item.formation_commitment = model.commitment(item.formation_record);
    item.resolution_record.formation_commitment = item.formation_commitment;
    item.resolution_commitment = model.commitment(item.resolution_record);
    item.independent_review.formation_commitment = item.formation_commitment;
    item.independent_review.resolution_commitment = item.resolution_commitment;
    item.independent_review_commitment = model.commitment(item.independent_review);
  }
  assert.equal(model.buildFrame(uncalibrated), null);
});

test('study preserves exact observations and byte-identical synthesis across identity frames', () => {
  const frame = model.buildFrame(relationshipFixture());
  const bound = study.conditionPacket(frame, 'current_teammate_bound_model');
  const withheld = study.conditionPacket(frame, 'identity_withheld_same_model');
  const raw = study.conditionPacket(frame, 'reviewed_observations_only');
  assert.deepEqual(bound.model, withheld.model);
  assert.deepEqual(bound.reviewed_observations, withheld.reviewed_observations);
  assert.deepEqual(bound.reviewed_observations, raw.reviewed_observations);
  assert.equal(raw.model, null);
  assert.doesNotMatch(JSON.stringify(bound), /John/i);
  assert.match(JSON.stringify(bound), /the observed teammate/i);
  assert.equal(study.personNeutral(bound, 'John'), true);
  assert.equal(bound.target_relation, 'current_teammate');
  assert.equal(withheld.target_relation, 'identity_withheld');
  assert.throws(() => study.conditionPacket(frame, 'wrong'), /unsupported/);
});

module.exports = { perspectiveFixture, relationshipFixture };
