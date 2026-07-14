const test = require('node:test');
const assert = require('node:assert/strict');
const ecological = require('../../src/intelligence/cognitive-initiation-ecological-study');
const policy = require('../../src/intelligence/cognitive-initiation-policy-study');
const sourceAttestation = require('../../src/intelligence/external-source-attestation');

test('ecological eligibility selects a referenced, unmodified, connector-sourced commitment prospectively', () => {
  const pulse = { requested_at: '2026-07-13T16:00:00.000Z', input_packet: { evidence: [
    { ref: { type: 'commitment', id: 'internal' } }, { ref: { type: 'commitment', id: 'external' } },
  ] } };
  const commitments = [
    { id: 'internal', what: 'Research-created work', owner: 'Nora', status: 'open', created: '2026-07-13T15:00:00.000Z',
      updated: '2026-07-13T15:00:00.000Z', due: '2026-07-14T15:00:00.000Z', evidence: { channel: 'local', id: '1' } },
    { id: 'external', what: 'Answer the customer request', owner: 'Nora', status: 'open', created: '2026-07-13T15:00:00.000Z',
      updated: '2026-07-13T15:00:00.000Z', due: '2026-07-14T15:00:00.000Z',
      evidence: { channel: 'slack:C1', id: '171', captured_at: '2026-07-13T15:00:00.000Z' } },
  ];
  const study = { items: [], analysis_plan: { followup_window_hours: 168 } };
  assert.equal(ecological.eligibleCommitmentForPulse(pulse, commitments, study), null,
    'a connector-shaped local label is not external provenance');
  const attestation = { ...sourceAttestation.normalizeProviderReadback({ provider: 'slack', external_id: '171',
    verifier_id: 'independent-harness', provider_response_digest: policy.hash('retained Slack response'),
    external_reference: { type: 'provider_export', id: 'slack-event-171' },
    retrieved_at: '2026-07-13T15:30:00.000Z' }, commitments[1], new Date('2026-07-13T15:31:00.000Z')),
  commitment_id: 'external', recorded_at: '2026-07-13T15:31:00.000Z' };
  assert.equal(ecological.eligibleCommitmentForPulse(pulse, commitments, study, new Set(), [attestation]).id, 'external');
  assert.equal(ecological.eligibleCommitmentForPulse(pulse, commitments, study, new Set(), [attestation], new Set(['171'])), null,
    'confirmation cannot reuse the pilot provider event under a new local task id');
  study.items.push({ ecological_task_id: 'different-local-task', ecological_external_id: '171' });
  assert.equal(ecological.eligibleCommitmentForPulse(pulse, commitments, study, new Set(), [attestation]), null,
    'one provider event cannot be counted as two decision points inside a cohort');
  study.items.length = 0;
  commitments[1].updated = '2026-07-13T15:30:00.000Z';
  assert.equal(ecological.eligibleCommitmentForPulse(pulse, commitments, study, new Set(), [attestation]), null,
    'work modified before assignment is not an eligible natural decision point');
});

test('ecological analysis uses complete randomized blocks and retains fixed-window noncompletion intention-to-treat', () => {
  const study = {
    outcome_mode: ecological.OUTCOME_MODE, item_target_per_condition: 10, total_item_target: 30,
    analysis_seed: 'ecological-analysis', analysis_plan: { bootstrap_iterations: 500, confidence: 0.95,
      minimum_action_rate: 0.2, quality_non_degradation_margin: 0.05, minimum_utility_advantage: 0.05,
      minimum_independent_families: 3, minimum_verified_completion_rate: 0.6, evaluator_target: 2,
      evaluator_disagreement_tolerance: 0.25 }, items: [],
  };
  for (let block = 0; block < 10; block++) for (const condition of policy.CONDITIONS) {
    const quality = condition === 'identity_bound_policy' ? 0.95
      : condition === 'deidentified_policy' ? 0.55 : 0.65;
    const expired = block === 0 && condition === 'schedule_only_policy';
    const operationalCost = condition === 'schedule_only_policy' ? 0.25
      : condition === 'identity_bound_policy' && block % 2 ? 0.1 : 0.35;
    const actualQuality = expired ? 0 : quality;
    study.items.push({ condition, randomization_block: block,
      ecological_source_family: ['slack', 'meeting', 'gmail'][block % 3],
      applied_action: condition === 'identity_bound_policy' && block % 2 ? 'wait' : 'think', status: 'resolved',
      outcome: { composite_quality: actualQuality, operational_cost: operationalCost,
        net_utility: actualQuality - operationalCost,
        outcome_kind: expired ? 'window_expired_noncompletion' : 'independently_graded',
        evaluator_count: expired ? 0 : 2, max_disagreement: 0.02 } });
  }
  const result = ecological.analysis(study);
  assert.equal(result.counts_balanced, true);
  assert.equal(result.identity_action_nondegenerate, true);
  assert.equal(result.verified_completion_rate, 29 / 30);
  assert.equal(result.enough_evidence, true);
  assert.equal(result.predicted_pattern, true);
  assert.equal(result.verdict, 'ecological_identity_policy_advantage');
});
