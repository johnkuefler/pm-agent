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
