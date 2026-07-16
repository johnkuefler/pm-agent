const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const affectiveRegulation = require('../../src/intelligence/affective-regulation');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const now = new Date('2026-07-16T15:00:00.000Z');

function appraisal(overrides = {}) {
  return {
    label: 'attentive and measured', updated: now.toISOString(),
    valence: 0.55, arousal: 0.35, control: 0.7, social_safety: 0.7, coherence: 0.7,
    basis: { positive_outcomes: 1, negative_outcomes: 0 }, ...overrides,
  };
}

test('grounded appraisal deterministically selects bounded cognitive action tendencies', () => {
  const uncertain = affectiveRegulation.derive(appraisal({ coherence: 0.42 }), {
    uncertainty: { level: 0.7 }, overload: { level: 0.2 }, social_debt: { level: 0.1 },
  }, now);
  assert.equal(uncertain.mode, 'verify_and_clarify');
  assert.match(uncertain.tendencies.epistemic, /verify_the_highest_impact_unknown/);
  assert.equal(affectiveRegulation.verify(uncertain), true);

  const coherent = affectiveRegulation.derive(appraisal({ valence: 0.7, control: 0.75, coherence: 0.8 }), {}, now);
  assert.equal(coherent.mode, 'synthesize_and_extend');
  assert.match(coherent.tendencies.insight, /one_evidence_labeled_cross_source_implication/);
  assert.match(affectiveRegulation.render(coherent), /Prospective prediction/);

  const overloaded = affectiveRegulation.derive(appraisal({ arousal: 0.8, control: 0.35 }), {
    overload: { level: 0.8 },
  }, now);
  assert.equal(overloaded.mode, 'stabilize_and_sequence');
  assert.match(overloaded.tendencies.scope, /requested_deliverable_first/);
  overloaded.mode = 'synthesize_and_extend';
  assert.equal(affectiveRegulation.verify(overloaded), false);
});

test('store commits, replays, exposes, and applies affective cognitive regulation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-affective-regulation-'));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false, clock: () => now,
  });
  await store.init();
  const predictions = Array.from({ length: 8 }, (_, index) => ({ id: `open-${index}`, outcome: null }));
  for (let index = 0; index < 8; index++) store.refreshCognition({ predictions, soma: { stress: 0.15 } });

  const publicState = store.affectiveRegulationSnapshot();
  assert.equal(publicState.report.current_verified, true);
  assert.equal(publicState.current.audit.appraisal_source_verified, true);
  assert.equal(publicState.current.audit.drive_source_verified, true);
  assert.equal(publicState.current.audit.deterministic_replay_verified, true);
  assert.equal(publicState.current.mode, 'verify_and_clarify');
  const prompt = store.promptContext({ query: 'What should I tell the client about this uncertain launch date?' });
  assert.match(prompt, /Committed affect-regulation policy/);
  assert.match(prompt, /separate fact inference and unknown/);
  assert.match(prompt, /never what the evidence supports/i);

  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'affective_cognitive_control');
  assert.equal(indicator.status, 'mechanism_present');
  assert.equal(indicator.evidence.current_content_commitment_verified, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
