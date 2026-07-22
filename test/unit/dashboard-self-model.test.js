'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactSelfModelForDashboard } = require('../../src/routes/intelligence');

test('dashboard self-model projection removes retained study payloads but preserves rendered evidence', () => {
  const large = 'x'.repeat(10000);
  const compact = compactSelfModelForDashboard({
    claims: [{ status: 'active', statement: 'I adapt', domain: 'behavior', confidence: 0.8,
      confidence_audit: { complete_chain_verified: true }, provider_trace: large }],
    probes: [{ status: 'open', question: 'Will I adapt?', prediction: { outcome: 'yes', confidence: 0.7 },
      evidence: large }, { status: 'resolved', evidence: large }],
    prediction_studies: [{ title: 'Study', status: 'active', study_phase: 'pilot', event_target: 12,
      report: { resolved: 2, verdict: 'collecting' }, assignments: [{ prompt: large }] }],
    context_trials: [{ hypothesis: 'Context helps', status: 'active', assignments: [
      { status: 'resolved', prompt: large }, { status: 'assigned', prompt: large }],
      evaluation: { enough_evidence: false } }],
    behavioral_fingerprints: { bank: { probe_count: 60, form_count: 3, probes: [large] },
      runs: [{ status: 'active', response_count: 4, probe_count: 20, scored_count: 3, responses: [large] }],
      drift: [], report: { active: 1 } },
    report: { probes: { resolved: 1 } },
  });
  const serialized = JSON.stringify(compact);
  assert.ok(serialized.length < 3000);
  assert.equal(compact.prediction_studies[0].report.resolved, 2);
  assert.deepEqual(compact.context_trials[0].assignment_progress,
    { assigned_total: 2, resolved_total: 1 });
  assert.equal(compact.behavioral_fingerprints.bank.probe_count, 60);
  assert.equal(compact.behavioral_fingerprints.runs[0].response_count, 4);
  assert.equal(serialized.includes(large), false);
});
