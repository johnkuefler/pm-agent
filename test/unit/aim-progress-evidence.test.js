'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../../src/intelligence/aim-progress-evidence');
const goalAffect = require('../../src/intelligence/goal-affect');
const { normalizeWantUpdate, RECEIPT_BOUND_FORMATION_PROTOCOL } = require('../../src/intelligence/wants');

const NOW = new Date('2026-07-18T10:00:00.000Z');
const memory = {
  id: 'memory-aim-progress',
  fact: 'A verified ownership question surfaced the missing launch approver before the handoff deadline.',
  project: 'Launch A', added: '2026-07-18', source: 'meeting', status: 'active',
};
const entry = {
  at: NOW.toISOString(),
  note: 'The ownership question surfaced one real gate before escalation.',
  evidence: [{ type: 'memory', id: memory.id }],
};

test('aim progress receipts bind the exact note and stored source commitments', () => {
  const bound = evidence.attachReceipt(entry, [memory], NOW);
  assert.equal(evidence.verifiedEntry(bound), true);
  const noteTamper = structuredClone(bound);
  noteTamper.note = 'A rewritten progress claim.';
  assert.equal(evidence.verifiedEntry(noteTamper), false);
  const sourceTamper = structuredClone(bound);
  sourceTamper.evidence_receipt.source_snapshots[0].project = 'Different project';
  assert.equal(evidence.verifiedEntry(sourceTamper), false);
  assert.throws(() => evidence.attachReceipt({ ...entry,
    evidence: [{ type: 'memory', id: 'missing' }] }, [memory], NOW), /not found/);
  assert.throws(() => evidence.attachReceipt(entry,
    [{ ...memory, added: '2026-07-17' }], NOW), /progress date/);
});

test('all provenance-valid aims require source-bound progress evidence', () => {
  const receiptBoundWant = { provenance: { formation_protocol: RECEIPT_BOUND_FORMATION_PROTOCOL } };
  assert.equal(goalAffect.progressEligible(receiptBoundWant, entry), false);
  assert.equal(goalAffect.progressEligible(receiptBoundWant,
    evidence.attachReceipt(entry, [memory], NOW)), true);
  const attestedWant = { provenance: { origin: 'self_generated', epistemic_status: 'subject_attested' } };
  assert.equal(goalAffect.progressEligible(attestedWant, entry), false);
  assert.equal(goalAffect.progressEligible(attestedWant,
    evidence.attachReceipt(entry, [memory], NOW)), true);
});

test('want normalization preserves a progress evidence receipt append-only', () => {
  const bound = evidence.attachReceipt(entry, [memory], NOW);
  const raw = [{
    id: 'aim-1', want: 'Learn which ownership questions surface delivery gates early',
    why: 'Repeated unowned gates are a preventable source of late delivery surprises',
    status: 'active', progress: [bound],
    provenance: {
      origin: 'self_generated', formation_context: 'A repeated cross-project pattern formed this direction.',
      formed_at: '2026-07-17T10:00:00.000Z', evidence: [{ type: 'memory', id: 'formation-memory' }],
    },
  }];
  const normalized = normalizeWantUpdate([], raw, { now: NOW.toISOString() });
  assert.equal(evidence.verifiedEntry(normalized[0].progress[0]), true);
  const tampered = structuredClone(normalized);
  tampered[0].progress[0].note = 'Changed note';
  assert.throws(() => normalizeWantUpdate(normalized, tampered,
    { now: new Date('2026-07-18T11:00:00.000Z').toISOString() }), /append-only/);
});

test('the server binds only newly appended progress on provenance-valid active aims', () => {
  const { __test } = require('../../server');
  const prior = [{
    id: 'aim-1', status: 'active', progress: [],
    provenance: { formation_protocol: RECEIPT_BOUND_FORMATION_PROTOCOL },
  }];
  const requested = [{ ...prior[0], progress: [entry] }];
  const bound = __test.bindVerifiedWantProgress(prior, requested, [memory], NOW);
  assert.equal(evidence.verifiedEntry(bound[0].progress[0]), true);
  assert.throws(() => __test.bindVerifiedWantProgress(prior,
    [{ ...prior[0], progress: [{ ...entry,
      evidence: [{ type: 'memory', id: 'not-real' }] }] }], [memory], NOW), /not found/);
  const legacy = __test.bindVerifiedWantProgress([], [{
    id: 'legacy', progress: [entry], provenance: { epistemic_status: 'legacy_unverified' },
  }], [memory], NOW);
  assert.equal(legacy[0].progress[0].evidence_receipt, undefined);
});
