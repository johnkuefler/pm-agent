const test = require('node:test');
const assert = require('node:assert/strict');
const consequences = require('../../src/intelligence/consequence-review');
const { createIntelligenceStore } = require('../../src/intelligence/store');

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

test('observed consequence lessons can enter prompt context as bounded prior evidence', async () => {
  const created = consequences.createAction({
    id: 'cr-john-deadline',
    action_type: 'deadline_flag',
    description: 'Sent John a concise deadline uncertainty note.',
    intended_effect: 'Help John decide whether to push the date or clear a blocker.',
    success_criteria: 'A later reply or task update shows whether the concise nudge clarified the next step.',
    expected_signal: 'Slack reply or Teamwork date update.',
    beneficiary: 'John and the project team',
    target_ref: 'slack:John',
    evidence: [{ type: 'slack_message', id: 'C1:1.000:1.000' }],
  }, consequences.emptyLedger(), { now: new Date('2026-07-20T10:00:00.000Z') });
  const observed = consequences.observeAction(created.ledger, 'cr-john-deadline', {
    outcome: 'helped',
    observed_effect: 'John replied with the needed owner decision and the Teamwork task moved.',
    evidence: [{ type: 'slack_message', id: 'C1:2.000:2.000' }],
    should_change_behavior: true,
    behavior_update: 'For John deadline ambiguity, lead with the concrete recommendation before detail.',
  }, { now: new Date('2026-07-20T12:00:00.000Z') });

  const lessons = consequences.promptLessons(observed.ledger, {
    person: 'John',
    query: 'deadline ambiguity recommendation',
  });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].outcome, 'helped');
  assert.match(consequences.renderPromptLessons(lessons), /Behavior update/);

  const store = createIntelligenceStore({ db: {}, isDbReady: () => false });
  await store.init();
  const prompt = store.promptContext({
    person: 'John',
    query: 'deadline ambiguity recommendation',
    consequenceContext: { lessons, rendered: consequences.renderPromptLessons(lessons) },
    returnContextReceipt: true,
  });
  assert.match(prompt.text, /Observed consequences from prior Nora actions/);
  assert.match(prompt.text, /Completion is not consequence/);
  assert.match(prompt.text, /lead with the concrete recommendation/);
  assert.deepEqual(prompt.context_receipt.consequence_lessons, [{
    action_id: lessons[0].action_id,
    observation_id: lessons[0].observation_id,
    action_commitment: lessons[0].action_commitment,
    observation_commitment: lessons[0].observation_commitment,
  }]);
  assert.equal(consequences.promptLessons(observed.ledger, {
    person: 'Maya',
    query: 'creative review',
  }).length, 0);
});

test('delivered consequence lessons form a replay-bound behavior revision loop', () => {
  const created = consequences.createAction({
    id: 'cr-pressure-pattern',
    action_type: 'warmth',
    description: 'Sent encouragement while a teammate was still blocked.',
    intended_effect: 'Help the teammate feel supported.',
    success_criteria: 'A later response shows whether the message reduced or added pressure.',
    target_ref: 'slack:teammate',
    evidence: [{ type: 'slack_message', id: 'source-1' }],
  }, consequences.emptyLedger(), { now: new Date('2026-07-20T10:00:00.000Z') });
  let state = consequences.observeAction(created.ledger, created.action.id, {
    outcome: 'backfired',
    observed_effect: 'The note added pressure before the blocker was removed.',
    evidence: [{ type: 'slack_message', id: 'source-2' }],
    should_change_behavior: true,
    behavior_update: 'Acknowledge the blocker and explicitly remove pressure before offering encouragement.',
  }, { now: new Date('2026-07-20T11:00:00.000Z') }).ledger;
  const lesson = consequences.promptLessons(state, {
    person: 'Teammate', query: 'blocked encouragement pressure', limit: 1,
  })[0];
  assert.match(consequences.renderPromptLessons([lesson]), /Pre-action error forecast/);

  for (let index = 0; index < 3; index++) {
    const recorded = consequences.recordPromptApplication(state, {
      id: `cr-app-${index}`,
      surface: 'slack',
      lesson_refs: [lesson],
      query: 'They are still blocked; what should I say?',
      person: 'Teammate',
      interaction_id: `ix-${index}`,
      interaction_ref: `slack-ts-${index}`,
    }, { now: new Date(`2026-07-20T12:0${index}:00.000Z`) });
    assert.equal(consequences.auditApplication(recorded.ledger, recorded.application).complete_chain_verified, true);
    state = consequences.resolvePromptApplication(recorded.ledger, {
      interaction_id: `ix-${index}`,
      outcome: index === 2 ? 'corrected' : 'landed',
      signal: index === 2 ? 'The teammate clarified that the blocker had already cleared.' : 'The teammate acknowledged the no-pressure note positively.',
      reviewed_at: `2026-07-21T12:0${index}:00.000Z`,
    }).ledger;
  }

  const feedback = consequences.applicationFeedback(state, created.action.id);
  assert.deepEqual({ decisive: feedback.decisive, positive: feedback.positive, negative: feedback.negative },
    { decisive: 3, positive: 2, negative: 1 });
  const revisedLesson = consequences.promptLessons(state, {
    person: 'Teammate', query: 'blocked encouragement pressure', limit: 1,
  })[0];
  assert.match(consequences.renderPromptLessons([revisedLesson]), /2 positive, 1 negative; observational only/);

  const tampered = JSON.parse(JSON.stringify(state));
  tampered.applications[0].lesson_refs[0].observation_commitment = '0'.repeat(64);
  assert.equal(consequences.auditApplication(tampered, tampered.applications[0]).complete_chain_verified, false);
  assert.equal(consequences.applicationFeedback(tampered, created.action.id).decisive, 2,
    'tampered exposure is excluded from future behavior feedback');
});
