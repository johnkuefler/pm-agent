const test = require('node:test');
const assert = require('node:assert/strict');
const consequences = require('../../src/intelligence/consequence-review');

test('consequence actions require intended effect, evidence, and success criteria', () => {
  const created = consequences.createAction({
    id: 'cr-deadline-ping',
    action_type: 'deadline_flag',
    description: 'Sent Mallory a deadline-risk note about TW-123.',
    intended_effect: 'Help Mallory decide whether the task needs a new date or a blocker cleared.',
    success_criteria: 'A later source shows a decision, a clarified blocker, or evidence that the ping was unnecessary.',
    expected_signal: 'Teamwork task comment, Slack reply, or updated due date.',
    beneficiary: 'Mallory and the project team',
    target_ref: 'tw-123',
    source_ref: 'cycle-1/action-2',
    workspace_frame_id: 'cw-1',
    epistemic_claim_refs: [{ type: 'epistemic_claim', id: 'ep-1' }],
    evidence: [{ type: 'teamwork_task', id: 'tw-123' }],
    consequence_due: '2026-07-21T15:00:00.000Z',
    created_by: 'Nora',
  }, consequences.emptyLedger());

  assert.equal(created.action.status, 'open');
  assert.equal(created.action.action_type, 'deadline_flag');
  assert.match(created.action.action_commitment, /^[a-f0-9]{64}$/);
  assert.equal(created.report.due_open_actions, 0);

  assert.throws(() => consequences.createAction({
    action_type: 'slack_message',
    description: 'Sent a note',
    intended_effect: 'Help',
    evidence: [{ type: 'slack_message', id: '1' }],
  }, consequences.emptyLedger()), /success_criteria/);

  assert.throws(() => consequences.createAction({
    action_type: 'guess',
    description: 'Sent a note',
    intended_effect: 'Help',
    success_criteria: 'A later reply shows whether it helped.',
    evidence: [{ type: 'slack_message', id: '1' }],
  }, consequences.emptyLedger()), /action_type/);
});

test('consequence observations preserve wrong or backfired outcomes as behavior signal', () => {
  const created = consequences.createAction({
    id: 'cr-warmth',
    action_type: 'warmth',
    description: 'Sent a warmth note after a teammate helped unblock a project.',
    intended_effect: 'Make the teammate feel seen without creating performative pressure.',
    success_criteria: 'Later response or behavior suggests the note landed warmly, neutrally, or badly.',
    evidence: [{ type: 'slack_message', id: '123.456' }],
    consequence_due: '2026-07-20T12:00:00.000Z',
  }, consequences.emptyLedger(), { now: new Date('2026-07-20T10:00:00.000Z') });

  assert.equal(consequences.dueActions(created.ledger, { now: new Date('2026-07-20T13:00:00.000Z') }).length, 1);

  const observed = consequences.observeAction(created.ledger, 'cr-warmth', {
    outcome: 'backfired',
    observed_effect: 'The teammate replied that the note felt like pressure while they were still blocked.',
    evidence: [{ type: 'slack_message', id: '123.789' }],
    should_change_behavior: true,
    behavior_update: 'Do not send warmth while the work is still blocked unless the note explicitly removes pressure.',
    followup_action: 'Apologize and clarify there is no pressure.',
  });

  assert.equal(observed.action.status, 'observed');
  assert.equal(observed.action.latest_outcome, 'backfired');
  assert.equal(observed.report.outcomes.backfired, 1);
  assert.equal(observed.report.behavior_updates, 1);
  assert.match(observed.observation.observation_commitment, /^[a-f0-9]{64}$/);

  assert.throws(() => consequences.observeAction(created.ledger, 'cr-warmth', {
    outcome: 'helped',
    observed_effect: 'It helped.',
    evidence: [{ type: 'slack_message', id: '123.999' }],
    should_change_behavior: true,
  }), /behavior_update/);
});
