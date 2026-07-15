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

test('protocol-v3 forecasts score awareness of self-model reliability and likely error domain', () => {
  const historical = Array.from({ length: 5 }, (_, index) => ({
    id: `metacognitive-history-${index}`,
    attention: { slots: [{ type: 'drive', id: `drive-${index}` }] },
    attention_rounds: [{ index: 0 }],
    closure: {
      actions: [{ type: 'review', id: `review-${index}` }], new_surprise_ids: [],
      appraisal_at_end: { valence: 0.5, arousal: 0.3, control: 0.7, social_safety: 0.8, coherence: 0.9 },
    },
    self_forecast: { outcome: {
      self_score: { action_f1: 1 },
      self_state_score: { composite: 0.9, attention_f1: 1, action_count_accuracy: 0.5,
        appraisal_mean_absolute_error: 0.05, reentry_brier: 0.01 },
    } },
  }));
  const input = {
    protocol_version: 3, predicted_action_types: ['review'], surprise_probability: 0.1,
    control_at_close: 0.7, confidence: 0.2,
    self_state_prediction: {
      attention_slot_types_at_close: ['drive'],
      appraisal_at_close: { valence: 0.5, arousal: 0.3, control: 0.7, social_safety: 0.8, coherence: 0.9 },
      expected_action_count: 2, reentry_probability: 0.1,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.2,
      predicted_largest_error_domain: 'attention',
    },
    rationale: 'The action plan is stable, but the closing workspace remains difficult to predict.',
    evidence: [{ type: 'intelligence_cycle', id: 'metacognitive-cycle' }],
  };
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...input,
    metacognitive_prediction: { ...input.metacognitive_prediction, predicted_success_probability: 0.8 } }),
  /must match confidence/);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...input,
    metacognitive_prediction: { ...input.metacognitive_prediction, predicted_largest_error_domain: 'intuition' } }),
  /must be one of/);
  const record = cycleSelfForecast.createRecord({ input,
    cycle: { id: 'metacognitive-cycle', holder: 'nora' }, moment: { id: 'metacognitive-moment' },
    baselineMoments: historical, committedAt: '2026-07-14T12:00:00.000Z' });
  assert.equal(record.forecast.metacognitive_prediction.integrated_success_threshold, 0.75);
  assert.equal(record.baseline.metacognitive_prediction.predicted_success_probability, 1);
  assert.equal(record.baseline.metacognitive_prediction.predicted_largest_error_domain, 'action_count');
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review', id: 'review' }, { type: 'triage', id: 'triage' }],
    newSurpriseIds: [],
    appraisalAtClose: { valence: 0.5, arousal: 0.3, control: 0.7, social_safety: 0.8, coherence: 0.9 },
    attentionAtClose: { slots: [{ type: 'commitment', id: 'commitment' }] },
    reentryOccurred: false, scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.equal(outcome.metacognitive_actual.integrated_success, false);
  assert.equal(outcome.metacognitive_actual.largest_error_domain, 'attention');
  assert.equal(outcome.metacognitive_score.largest_error_domain_hit, true);
  assert.equal(outcome.baseline_metacognitive_score.largest_error_domain_hit, false);
  assert.ok(outcome.metacognitive_self_minus_baseline > 0.9);
  assert.equal(outcome.metacognitive_baseline_comparison_eligible, true);
});

test('protocol-v3 preserves incomplete closures but excludes them from reliability evidence', () => {
  const record = cycleSelfForecast.createRecord({
    input: {
      protocol_version: 3, predicted_action_types: ['review'], surprise_probability: 0.2,
      control_at_close: 0.7, confidence: 0.5,
      self_state_prediction: {
        attention_slot_types_at_close: ['drive'],
        appraisal_at_close: { valence: 0.5, arousal: 0.3, control: 0.7, social_safety: 0.8, coherence: 0.9 },
        expected_action_count: 1, reentry_probability: 0.1,
      },
      metacognitive_prediction: {
        predicted_success_probability: 0.5,
        predicted_largest_error_domain: 'appraisal',
      },
      rationale: 'The bounded review is predictable but the closing appraisal may be unavailable.',
      evidence: [{ type: 'intelligence_cycle', id: 'incomplete-cycle' }],
    },
    cycle: { id: 'incomplete-cycle', holder: 'nora' }, moment: { id: 'incomplete-moment' },
    baselineMoments: [], committedAt: '2026-07-14T12:00:00.000Z',
  });
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review', id: 'review' }], newSurpriseIds: [],
    attentionAtClose: { slots: [{ type: 'drive', id: 'drive' }] }, reentryOccurred: false,
    scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.equal(outcome.metacognitive_actual.complete_domain_observation, false);
  assert.deepEqual(outcome.metacognitive_actual.missing_domains, ['appraisal']);
  assert.equal(outcome.metacognitive_actual.integrated_success, null);
  assert.equal(outcome.metacognitive_actual.largest_error_domain, null);
  assert.equal(outcome.metacognitive_score, null);
  assert.equal(outcome.baseline_metacognitive_score, null);
  assert.equal(outcome.metacognitive_self_minus_baseline, null);
  assert.equal(outcome.metacognitive_baseline_comparison_eligible, false);
});
