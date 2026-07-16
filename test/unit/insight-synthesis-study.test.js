'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dreamInsight = require('../../src/intelligence/dream-insight');
const study = require('../../src/intelligence/insight-synthesis-study');

function fixture() {
  const dreams = [
    { id: 'dream-a', date: '2026-07-01', reflection: { ideas: ['Handoffs fail when ownership changes after scoping.'] } },
    { id: 'dream-b', date: '2026-07-03', reflection: { ideas: ['Late ownership changes keep producing handoff ambiguity.'] } },
  ];
  const formation = {
    id: 'insight-a', statement: 'Late ownership changes may be the common cause of avoidable handoff ambiguity.',
    scope: 'process', confidence: 0.55,
    rationale: 'The same directional mechanism recurred on separate review dates.',
    expected_usefulness: 'Checking ownership timing may improve handoff planning.',
    falsification_criteria: ['The next three handoff gaps retain stable ownership.'],
    next_observation: 'Classify ownership timing for the next reported handoff gap.',
    source_ideas: [
      { dream_id: 'dream-a', dream_date: '2026-07-01', idea_index: 0,
        idea: dreams[0].reflection.ideas[0] },
      { dream_id: 'dream-b', dream_date: '2026-07-03', idea_index: 0,
        idea: dreams[1].reflection.ideas[0] },
    ],
    provenance_claim: 'submitted_as_nora_nightly_reflection', formed_at: '2026-07-03T06:00:00.000Z',
  };
  const formationCommitment = dreamInsight.commitment(formation);
  const resolution = { formation_commitment: formationCommitment, outcome: 'supported',
    observation: 'The next handoff gap followed a late ownership change.',
    evidence: [{ type: 'decision_trace', id: 'trace-a' }], confounds: [],
    resolved_at: '2026-07-05T06:00:00.000Z' };
  const resolutionCommitment = dreamInsight.commitment(resolution);
  const review = { formation_commitment: formationCommitment,
    resolution_commitment: resolutionCommitment, evaluator_id: 'independent-reviewer',
    outcome: 'supported', subject_outcome: 'supported', subject_agreement: true,
    rationale: 'The cited trace independently matches the preregistered mechanism.',
    evidence: [{ type: 'independent_review', id: 'review-a' }],
    reviewed_at: '2026-07-05T07:00:00.000Z' };
  dreams[1].reflection.insight_candidates = [{ id: formation.id, statement: formation.statement,
    scope: formation.scope, confidence: formation.confidence, status: 'independently_supported',
    formed_at: formation.formed_at, formation_record: formation,
    formation_commitment: formationCommitment, resolution_record: resolution,
    resolution_commitment: resolutionCommitment, independent_review: review,
    independent_review_commitment: dreamInsight.commitment(review) }];
  return dreams;
}

test('supported dream insight snapshots fail closed when a source idea changes', () => {
  const dreams = fixture();
  const snapshot = dreamInsight.eligibleSnapshots(dreams)[0];
  assert.equal(dreamInsight.verifyFinalSnapshot(snapshot, dreams), true);
  dreams[0].reflection.ideas[0] = 'Rewritten source idea';
  assert.equal(dreamInsight.verifyFinalSnapshot(snapshot, dreams), false);
});

test('support labels cannot substitute for a complete committed lifecycle', () => {
  const dreams = fixture();
  const insight = dreams[1].reflection.insight_candidates[0];
  const complete = dreamInsight.insightAudit(insight, dreams);
  assert.equal(complete.final_evidence_eligible, true);

  const noReview = structuredClone(insight);
  noReview.independent_review = null;
  noReview.independent_review_commitment = null;
  assert.equal(dreamInsight.insightAudit(noReview, dreams).final_evidence_eligible, false);

  const statusMismatch = structuredClone(insight);
  statusMismatch.status = 'independently_contradicted';
  assert.equal(dreamInsight.insightAudit(statusMismatch, dreams).final_evidence_eligible, false);

  const projectionTamper = structuredClone(insight);
  projectionTamper.statement = 'An uncommitted replacement synthesis.';
  assert.equal(dreamInsight.insightAudit(projectionTamper, dreams).final_evidence_eligible, false);
});

test('insight study preserves source ideas and byte-identical synthesis across identity bindings', () => {
  const snapshot = dreamInsight.eligibleSnapshots(fixture())[0];
  const bound = study.conditionPacket(snapshot, 'nora_bound_insight_synthesis');
  const deidentified = study.conditionPacket(snapshot, 'deidentified_same_insight_synthesis');
  const sources = study.conditionPacket(snapshot, 'source_ideas_only');
  assert.deepEqual(bound.synthesis, deidentified.synthesis);
  assert.deepEqual(bound.source_ideas, deidentified.source_ideas);
  assert.deepEqual(bound.source_ideas, sources.source_ideas);
  assert.equal(sources.synthesis, null);
  assert.equal(bound.target_relation, 'nora_self');
  assert.equal(deidentified.target_relation, 'identity_withheld');
  assert.throws(() => study.conditionPacket(snapshot, 'unsupported'), /unsupported/);
});
