'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evidenceForLearning,
  verifyLearningEvidence,
} = require('../../src/intelligence/learning-memory-evidence');

const interactions = [
  { id: 'interaction-1', reviewed: true, outcome: 'landed',
    reviewed_at: '2026-07-20T10:00:00.000Z' },
  { id: 'interaction-2', reviewed: true, outcome: 'corrected',
    reviewed_at: '2026-07-21T10:00:00.000Z' },
  { id: 'interaction-neutral', reviewed: true, outcome: 'neutral',
    reviewed_at: '2026-07-22T10:00:00.000Z' },
];

test('a prompt-authoritative learning binds its exact fact to multiple decisive reviews', () => {
  const fact = 'Lead with the decision and keep supporting context below it.';
  const bound = evidenceForLearning({
    fact,
    evidence_refs: [
      { type: 'interaction', id: 'interaction-2' },
      { type: 'interaction', id: 'interaction-1' },
    ],
  }, interactions);
  const memory = { fact, ...bound };
  assert.equal(verifyLearningEvidence(memory, interactions).valid, true);
  assert.equal(bound.learning_evidence_receipt.source_count, 2);
  assert.deepEqual(bound.learning_evidence_receipt.sources.map(item => item.id),
    ['interaction-1', 'interaction-2']);
});

test('one source, neutral/unreviewed evidence, and fact or outcome tampering fail closed', () => {
  const fact = 'Use concise status updates.';
  assert.throws(() => evidenceForLearning({
    fact, evidence_refs: [{ type: 'interaction', id: 'interaction-1' }],
  }, interactions), /at least two/);
  assert.throws(() => evidenceForLearning({
    fact,
    evidence_refs: [
      { type: 'interaction', id: 'interaction-1' },
      { type: 'interaction', id: 'interaction-neutral' },
    ],
  }, interactions), /decisive immutable reviewed/);
  const memory = {
    fact,
    ...evidenceForLearning({
      fact,
      evidence_refs: [
        { type: 'interaction', id: 'interaction-1' },
        { type: 'interaction', id: 'interaction-2' },
      ],
    }, interactions),
  };
  assert.equal(verifyLearningEvidence({ ...memory, fact: 'Tampered instruction.' }, interactions).valid,
    false);
  const changed = structuredClone(interactions);
  changed[0].outcome = 'ignored';
  assert.equal(verifyLearningEvidence(memory, changed).valid, false);
});
