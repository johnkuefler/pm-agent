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

test('prospective affective applications are replayable, content-minimized, and study-aware', () => {
  const drives = { uncertainty: { level: 0.7 }, overload: { level: 0.2 }, social_debt: { level: 0.1 } };
  const state = appraisal({ coherence: 0.42 });
  const policy = affectiveRegulation.derive(state, drives, now);
  const prior = affectiveRegulation.derive(appraisal({ arousal: 0.8, control: 0.35 }), {
    overload: { level: 0.8 },
  }, new Date(now.getTime() - 1000));
  const transition = affectiveRegulation.transition(prior, policy, now);
  assert.equal(affectiveRegulation.verifyTransition(transition), true);
  transition.to_mode = 'steady_execution';
  assert.equal(affectiveRegulation.verifyTransition(transition), false);

  const interaction = {
    id: 'ix-affect-1', created: now.toISOString(), channel: 'C0123456789',
    thread_ts: '1784214000.000001', ts: '1784214001.000001',
    trigger: 'This exact private request must not be retained.',
    text: 'This exact private response must not be retained.',
  };
  const application = affectiveRegulation.createApplication({
    interaction, policy, appraisal: state, drives, activeContextTrialIds: [],
  });
  assert.equal(affectiveRegulation.verifyApplication(application), true);
  assert.doesNotMatch(JSON.stringify(application), /exact private request|exact private response/);
  const resolution = affectiveRegulation.outcomeResolution({
    ...interaction, reviewed: true, outcome: 'appreciated', signal: 'clear and useful',
    reviewed_at: '2026-07-16T16:00:00.000Z',
  }, application);
  application.resolution = resolution;
  assert.equal(resolution.scored, true);
  assert.equal(resolution.success, true);
  assert.equal(affectiveRegulation.verifyResolution(resolution, application), true);

  const studied = affectiveRegulation.createApplication({
    interaction: { ...interaction, id: 'ix-affect-study' }, policy, appraisal: state, drives,
    activeContextTrialIds: ['sealed-context-trial'],
  });
  const studiedResolution = affectiveRegulation.outcomeResolution({
    ...interaction, id: 'ix-affect-study', reviewed: true, outcome: 'corrected', signal: 'revise',
    reviewed_at: '2026-07-16T16:00:00.000Z',
  }, studied);
  assert.equal(studiedResolution.eligible, false);
  assert.equal(studiedResolution.scored, false);
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
  assert.ok(publicState.report.transitions >= 1);
  assert.equal(publicState.report.replay_verified_transitions, publicState.report.transitions);
  assert.equal(publicState.transitions, undefined, 'dashboard snapshot stays compact by default');

  const interaction = {
    id: 'ix-store-affect-1', created: now.toISOString(), channel: 'C0123456789',
    thread_ts: '1784214000.000001', ts: '1784214001.000001',
    trigger: 'Please check the uncertain launch date.', text: 'I will verify it before claiming it.',
  };
  const application = store.recordAffectiveRegulationApplication(interaction);
  assert.equal(application.experimental_context_active, false);
  store.resolveAffectiveRegulationApplicationOutcome({
    ...interaction, reviewed: true, outcome: 'landed', signal: 'helpful',
    reviewed_at: '2026-07-16T16:00:00.000Z',
  });
  const evidenceState = store.affectiveRegulationSnapshot({ includeRecords: true });
  assert.equal(evidenceState.report.applications, 1);
  assert.equal(evidenceState.report.replay_verified_applications, 1);
  assert.equal(evidenceState.report.scored_outcomes, 1);
  assert.equal(evidenceState.applications[0].audit.complete_chain_verified, true);
  assert.equal(evidenceState.report.outcome_projection.modes.verify_and_clarify.successes, 1);
  const prompt = store.promptContext({ query: 'What should I tell the client about this uncertain launch date?' });
  assert.match(prompt, /Committed affect-regulation policy/);
  assert.match(prompt, /separate fact inference and unknown/);
  assert.match(prompt, /never what the evidence supports/i);

  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'affective_cognitive_control');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.current_content_commitment_verified, true);
  assert.equal(indicator.evidence.replay_verified_applications, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
