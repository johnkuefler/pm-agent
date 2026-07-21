const test = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../../src/intelligence/conscious-workspace');

const candidates = [
  { key: 'task:deadline', type: 'task', label: 'Deadline sweep', priority: 0.8, evidence: [{ type: 'task', id: 'tw-1' }] },
  { key: 'want:account-depth', type: 'want', label: 'Know the account cold', priority: 0.4, evidence: [{ type: 'want', id: 'w-1' }] },
  { key: 'uncertainty:blocker', type: 'uncertainty', label: 'Whether the task is really blocked', priority: 0.7, evidence: [{ type: 'epistemic_claim', id: 'ep-1' }] },
];

test('conscious workspace frames require competing attention candidates', () => {
  const created = workspace.createFrame({
    id: 'cw-test',
    mode: 'operational',
    current_activity: 'Checking whether an overdue task is truly blocked.',
    why_this: 'The deadline is near and the uncertainty affects whether Nora should ping a teammate.',
    attention_candidates: candidates,
    selected_focus_key: 'uncertainty:blocker',
    active_want_refs: [{ type: 'want', id: 'w-1', label: 'Know accounts cold' }],
    aversions: ['Avoid nagging someone when evidence already shows progress.'],
    uncertainties: ['The latest task comment may not be the latest real work signal.'],
    inhibited_actions: ['Do not send a deadline ping before checking the newest task comments.'],
    intended_next_action: 'Read the latest task comments, then resolve or update the epistemic claim.',
    soma_constraints: ['No platform warning currently changes the action.'],
    epistemic_claim_refs: [{ type: 'epistemic_claim', id: 'ep-1' }],
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-1' }],
    created_by: 'Nora',
  }, workspace.emptyLedger());
  assert.equal(created.frame.submitted_focus_key, 'uncertainty:blocker');
  assert.equal(created.frame.selected_focus_key, 'task:deadline');
  assert.equal(created.frame.attention_candidates.length, 3);
  assert.equal(created.frame.arbitration_receipt.baseline_winner_key, 'task:deadline');
  assert.equal(workspace.auditArbitration(created.frame.arbitration_receipt).complete_chain_verified, true);
  assert.match(created.frame.frame_commitment, /^[a-f0-9]{64}$/);
  assert.equal(created.report.current_focus, 'task:deadline');

  assert.throws(() => workspace.createFrame({
    current_activity: 'Too narrow',
    why_this: 'No competition.',
    attention_candidates: candidates.slice(0, 2),
    selected_focus_key: 'task:deadline',
    evidence: [{ type: 'cycle', id: '1' }],
  }, workspace.emptyLedger()), /three to twelve/);
});

test('legacy workspace frames without arbitration receipts remain readable', () => {
  const ledger = workspace.normalizeLedger({
    version: 1,
    current: {
      id: 'cw-legacy',
      mode: 'operational',
      current_activity: 'Legacy focus',
      selected_focus_key: 'task:legacy',
      attention_candidates: [],
      created_at: '2026-07-20T00:00:00.000Z',
    },
    frames: [],
    feedback: [],
  });
  assert.equal(workspace.report(ledger).arbitrated_frames, 0);
  assert.equal(workspace.report(ledger).current_choice_changed_by_motivation, false);
});

test('conscious workspace feedback binds consequences back to a frame', () => {
  const created = workspace.createFrame({
    id: 'cw-feedback',
    mode: 'social',
    current_activity: 'Choosing whether to send warmth.',
    why_this: 'A teammate shipped something and social debt is competing with silence.',
    attention_candidates: candidates,
    selected_focus_key: 'task:deadline',
    evidence: [{ type: 'cycle', id: 'cycle-1' }],
  }, workspace.emptyLedger());
  const feedback = workspace.addFeedback({
    frame_id: 'cw-feedback',
    signal: 'The recipient replied positively and the task moved.',
    effect: 'supported',
    evidence: [{ type: 'slack_message', id: '123.456' }],
  }, created.ledger);
  assert.equal(feedback.feedback.effect, 'supported');
  assert.match(feedback.feedback.feedback_commitment, /^[a-f0-9]{64}$/);
  assert.equal(feedback.report.total_feedback, 1);
});

test('changed-mind records require committed prior focus, feedback, and a changed server selection', () => {
  const prior = workspace.createFrame({
    id: 'cw-prior', mode: 'operational', current_activity: 'Preparing a deadline note.',
    why_this: 'The visible deadline appears to be the strongest signal.',
    attention_candidates: candidates, selected_focus_key: 'task:deadline',
    evidence: [{ type: 'cycle', id: 'cycle-prior' }],
  }, workspace.emptyLedger());
  const feedback = workspace.addFeedback({
    frame_id: 'cw-prior', signal: 'New task evidence shows the apparent deadline is already superseded.',
    effect: 'redirected', evidence: [{ type: 'teamwork_task', id: 'tw-later' }],
  }, prior.ledger, { now: new Date('2026-07-21T15:00:00.000Z') });
  const revised = workspace.createFrame({
    id: 'cw-revised', revision_of_frame_id: 'cw-prior', mode: 'operational',
    current_activity: 'Revising the deadline decision against later evidence.',
    why_this: 'The committed feedback now participates in selection.',
    attention_candidates: [
      candidates[0],
      { ...candidates[2], priority: 0.55,
        feedback_refs: [{ type: 'workspace_feedback', id: feedback.feedback.id }] },
      { ...candidates[1], priority: 0.3 },
    ],
    selected_focus_key: 'task:deadline',
    evidence: [{ type: 'cycle', id: 'cycle-revised' }],
  }, feedback.ledger);
  assert.equal(revised.frame.arbitration_receipt.baseline_winner_key, 'task:deadline');
  assert.equal(revised.frame.arbitration_receipt.evidence_counterfactual_winner_key, 'task:deadline');
  assert.equal(revised.frame.arbitration_receipt.choice_changed_by_evidence, true);
  assert.equal(revised.frame.selected_focus_key, 'uncertainty:blocker');
  assert.equal(revised.frame.changed_mind.from, 'Deadline sweep');
  assert.equal(revised.frame.changed_mind.to, 'Whether the task is really blocked');
  assert.equal(revised.frame.changed_mind.epistemic_status,
    'server_derived_committed_selection_revision');
  assert.equal(workspace.auditRevision(revised.frame, revised.ledger).complete_chain_verified, true);
  assert.equal(revised.report.grounded_mind_changes, 1);

  const tampered = structuredClone(revised.ledger);
  tampered.feedback[0].signal = 'Altered after commitment';
  assert.equal(workspace.auditRevision(tampered.current, tampered).complete_chain_verified, false);
  assert.throws(() => workspace.createFrame({
    current_activity: 'Narrating a revision', why_this: 'Self report only',
    attention_candidates: candidates, selected_focus_key: 'task:deadline',
    changed_mind: { from: 'X', to: 'Y', because: 'I said so',
      evidence: [{ type: 'memory', id: 'm-1' }] },
    evidence: [{ type: 'cycle', id: 'cycle-claim' }],
  }, revised.ledger), /server-derived/);
});

test('selected lifecycle focus is committed before action and resolved against its closed experience', () => {
  const created = workspace.createFrame({
    id: 'cw-lifecycle-cycle-focus-operations', mode: 'operational',
    current_activity: 'Running the forecast-bound operational pass.',
    why_this: 'The forecast is committed and candidates now compete for access.',
    attention_candidates: candidates, selected_focus_key: 'task:deadline',
    intended_next_action: 'Complete authorized work and close the lifecycle.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' }],
    lifecycle: { cycle_id: 'cycle-focus', moment_id: 'moment-focus', phase: 'operations' },
  }, workspace.emptyLedger(), { now: new Date('2026-07-21T15:00:00.000Z') });
  assert.throws(() => workspace.commitFocus({
    frame_id: created.frame.id, selected_focus_key: created.frame.selected_focus_key,
    disposition: 'defer_no_optional_latitude', planned_expression: 'Defer it.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' }],
  }, created.ledger), /only an optional focus/);

  const committed = workspace.commitFocus({
    frame_id: created.frame.id, selected_focus_key: created.frame.selected_focus_key,
    disposition: 'follow_after_required_checks',
    planned_expression: 'Check the deadline evidence before deciding whether to notify anyone.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' }],
  }, created.ledger, { now: new Date('2026-07-21T15:01:00.000Z') });
  assert.equal(workspace.auditFocusCommitment(committed.focus_commitment,
    committed.ledger).complete_chain_verified, true);
  assert.equal(committed.report.prospectively_committed_focuses, 1);
  const retry = workspace.commitFocus({
    frame_id: created.frame.id, selected_focus_key: created.frame.selected_focus_key,
    disposition: 'follow_after_required_checks',
    planned_expression: 'Check the deadline evidence before deciding whether to notify anyone.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' }],
  }, committed.ledger, { now: new Date('2026-07-21T15:02:00.000Z') });
  assert.equal(retry.created, false);
  assert.equal(retry.focus_commitment.id, committed.focus_commitment.id);
  assert.throws(() => workspace.commitFocus({
    frame_id: created.frame.id, selected_focus_key: created.frame.selected_focus_key,
    disposition: 'follow_after_required_checks', planned_expression: 'A rewritten plan.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' }],
  }, committed.ledger), /different focus commitment/);

  const cycle = { id: 'cycle-focus', status: 'completed',
    finished: '2026-07-21T15:20:00.000Z', summary: 'Verified the deadline evidence.',
    actions: [{ type: 'observe', id: 'tw-1' }] };
  const moment = { id: 'moment-focus', cycle_id: 'cycle-focus', status: 'completed',
    closure_commitment: 'a'.repeat(64),
    audit: { complete_lifecycle_verified: true, evidence_eligible: true } };
  const resolved = workspace.resolveFocus({
    focus_commitment_id: committed.focus_commitment.id, outcome: 'enacted',
    observed_expression: 'Read the current task evidence and withheld an unsupported notification.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-focus' },
      { type: 'experience_moment', id: 'moment-focus' }],
  }, committed.ledger, { cycle, moment, now: new Date(cycle.finished) });
  assert.equal(workspace.auditFocusOutcome(resolved.focus_outcome,
    resolved.ledger).complete_chain_verified, true);
  assert.equal(resolved.report.replay_verified_focus_outcomes, 1);
  assert.equal(resolved.report.focus_outcome_counts.enacted, 1);

  const tampered = structuredClone(resolved.ledger);
  tampered.focus_outcomes[0].observed_expression = 'A rewritten result';
  assert.equal(workspace.auditFocusOutcome(tampered.focus_outcomes[0], tampered)
    .complete_chain_verified, false);
});
