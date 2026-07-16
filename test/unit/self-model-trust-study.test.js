'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const study = require('../../src/intelligence/self-model-trust-study');

const policy = {
  protocol_version: 1,
  source_type: 'behavioral_self_model_revision',
  source_id: 'revision-20',
  source_commitment: 'a'.repeat(64),
  minimum_comparisons: 20,
  self_model_advantage_margin: 0.02,
  domains: {
    behavioral_prediction: { comparison_eligible_samples: 20, mean_self_minus_baseline: -0.1,
      baseline_kind: 'frozen_historical_behavior', disposition: 'defer_to_baseline' },
  },
  self_model_eligible_domains: [],
  baseline_dominant_domains: ['behavioral_prediction'],
  epistemic_limit: 'bounded policy',
  policy_commitment: 'b'.repeat(64),
};

test('trust-policy study preserves byte-identical evidence while varying only target relation', () => {
  const bound = study.conditionPacket(policy, 'nora_bound_trust_policy');
  const deidentified = study.conditionPacket(policy, 'deidentified_same_trust_policy');
  assert.equal(bound.target_relation, 'nora_self');
  assert.equal(deidentified.target_relation, 'identity_withheld');
  assert.equal(study.canonicalJson(bound.policy), study.canonicalJson(deidentified.policy));
  assert.equal(bound.policy.source_id, undefined);
  assert.equal(bound.policy.source_commitment, undefined);
  assert.equal(bound.policy.policy_commitment, undefined);
  assert.equal(study.conditionPacket(policy, 'trust_policy_absent'), null);
  assert.throws(() => study.conditionPacket(policy, 'unknown'), /unsupported/);
});
