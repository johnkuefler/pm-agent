'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../../src/approvals/teammate-actions');

const NOW = new Date('2026-08-09T15:00:00.000Z');

function input(overrides = {}) {
  return {
    dedupe_key: 'morton-salt:hypercare-before-launch', project_key: 'morton-salt',
    issue_summary: 'Morton Salt hypercare dates precede launch.',
    evidence_summary: 'Launch is Aug 12 while hypercare task 42 is due Aug 9.',
    recommendation: 'Move hypercare task 42 to Aug 16.',
    approver: { name: 'Mallory Maryman', slack_user_id: 'UMALLORY',
      basis: 'Mallory is the project manager in Teamwork.' },
    actions: [{ type: 'update_task', task_id: '42', task_name: 'Hypercare',
      expected_before: { due_date: '2026-08-09' }, changes: { due_date: '2026-08-16' },
      reason: 'Hypercare must follow launch.' }],
    ...overrides,
  };
}

function attestation(user = 'UMALLORY', channel = 'DMALLORY', text = '') {
  return { provider: 'slack', status: 'provider_verified', receipt_commitment: 'receipt-1',
    receipt: { cryptographically_verified_at_ingress: true },
    source_snapshot: { event: { user, channel, ts: '1.3',
      text_sha256: require('../../src/runtime/source-attestation').hash(text) } } };
}

test('proposal creation is exact, idempotent, versioned, and noise suppressing', () => {
  const created = actions.createProposal(actions.emptyState(), input(), { now: NOW });
  assert.equal(created.proposal.id, `ta-${require('../../src/runtime/source-attestation').hash(input().dedupe_key).slice(0, 10)}-v1`);
  assert.equal(actions.integrity(created.proposal), true);
  const duplicate = actions.createProposal(created.state, input(), { now: new Date(NOW.getTime() + 1000) });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.stats.duplicate_suppressed, 1);
  const revised = actions.createProposal(duplicate.state, input({
    recommendation: 'Move hypercare task 42 to Aug 17.',
    actions: [{ type: 'update_task', task_id: '42', task_name: 'Hypercare',
      expected_before: { due_date: '2026-08-09' }, changes: { due_date: '2026-08-17' } }],
  }), { now: new Date(NOW.getTime() + 2000) });
  assert.equal(revised.proposal.version, 2);
  assert.equal(revised.state.proposals[0].status, 'invalidated');
  assert.equal(revised.state.stats.superseded, 1);
});

test('every proposed change carries a different exact before-state', () => {
  assert.throws(() => actions.normalizeInput(input({
    actions: [{ type: 'update_task', task_id: '42', task_name: 'Hypercare',
      expected_before: {}, changes: { due_date: '2026-08-16' } }],
  })), /expected_before must include/);
  assert.throws(() => actions.normalizeInput(input({
    actions: [{ type: 'update_task', task_id: '42', task_name: 'Hypercare',
      expected_before: { due_date: '2026-08-16' }, changes: { due_date: '2026-08-16' } }],
  })), /does not change/);
  assert.throws(() => actions.normalizeInput(input({
    actions: [{ type: 'delete_task', task_id: '42', task_name: 'Hypercare',
      expected_before: { status: 'active' }, changes: { status: 'deleted' } }],
  })), /update_task/);
});

test('approval binds the exact delivered version to its named Slack teammate', () => {
  const created = actions.createProposal(actions.emptyState(), input(), { now: NOW });
  const delivered = actions.markDelivered(created.state, created.proposal.id,
    { channel: 'DMALLORY', ts: '1.2' }, { now: NOW });
  assert.throws(() => actions.recordDecision(delivered.state, created.proposal.id, {
    decision: 'approve', user: 'USOMEONE', channel: 'DMALLORY', event_ts: '1.3',
    text: `approve ${created.proposal.id}`, raw_text: `approve ${created.proposal.id}`,
    attestation: attestation('USOMEONE', 'DMALLORY', `approve ${created.proposal.id}`),
  }, { now: NOW }), /named teammate/);
  const approved = actions.recordDecision(delivered.state, created.proposal.id, {
    decision: 'approve', user: 'UMALLORY', user_name: 'Mallory Maryman',
    channel: 'DMALLORY', event_ts: '1.3', text: `approve ${created.proposal.id}`,
    raw_text: `approve ${created.proposal.id}`,
    attestation: attestation('UMALLORY', 'DMALLORY', `approve ${created.proposal.id}`),
  }, { now: NOW });
  assert.equal(approved.proposal.status, 'approved');
  assert.equal(approved.proposal.decision.proposal_commitment, created.proposal.proposal_commitment);
  assert.match(approved.proposal.decision.decision_commitment, /^[a-f0-9]{64}$/);
});

test('plain approval works only when one proposal is open in that teammate DM', () => {
  const one = actions.createProposal(actions.emptyState(), input(), { now: NOW });
  const deliveredOne = actions.markDelivered(one.state, one.proposal.id,
    { channel: 'DMALLORY', ts: '1.2' }, { now: NOW });
  const candidate = actions.decisionCandidate(deliveredOne.state,
    { user: 'UMALLORY', channel: 'DMALLORY', text: 'go ahead' });
  assert.equal(candidate.proposal.id, one.proposal.id);
  assert.equal(actions.decisionCandidate(deliveredOne.state,
    { user: 'UMALLORY', channel: 'DMALLORY', text: 'yes' }).parsed, null);

  const two = actions.createProposal(deliveredOne.state, input({
    dedupe_key: 'morton-salt:second-issue', issue_summary: 'Second issue',
  }), { now: new Date(NOW.getTime() + 1000) });
  const deliveredTwo = actions.markDelivered(two.state, two.proposal.id,
    { channel: 'DMALLORY', ts: '2.2' }, { now: NOW });
  assert.equal(actions.decisionCandidate(deliveredTwo.state,
    { user: 'UMALLORY', channel: 'DMALLORY', text: 'approve' }).ambiguous, true);
});

test('an expired proposal never suppresses a freshly verified replacement', () => {
  const created = actions.createProposal(actions.emptyState(), input(), { now: NOW, ttlHours: 1 });
  const replacement = actions.createProposal(created.state, input(), {
    now: new Date(NOW.getTime() + 2 * 3600000), ttlHours: 1,
  });
  assert.equal(replacement.created, true);
  assert.equal(replacement.proposal.version, 2);
  assert.equal(replacement.state.proposals[0].status, 'invalidated');
  assert.match(replacement.state.proposals[0].invalidation_reason, /expired/);
});
