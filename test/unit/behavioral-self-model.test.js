const test = require('node:test');
const assert = require('node:assert/strict');
const behavioralSelfModel = require('../../src/intelligence/behavioral-self-model');

function moment(index, { action = 'review', surprise = false, predictedSurprise = 0.2,
  control = 0.7, predictedControl = 0.8, eligible = true } = {}) {
  return {
    id: `moment-${index}`,
    self_forecast: {
      id: `forecast-${index}`,
      forecast: { surprise_probability: predictedSurprise, control_at_close: predictedControl },
      outcome: {
        actual: { action_types: [action], surprise_occurred: surprise, control_at_close: control },
        self_score: { action_f1: 1, surprise_brier: (predictedSurprise - Number(surprise)) ** 2,
          control_absolute_error: Math.abs(predictedControl - control), composite: 0.9 },
        baseline_score: { composite: 0.6 }, self_minus_baseline: 0.3,
        baseline_comparison_eligible: eligible,
      },
    },
  };
}

test('behavioral self-model revisions expose directional error and bounded action tendencies', () => {
  const moments = [
    moment(0), moment(1), moment(2, { action: 'triage', surprise: true, predictedSurprise: 0.4 }),
    moment(3), moment(4),
  ];
  const revision = behavioralSelfModel.buildRevision({ moments, revisionIndex: 0,
    createdAt: '2026-07-14T12:00:00.000Z' });
  assert.equal(revision.evidence_status, 'observational_profile');
  assert.equal(revision.estimates.sample_size, 5);
  assert.deepEqual(revision.estimates.action_tendencies.map(item => item.action_type), ['review', 'triage']);
  assert.ok(revision.estimates.surprise.signed_bias > 0, 'predicted surprise exceeds observed rate');
  assert.ok(revision.estimates.control.signed_bias > 0, 'predicted control exceeds observed control');
  assert.equal(behavioralSelfModel.commitment(behavioralSelfModel.revisionManifest(revision)), revision.revision_commitment);
});

test('behavioral self-model revisions retain only the latest twenty source moments', () => {
  const moments = Array.from({ length: 25 }, (_, index) => moment(index, { action: index < 5 ? 'legacy' : 'review' }));
  const revision = behavioralSelfModel.buildRevision({ moments, revisionIndex: 4,
    priorRevisionCommitment: 'prior-commitment', createdAt: '2026-07-14T12:00:00.000Z' });
  assert.equal(revision.estimates.sample_size, 20);
  assert.equal(revision.source_moment_ids[0], 'moment-5');
  assert.equal(revision.estimates.action_tendencies.some(item => item.action_type === 'legacy'), false);
});

test('lagged forecast priors preserve source audit while removing retired action families', () => {
  const moments = Array.from({ length: 20 }, (_, index) =>
    moment(index, { action: index < 6 ? 'dev_dispatch' : 'review' }));
  const revision = behavioralSelfModel.buildRevision({ moments, revisionIndex: 7,
    priorRevisionCommitment: 'prior-commitment', createdAt: '2026-07-14T12:00:00.000Z' });
  assert.equal(revision.estimates.action_tendencies.some(item => item.action_type === 'dev_dispatch'), true,
    'historical committed revision remains unchanged');
  const prior = behavioralSelfModel.buildForecastPrior({ revision,
    excludedImmediatePredecessorId: 'moment-20' });
  assert.equal(prior.estimates.action_tendencies.some(item => item.action_type === 'dev_dispatch'), false);
  assert.equal(prior.excluded_retired_action_observations, 6);
  assert.equal(prior.excluded_immediate_predecessor_id, 'moment-20');
  assert.equal(behavioralSelfModel.commitment(behavioralSelfModel.forecastPriorManifest(prior)),
    prior.content_commitment);
  assert.throws(() => behavioralSelfModel.buildForecastPrior({ revision,
    excludedImmediatePredecessorId: 'moment-19' }), /exclude the immediate predecessor/);
});

test('protocol-v3 revisions consolidate second-order reliability calibration without erasing first-order error', () => {
  const moments = Array.from({ length: 5 }, (_, index) => {
    const base = moment(index);
    base.self_forecast.protocol_version = 3;
    base.self_forecast.forecast.self_state_prediction = {};
    base.self_forecast.forecast.metacognitive_prediction = {
      predicted_success_probability: index < 3 ? 0.8 : 0.3,
      predicted_largest_error_domain: index % 2 ? 'attention' : 'action_count',
    };
    base.self_forecast.outcome.self_state_score = { composite: index < 3 ? 0.8 : 0.6,
      attention_f1: 0.5, action_count_absolute_error: 2, action_count_accuracy: 0.8,
      appraisal_absolute_errors: {}, appraisal_mean_absolute_error: 0.1, reentry_brier: 0.04 };
    base.self_forecast.outcome.self_state_actual = { appraisal_at_close: {} };
    base.self_forecast.outcome.baseline_state_score = { composite: 0.7 };
    base.self_forecast.outcome.self_state_minus_baseline = 0.05;
    base.self_forecast.outcome.self_state_baseline_comparison_eligible = true;
    const success = index < 3;
    const hit = index % 2 === 1;
    base.self_forecast.outcome.metacognitive_actual = {
      integrated_success: success,
      largest_error_domain: hit ? 'attention' : 'appraisal',
    };
    base.self_forecast.outcome.metacognitive_score = {
      success_brier: (base.self_forecast.forecast.metacognitive_prediction.predicted_success_probability
        - Number(success)) ** 2,
      largest_error_domain_hit: hit,
      composite: hit ? 0.8 : 0.4,
    };
    base.self_forecast.outcome.baseline_metacognitive_score = { composite: 0.5 };
    base.self_forecast.outcome.metacognitive_self_minus_baseline = hit ? 0.3 : -0.1;
    base.self_forecast.outcome.metacognitive_baseline_comparison_eligible = true;
    return base;
  });
  const revision = behavioralSelfModel.buildRevision({ moments, revisionIndex: 0,
    createdAt: '2026-07-14T12:00:00.000Z' });
  assert.equal(revision.protocol_version, 3);
  assert.equal(revision.estimates.metacognitive_self_awareness.samples, 5);
  assert.equal(revision.estimates.metacognitive_self_awareness.observed_integrated_success_rate, 0.6);
  assert.equal(revision.estimates.metacognitive_self_awareness.largest_error_domain_hit_rate, 0.4);
  assert.equal(revision.estimates.metacognitive_self_awareness.comparison_eligible_samples, 5);
  assert.match(revision.epistemic_limit, /second-order reliability/);
});
