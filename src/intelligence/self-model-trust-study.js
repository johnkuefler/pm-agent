'use strict';

const crypto = require('node:crypto');

const CONDITIONS = Object.freeze([
  'nora_bound_trust_policy',
  'deidentified_same_trust_policy',
  'trust_policy_absent',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rawPolicy(policy = {}) {
  return {
    protocol_version: Number(policy.protocol_version),
    minimum_comparisons: Number(policy.minimum_comparisons),
    self_model_advantage_margin: Number(policy.self_model_advantage_margin),
    domains: JSON.parse(JSON.stringify(policy.domains || {})),
    self_model_eligible_domains: [...(policy.self_model_eligible_domains || [])],
    baseline_dominant_domains: [...(policy.baseline_dominant_domains || [])],
    epistemic_limit: policy.epistemic_limit,
  };
}

function conditionPacket(policy, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error('unsupported self-model trust condition');
  if (condition === 'trust_policy_absent') return null;
  return {
    protocol_version: 1,
    target_relation: condition === 'nora_bound_trust_policy' ? 'nora_self' : 'identity_withheld',
    policy: rawPolicy(policy),
  };
}

module.exports = { CONDITIONS, canonicalJson, commitment, rawPolicy, conditionPacket };
