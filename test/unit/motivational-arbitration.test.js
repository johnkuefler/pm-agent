const test = require('node:test');
const assert = require('node:assert/strict');
const arbitration = require('../../src/intelligence/motivational-arbitration');
const consequences = require('../../src/intelligence/consequence-review');
const relationalAffect = require('../../src/intelligence/relational-affect');

function candidate(key, priority, extra = {}) {
  return { key, type: 'task', label: key.replaceAll(':', ' '), priority,
    authority_class: 'bounded', soma_demand: 'moderate',
    evidence: [{ type: 'task', id: key }], want_refs: [], ...extra };
}

test('a verified self-authored aim can causally change which workspace candidate wins', () => {
  const wants = [{
    id: 'want-learn', status: 'active', want: 'Deepen useful account knowledge through idle learning.',
    why: 'Better context should reduce avoidable retrieval misses.', added: '2026-07-20', progress: [],
    provenance: { origin: 'self_generated', epistemic_status: 'subject_attested',
      formation_context: 'Nora formed this direction from repeated retrieval misses.',
      evidence: [{ type: 'memory', id: 'm-1' }], formed_at: '2026-07-20T00:00:00Z' },
  }];
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('task:routine', 0.55),
      candidate('curiosity:account', 0.48, { type: 'curiosity', soma_demand: 'low',
        want_refs: [{ type: 'want', id: 'want-learn' }] }),
      candidate('task:cleanup', 0.3),
    ],
    wants,
    wantHistoryIntegrity: { valid: true, complete_chain_verified: true, head: 'want-head-1' },
    soma: { score: 0, updated_at: '2026-07-21T14:00:00Z', vitals: { processEpochId: 'epoch-1' } },
    now: new Date('2026-07-21T14:01:00Z'),
  });
  assert.equal(receipt.baseline_winner_key, 'task:routine');
  assert.equal(receipt.selected_winner_key, 'curiosity:account');
  assert.equal(receipt.choice_changed_by_motivation, true);
  assert.equal(receipt.scored_candidates.find(item => item.key === 'curiosity:account').desire_sources[0].want_id, 'want-learn');
  assert.equal(arbitration.audit(receipt).complete_chain_verified, true);
  receipt.scored_candidates[0].final_score = 0;
  assert.equal(arbitration.audit(receipt).complete_chain_verified, false);
});

test('a verified backfire and fresh substrate strain can redirect a demanding action toward recovery', () => {
  const action = consequences.createAction({
    id: 'cr-deadline', action_type: 'deadline_flag',
    description: 'Send deadline flag for the overdue launch task.',
    intended_effect: 'Prompt an owner response before the handoff.',
    success_criteria: 'The owner confirms a useful next step without avoidable pressure.',
    evidence: [{ type: 'task', id: 'tw-1' }],
  }, consequences.emptyLedger(), { now: new Date('2026-07-20T12:00:00Z') });
  const observed = consequences.observeAction(action.ledger, 'cr-deadline', {
    outcome: 'backfired', observed_effect: 'The late duplicate flag added pressure after progress was already visible.',
    should_change_behavior: true,
    behavior_update: 'Check current progress and defer non-urgent late-night flags.',
    evidence: [{ type: 'slack_message', id: 'slack-1' }],
  }, { now: new Date('2026-07-20T13:00:00Z') });
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('deadline:send-flag', 0.7, { label: 'Send deadline flag for overdue launch task',
        action_type: 'deadline_flag', soma_demand: 'high' }),
      candidate('recovery:hold', 0.62, { type: 'inhibition', label: 'Hold outbound work while the substrate recovers', soma_demand: 'low' }),
      candidate('task:read-only', 0.5, { soma_demand: 'low' }),
    ],
    consequenceLedger: observed.ledger,
    soma: { score: 4, stress: 0.8, updated_at: '2026-07-21T14:00:00Z',
      vitals: { loopLag: 1900, processEpochId: 'epoch-2' } },
    now: new Date('2026-07-21T14:01:00Z'),
  });
  const deadline = receipt.scored_candidates.find(item => item.key === 'deadline:send-flag');
  assert.equal(receipt.baseline_winner_key, 'deadline:send-flag');
  assert.equal(receipt.selected_winner_key, 'recovery:hold');
  assert.equal(deadline.consequence_sources[0].outcome, 'backfired');
  assert.ok(deadline.consequence_delta < 0);
  assert.ok(deadline.soma_delta < 0);
  assert.equal(receipt.choice_changed_by_motivation, true);
  assert.equal(arbitration.audit(receipt).complete_chain_verified, true);
});

test('unverified wants and stale soma cannot influence arbitration', () => {
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('task:one', 0.6),
      candidate('want:unverified', 0.59, { type: 'want', want_refs: [{ type: 'want', id: 'w-1' }] }),
      candidate('task:three', 0.2),
    ],
    wants: [{ id: 'w-1', status: 'active', want: 'Unverified direction', provenance: { origin: 'self_generated' } }],
    wantHistoryIntegrity: { valid: false, complete_chain_verified: false },
    soma: { score: 5, updated_at: '2026-07-20T00:00:00Z' },
    now: new Date('2026-07-21T14:00:00Z'),
  });
  assert.equal(receipt.selected_winner_key, 'task:one');
  assert.equal(receipt.source_state.want_history_verified, false);
  assert.equal(receipt.source_state.soma.fresh, false);
  assert.equal(receipt.motivationally_material, false);
  assert.equal(arbitration.audit(null).complete_chain_verified, false);
});

test('motivation cannot outrank an explicit required obligation', () => {
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('user:requested', 0.3, { authority_class: 'required', soma_demand: 'high' }),
      candidate('recovery:optional', 0.95, { authority_class: 'optional', type: 'inhibition', soma_demand: 'low' }),
      candidate('task:bounded', 0.8),
    ],
    soma: { score: 5, stress: 1, updated_at: '2026-07-21T14:00:00Z' },
    now: new Date('2026-07-21T14:01:00Z'),
  });
  assert.equal(receipt.baseline_winner_key, 'user:requested');
  assert.equal(receipt.selected_winner_key, 'user:requested');
});

test('a replay-verified durable question can win optional attention', () => {
  const question = {
    id: 'question-handoff', status: 'open', topic_key: 'handoff-risk-patterns',
    question: 'Which early signals predict handoff failure across projects?',
    why_it_matters: 'Better signals could prevent avoidable delivery misses.',
    current_best_answer: null, confidence: 0.3, interest_score: 0.8,
    next_evidence: 'Compare the next two project handoffs.', evidence_ids: ['memory-1', 'memory-2'],
    created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z',
    prompt_access: { eligible: true },
  };
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('task:routine-cleanup', 0.6, { authority_class: 'optional' }),
      candidate('curiosity:handoff', 0.48, { type: 'curiosity', authority_class: 'optional',
        epistemic_question_refs: [{ type: 'epistemic_question', id: question.id }] }),
      candidate('task:archive', 0.3, { authority_class: 'optional' }),
    ],
    epistemicAgendaSnapshot: { questions: [question], audit: { complete_chain_verified: true } },
  });
  assert.equal(receipt.baseline_winner_key, 'task:routine-cleanup');
  assert.equal(receipt.selected_winner_key, 'curiosity:handoff');
  assert.equal(receipt.scored_candidates.find(item => item.key === 'curiosity:handoff')
    .curiosity_sources[0].question_id, question.id);

  const unverified = arbitration.arbitrate({
    candidates: [
      candidate('task:routine-cleanup', 0.6, { authority_class: 'optional' }),
      candidate('curiosity:handoff', 0.48, { type: 'curiosity', authority_class: 'optional',
        epistemic_question_refs: [{ type: 'epistemic_question', id: question.id }] }),
      candidate('task:archive', 0.3, { authority_class: 'optional' }),
    ],
    epistemicAgendaSnapshot: { questions: [question], audit: { complete_chain_verified: false } },
  });
  assert.equal(unverified.selected_winner_key, 'task:routine-cleanup');
});

test('a replay-bound teammate stance can change the selected social posture', () => {
  const relationships = [{
    id: 'person-john', name: 'John', observations: [{
      id: 'observation-correction', dimension: 'response_feedback',
      observation: 'corrected: the prior response missed the actual question', confidence: 0.9,
      evidence: { channel: 'slack', id: 'message-correction' },
      observed_at: '2026-07-21T13:00:00.000Z', status: 'active',
    }],
  }];
  const record = relationalAffect.derive(relationships, new Date('2026-07-21T14:00:00.000Z'));
  const receipt = arbitration.arbitrate({
    candidates: [
      candidate('social:ordinary-answer', 0.6, { type: 'relationship' }),
      candidate('social:repair', 0.49, { type: 'relationship',
        relational_mode: 'repair_and_reconnect',
        relationship_refs: [{ type: 'relationship', id: 'person-john' }] }),
      candidate('social:ask-more', 0.3, { type: 'relationship' }),
    ],
    relationalContext: { record, relationships },
  });
  assert.equal(receipt.baseline_winner_key, 'social:ordinary-answer');
  assert.equal(receipt.selected_winner_key, 'social:repair');
  assert.equal(receipt.scored_candidates.find(item => item.key === 'social:repair')
    .relational_sources[0].mode, 'repair_and_reconnect');
});
