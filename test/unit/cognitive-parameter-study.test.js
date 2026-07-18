'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const params = require('../../src/intelligence/cognitive-parameters');
const studyProtocol = require('../../src/intelligence/cognitive-parameter-study');

function create(overrides = {}) {
  return studyProtocol.createStudy({
    id: 'dial-relevance-pilot', title: 'Workspace relevance pilot',
    created_by: 'research-owner', parameter_path: 'workspace.relevance_per_term',
    candidate_value: 2.4, minimum_samples_per_arm: 10, maximum_assignments: 40,
    evaluation_window_days: 14, minimum_effect: 0.08, guard_minimum_rate: 0.9,
    ...overrides,
  }, params.defaultRecord(), {
    randomizationSecret: 'server-secret-that-is-at-least-thirty-two-characters',
    now: new Date('2026-07-18T00:00:00Z'),
  });
}

function assign(study, index, { latency = 4000, prompt = 43000, outcome = null } = {}) {
  const assignment = studyProtocol.createAssignment(study, {
    unitKey: `slack-unit-${index}`, now: new Date(`2026-07-18T00:${String(index).padStart(2, '0')}:00Z`),
  });
  study.assignments.push(assignment);
  studyProtocol.deliverAssignment(study, assignment, {
    interaction_id: `interaction-${index}`, interaction_ref: `slack-ref-${index}`,
    latency: { protocol_version: 7, surface: 'slack', latency_ms: latency, budget_ms: 8000,
      within_budget: latency <= 8000, prompt_chars: prompt, prompt_budget_chars: 45000,
      prompt_within_budget: prompt <= 45000, stages: {} },
    workspace_commitment: studyProtocol.commitment({ slots: [`slot-${index}`] }),
  }, new Date(`2026-07-18T00:${String(index).padStart(2, '0')}:01Z`));
  if (outcome) studyProtocol.resolveAssignment(study, assignment, {
    interaction_id: `interaction-${index}`, outcome, signal: 'independent delayed review',
    reviewed_at: `2026-07-19T00:${String(index).padStart(2, '0')}:00Z`,
  });
  return assignment;
}

test('DIALS study preregisters one supported bounded parameter without mutating the baseline', () => {
  const baseline = params.defaultRecord();
  const study = create();
  assert.equal(studyProtocol.verifyStudy(study), true);
  assert.equal(study.parameter_path, 'workspace.relevance_per_term');
  assert.equal(study.baseline.value, 2);
  assert.equal(study.candidate.value, 2.4);
  assert.equal(study.authority.global_document_mutated, false);
  assert.equal(baseline.params.workspace.relevance_per_term, 2);
  assert.throws(() => create({ parameter_path: 'voice.active_window_ms', candidate_value: 50000 }), /unsupported/);
  assert.throws(() => create({ created_by: 'Nora self tune' }), /non-Nora research owner/);
});

test('assignments are deterministic, balanced, replay-valid, and expose only ephemeral params', () => {
  const study = create();
  for (let index = 0; index < 10; index++) assign(study, index);
  assert.equal(studyProtocol.auditStudy(study).complete_chain_verified, true);
  const counts = Object.fromEntries(studyProtocol.ARMS.map(arm => [arm,
    study.assignments.filter(item => item.arm === arm).length]));
  assert.deepEqual(counts, { frozen_baseline: 5, candidate_parameter: 5 });
  for (const block of new Set(study.assignments.map(item => item.randomization_block))) {
    const rows = study.assignments.filter(item => item.randomization_block === block);
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(item => item.arm)), new Set(studyProtocol.ARMS));
  }
  const candidate = study.assignments.find(item => item.arm === 'candidate_parameter');
  const effective = studyProtocol.paramsForArm(study, candidate.arm);
  assert.equal(effective.workspace.relevance_per_term, 2.4);
  assert.equal(study.baseline.params.workspace.relevance_per_term, 2);
  const repeated = studyProtocol.createAssignment(study, { unitKey: `slack-unit-${candidate.sequence - 1}` });
  assert.equal(repeated.id, candidate.id);
});

test('delayed reviewed outcomes can support a pilot but never authorize promotion', () => {
  const study = create();
  for (let index = 0; index < 20; index++) {
    const next = studyProtocol.createAssignment(study, { unitKey: `slack-unit-${index}` });
    const outcome = next.arm === 'candidate_parameter' ? 'landed'
      : index % 2 ? 'neutral' : 'ignored';
    assign(study, index, { outcome });
  }
  const report = studyProtocol.analysis(study);
  assert.equal(report.sufficient_preregistered_sample, true);
  assert.equal(report.effect_direction, 'candidate_advantage');
  assert.equal(report.randomization_analysis.complete_blocks, 10);
  assert.ok(report.randomization_analysis.exact_one_sided_candidate_advantage_p <= 0.1);
  assert.equal(report.promotion_eligible, false);
  const recommendation = studyProtocol.terminalRecommendation(study, new Date('2026-07-20T00:00:00Z'));
  assert.equal(recommendation.status, 'completed');
  studyProtocol.closeStudy(study, recommendation, new Date('2026-07-20T00:00:00Z'));
  assert.equal(studyProtocol.auditStudy(study).complete_chain_verified, true);
  assert.equal(study.status, 'completed');
  assert.equal(study.terminal.reason, 'candidate_advantage');
});

test('a favorable average below the exact preregistered randomization gate stays inconclusive', () => {
  const study = create();
  for (let index = 0; index < 20; index++) {
    const preview = studyProtocol.createAssignment(study, { unitKey: `slack-unit-${index}` });
    const outcome = preview.arm === 'frozen_baseline' && preview.randomization_block <= 2
      ? 'neutral' : 'landed';
    assign(study, index, { outcome });
  }
  const report = studyProtocol.analysis(study);
  assert.equal(report.sufficient_preregistered_sample, true);
  assert.equal(report.candidate_minus_baseline, 0.1);
  assert.equal(report.randomization_analysis.exact_one_sided_candidate_advantage_p, 0.25);
  assert.equal(report.effect_direction, 'inconclusive_band');
});

test('a prompt violation automatically stops candidate exposure and preserves baseline rollback', () => {
  const study = create();
  let index = 0;
  while (true) {
    const next = studyProtocol.createAssignment(study, { unitKey: `slack-unit-${index}` });
    const prompt = next.arm === 'candidate_parameter' ? 45001 : 43000;
    assign(study, index, { prompt });
    if (next.arm === 'candidate_parameter') break;
    index += 1;
  }
  const recommendation = studyProtocol.terminalRecommendation(study);
  assert.equal(recommendation.status, 'aborted');
  assert.equal(recommendation.reason, 'candidate_prompt_guard_failed_automatic_rollback');
  studyProtocol.closeStudy(study, recommendation);
  assert.equal(study.status, 'aborted');
  assert.equal(study.authority.global_document_mutated, false);
  assert.equal(studyProtocol.auditStudy(study).complete_chain_verified, true);
});

test('active public projection seals condition values and assignment arms', () => {
  const study = create();
  assign(study, 0);
  const visible = studyProtocol.publicStudy(study);
  assert.equal(visible.conditions_sealed, true);
  assert.equal(visible.parameter_path, undefined);
  assert.equal(visible.assignments, 1);
  assert.equal(JSON.stringify(visible).includes('candidate_parameter'), false);
  assert.equal(JSON.stringify(visible).includes('2.4'), false);
  const research = studyProtocol.researchStudy(study);
  assert.equal(research.randomization_secret, undefined);
  assert.equal(research.assignments[0].arm.length > 0, true);
});

test('tampering with an arm, delivery, or outcome breaks replay', () => {
  const study = create();
  assign(study, 0, { outcome: 'landed' });
  for (const mutate of [
    copy => { copy.assignments[0].arm = 'frozen_baseline'; },
    copy => { copy.assignments[0].delivery.latency.prompt_chars = 1; },
    copy => { copy.assignments[0].resolution.score = 0; },
  ]) {
    const copy = structuredClone(study);
    mutate(copy);
    assert.equal(studyProtocol.auditStudy(copy).complete_chain_verified, false);
  }
});
