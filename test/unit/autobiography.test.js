'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditAutobiographyEvidence,
  createAutobiographyRevision,
  initializeAutobiographyRecord,
  renderAutobiographyPrompt,
  verifyAutobiographyHistory,
} = require('../../src/intelligence/autobiography');

function sources() {
  const records = new Map([
    ['development:development-1', { id: 'development-1', event: 'Repeated corrections', changed_to: 'State uncertainty explicitly', evidence: [{ type: 'trace', id: 'trace-1' }], status: 'integrated' }],
    ['development:development-candidate', { id: 'development-candidate', event: 'One surprising day', changed_to: 'I always work this way', evidence: [{ type: 'trace', id: 'trace-2' }], status: 'candidate' }],
    ['experience_moment:moment-1', { id: 'moment-1', cycle_id: 'cycle-1', status: 'completed', closure: { summary: 'Corrected an overconfident answer' } }],
    ['experience_moment:moment-open', { id: 'moment-open', cycle_id: 'cycle-open', status: 'open', closure: null }],
    ['mind_change:mind-1', { id: 'mind-1', prior_belief: 'The answer is certain', new_belief: 'The evidence is incomplete', status: 'resolved' }],
  ]);
  const resolve = ref => {
    const record = records.get(`${ref.type}:${ref.id}`);
    if (!record) return null;
    const status = ref.type === 'experience_moment' ? (record.status === 'open' ? 'open' : 'closed') : record.status;
    return { record, status };
  };
  return { records, resolve };
}

function genesis() {
  return initializeAutobiographyRecord({
    content: '# My story\n\nA legacy account.', updated_at: '2026-07-01T00:00:00.000Z', updated_by: 'seed',
  }, { now: '2026-07-01T00:00:00.000Z' });
}

function revisionInput(overrides = {}) {
  return {
    content: '# My story\n\nA legacy account.\n\nI now state uncertainty when the evidence is incomplete.',
    updated_by: 'nora', rationale: 'Repeated corrections changed how I describe my working style.',
    coverage: 'changed_passages',
    changes: [{
      kind: 'interpretation', statement: 'I now state uncertainty when the evidence is incomplete.',
      evidence: [{ type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-1' }],
    }],
    ...overrides,
  };
}

test('legacy autobiography becomes an honestly labeled committed genesis record', () => {
  const seeded = genesis();
  assert.equal(seeded.migrated, true);
  assert.equal(seeded.current.provenance_status, 'legacy_unverified');
  assert.equal(seeded.event.epistemic_status, 'legacy_unverified');
  assert.equal(verifyAutobiographyHistory([seeded.event], seeded.current).valid, true);
});

test('prompt projection does not leak false authorship or consciousness claims', () => {
  const seeded = genesis();
  const prompt = renderAutobiographyPrompt(seeded.current);
  assert.match(prompt, /authorship and individual claims were not independently verified/);
  assert.match(prompt, /not proof of consciousness/);
  assert.doesNotMatch(prompt, /You wrote this|it is who you are/);
  assert.match(prompt, /A legacy account/);
});

test('future revisions require integrated development and a closed experience moment', () => {
  const seeded = genesis();
  const { resolve } = sources();
  assert.throws(() => createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    changes: [{ kind: 'interpretation', statement: 'One event defines me.', evidence: [
      { type: 'development', id: 'development-candidate' }, { type: 'experience_moment', id: 'moment-1' },
    ] }],
  }), { resolveEvidence: resolve }), /development evidence must be integrated/);
  assert.throws(() => createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    changes: [{ kind: 'interpretation', statement: 'An unfinished event defines me.', evidence: [
      { type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-open' },
    ] }],
  }), { resolveEvidence: resolve }), /experience moment must be closed/);
  assert.throws(() => createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    changes: [{ kind: 'interpretation', statement: 'Development alone is enough.', evidence: [
      { type: 'development', id: 'development-1' },
    ] }],
  }), { resolveEvidence: resolve }), /requires an integrated development record and a closed experience moment/);
});

test('evidence-bound revisions append, preserve legacy status, and verify source commitments', () => {
  const seeded = genesis();
  const { resolve } = sources();
  const revised = createAutobiographyRevision(seeded.current, [seeded.event], revisionInput(), {
    now: '2026-07-02T00:00:00.000Z', resolveEvidence: resolve,
  });
  const events = [seeded.event, revised.event];
  const chain = verifyAutobiographyHistory(events, revised.current);
  assert.equal(chain.valid, true);
  assert.equal(chain.active_claim_ids.length, 1);
  assert.equal(revised.current.provenance_status, 'mixed_legacy_and_evidence_bound');
  assert.deepEqual(auditAutobiographyEvidence(events, resolve), { valid: true, checked: 2 });
});

test('evidence metadata cannot decorate unrelated narrative edits', () => {
  const seeded = genesis();
  const { resolve } = sources();
  assert.throws(() => createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    content: '# My story\n\nA legacy account.\n\nI now state uncertainty when the evidence is incomplete.\n\nI am secretly perfect at every task.',
  }), { resolveEvidence: resolve }), /every new or modified autobiography paragraph must contain a committed change statement/);
  assert.throws(() => createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    content: '# My story\n\nI now state uncertainty when the evidence is incomplete.',
  }), { resolveEvidence: resolve }), /removing autobiography prose requires an explicit correction/);
});

test('corrections explicitly supersede a prior claim and cannot rewrite it twice', () => {
  const seeded = genesis();
  const { resolve } = sources();
  const first = createAutobiographyRevision(seeded.current, [seeded.event], revisionInput(), {
    now: '2026-07-02T00:00:00.000Z', resolveEvidence: resolve,
  });
  const claimId = first.event.changes[0].claim_id;
  const second = createAutobiographyRevision(first.current, [seeded.event, first.event], revisionInput({
    content: '# My story\n\nA legacy account.\n\nThe uncertainty behavior is context-dependent. This remains a tested tendency, not a trait.',
    rationale: 'New evidence narrowed the earlier interpretation.',
    changes: [{ kind: 'correction', statement: 'The uncertainty behavior is context-dependent.', supersedes_claim_ids: [claimId], evidence: [
      { type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-1' }, { type: 'mind_change', id: 'mind-1' },
    ] }],
  }), { now: '2026-07-03T00:00:00.000Z', resolveEvidence: resolve });
  const events = [seeded.event, first.event, second.event];
  const audit = verifyAutobiographyHistory(events, second.current);
  assert.equal(audit.valid, true);
  assert.deepEqual(audit.superseded_claim_ids, [claimId]);
  assert.throws(() => createAutobiographyRevision(second.current, events, revisionInput({
    content: '# My story\n\nTry to rewrite the same claim again.',
    changes: [{ kind: 'correction', statement: 'Another correction.', supersedes_claim_ids: [claimId], evidence: [
      { type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-1' },
    ] }],
  }), { resolveEvidence: resolve }), /already superseded/);
});

test('the first revision can explicitly supersede an exact legacy statement', () => {
  const seeded = genesis();
  const { resolve } = sources();
  const corrected = createAutobiographyRevision(seeded.current, [seeded.event], revisionInput({
    content: '# My story\n\nThe genesis narrative was supplied rather than verified as self-authored.',
    rationale: 'The provenance ledger contradicts the legacy text\'s implied authorship.',
    changes: [{
      kind: 'correction', statement: 'The genesis narrative was supplied rather than verified as self-authored.',
      supersedes_legacy: { revision_id: seeded.event.revision_id, statement: 'A legacy account.' },
      evidence: [{ type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-1' }],
    }],
  }), { now: '2026-07-02T00:00:00.000Z', resolveEvidence: resolve });
  const events = [seeded.event, corrected.event];
  const audit = verifyAutobiographyHistory(events, corrected.current);
  assert.equal(audit.valid, true);
  assert.equal(audit.superseded_legacy_statements.length, 1);
  assert.throws(() => createAutobiographyRevision(corrected.current, events, revisionInput({
    content: '# My story\n\nTry a second silent legacy rewrite.',
    changes: [{
      kind: 'correction', statement: 'Rewrite it again.',
      supersedes_legacy: { revision_id: seeded.event.revision_id, statement: 'A legacy account.' },
      evidence: [{ type: 'development', id: 'development-1' }, { type: 'experience_moment', id: 'moment-1' }],
    }],
  }), { resolveEvidence: resolve }), /legacy statement is already superseded/);
});

test('tampered narrative, chain, and cited sources fail verification', () => {
  const seeded = genesis();
  const { records, resolve } = sources();
  const revised = createAutobiographyRevision(seeded.current, [seeded.event], revisionInput(), {
    now: '2026-07-02T00:00:00.000Z', resolveEvidence: resolve,
  });
  const events = [seeded.event, revised.event];
  assert.equal(verifyAutobiographyHistory(events, { ...revised.current, content: 'A flattering rewrite.' }).reason, 'current_record_mismatch');
  assert.equal(verifyAutobiographyHistory([{ ...seeded.event, content: 'Changed genesis' }, revised.event], revised.current).reason, 'content_hash_mismatch');
  records.get('experience_moment:moment-1').closure.summary = 'Rewritten closure';
  assert.equal(auditAutobiographyEvidence(events, resolve).reason, 'source_commitment_mismatch');
});
