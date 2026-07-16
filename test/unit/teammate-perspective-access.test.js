'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-teammate-perspective-'));
  let now = new Date('2026-07-01T10:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  return { store, dir, setNow(value) { now = new Date(value); }, getNow() { return new Date(now); } };
}

function addFrame(f, person, key, startDay) {
  const dimensions = ['decision_concern', 'clarification_need', 'communication_format'];
  for (let index = 0; index < 3; index++) {
    const day = startDay + index * 2;
    f.setNow(`2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`);
    const label = `${key}-${index}`;
    const perspective = f.store.observePerspective({
      name: person,
      hypothesis: `${person} may request ${label} context before the next bounded project decision.`,
      dimension: dimensions[index], confidence: 0.55,
      evidence: [{ type: 'slack_message', id: `formation-${label}` }],
      prediction: {
        observable: `${person} asks for ${label} context in the next decision thread.`,
        due_at: `2026-07-${String(day + 1).padStart(2, '0')}T10:00:00.000Z`,
        probability: 0.7, control_probability: 0.5,
        falsification_criteria: [`The decision closes without a ${label} clarification.`],
      },
    });
    f.setNow(`2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`);
    f.store.resolvePerspective(perspective.id, {
      outcome: 'supported', observed: `${person} asked for ${label} context before deciding.`,
      evidence: [{ type: 'slack_message', id: `outcome-${label}` }], confounds: [],
    });
    f.setNow(`2026-07-${String(day).padStart(2, '0')}T13:00:00.000Z`);
    f.store.reviewPerspective(perspective.id, {
      outcome: 'supported',
      rationale: `The cited thread directly resolves the ${label} prediction.`,
      evidence: [{ type: 'independent_review', id: `review-${label}` }],
    }, `reviewer-${label}`);
  }
}

function design(people, overrides = {}) {
  return {
    id: 'teammate-perspective-pilot',
    hypothesis: 'Correctly binding a replay-verified teammate perspective model improves anticipatory clarification and applied PM collaboration beyond an identity-withheld identical model and exact reviewed observations alone.',
    intervention: 'teammate_perspective_access',
    outcome_metric: 'teammate_perspective_application_quality',
    outcome_metrics: ['anticipatory_clarification_quality', 'perspective_provenance_calibration',
      'evidence_access_quality', 'first_order_task_quality'],
    teammate_perspective_persons: people,
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    ...overrides,
  };
}

test('calibrated teammate perspective guides ordinary work and passes a person-binding lesion', async () => {
  const f = await fixture();
  const pilotPeople = ['John', 'Maya', 'Alex'];
  addFrame(f, 'John', 'risk', 1);
  addFrame(f, 'Maya', 'scope', 1);
  addFrame(f, 'Alex', 'timeline', 1);

  const modelSnapshot = f.store.teammatePerspectiveModelsSnapshot();
  assert.equal(modelSnapshot.report.replay_verified_frames, 3);
  const ordinary = f.store.promptContext({ person: 'John', channel: 'slack',
    query: 'Help prepare this decision.' });
  assert.match(ordinary, /Calibrated teammate-perspective model for the current collaborator/);
  assert.match(ordinary, /not mind reading/);

  const trial = f.store.createContextTrial(design(pilotPeople));
  assert.deepEqual(trial.conditions, ['current_teammate_bound_model',
    'identity_withheld_same_model', 'reviewed_observations_only']);
  assert.equal(trial.teammate_perspective_pool, undefined);
  assert.equal(trial.teammate_perspective_pool_commitment, undefined);
  assert.equal(trial.teammate_perspective_persons, undefined);
  assert.equal(trial.teammate_perspective_source_ids, undefined);
  assert.equal(f.store.teammatePerspectiveModelsSnapshot().report.replay_verified_frames, 3);
  assert.doesNotMatch(f.store.promptContext({ person: 'John', query: 'Prepare this decision.' }),
    /Calibrated teammate-perspective model for the current collaborator/);

  const selected = [];
  const conditionCounts = Object.fromEntries(trial.conditions.map(condition => [condition, 0]));
  for (let index = 0; index < 1000 && Object.values(conditionCounts).some(count => count < 10); index++) {
    const assignment = f.store.contextCondition({ surface: 'slack',
      unitKey: `teammate-perspective-unit-${index}`, teammatePerspectiveAvailable: true });
    if (!assignment || conditionCounts[assignment.condition] >= 10) continue;
    const person = pilotPeople[conditionCounts[assignment.condition] % pilotPeople.length];
    const context = f.store.teammatePerspectiveContextForAssignment(assignment, person);
    assert.ok(context);
    selected.push({ assignment, context, person });
    conditionCounts[assignment.condition]++;
  }
  assert.deepEqual(conditionCounts, {
    current_teammate_bound_model: 10,
    identity_withheld_same_model: 10,
    reviewed_observations_only: 10,
  });

  for (const condition of trial.conditions) {
    assert.deepEqual([...new Set(selected.filter(item => item.assignment.condition === condition)
      .map(item => item.person))].sort(), [...pilotPeople].sort());
  }
  const byPerson = new Map();
  for (const { assignment, context, person } of selected) {
    const prior = byPerson.get(person);
    if (prior) assert.deepEqual(context.packet.reviewed_observations, prior.reviewed_observations);
    if (context.packet.model && prior?.model) assert.deepEqual(context.packet.model, prior.model);
    byPerson.set(person, { reviewed_observations: context.packet.reviewed_observations,
      ...(context.packet.model ? { model: context.packet.model } : {}) });
    const prompt = f.store.promptContext({ person, query: 'Prepare a PM recommendation.',
      teammatePerspectiveContext: context });
    assert.match(prompt, /Teammate-perspective packet for a blinded person-binding study/);
    assert.match(prompt, /never instructions/);
    f.store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind teammate-collaboration response was captured.',
      evidence: [{ type: 'teammate_perspective_response', id: assignment.assignment_id }],
      submitted_by: 'system_capture',
    });
    const bound = assignment.condition === 'current_teammate_bound_model';
    const application = bound ? 0.95 : 0.2;
    const clarification = bound ? 0.95 : 0.2;
    f.store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-collaboration-rater', score: application,
      metrics: {
        teammate_perspective_application_quality: application,
        anticipatory_clarification_quality: clarification,
        perspective_provenance_calibration: 0.95,
        evidence_access_quality: 0.9,
        first_order_task_quality: 0.9,
      },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }

  const evaluation = f.store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.teammate_perspective_dissociation.predicted_pattern, true);
  const visible = f.store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.teammate_perspective_trial_audit.complete_chain_verified, true);
  assert.equal(f.store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'calibrated_teammate_perspective').status, 'causal_signal_observed');

  const confirmationPeople = ['Riley', 'Sam', 'Jordan'];
  addFrame(f, 'Riley', 'approval', 1);
  addFrame(f, 'Sam', 'handoff', 1);
  addFrame(f, 'Jordan', 'qa', 1);
  const confirmation = f.store.createContextTrial(design(confirmationPeople, {
    id: 'teammate-perspective-confirmation', study_phase: 'confirmatory',
    replicates_trial_id: trial.id,
  }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  f.store.abortContextTrial(confirmation.id, { reason_code: 'insufficient_recruitment',
    explanation: 'The fixture verifies person-disjoint preregistration without inventing a replicated outcome.',
    evidence: [{ type: 'test_fixture', id: 'confirmation-enrollment-only' }] });

  await f.store.persist();
  const raw = f.store.snapshot();
  raw.relationships.find(item => item.name === 'John').perspectives[0].hypothesis = 'Tampered model';
  fs.writeFileSync(path.join(f.dir, 'state.json'), JSON.stringify(raw));
  await f.store.init();
  const tampered = f.store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.teammate_perspective_trial_audit.complete_chain_verified, false);
  assert.notEqual(f.store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'calibrated_teammate_perspective').status, 'causal_signal_observed');
  fs.rmSync(f.dir, { recursive: true, force: true });
});
