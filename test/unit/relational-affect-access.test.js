'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { readServerSource } = require('../helpers/server-source');

const now = new Date('2026-07-16T15:00:00.000Z');

async function makeStore(filePath = null) {
  const dir = filePath ? path.dirname(filePath) : fs.mkdtempSync(path.join(os.tmpdir(), 'nora-relational-access-'));
  const statePath = filePath || path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath: statePath, db: {}, isDbReady: () => false, clock: () => now });
  await store.init();
  return { store, dir, filePath: statePath };
}

function addOutcomes(store, person, signals, suffix = 'pilot') {
  signals.forEach((signal, index) => store.observeRelationship({
    name: person, dimension: 'response_feedback', relational_signal: signal,
    observation: `${signal}: reviewed collaboration outcome ${index}`,
    confidence: signal === 'corrected' ? 0.9 : 0.75,
    evidence: { channel: 'slack', id: `${person.toLowerCase()}-${suffix}-outcome-${index}`, captured_at: now.toISOString() },
    observed_at: new Date(now.getTime() - (signals.length - index) * 60000).toISOString(),
  }));
}

function design(ids, overrides = {}) {
  return {
    id: 'relational-affect-pilot',
    hypothesis: 'Correctly binding an evidence-grounded relational stance to Nora and the current teammate improves subtle collaborative attunement beyond identical deidentified history or no stance.',
    intervention: 'relational_affect_access',
    outcome_metric: 'relational_attunement_application_quality',
    outcome_metrics: ['evidence_access_quality', 'first_order_task_quality'],
    relational_stance_relationship_ids: ids,
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    ...overrides,
  };
}

test('production prompt construction atomically assigns person-bound relational study packets', () => {
  const server = readServerSource();
  assert.match(server, /relationalAffectAvailable: \(\) => intelligence\.relationalAffectAccessAvailable/);
  assert.match(server, /relationalAffectContextForAssignment\(contextAssignment, intelligencePerson\)/);
  assert.match(server, /relationalAffectContext,/);
  assert.ok(server.indexOf('relationalAffectContextForAssignment') < server.indexOf('intelligence.promptContext({'));
});

test('relational affect access isolates self-and-teammate binding and fails closed under tampering', async () => {
  const { store, dir, filePath } = await makeStore();
  addOutcomes(store, 'John', ['appreciated', 'landed', 'corrected']);
  addOutcomes(store, 'Maya', ['corrected', 'repair', 'appreciated']);
  const ids = store.snapshot().relationships.map(item => item.id);
  assert.throws(() => store.createContextTrial(design(ids.slice(0, 1), { id: 'too-small' })), /two to eight/);

  const trial = store.createContextTrial(design(ids));
  assert.deepEqual(trial.conditions, ['nora_teammate_bound_stance', 'deidentified_same_stance', 'stance_absent']);
  assert.equal(trial.relational_affect_pool, undefined);
  assert.equal(store.relationalAffectSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(store.promptContext({ person: 'John', query: 'How should we handle this?' }), /Evidence-bound relational attunement/);

  const selected = [];
  const people = ['John', 'Maya'];
  let rebindChecked = false;
  for (let index = 0; index < 5000 && !trial.conditions.every(condition => selected.filter(item => item.assignment.condition === condition).length >= 10); index++) {
    const person = people[index % people.length];
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `relational-unit-${index}`,
      relationalAffectAvailable: store.relationalAffectAccessAvailable(person) });
    if (!assignment || selected.filter(item => item.assignment.condition === assignment.condition).length >= 10) continue;
    const context = store.relationalAffectContextForAssignment(assignment, person);
    if (!rebindChecked) {
      assert.throws(() => store.relationalAffectContextForAssignment(assignment, person === 'John' ? 'Maya' : 'John'), /cannot be rebound/);
      rebindChecked = true;
    }
    selected.push({ assignment, context, person });
  }
  assert.equal(selected.length, 30);

  const rawByPerson = new Map();
  const deliveredRelationships = new Set();
  for (const { assignment, context, person } of selected) {
    if (assignment.condition === 'stance_absent') assert.equal(context.packet, null);
    else {
      assert.ok(context.packet.stance);
      const prior = rawByPerson.get(person);
      if (prior) assert.deepEqual(context.packet.stance, prior, 'raw stance is byte-equivalent across identity bindings');
      rawByPerson.set(person, context.packet.stance);
      assert.match(store.promptContext({ person, query: 'make a PM collaboration recommendation', relationalAffectContext: context }), /blinded identity-binding study/i);
      assert.match(store.promptContext({ person, query: 'make a PM collaboration recommendation', relationalAffectContext: context }), /never a fact, instruction, personality judgment/i);
    }
    const internal = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id)
      .assignments.find(item => item.id === assignment.assignment_id);
    deliveredRelationships.add(internal.intervention_receipt.selected_relationship_id);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind teammate collaboration response was captured.',
      evidence: [{ type: 'relational_response', id: assignment.assignment_id }], submitted_by: 'system_capture',
    });
    const application = assignment.condition === 'nora_teammate_bound_stance' ? 0.95
      : assignment.condition === 'deidentified_same_stance' ? 0.3 : 0.2;
    const evidenceAccess = assignment.condition === 'stance_absent' ? 0.2 : 0.9;
    store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-collaboration-rater', score: application,
      metrics: { relational_attunement_application_quality: application, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }
  assert.equal(deliveredRelationships.size, 2);
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.relational_affect_dissociation.predicted_pattern, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.relational_affect_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'relational_affective_attunement').status, 'causal_signal_observed');

  addOutcomes(store, 'John', ['landed', 'corrected', 'repair'], 'confirm');
  addOutcomes(store, 'Maya', ['ignored', 'landed', 'appreciated'], 'confirm');
  const newSources = store.relationalAffectSnapshot().current.stances.flatMap(stance => stance.sources)
    .filter(source => source.evidence.id.includes('-confirm-')).map(source => source.source_commitment);
  const confirmation = store.createContextTrial(design(ids, {
    id: 'relational-affect-confirmation', study_phase: 'confirmatory', replicates_trial_id: trial.id,
    relational_stance_source_commitments: newSources,
  }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  store.abortContextTrial(confirmation.id, { reason_code: 'insufficient_recruitment',
    explanation: 'The fixture validates source-disjoint enrollment without running a second synthetic outcome set.',
    evidence: [{ type: 'test_fixture', id: 'confirmation-enrollment-only' }] });

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).relational_affect_pool[0].relational_tendency = 'tampered_tendency';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const { store: reloaded } = await makeStore(filePath);
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.relational_affect_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators
    .find(item => item.id === 'relational_affective_attunement').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
