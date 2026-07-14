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
