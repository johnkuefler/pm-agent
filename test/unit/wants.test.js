const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWantUpdate, stableHash, wantRevisionEvent, verifyWantHistory } = require('../../src/intelligence/wants');

const now = '2026-07-12T12:00:00.000Z';
const formed = {
  id: 'w-new',
  want: 'Understand which uncertainties change my decisions',
  why: 'I keep noticing that calibration changes what I choose to check',
  status: 'active',
  progress: [],
  provenance: {
    origin: 'self_generated',
    formation_context: 'The same calibration question recurred in two dream reviews.',
    formed_at: '2026-07-12T11:00:00.000Z',
    evidence: [{ type: 'dream', id: 'dream-17' }],
  },
};

test('new self-generated wants require an evidence-bearing formation record', () => {
  assert.throws(() => normalizeWantUpdate([], [{ ...formed, provenance: undefined }], { now }), /require provenance/);
  assert.throws(() => normalizeWantUpdate([], [{ ...formed, provenance: { ...formed.provenance, evidence: [] } }], { now }), /formation evidence/);
  const [want] = normalizeWantUpdate([], [formed], { now });
  assert.equal(want.provenance.epistemic_status, 'subject_attested');
  assert.equal(want.revision, 1);
});

test('want identity and provenance cannot be rewritten in place', () => {
  const [existing] = normalizeWantUpdate([], [formed], { now });
  assert.throws(() => normalizeWantUpdate([existing], [{ ...existing, want: 'A different aim' }], { now }), /immutable/);
  assert.throws(() => normalizeWantUpdate([existing], [{ ...existing, provenance: { ...existing.provenance, origin: 'user_suggested' } }], { now }), /provenance is immutable/);
  const withProgress = normalizeWantUpdate([existing], [{ ...existing, progress: ['first observation'] }], { now })[0];
  assert.throws(() => normalizeWantUpdate([withProgress], [{ ...withProgress, progress: ['rewritten observation'] }], { now }), /append-only/);
});

test('active wants must be explicitly closed before removal', () => {
  const [existing] = normalizeWantUpdate([], [formed], { now });
  assert.throws(() => normalizeWantUpdate([existing], [], { now }), /must be completed or retired/);
  const [closed] = normalizeWantUpdate([existing], [{ ...existing, status: 'retired' }], { now: '2026-07-13T12:00:00.000Z' });
  assert.equal(closed.status, 'retired');
  assert.ok(closed.closed_at);
  assert.throws(() => normalizeWantUpdate([closed], [{ ...closed, status: 'active' }], { now }), /cannot be reopened/);
  assert.deepEqual(normalizeWantUpdate([closed], [], { now: '2026-07-14T12:00:00.000Z' }), []);
});

test('legacy wants are labeled unverified instead of retroactively self-authored', () => {
  const legacy = { id: 'w-old', want: 'Know the account', why: 'Be useful', added: '2026-01-01', status: 'active', progress: [] };
  const [updated] = normalizeWantUpdate([legacy], [legacy], { now });
  assert.equal(updated.provenance.origin, 'unknown');
  assert.equal(updated.provenance.epistemic_status, 'legacy_unverified');
});

test('revision events bind consecutive records by hash', () => {
  const first = { items: normalizeWantUpdate([], [formed], { now }), updated_at: now };
  const secondAt = '2026-07-13T12:00:00.000Z';
  const second = { items: normalizeWantUpdate(first.items, [{ ...first.items[0], progress: ['2026-07-13: compared two decisions'] }], { now: secondAt }), updated_at: secondAt };
  const event = wantRevisionEvent(first, second, 'nora');
  assert.equal(event.previous_hash, stableHash(first));
  assert.equal(event.record_hash, stableHash(second));
  const genesis = wantRevisionEvent(null, first, 'nora');
  assert.equal(verifyWantHistory([genesis, event], second).valid, true);
  const tampered = structuredClone(event);
  tampered.record.items[0].want = 'tampered';
  assert.equal(verifyWantHistory([genesis, tampered], second).valid, false);
});

test('receipt-bound aims preserve immutable evaluation and generation provenance', () => {
  const receiptBound = {
    ...formed,
    id: 'w-receipt-bound',
    evaluation: {
      success_observation: 'A future handoff surfaces one verified dependency earlier.',
      counterevidence: ['Comparable projects show the check adds no useful signal.'],
      horizon_days: 45,
    },
    provenance: {
      ...formed.provenance,
      formation_protocol: 'server_direct_subject_aim_reflection_v1',
      source_dream_id: 'dream-source',
      generation_receipt: { receipt_commitment: 'a'.repeat(64) },
    },
  };
  const [saved] = normalizeWantUpdate([], [receiptBound], { now });
  assert.equal(saved.provenance.epistemic_status, 'receipt_bound_subject_synthesis');
  assert.equal(saved.evaluation.horizon_days, 45);
  assert.throws(() => normalizeWantUpdate([saved], [{ ...saved,
    evaluation: { ...saved.evaluation, horizon_days: 60 },
  }], { now }), /evaluation is immutable/);
  assert.throws(() => normalizeWantUpdate([], [{ ...receiptBound,
    provenance: { ...receiptBound.provenance, generation_receipt: null },
  }], { now }), /require a generation receipt/);
});
