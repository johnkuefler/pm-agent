'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeammateApprovalRuntime } = require('../../src/approvals/runtime');
const { hash } = require('../../src/intelligence/external-source-attestation');

function proposalInput(overrides = {}) {
  return { dedupe_key: 'morton:hypercare', project_key: 'morton-salt',
    issue_summary: 'Hypercare dates precede launch.',
    evidence_summary: 'Launch is Aug 12 and hypercare is due Aug 9.',
    recommendation: 'Move hypercare to Aug 16.',
    approver: { name: 'Mallory', slack_user_id: 'UMALLORY', basis: 'Project manager' },
    actions: [{ type: 'update_task', task_id: '42', task_name: 'Hypercare',
      expected_before: { due_date: '2026-08-09' }, changes: { due_date: '2026-08-16' } }],
    ...overrides };
}

function signedApproval(text, user = 'UMALLORY', channel = 'DMALLORY') {
  return { text, user, channel, eventTs: '2.2',
    attestation: { provider: 'slack', status: 'provider_verified', receipt_commitment: 'receipt',
      receipt: { cryptographically_verified_at_ingress: true },
      source_snapshot: { event: { user, channel, ts: '2.2', text_sha256: hash(text) } } } };
}

function fixture(overrides = {}) {
  let stored = null;
  const tasks = new Map([['42', { id: '42', name: 'Hypercare', due: '2026-08-09',
    priority: 'medium', progress: 0, status: 'active' }]]);
  const sends = [], posts = [], writes = [];
  const runtime = createTeammateApprovalRuntime({
    db: { getState: async () => stored, setState: async (_key, value) => { stored = value; } },
    dataDirectory: '.', databaseReady: () => true, writeThrough: async (_key, operation) => operation(),
    readTask: async taskId => ({ ...tasks.get(taskId) }),
    updateTask: async input => {
      writes.push(input);
      if (overrides.updateError) throw new Error(overrides.updateError);
      const current = tasks.get(input.task_id); const next = { ...current };
      if (input.due_date) next.due = input.due_date;
      if (input.name) next.name = input.name;
      if (input.priority) next.priority = input.priority;
      if (input.progress != null) next.progress = input.progress;
      tasks.set(input.task_id, next); return { ok: true, updated: Object.keys(input) };
    },
    resolveSlackIdentity: async id => ({ id, name: 'Mallory Maryman', fullMember: true,
      isBot: false, isAppUser: false, deleted: false }),
    sendProposal: async (user, message) => { sends.push({ user, message });
      return { ok: true, channel: 'DMALLORY', ts: '1.2' }; },
    postMessage: async (channel, message) => { posts.push({ channel, message }); return true; },
  });
  return { runtime, tasks, sends, posts, writes, stored: () => stored };
}

test('the named teammate can approve one exact update which is then reread and closed', async () => {
  const f = fixture(); await f.runtime.hydrate();
  const proposed = await f.runtime.propose(proposalInput());
  assert.equal(proposed.sent, true);
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].message, /due date: 2026-08-09 to 2026-08-16/);
  assert.match(f.sends[0].message, new RegExp(`approve ${proposed.proposal.id}`));
  assert.equal(await f.runtime.handleSlackDecision(signedApproval(`approve ${proposed.proposal.id}`)), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.tasks.get('42').due, '2026-08-16');
  const closed = f.runtime.snapshot().state.proposals[0];
  assert.equal(closed.status, 'verified_closed');
  assert.equal(closed.execution.verification[0].observed.due_date, '2026-08-16');
  assert.match(f.posts.at(-1).message, /now verified/);
  assert.equal(f.runtime.snapshot().report.anti_noise.reminders_sent, 0);
});

test('a duplicate discovery sends no second Slack proposal', async () => {
  const f = fixture(); await f.runtime.hydrate();
  const first = await f.runtime.propose(proposalInput());
  const second = await f.runtime.propose(proposalInput());
  assert.equal(first.sent, true);
  assert.equal(second.reason, 'duplicate_suppressed');
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.snapshot().state.stats.duplicate_suppressed, 1);
});

test('source drift after approval stops before any Teamwork write', async () => {
  const f = fixture(); await f.runtime.hydrate();
  const proposed = await f.runtime.propose(proposalInput());
  f.tasks.get('42').due = '2026-08-10';
  await f.runtime.handleSlackDecision(signedApproval(`go ahead ${proposed.proposal.id}`));
  assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.snapshot().state.proposals[0].status, 'invalidated');
  assert.match(f.posts.at(-1).message, /did not apply/);
});

test('an execution failure is visible and never retried automatically', async () => {
  const f = fixture({ updateError: 'Teamwork timeout after request' }); await f.runtime.hydrate();
  const proposed = await f.runtime.propose(proposalInput());
  await f.runtime.handleSlackDecision(signedApproval(`approve ${proposed.proposal.id}`));
  assert.equal(f.writes.length, 1);
  assert.equal(f.runtime.snapshot().state.proposals[0].status, 'execution_uncertain');
  assert.match(f.posts.at(-1).message, /will not retry automatically/);
});

test('guest and bot identities cannot receive an actionable proposal', async () => {
  const blocked = createTeammateApprovalRuntime({
    db: { getState: async () => null, setState: async () => {} }, dataDirectory: '.',
    databaseReady: () => true, writeThrough: async (_key, operation) => operation(),
    readTask: async () => ({ id: '42', name: 'Hypercare', due: '2026-08-09' }),
    updateTask: async () => ({ ok: true }), resolveSlackIdentity: async () => ({ id: 'UGUEST', fullMember: false }),
    sendProposal: async () => ({ ok: true }), postMessage: async () => true,
  });
  await blocked.hydrate();
  await assert.rejects(blocked.propose(proposalInput()), /full LimeLight Slack member/);
});
