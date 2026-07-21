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
    changed_mind: {
      from: 'Send a generic thanks.',
      to: 'Wait for specific evidence and make it concrete.',
      because: 'The epistemic claim recorded thin evidence.',
      evidence: [{ type: 'epistemic_claim', id: 'ep-1' }],
    },
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
