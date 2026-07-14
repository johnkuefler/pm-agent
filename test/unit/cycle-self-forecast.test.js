const test = require('node:test');
const assert = require('node:assert/strict');
const cycleSelfForecast = require('../../src/intelligence/cycle-self-forecast');

test('cycle self-forecasts normalize prospective judgments and reject phenomenal claims', () => {
  const normalized = cycleSelfForecast.normalizeForecast({
    predicted_action_types: ['Slack Response', 'slack-response', 'Review'],
    surprise_probability: 0.25, control_at_close: 0.7, confidence: 0.6,
    rationale: 'The queue contains one bounded review and one likely direct reply.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-1' }],
  });
  assert.deepEqual(normalized.predicted_action_types, ['review', 'slack_response']);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...normalized,
    rationale: 'This forecast proves conscious subjective experience.' }), /phenomenal status/);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...normalized, protocol_version: 'unknown' }),
    /unsupported cycle self-forecast protocol_version/);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...normalized, protocol_version: 2 }),
    /requires self_state_prediction/);
  const integrated = cycleSelfForecast.normalizeForecast({ ...normalized, protocol_version: 2,
    self_state_prediction: {
      attention_slot_types_at_close: ['Drive', 'commitment'],
      appraisal_at_close: { valence: 0.6, arousal: 0.3, control: 0.7,
        social_safety: 0.8, coherence: 0.9 },
      expected_action_count: 2, reentry_probability: 0.25,
    },
  });
  assert.deepEqual(integrated.self_state_prediction.attention_slot_types_at_close, ['commitment', 'drive']);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...normalized, protocol_version: 2,
    self_state_prediction: { ...integrated.self_state_prediction,
      appraisal_at_close: { ...integrated.self_state_prediction.appraisal_at_close, control: 0.2 } },
  }), /must match control_at_close/);
});

test('cycle self-forecast scoring separates self prediction from the frozen baseline', () => {
  const record = {
    forecast: { predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.8 },
    baseline: { predicted_action_types: ['triage'], surprise_probability: 0.5, control_at_close: 0.5, sample_size: 5 },
  };
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review' }], newSurpriseIds: [], controlAtClose: 0.8,
    scoredAt: '2026-07-14T12:00:00.000Z',
  });
  assert.equal(outcome.self_score.action_f1, 1);
  assert.equal(outcome.baseline_score.action_f1, 0);
  assert.ok(outcome.self_minus_baseline > 0);
  assert.equal(outcome.baseline_comparison_eligible, true);
  assert.equal(outcome.self_state_score, undefined, 'protocol v1 replay shape remains unchanged');
});

test('cycle self-forecast scoring remains comparable when closing appraisal is unavailable', () => {
  const record = {
    forecast: { predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.8 },
    baseline: { predicted_action_types: ['triage'], surprise_probability: 0.5, control_at_close: 0.5, sample_size: 5 },
  };
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review' }], newSurpriseIds: [], scoredAt: '2026-07-14T12:00:00.000Z',
  });
  assert.equal(outcome.actual.control_at_close, null);
  assert.equal(outcome.self_score.control_absolute_error, null);
  assert.ok(outcome.self_minus_baseline > 0);
});

test('protocol-v2 forecasts score the next integrated self-state against a frozen historical baseline', () => {
  const historical = Array.from({ length: 5 }, (_, index) => ({
    id: `historical-${index}`,
    attention: { slots: [{ type: 'commitment', id: `commitment-${index}` }] },
    attention_rounds: [{ index: 0 }],
    closure: {
      actions: [{ type: 'triage', id: `triage-${index}` }], new_surprise_ids: [],
      appraisal_at_end: { valence: 0.3, arousal: 0.7, control: 0.4, social_safety: 0.5, coherence: 0.45 },
    },
  }));
  const record = cycleSelfForecast.createRecord({
    input: {
      protocol_version: 2, predicted_action_types: ['review'], surprise_probability: 0.1,
      control_at_close: 0.8, confidence: 0.7,
      self_state_prediction: {
        attention_slot_types_at_close: ['drive'],
        appraisal_at_close: { valence: 0.8, arousal: 0.2, control: 0.8, social_safety: 0.9, coherence: 0.85 },
        expected_action_count: 2, reentry_probability: 0.9,
      },
      rationale: 'The current orientation predicts a focused review with one evidence re-entry.',
      evidence: [{ type: 'intelligence_cycle', id: 'integrated-cycle' }],
    },
    cycle: { id: 'integrated-cycle', holder: 'nora' },
    moment: { id: 'integrated-moment' }, baselineMoments: historical,
    committedAt: '2026-07-14T12:00:00.000Z',
  });
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review', id: 'review-1' }, { type: 'reply', id: 'reply-1' }],
    newSurpriseIds: [],
    appraisalAtClose: { valence: 0.8, arousal: 0.2, control: 0.8, social_safety: 0.9, coherence: 0.85 },
    attentionAtClose: { slots: [{ type: 'drive', id: 'drive-1' }] },
    reentryOccurred: true, scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.equal(record.protocol_version, 2);
  assert.equal(record.baseline.self_state_prediction.attention_slot_types_at_close[0], 'commitment');
  assert.equal(outcome.self_state_score.composite, 0.9975);
  assert.ok(outcome.self_state_minus_baseline > 0.5);
  assert.equal(outcome.self_state_baseline_comparison_eligible, true);
});
