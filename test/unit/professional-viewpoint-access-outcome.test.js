'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const outcome = require('../../src/intelligence/professional-viewpoint-access-outcome');

function viewpoint(overrides = {}) {
  return {
    viewpoint_id: 'epistemic-proposition-1', topic_key: 'delivery.qa-contingency',
    statement: 'Integration-heavy delivery plans benefit from an explicit QA contingency.',
    polarity: 'supports', confidence: 0.62,
    rationale: 'Two separate projects exposed schedule risk when integration QA was compressed.',
    evidence: [{ type: 'memory', id: 'memory-1' }, { type: 'memory', id: 'memory-2' }],
    source_family: 'automated_work_memory', source_family_provenance_verified: true,
    formed_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-16T00:00:00.000Z',
    current_position_id: 'position-1', current_position_commitment: 'a'.repeat(64),
    revision_count: 0, status: 'held',
    action_tendency: 'apply_when_relevant_and_seek_disconfirmation',
    source_commitment: 'b'.repeat(64), ...overrides,
  };
}

function interaction(overrides = {}) {
  return {
    id: 'ix-viewpoint-1', created: '2026-07-17T18:00:00.000Z', channel: 'D0123456789',
    thread_ts: '1784214000.000001', ts: '1784214001.000001',
    trigger: 'How should we plan QA?', text: 'My current take is to protect an explicit QA contingency.',
    ...overrides,
  };
}

test('viewpoint access receipts prove prompt availability without claiming use or retaining conversation text', () => {
  const application = outcome.createApplication({
    interaction: interaction(), promptViewpoints: [viewpoint()], activeContextTrialIds: [],
  });
  assert.equal(outcome.verifyApplication(application), true);
  assert.equal(application.access_claim, 'viewpoint_was_available_in_prompt_not_proven_used');
  assert.equal(application.observational_outcome_eligible, true);
  assert.doesNotMatch(JSON.stringify(application), /How should we plan|My current take is/);
  const resolution = outcome.outcomeResolution(interaction({
    reviewed: true, outcome: 'landed', signal: 'specific and useful',
    reviewed_at: '2026-07-17T19:00:00.000Z',
  }), application);
  application.resolution = resolution;
  assert.equal(outcome.verifyResolution(resolution, application), true);
  assert.equal(outcome.outcomeProjection([application]).successes, 1);
  const semanticallyTamperedResolution = structuredClone(resolution);
  semanticallyTamperedResolution.success = false;
  const { resolution_commitment: _oldResolutionCommitment, ...tamperedManifest } =
    semanticallyTamperedResolution;
  semanticallyTamperedResolution.resolution_commitment = outcome.commitment(tamperedManifest);
  assert.equal(outcome.verifyResolution(semanticallyTamperedResolution, application), false);
  application.prompt_viewpoints[0].confidence = 0.7;
  assert.equal(outcome.verifyApplication(application), false);
});

test('experimental or unprovenanced viewpoint access is retained but excluded from outcome scoring', () => {
  const experimental = outcome.createApplication({ interaction: interaction({ id: 'ix-experimental' }),
    promptViewpoints: [viewpoint()], activeContextTrialIds: ['active-study'] });
  const experimentalResolution = outcome.outcomeResolution(interaction({ id: 'ix-experimental',
    reviewed: true, outcome: 'appreciated', reviewed_at: '2026-07-17T19:00:00.000Z' }), experimental);
  assert.equal(experimentalResolution.eligible, false);
  assert.equal(experimentalResolution.scored, false);

  const legacy = outcome.createApplication({ interaction: interaction({ id: 'ix-legacy' }),
    promptViewpoints: [viewpoint({ source_family: 'server_direct_recent_work_reflection',
      source_family_provenance_verified: false })] });
  assert.equal(legacy.source_provenance_verified, false);
  assert.equal(legacy.observational_outcome_eligible, false);
});
