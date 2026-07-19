'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../../src/intelligence/professional-viewpoint-access-outcome');
const usefulness = require('../../src/intelligence/professional-viewpoint-usefulness');

function viewpoint(overrides = {}) {
  return {
    viewpoint_id: 'viewpoint-1', topic_key: 'delivery.qa',
    statement: 'Protect a QA contingency for integration-heavy launches.',
    polarity: 'supports', confidence: 0.62, rationale: 'Two launch records support it.',
    source_family: 'automated_work_memory', source_family_provenance_verified: true,
    current_position_id: 'position-1', current_position_commitment: 'a'.repeat(64),
    source_commitment: 'b'.repeat(64), ...overrides,
  };
}

function application(index, outcome = 'landed', options = {}) {
  const promptViewpoints = options.promptViewpoints || [viewpoint()];
  const interaction = {
    id: `ix-usefulness-${index}`, created: `2026-07-${String(10 + index).padStart(2, '0')}T18:00:00.000Z`,
    channel: 'D0123456789', thread_ts: `178421400${index}.000001`,
    ts: `178421400${index}.000002`, trigger: `private request text ${index}`,
    text: `private response text ${index}`,
  };
  const record = access.createApplication({ interaction, promptViewpoints,
    activeContextTrialIds: options.activeContextTrialIds || [] });
  if (options.resolve !== false) record.resolution = access.outcomeResolution({
    ...interaction, reviewed: true, outcome, signal: `private review signal ${index}`,
    reviewed_at: `2026-07-${String(10 + index).padStart(2, '0')}T19:00:00.000Z`,
  }, record);
  record.audit = { complete_chain_verified: options.auditVerified !== false };
  return record;
}

test('derives position-bound usefulness separately from viewpoint truth', () => {
  const records = [application(1, 'landed'), application(2, 'appreciated'), application(3, 'landed')];
  const projection = usefulness.derive(records, [viewpoint()]);
  assert.equal(projection.eligible_resolved_single_viewpoint_applications, 3);
  assert.equal(projection.calibrations[0].calibration_status, 'provisionally_helpful');
  assert.equal(projection.calibrations[0].observed_helpfulness_rate, 1);
  assert.match(usefulness.guidance(projection.calibrations[0]), /does not raise the view's truth confidence/);
  assert.equal(usefulness.verify(projection, records, [viewpoint()]), true);
  assert.doesNotMatch(JSON.stringify(projection), /private request|private response|private review signal/);

  const tampered = structuredClone(projection);
  tampered.calibrations[0].helpful_outcomes = 2;
  assert.equal(usefulness.verify(tampered, records, [viewpoint()]), false);
  assert.equal(usefulness.compact(projection).calibrations[0].source_receipts, undefined);
});

test('requires replay-valid, observational, single-viewpoint outcomes for the current position', () => {
  const multi = application(4, 'landed', { promptViewpoints: [viewpoint(), viewpoint({
    viewpoint_id: 'viewpoint-2', current_position_commitment: 'c'.repeat(64),
    source_commitment: 'd'.repeat(64),
  })] });
  const unverified = application(5, 'corrected', { auditVerified: false });
  const experimental = application(6, 'appreciated', { activeContextTrialIds: ['trial-1'] });
  const oldPosition = application(7, 'corrected', { promptViewpoints: [viewpoint({
    current_position_commitment: 'e'.repeat(64),
  })] });
  const unresolved = application(8, 'neutral', { resolve: false });
  const projection = usefulness.derive([multi, unverified, experimental, oldPosition, unresolved],
    [viewpoint(), viewpoint({ viewpoint_id: 'viewpoint-2', current_position_commitment: 'c'.repeat(64),
      source_commitment: 'd'.repeat(64) })]);
  assert.equal(projection.eligible_resolved_single_viewpoint_applications, 0);
  assert.equal(projection.ambiguous_multi_viewpoint_applications_excluded, 1);
  assert.deepEqual(projection.calibrations, []);
});

test('repeated corrections create caution without rewriting belief confidence', () => {
  const projection = usefulness.derive([
    application(1, 'corrected'), application(2, 'corrected'), application(3, 'landed'),
  ], [viewpoint()]);
  const calibration = projection.calibrations[0];
  assert.equal(calibration.calibration_status, 'needs_caution');
  assert.equal(calibration.corrections, 2);
  assert.match(usefulness.guidance(calibration), /verify the current evidence/);
  assert.equal(viewpoint().confidence, 0.62);
});
