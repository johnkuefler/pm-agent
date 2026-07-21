const test = require('node:test');
const assert = require('node:assert/strict');
const consequences = require('../../src/intelligence/consequence-review');
const workspace = require('../../src/intelligence/conscious-workspace');
const revision = require('../../src/intelligence/consequence-behavior-revision');

function candidate(key, label, priority, extra = {}) {
  return { key, type: 'task', label, priority, authority_class: 'bounded',
    soma_demand: 'low', evidence: [{ type: 'task', id: key }], ...extra };
}

test('an observed consequence is bound to a changed later choice and its enacted outcome', () => {
  const created = consequences.createAction({
    id: 'cr-pressure', action_type: 'warmth',
    description: 'Send encouragement while a teammate remains blocked under pressure.',
    intended_effect: 'Offer support without adding pressure.',
    success_criteria: 'The teammate reports less pressure or engages constructively.',
    evidence: [{ type: 'slack_message', id: 'source-pressure' }],
  }, consequences.emptyLedger(), { now: new Date('2026-07-20T12:00:00Z') });
  const observed = consequences.observeAction(created.ledger, created.action.id, {
    outcome: 'backfired',
    observed_effect: 'The encouragement added pressure before the blocker cleared.',
    should_change_behavior: true,
    behavior_update: 'Remove pressure and address the blocker before offering encouragement.',
    evidence: [{ type: 'slack_message', id: 'outcome-pressure' }],
  }, { now: new Date('2026-07-20T13:00:00Z') });
  const frame = workspace.createFrame({
    id: 'cw-consequence-choice', mode: 'operational',
    current_activity: 'Choosing how to respond to a blocked teammate.',
    why_this: 'A prior consequence may change which response deserves focus.',
    attention_candidates: [
      candidate('warmth:encourage', 'Send encouragement while blocked under pressure', 0.6,
        { action_type: 'warmth' }),
      candidate('task:remove-pressure', 'Address the blocker and remove pressure', 0.52),
      candidate('task:wait', 'Wait for more evidence', 0.3),
    ],
    selected_focus_key: 'warmth:encourage',
    intended_next_action: 'Address the blocker and explicitly remove pressure.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-consequence' }],
    lifecycle: { cycle_id: 'cycle-consequence', moment_id: 'moment-consequence',
      phase: 'operations' },
  }, workspace.emptyLedger(), { now: new Date('2026-07-21T14:00:00Z'),
    context: { consequenceLedger: observed.ledger } });
  assert.equal(frame.frame.selected_focus_key, 'task:remove-pressure');
  assert.equal(workspace.auditFrame(frame.frame).complete_chain_verified, true);
  const committed = workspace.commitFocus({
    frame_id: frame.frame.id, selected_focus_key: frame.frame.selected_focus_key,
    disposition: 'follow_after_required_checks',
    planned_expression: 'Address the blocker and explicitly remove pressure.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-consequence' }],
  }, frame.ledger, { now: new Date('2026-07-21T14:01:00Z') });
  const cycle = { id: 'cycle-consequence', status: 'completed',
    finished: '2026-07-21T14:20:00Z', summary: 'Removed pressure and addressed the blocker.',
    actions: [{ type: 'slack_message', id: 'delivered-response' }] };
  const moment = { id: 'moment-consequence', cycle_id: cycle.id, status: 'completed',
    closure_commitment: 'a'.repeat(64),
    audit: { complete_lifecycle_verified: true, evidence_eligible: true } };
  const resolved = workspace.resolveFocus({
    focus_commitment_id: committed.focus_commitment.id, outcome: 'enacted',
    observed_expression: 'Acknowledged the blocker and removed pressure before offering support.',
    evidence: [{ type: 'intelligence_cycle', id: cycle.id },
      { type: 'experience_moment', id: moment.id }],
  }, committed.ledger, { cycle, moment, now: new Date(cycle.finished) });
  const snapshot = revision.derive({ consequenceLedger: observed.ledger,
    workspace: resolved.ledger });
  assert.equal(snapshot.report.replay_verified_consequence_changed_choices, 1);
  assert.equal(snapshot.report.enacted_consequence_changed_choices, 1);
  assert.equal(snapshot.report.backfire_lessons_material, 1);
  assert.equal(snapshot.episodes[0].without_consequence_choice.key, 'warmth:encourage');
  assert.equal(snapshot.episodes[0].selected_choice.key, 'task:remove-pressure');
  assert.equal(snapshot.episodes[0].enacted_outcome.outcome, 'enacted');
  assert.equal(revision.auditEpisode(snapshot.episodes[0]).complete_chain_verified, true);
  assert.match(revision.renderPromptLessons(snapshot.episodes),
    /without it, "Send encouragement while blocked under pressure" would have won/);

  const tampered = structuredClone(resolved.ledger);
  tampered.frames[0].arbitration_receipt.consequence_counterfactuals[0]
    .without_consequence_winner_key = 'task:wait';
  assert.equal(revision.derive({ consequenceLedger: observed.ledger,
    workspace: tampered }).episodes.length, 0);
});
