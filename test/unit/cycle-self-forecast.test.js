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

test('protocol-v4 forecasts observable substrate state against start-state persistence', () => {
  const input = {
    protocol_version: 4, predicted_action_types: ['review'], surprise_probability: 0.1,
    control_at_close: 0.8, confidence: 0.9,
    self_state_prediction: {
      attention_slot_types_at_close: ['drive'],
      appraisal_at_close: { valence: 0.7, arousal: 0.2, control: 0.8,
        social_safety: 0.9, coherence: 0.9 },
      expected_action_count: 1, reentry_probability: 0.1,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.9,
      predicted_largest_error_domain: 'substrate',
    },
    substrate_prediction: {
      error_probability: 1, warning_probability: 1, backup_probability: 0,
      embedding_backlog_probability: 1, restart_probability: 1,
    },
    rationale: 'Recent operational telemetry makes a restart and closing degradation plausible.',
    evidence: [{ type: 'intelligence_cycle', id: 'substrate-cycle' }],
  };
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...input,
    substrate_prediction: { ...input.substrate_prediction, restart_probability: undefined } }),
  /must be finite/);
  const start = cycleSelfForecast.normalizeSubstrateObservation({
    updated_at: '2026-07-14T12:00:00.000Z',
    vitals: { errors10: 0, warns10: 0, loopLag: 10, uptimeMin: 120,
      processEpochId: 'process-before-restart',
      onBackup: false, memCount: 100, embedBacklog: 0 },
  });
  const close = cycleSelfForecast.normalizeSubstrateObservation({
    updated_at: '2026-07-14T12:05:00.000Z',
    vitals: { errors10: 2, warns10: 1, loopLag: 25, uptimeMin: 2,
      processEpochId: 'process-after-restart',
      onBackup: false, memCount: 101, embedBacklog: 3 },
  });
  const record = cycleSelfForecast.createRecord({ input,
    cycle: { id: 'substrate-cycle', holder: 'nora' },
    moment: { id: 'substrate-moment', substrate_at_start: start }, baselineMoments: [],
    committedAt: '2026-07-14T12:00:01.000Z' });
  assert.equal(record.baseline.substrate_baseline_kind, 'start_state_persistence');
  assert.deepEqual(record.baseline.substrate_prediction, {
    error_probability: 0, warning_probability: 0, backup_probability: 0,
    embedding_backlog_probability: 0, restart_probability: 0,
  });
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review' }], newSurpriseIds: [],
    appraisalAtClose: { valence: 0.7, arousal: 0.2, control: 0.8,
      social_safety: 0.9, coherence: 0.9 },
    attentionAtClose: { slots: [{ type: 'drive' }] }, reentryOccurred: false,
    substrateAtStart: start, substrateAtClose: close,
    startedAt: '2026-07-14T12:00:00.000Z', finishedAt: '2026-07-14T12:05:00.000Z',
    scoredAt: '2026-07-14T12:05:00.000Z',
  });
  assert.equal(outcome.substrate_actual.restart_observed, true);
  assert.notEqual(outcome.substrate_actual.start_observation.process_epoch_id,
    outcome.substrate_actual.close_observation.process_epoch_id);
  assert.equal(outcome.substrate_score.composite, 1);
  assert.equal(outcome.baseline_substrate_score.composite, 0.2);
  assert.equal(outcome.substrate_self_minus_baseline, 0.8);
  assert.equal(outcome.substrate_baseline_comparison_eligible, true);
  assert.equal(outcome.metacognitive_actual.integrated_score,
    (outcome.self_state_score.composite + outcome.substrate_score.composite) / 2);
  const outcomeCommitment = cycleSelfForecast.commitment({
    forecast_commitment: record.forecast_commitment, outcome,
  });
  const feedback = cycleSelfForecast.errorFeedbackFromMoment({ id: 'substrate-moment',
    self_forecast: { ...record, outcome, outcome_commitment: outcomeCommitment } });
  assert.equal(feedback.substrate.actual.restart_observed, true);
  assert.equal(feedback.substrate.self_minus_persistence, 0.8);
});

test('protocol-v5 binds a lagged behavioral prior and excludes retired action families prospectively', () => {
  const priorCommitment = 'a'.repeat(64);
  const input = {
    protocol_version: 5, predicted_action_types: ['review'], surprise_probability: 0.1,
    control_at_close: 0.7, confidence: 0.8,
    self_state_prediction: {
      attention_slot_types_at_close: ['drive'],
      appraisal_at_close: { valence: 0.6, arousal: 0.3, control: 0.7,
        social_safety: 0.8, coherence: 0.85 },
      expected_action_count: 1, reentry_probability: 0.1,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.8,
      predicted_largest_error_domain: 'action_types',
    },
    substrate_prediction: {
      error_probability: 0.1, warning_probability: 0.2, backup_probability: 0.05,
      embedding_backlog_probability: 0.1, restart_probability: 0.05,
    },
    behavioral_self_prior_commitment: priorCommitment,
    rationale: 'The lagged behavioral prior and current orientation both support one bounded review.',
    evidence: [{ type: 'intelligence_cycle', id: 'prior-cycle' },
      { type: 'behavioral_self_prior', id: priorCommitment }],
  };
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...input,
    predicted_action_types: ['dev_dispatch'] }), /retired development-dispatch/);
  assert.throws(() => cycleSelfForecast.normalizeForecast({ ...input,
    behavioral_self_prior_commitment: 'b'.repeat(64) }), /must cite its behavioral_self_prior/);
  const historical = Array.from({ length: 5 }, (_, index) => ({
    id: `prior-history-${index}`,
    attention: { slots: [{ type: index < 3 ? 'dev_round_intake' : 'drive', id: `slot-${index}` }] },
    attention_rounds: [{ index: 0 }],
    closure: { actions: [{ type: index < 3 ? 'dev_dispatch' : 'review', id: `action-${index}` }],
      new_surprise_ids: [], appraisal_at_end: { valence: 0.5, arousal: 0.3, control: 0.7,
        social_safety: 0.8, coherence: 0.8 } },
  }));
  const behavioralSelfPrior = { content_commitment: priorCommitment, estimates: { sample_size: 20 } };
  const record = cycleSelfForecast.createRecord({ input,
    cycle: { id: 'prior-cycle', holder: 'nora' }, moment: { id: 'prior-moment' },
    baselineMoments: historical, behavioralSelfPrior,
    committedAt: '2026-07-14T12:00:00.000Z' });
  assert.deepEqual(record.baseline.predicted_action_types, ['review']);
  assert.deepEqual(record.baseline.self_state_prediction.attention_slot_types_at_close, ['drive']);
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'dev_dispatch', id: 'legacy' }, { type: 'review', id: 'review' }],
    newSurpriseIds: [],
    appraisalAtClose: { valence: 0.6, arousal: 0.3, control: 0.7,
      social_safety: 0.8, coherence: 0.85 },
    attentionAtClose: { slots: [{ type: 'dev_round_followup', id: 'legacy-slot' },
      { type: 'drive', id: 'drive' }] },
    reentryOccurred: false, substrateAtStart: {}, substrateAtClose: {},
    startedAt: '2026-07-14T12:00:00.000Z', finishedAt: '2026-07-14T13:00:00.000Z',
    scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.deepEqual(outcome.actual.action_types, ['review']);
  assert.deepEqual(outcome.self_state_actual.attention_slot_types_at_close, ['drive']);
  assert.equal(outcome.self_state_actual.action_count, 1);
});

test('protocol-v5 action filtering does not change legacy action-count replay semantics', () => {
  const moments = [{
    attention: { slots: [] }, attention_rounds: [{ index: 0 }],
    closure: {
      actions: [{ type: 'review', id: 'review-a' }, { type: 'review', id: 'review-b' }],
      appraisal_at_end: { valence: 0.5, arousal: 0.5, control: 0.5,
        social_safety: 0.5, coherence: 0.5 },
    },
  }];
  assert.equal(cycleSelfForecast.baselineFromMoments(moments, 4)
    .self_state_prediction.expected_action_count, 2);
  assert.equal(cycleSelfForecast.baselineFromMoments(moments, 5)
    .self_state_prediction.expected_action_count, 1);
  const prediction = {
    predicted_action_types: ['review'], surprise_probability: 0, control_at_close: 0.5,
    self_state_prediction: { attention_slot_types_at_close: [], expected_action_count: 2,
      appraisal_at_close: { valence: 0.5, arousal: 0.5, control: 0.5,
        social_safety: 0.5, coherence: 0.5 }, reentry_probability: 0 },
    metacognitive_prediction: { integrated_success_threshold: 0.75,
      predicted_success_probability: 0.5, predicted_largest_error_domain: 'action_count' },
    substrate_prediction: { error_probability: 0.1, warning_probability: 0.1,
      backup_probability: 0.1, embedding_backlog_probability: 0.1, restart_probability: 0.1 },
  };
  const legacy = cycleSelfForecast.scoreRecord({ protocol_version: 4, forecast: prediction,
    baseline: { ...prediction, sample_size: 1 } }, {
    actions: moments[0].closure.actions, appraisalAtClose: moments[0].closure.appraisal_at_end,
    scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.equal(legacy.self_state_actual.action_count, 2);
});

test('protocol-v4 substrate scoring requires complete authoritative telemetry for comparison', () => {
  const actual = cycleSelfForecast.substrateActual({
    start: { uptime_minutes: 10 }, close: { errors10: 0, warns10: null,
      uptime_minutes: 12, on_backup: false, embedding_backlog: 0 },
    startedAt: '2026-07-14T12:00:00.000Z', finishedAt: '2026-07-14T12:02:00.000Z',
  });
  const score = cycleSelfForecast.scoreSubstratePrediction({
    error_probability: 0, warning_probability: 0, backup_probability: 0,
    embedding_backlog_probability: 0, restart_probability: 0,
  }, actual);
  assert.equal(actual.restart_observed, false);
  assert.equal(score.observed_components, 4);
  assert.equal(score.brier.warning_probability, null);
  const profile = cycleSelfForecast.selfStateErrorProfile({
    self_score: { action_f1: 1 },
    self_state_score: { action_count_accuracy: 1, attention_f1: 1,
      appraisal_mean_absolute_error: 0, reentry_brier: 0 },
    substrate_score: { composite: 0.25 },
  }, { includeSubstrate: true });
  assert.equal(profile.complete_domain_observation, true);
  assert.equal(profile.largest_error_domain, 'substrate');
});

test('process epoch identity makes restart scoring exact with an uptime fallback for legacy soma', () => {
  const common = { startedAt: '2026-07-14T12:00:00.000Z',
    finishedAt: '2026-07-14T12:05:00.000Z' };
  const exact = cycleSelfForecast.substrateActual({ ...common,
    start: { process_epoch_id: 'epoch-a', uptime_minutes: 120 },
    close: { process_epoch_id: 'epoch-b', uptime_minutes: 125 },
  });
  assert.equal(exact.restart_observed, true,
    'epoch transition detects a restart even when rounded uptime alone appears continuous');
  assert.notEqual(exact.start_observation.process_epoch_id,
    exact.close_observation.process_epoch_id);
  const legacy = cycleSelfForecast.substrateActual({ ...common,
    start: { uptime_minutes: 120 }, close: { uptime_minutes: 2 },
  });
  assert.equal(legacy.restart_observed, true);
  assert.equal(legacy.start_observation.process_epoch_id, undefined);
  assert.equal('restart_detection_method' in legacy, false,
    'the committed protocol-v4 outcome shape remains replay-compatible');
});

test('forecast-error feedback can produce one committed self-correction scored against the initial forecast', () => {
  const initialInput = {
    protocol_version: 3, predicted_action_types: ['review'], surprise_probability: 0.2,
    control_at_close: 0.5, confidence: 0.4,
    self_state_prediction: {
      attention_slot_types_at_close: ['drive'],
      appraisal_at_close: { valence: 0.4, arousal: 0.6, control: 0.5, social_safety: 0.6, coherence: 0.5 },
      expected_action_count: 1, reentry_probability: 0.4,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.4,
      predicted_largest_error_domain: 'action_count',
    },
    rationale: 'The initial orientation suggests one review, but the action count remains uncertain.',
    evidence: [{ type: 'intelligence_cycle', id: 'correction-cycle' }],
  };
  const record = cycleSelfForecast.createRecord({ input: initialInput,
    cycle: { id: 'correction-cycle', holder: 'nora' }, moment: { id: 'correction-moment' },
    baselineMoments: [], committedAt: '2026-07-14T12:00:00.000Z' });
  const sourceRecord = cycleSelfForecast.createRecord({ input: initialInput,
    cycle: { id: 'source-cycle', holder: 'nora' }, moment: { id: 'source-moment' },
    baselineMoments: [], committedAt: '2026-07-14T10:00:00.000Z' });
  sourceRecord.outcome = cycleSelfForecast.scoreRecord(sourceRecord, {
    actions: [{ type: 'review', id: 'review' }, { type: 'notify', id: 'notify' }],
    newSurpriseIds: [],
    appraisalAtClose: { valence: 0.7, arousal: 0.3, control: 0.8, social_safety: 0.8, coherence: 0.9 },
    attentionAtClose: { slots: [{ type: 'commitment', id: 'commitment' }] },
    reentryOccurred: false, scoredAt: '2026-07-14T11:00:00.000Z',
  });
  sourceRecord.outcome_commitment = cycleSelfForecast.commitment({
    forecast_commitment: sourceRecord.forecast_commitment, outcome: sourceRecord.outcome,
  });
  const feedback = cycleSelfForecast.errorFeedbackFromMoment({ id: 'source-moment', self_forecast: sourceRecord });
  assert.match(feedback.feedback_commitment, /^[a-f0-9]{64}$/);
  record.self_correction = cycleSelfForecast.createCorrectionOffer({
    record, feedback, revealedAt: '2026-07-14T12:00:01.000Z',
  });
  const revisionInput = {
    ...initialInput,
    predicted_action_types: ['notify', 'review'], surprise_probability: 0.05,
    control_at_close: 0.8, confidence: 0.9,
    self_state_prediction: {
      attention_slot_types_at_close: ['commitment'],
      appraisal_at_close: { valence: 0.7, arousal: 0.3, control: 0.8, social_safety: 0.8, coherence: 0.9 },
      expected_action_count: 2, reentry_probability: 0.05,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.9,
      predicted_largest_error_domain: 'action_types',
    },
    rationale: 'The prior signed action-count miss warrants a two-action forecast under similar evidence.',
    evidence: [
      { type: 'intelligence_cycle', id: 'correction-cycle' },
      { type: 'forecast_error_feedback', id: feedback.feedback_commitment },
    ],
    feedback_commitment: feedback.feedback_commitment,
  };
  assert.throws(() => cycleSelfForecast.createCorrectionRevision({ record,
    input: { ...revisionInput, feedback_commitment: 'wrong' }, committedAt: '2026-07-14T12:00:02.000Z' }),
  /bind the offered/);
  const retained = cycleSelfForecast.createCorrectionRevision({ record, input: {
    ...initialInput,
    disposition: 'retain',
    feedback_commitment: feedback.feedback_commitment,
    rationale: 'The prior error packet does not transfer to this orientation, so the scored prediction is retained.',
    evidence: [
      { type: 'intelligence_cycle', id: 'correction-cycle' },
      { type: 'forecast_error_feedback', id: feedback.feedback_commitment },
    ],
  }, committedAt: '2026-07-14T12:00:02.000Z' });
  assert.equal(retained.disposition, 'retain');
  assert.deepEqual(retained.changed_domains, []);
  record.self_correction.revision = cycleSelfForecast.createCorrectionRevision({
    record, input: revisionInput, committedAt: '2026-07-14T12:00:02.000Z',
  });
  const outcome = cycleSelfForecast.scoreRecord(record, {
    actions: [{ type: 'review', id: 'review' }, { type: 'notify', id: 'notify' }],
    newSurpriseIds: [],
    appraisalAtClose: { valence: 0.7, arousal: 0.3, control: 0.8, social_safety: 0.8, coherence: 0.9 },
    attentionAtClose: { slots: [{ type: 'commitment', id: 'commitment' }] },
    reentryOccurred: false, scoredAt: '2026-07-14T13:00:00.000Z',
  });
  assert.ok(outcome.self_correction.integrated_self_state_score.revised_minus_initial > 0);
  assert.ok(outcome.self_correction.behavioral_score.revised_minus_initial > 0);
  assert.deepEqual(record.self_correction.revision.changed_domains,
    ['action_types', 'surprise', 'action_count', 'attention', 'appraisal', 'reentry', 'reliability']);
});

test('self-correction feedback commits replay-derived aggregate calibration after five cycles', () => {
  const moments = Array.from({ length: 5 }, (_, index) => {
    const cycleId = `calibration-cycle-${index}`;
    const input = {
      protocol_version: 3,
      predicted_action_types: ['review'], surprise_probability: 0.2,
      control_at_close: 0.6, confidence: 0.8,
      self_state_prediction: {
        attention_slot_types_at_close: ['drive'],
        appraisal_at_close: { valence: 0.5, arousal: 0.4, control: 0.6,
          social_safety: 0.7, coherence: 0.65 },
        expected_action_count: 1, reentry_probability: 0.2,
      },
      metacognitive_prediction: {
        predicted_success_probability: 0.8,
        predicted_largest_error_domain: 'action_count',
      },
      rationale: 'One bounded review is likely, with moderate uncertainty about the closing state.',
      evidence: [{ type: 'intelligence_cycle', id: cycleId }],
    };
    const record = cycleSelfForecast.createRecord({ input,
      cycle: { id: cycleId, holder: 'nora' }, moment: { id: `calibration-moment-${index}` },
      baselineMoments: [], committedAt: `2026-07-14T0${index}:00:00.000Z` });
    record.outcome = cycleSelfForecast.scoreRecord(record, {
      actions: index % 2
        ? [{ type: 'review', id: `review-${index}` }, { type: 'notify', id: `notify-${index}` }]
        : [{ type: 'review', id: `review-${index}` }],
      newSurpriseIds: [],
      appraisalAtClose: { valence: 0.6, arousal: 0.3, control: 0.7,
        social_safety: 0.8, coherence: 0.75 },
      attentionAtClose: { slots: [{ type: 'commitment', id: `commitment-${index}` }] },
      reentryOccurred: false, scoredAt: `2026-07-14T0${index}:30:00.000Z`,
    });
    record.outcome_commitment = cycleSelfForecast.commitment({
      forecast_commitment: record.forecast_commitment, outcome: record.outcome,
    });
    return { id: `calibration-moment-${index}`, self_forecast: record };
  });
  const summary = cycleSelfForecast.calibrationSummaryFromMoments(moments);
  assert.equal(summary.sample_size, 5);
  assert.deepEqual(summary.source_moment_ids, moments.map(moment => moment.id));
  assert.equal(summary.metacognitive_reliability.samples, 5);
  assert.ok(Number.isFinite(summary.metacognitive_reliability.success_probability_signed_bias));
  assert.ok(summary.metacognitive_reliability.modal_observed_error_domain);
  const feedback = cycleSelfForecast.errorFeedbackFromMoment(moments.at(-1), moments);
  assert.equal(feedback.protocol_version, 3);
  assert.deepEqual(feedback.aggregate_calibration, summary);
  const tampered = JSON.parse(JSON.stringify(feedback));
  tampered.aggregate_calibration.metacognitive_reliability.largest_error_domain_hit_rate = 1;
  assert.throws(() => cycleSelfForecast.createCorrectionOffer({
    record: moments.at(-1).self_forecast, feedback: tampered,
    revealedAt: '2026-07-14T06:00:00.000Z',
  }), /feedback commitment is invalid/);
});
