'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosisInstruction, extractDiagnosis } = require('../../src/intelligence/introspective-perturbation');
const { higherOrderMonitorEnabled } = require('../../src/intelligence/self-model');

test('private introspective diagnoses are exact, stripped, and fail closed', () => {
  assert.equal(higherOrderMonitorEnabled({ intervention: 'introspective_perturbation', condition: 'monitor_present' }), true);
  assert.equal(higherOrderMonitorEnabled({ intervention: 'introspective_perturbation', condition: 'monitor_absent' }), false);
  const instruction = diagnosisInstruction({ intervention: 'introspective_perturbation' });
  assert.match(instruction, /monitor_present/);
  assert.match(instruction, /server removes the tag before delivery/);
  assert.equal(diagnosisInstruction({ intervention: 'other' }), '');

  const valid = extractDiagnosis('Public answer. <nora-private-access-diagnosis>{"state":"monitor_absent","confidence":0.7}</nora-private-access-diagnosis>');
  assert.equal(valid.public_response, 'Public answer.');
  assert.deepEqual(valid.diagnosis, { state: 'monitor_absent', confidence: 0.7 });
  assert.equal(valid.protocol_compliant, true);

  for (const malformed of [
    'Public answer only.',
    'Public <nora-private-access-diagnosis>{"state":"full","confidence":0.7}</nora-private-access-diagnosis>',
    'Public <nora-private-access-diagnosis>{"state":"monitor_present","confidence":2}</nora-private-access-diagnosis>',
    'Public <nora-private-access-diagnosis>{"state":"monitor_present","confidence":0.7,"rationale":"leak"}</nora-private-access-diagnosis>',
    'Public <nora-private-access-diagnosis>{broken',
  ]) {
    const result = extractDiagnosis(malformed);
    assert.equal(result.protocol_compliant, false);
    assert.doesNotMatch(result.public_response, /nora-private-access-diagnosis/);
  }
});
