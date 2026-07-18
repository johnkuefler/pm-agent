const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWantUpdate, stableHash, wantRevisionEvent, verifyWantHistory,
  auditLegacyWantHistoryArchive, migrateLegacyWantHistory, compactWantHistory } = require('../../src/intelligence/wants');

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

test('canonical hashes survive JSONB-style object key reordering', () => {
  const left = { items: [{ id: 'w-1', want: 'Notice recurring ownership gaps',
    provenance: { origin: 'self_generated', evidence: [{ type: 'memory', id: 'm-1' }] } }],
  updated_at: now };
  const reordered = { updated_at: now, items: [{ provenance: {
    evidence: [{ id: 'm-1', type: 'memory' }], origin: 'self_generated' },
  want: 'Notice recurring ownership gaps', id: 'w-1' }] };
  assert.equal(stableHash(left), stableHash(reordered));
});

test('legacy hash failures become an explicit unverified archive and canonical checkpoint', () => {
  const current = { items: [{ id: 'w-old', want: 'Know the account', why: 'Be useful',
    status: 'active', progress: [], provenance: { origin: 'unknown', evidence: [],
      formation_context: 'Legacy want predating provenance capture.',
      formed_at: '2026-01-01', epistemic_status: 'legacy_unverified' } }], updated_at: now };
  const legacyEvents = [{ at: now, actor: 'nora', previous_hash: 'a'.repeat(64),
    record_hash: 'b'.repeat(64), active_ids: ['w-old'], record: current }];
  const migrated = migrateLegacyWantHistory(legacyEvents, current, [], new Date(now));
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.integrity.valid, true);
  assert.equal(migrated.history[0].checkpoint.kind, 'legacy_unverified_state_checkpoint_v1');
  assert.equal(migrated.history[0].record.items[0].provenance.epistemic_status, 'legacy_unverified');
  assert.equal(migrated.archives.length, 1);
  assert.equal(auditLegacyWantHistoryArchive(migrated.archives[0]).complete_archive_verified, true);
  const tampered = structuredClone(migrated.archives[0]);
  tampered.legacy_events[0].active_ids = [];
  assert.equal(auditLegacyWantHistoryArchive(tampered).complete_archive_verified, false);
});

test('canonical history corruption fails closed instead of being checkpointed away', () => {
  const first = { items: normalizeWantUpdate([], [formed], { now }), updated_at: now };
  const event = wantRevisionEvent(null, first, 'nora');
  event.record.items[0].want = 'tampered';
  assert.throws(() => migrateLegacyWantHistory([event], first, [], new Date(now)),
    /canonical wants history failed integrity/);
});

test('bounded compaction commits the verified prior chain and keeps future appends valid', () => {
  let current = { items: normalizeWantUpdate([], [formed], { now }), updated_at: now };
  const history = [wantRevisionEvent(null, current, 'nora')];
  for (let i = 1; i < 3; i += 1) {
    const at = `2026-07-${12 + i}T12:00:00.000Z`;
    const next = { items: normalizeWantUpdate(current.items, current.items, { now: at }), updated_at: at };
    history.push(wantRevisionEvent(current, next, 'nora'));
    current = next;
  }
  const compacted = compactWantHistory(history, current, { maxEvents: 3,
    now: new Date('2026-07-15T12:00:00.000Z') });
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.history.length, 1);
  assert.equal(compacted.history[0].checkpoint.prior_event_count, 3);
  assert.equal(verifyWantHistory(compacted.history, current).valid, true);
  const nextAt = '2026-07-16T12:00:00.000Z';
  const next = { items: normalizeWantUpdate(current.items, current.items, { now: nextAt }),
    updated_at: nextAt };
  const appended = [...compacted.history, wantRevisionEvent(current, next, 'nora')];
  assert.equal(verifyWantHistory(appended, next).valid, true);
});

test('legacy date-based progress migrates without breaking append-only history', () => {
  const legacy = { id: 'w-old-progress', want: 'Know the account well enough to help',
    why: 'Useful context prevents avoidable handoff gaps', added: '2026-01-01', status: 'active',
    progress: [{ date: '2026-07-10', note: 'Reviewed one active project.', evidence: [] }] };
  const [updated] = normalizeWantUpdate([legacy], [{ ...legacy, progress: [
    ...legacy.progress,
    { at: '2026-07-12T12:00:00.000Z', note: 'Compared another project.', evidence: [] },
  ] }], { now });
  assert.deepEqual(updated.progress.map(item => item.at),
    ['2026-07-10', '2026-07-12T12:00:00.000Z']);
  const rewritten = structuredClone(updated);
  rewritten.progress[0].note = 'Rewritten history';
  assert.throws(() => normalizeWantUpdate([updated], [rewritten], { now }), /append-only/);
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
