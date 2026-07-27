'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProactiveDecision,
  selectProactiveEvidence,
} = require('../../src/integrations/slack-proactive-gate');

test('proactive evidence selection requires a PM cue and distinctive source overlap', () => {
  const memories = [
    { id: 'memory-acme-launch', project: 'Acme', fact: 'Acme launch is scheduled for August 12, with Dana as owner.' },
    { id: 'memory-other', project: 'Orchid', fact: 'The Orchid report was completed last week.' },
  ];
  assert.deepEqual(selectProactiveEvidence('nice weather today', { memories }), []);
  const selected = selectProactiveEvidence('Does anyone know when Acme is launching?', { memories });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'memory-acme-launch');
  assert.match(selected[0].summary, /August 12/);
});

test('generic PM vocabulary alone cannot manufacture evidence for an interruption', () => {
  const selected = selectProactiveEvidence('Any update on the project status?', {
    memories: [{ id: 'unrelated', fact: 'A different project status exists.' }],
  });
  assert.deepEqual(selected, []);
});

test('gate decisions fail closed unless they cite available evidence with calibrated value', () => {
  const evidence = [{ index: 1, kind: 'memory', id: 'memory-1', summary: 'Launch is August 12.' }];
  for (const raw of [
    'yes',
    { engage: true, confidence: 0.9, value: 0.9, evidence_indexes: [] },
    { engage: true, confidence: 0.9, value: 0.9, evidence_indexes: [2] },
    { engage: true, confidence: 0.4, value: 0.9, evidence_indexes: [1] },
  ]) {
    assert.equal(normalizeProactiveDecision(raw, evidence).engage, false);
  }
  const accepted = normalizeProactiveDecision({
    engage: true,
    confidence: 0.86,
    value: 0.78,
    urgency: 0.62,
    interruption_cost: 0.38,
    evidence_indexes: [1],
    reason: 'The source directly answers the launch-date question.',
  }, evidence);
  assert.equal(accepted.engage, true);
  assert.deepEqual(accepted.evidence_refs, [{ type: 'memory', id: 'memory-1' }]);
  assert.equal(accepted.interruption_cost, 0.38);
});
