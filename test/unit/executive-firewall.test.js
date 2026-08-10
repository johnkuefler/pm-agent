'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const firewall = require('../../src/executive/firewall');
const { parseExecutiveDecision, handleExecutiveDecisionReply } = require('../../src/executive/slack-decision');

const now = new Date('2026-08-08T15:00:00.000Z');

function intake(overrides = {}, state = firewall.emptyState(now)) {
  return firewall.intakeCase({
    source: 'teamwork', source_ref: 'task-42', category: 'coordination',
    authority_class: 'status_followup', severity: 'medium',
    summary: 'Owner has not confirmed the delivery handoff', owner: 'Mallory',
    next_action: 'Ask the owner for the missing handoff and verify Teamwork.',
    evidence: [{ type: 'teamwork_task', ref: 'task-42' }], ...overrides,
  }, { state, now });
}

test('firewall preserves Nora team PM role and pull-only executive brief', () => {
  const state = firewall.emptyState(now);
  assert.equal(state.policy.team_pm_role_preserved, true);
  assert.equal(state.policy.daily_brief_is_pull_only, true);
  assert.equal(state.policy.executive_budget_scope, 'executive:john');
  assert.ok(state.policy.standing_authority.includes('task_management'));
  assert.ok(state.policy.executive_gates.includes('budget'));
});

test('ordinary PM intake is owned by Nora without becoming an executive decision', () => {
  const result = intake();
  assert.equal(result.case.state, 'resolving');
  assert.equal(result.case.requires_executive, false);
  assert.equal(firewall.notificationCandidates(result.state).length, 0);
});

test('resolution queue puts decision packets and overdue owner work ahead of new research', () => {
  const overdue = intake({ source_ref: 'overdue', summary: 'Overdue owner follow-up',
    resolution_due_at: '2026-08-08T14:00:00.000Z' });
  const future = intake({ source_ref: 'future', summary: 'Future high-severity risk', severity: 'high',
    resolution_due_at: '2026-08-09T15:00:00.000Z' }, overdue.state);
  const gated = intake({ source_ref: 'decision', summary: 'Concrete budget decision',
    requires_executive: true, executive_gate: 'budget' }, future.state);
  const prepared = firewall.prepareDecision(gated.state, gated.case.id, {
    question: 'Approve the recovery budget?', recommendation: 'Approve the bounded option.',
    consequence: 'The project otherwise slips.', options: ['Approve', 'Accept slip'],
    evidence: [{ type: 'estimate', ref: 'estimate-queue' }],
  }, { now });
  const queue = firewall.resolutionCandidates(prepared.state, { now });
  assert.equal(queue[0].id, prepared.case.id);
  assert.equal(queue[1].id, overdue.case.id);
  const metrics = firewall.metrics(prepared.state, { now });
  assert.equal(metrics.overdue_without_attempt, 1);
  assert.equal(metrics.unpacketized_executive, 0);
  const context = firewall.promptContext(prepared.state);
  assert.match(context, /Before discretionary research, advance the first overdue resolving matter/);
  assert.ok(context.indexOf('Concrete budget decision') < context.indexOf('Overdue owner follow-up'));
});

test('stable source identity absorbs unchanged duplicate noise', () => {
  const first = intake();
  const second = intake({}, first.state);
  assert.equal(second.created, false);
  assert.equal(second.material_change, false);
  assert.equal(second.state.cases.length, 1);
  assert.equal(second.state.quiet.duplicates_absorbed, 1);
  assert.equal(second.state.quiet.unchanged_absorbed, 1);
});

test('material source changes update the owned case without duplicating it', () => {
  const first = intake();
  const second = intake({ severity: 'high', summary: 'Delivery handoff now blocks launch' }, first.state);
  assert.equal(second.material_change, true);
  assert.equal(second.state.cases.length, 1);
  assert.equal(second.case.material_revision, 2);
});

test('budget and scope language are recognized as executive gates', () => {
  assert.equal(firewall.gateFromText('Approve a $20,000 budget increase'), 'budget');
  assert.equal(firewall.gateFromText('This needs a scope change'), 'scope');
  assert.equal(firewall.gateFromText('Note anything out of scope before client review'), null);
  assert.equal(firewall.gateFromText('Ask the task owner for status'), null);
});

test('decision packets require recommendation, options, consequence, and evidence', () => {
  const first = intake({ requires_executive: true, executive_gate: 'budget' });
  assert.throws(() => firewall.prepareDecision(first.state, first.case.id,
    { question: 'Approve spend?' }, { now }), /recommendation/);
  const prepared = firewall.prepareDecision(first.state, first.case.id, {
    question: 'Approve the additional production budget?',
    recommendation: 'Approve the smaller recovery option.',
    consequence: 'The launch slips without additional production capacity.',
    options: ['Approve recovery option', 'Accept the slip'],
    evidence: [{ type: 'estimate', ref: 'estimate-9' }],
    executive_gate: 'budget',
  }, { now });
  assert.equal(prepared.case.state, 'decision_ready');
  assert.equal(prepared.case.resolution_due_at, prepared.case.decision_packet.deadline);
  assert.equal(firewall.notificationCandidates(prepared.state).length, 1);
});

test('one executive decision moves the case into follow-through execution', () => {
  const first = intake({ requires_executive: true, executive_gate: 'budget' });
  const prepared = firewall.prepareDecision(first.state, first.case.id, {
    question: 'Approve recovery?', recommendation: 'Approve option A.',
    consequence: 'The deadline otherwise slips.', options: ['Option A'],
    evidence: [{ type: 'estimate', ref: 'estimate-9' }],
  }, { now });
  const marked = firewall.markNotified(prepared.state, [prepared.case.id], { now,
    delivery_ref: 'slack-123' });
  const decided = firewall.recordDecision(marked.state, prepared.case.id,
    { decision: 'approve', decided_by: 'John' }, { now });
  assert.equal(decided.case.state, 'executing');
  assert.equal(decided.case.executive_involved, true);
  assert.match(decided.case.next_action, /Execute/);
});

test('verified closure is evidence backed and measures work handled without John', () => {
  const first = intake();
  const attempt = firewall.recordAttempt(first.state, first.case.id, {
    action: 'Asked the owner for the handoff', result: 'Owner supplied it and Teamwork is updated',
    actor: 'Nora', evidence: [{ type: 'teamwork_comment', ref: 'comment-1' }],
  }, { now });
  assert.throws(() => firewall.verifyClosure(attempt.state, first.case.id,
    { outcome: 'Done' }, { now }), /evidence/);
  const closed = firewall.verifyClosure(attempt.state, first.case.id, {
    outcome: 'The handoff is complete and the dependent task began.',
    evidence: [{ type: 'teamwork_task', ref: 'task-42-complete' }],
  }, { now });
  const metrics = firewall.metrics(closed.state, { now });
  assert.equal(closed.case.handled_without_executive, true);
  assert.equal(metrics.handled_without_executive_rate, 1);
  assert.equal(metrics.silent_closures, 1);
});

test('executive feedback changes future prompt guidance without rewriting evidence', () => {
  const first = intake({ requires_executive: true, executive_gate: 'budget' });
  const feedback = firewall.recordFeedback(first.state, first.case.id, {
    rating: 'unnecessary',
    behavior_change: 'Resolve analogous production tradeoffs through the PM before escalating.',
  }, { now });
  assert.equal(firewall.metrics(feedback.state, { now }).unnecessary_escalations, 1);
  assert.match(firewall.promptContext(feedback.state), /Resolve analogous production tradeoffs/);
});

test('decision message is grouped and asks for a compact reply', () => {
  const first = intake({ source_ref: 'one', requires_executive: true, executive_gate: 'budget' });
  const p1 = firewall.prepareDecision(first.state, first.case.id, {
    question: 'Approve one?', recommendation: 'Approve.', consequence: 'Work stops otherwise.',
    options: ['Approve'], evidence: [{ type: 'source', ref: 'one' }],
  }, { now });
  const second = intake({ source_ref: 'two', summary: 'Second gated matter',
    requires_executive: true, executive_gate: 'scope' }, p1.state);
  const p2 = firewall.prepareDecision(second.state, second.case.id, {
    question: 'Approve two?', recommendation: 'Approve.', consequence: 'Scope remains blocked.',
    options: ['Approve'], evidence: [{ type: 'source', ref: 'two' }],
  }, { now });
  const message = firewall.decisionMessage(firewall.notificationCandidates(p2.state));
  assert.match(message, /2 decisions/);
  assert.match(message, /grouped them into one interruption/);
  assert.match(message, /Reply with the case ID/);
});

test('Slack decision parser accepts compact case decisions and ignores ordinary messages', () => {
  assert.deepEqual(parseExecutiveDecision('EF-case-abc-123 approve'), {
    case_id: 'ef-case-abc-123', decision: 'approve', instruction: '',
  });
  assert.equal(parseExecutiveDecision('Looks good to me'), null);
});

test('only John direct messages can apply a compact Slack decision', async () => {
  const decisions = [];
  const messages = [];
  const options = { text: 'ef-case-abc-123 approve', executiveUserId: 'UJOHN',
    channel: 'DJOHN', runtime: { decide: async (...args) => decisions.push(args) },
    postMessage: async (...args) => messages.push(args) };
  assert.equal(await handleExecutiveDecisionReply({ ...options, isDirectMessage: true,
    user: 'UOTHER' }), false);
  assert.equal(await handleExecutiveDecisionReply({ ...options, isDirectMessage: true,
    user: 'UJOHN' }), true);
  assert.equal(decisions.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0][1], /carry it through and verify closure/);
});
