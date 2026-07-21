const test = require('node:test');
const assert = require('node:assert/strict');
const epistemics = require('../../src/intelligence/operational-epistemics');

test('operational epistemic claims require stance, evidence, confidence, and falsifier', () => {
  const claim = epistemics.createClaim({
    id: 'ep-task-blocked',
    statement: 'The Edge landing page copy task is blocked on go/no-go confirmation.',
    stance: 'inferred',
    confidence: 0.62,
    domain: 'deadline',
    subject_ref: 'tw-39594496',
    rationale: 'Recent comments ask for a decision before copy can move cleanly.',
    falsifier: 'A newer task comment or completed deliverable shows the page decision is already made.',
    evidence: [{ type: 'teamwork_task', id: 'tw-39594496' }],
  }, epistemics.emptyLedger());
  assert.equal(claim.claim.status, 'open');
  assert.equal(claim.claim.stance, 'inferred');
  assert.match(claim.claim.claim_commitment, /^[a-f0-9]{64}$/);
  assert.equal(claim.report.open_high_confidence, 0);
  assert.throws(() => epistemics.createClaim({
    statement: 'Probably blocked',
    stance: 'assumption',
    confidence: 0.8,
    falsifier: 'Evidence says otherwise',
    evidence: [{ type: 'task', id: '1' }],
  }, epistemics.emptyLedger()), /assumptions/);
  assert.throws(() => epistemics.createClaim({
    statement: 'Probably blocked',
    stance: 'guess',
    confidence: 0.4,
    falsifier: 'Evidence says otherwise',
    evidence: [{ type: 'task', id: '1' }],
  }, epistemics.emptyLedger()), /stance/);
});

test('operational epistemic claims resolve with evidence without deleting history', () => {
  const created = epistemics.createClaim({
    id: 'ep-decision',
    statement: 'Mallory has not answered the go/no-go question yet.',
    stance: 'observed',
    confidence: 0.82,
    domain: 'project',
    falsifier: 'A later task comment from Mallory answers the question.',
    evidence: [{ type: 'teamwork_comment', id: 'comment-1' }],
  }, epistemics.emptyLedger());
  const resolved = epistemics.resolveClaim(created.ledger, 'ep-decision', {
    outcome: 'contradicted',
    observed: 'A later comment shows Mallory answered before the run summary.',
    evidence: [{ type: 'teamwork_comment', id: 'comment-2' }],
    resolved_by: 'Nora',
  });
  assert.equal(resolved.claim.status, 'contradicted');
  assert.equal(resolved.ledger.claims.length, 1);
  assert.equal(resolved.ledger.resolutions.length, 1);
  assert.match(resolved.resolution.resolution_commitment, /^[a-f0-9]{64}$/);
  assert.equal(resolved.report.counts.contradicted, 1);
});
