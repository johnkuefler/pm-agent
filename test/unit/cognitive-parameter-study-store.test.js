'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parameters = require('../../src/intelligence/cognitive-parameters');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-dials-study-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = new Date('2026-07-18T12:00:00.000Z');
  let parameterRecord = parameters.defaultRecord();
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    clock: () => now, getCognitiveParameterRecord: commitment => !commitment
      || commitment === parameterRecord.content_commitment ? parameterRecord : null,
  });
  await store.init();
  return { store, setNow: value => { now = new Date(value); },
    setParameterRecord: value => { parameterRecord = value; } };
}

function createPilot(store, overrides = {}) {
  return store.createCognitiveParameterStudy({
    id: 'workspace-relevance-pilot', title: 'Workspace relevance pilot',
    created_by: 'research-owner', parameter_path: 'workspace.relevance_per_term',
    candidate_value: 2.4, minimum_samples_per_arm: 10, maximum_assignments: 40,
    evaluation_window_days: 14, minimum_effect: 0.08, guard_minimum_rate: 0.9,
    ...overrides,
  });
}

function latency(overrides = {}) {
  return { protocol_version: 7, surface: 'slack', latency_ms: 4200, budget_ms: 8000,
    within_budget: true, prompt_chars: 43000, prompt_budget_chars: 45000,
    prompt_within_budget: true, stages: {}, ...overrides };
}

test('store binds DIALS assignments, delivery, review, and research events end to end', async t => {
  const { store, setNow } = await setup(t);
  const pilot = createPilot(store);
  assert.equal(pilot.conditions_sealed, true);
  const receipt = store.assignCognitiveParameterStudy({
    eligible: true, surface: 'slack', unit_key: 'slack:C1:100.1',
  });
  assert.equal(receipt.study_id, pilot.id);
  assert.equal(receipt.arm, undefined);
  const effective = store.cognitiveParameterInputForAssignment(receipt);
  assert.ok([2, 2.4].includes(effective.workspace.relevance_per_term));
  store.markCognitiveParameterAssignmentDelivered(receipt.assignment_id, {
    interaction_id: 'ix-1', interaction_ref: 'slack-message-1', latency: latency(),
    workspace_commitment: 'a'.repeat(64), procedure_selection_commitment: null,
    exemplar_selection_commitment: null,
  });
  setNow('2026-07-19T12:00:00.000Z');
  store.resolveCognitiveParameterAssignmentOutcome(receipt.assignment_id, {
    interaction_id: 'ix-1', outcome: 'landed', signal: 'Teammate continued with the answer.',
    reviewed_at: '2026-07-19T11:00:00.000Z',
  });
  const publicView = store.cognitiveParameterStudiesSnapshot();
  assert.equal(publicView.studies[0].resolved, 1);
  assert.equal(JSON.stringify(publicView).includes('candidate_parameter'), false);
  assert.equal(publicView.studies[0].audit.complete_chain_verified, true);
  const research = store.cognitiveParameterStudiesSnapshot({ research: true });
  assert.equal(research.studies[0].assignments[0].resolution.outcome, 'landed');
  assert.equal(research.studies[0].randomization_secret, undefined);
  assert.equal(research.studies[0].audit.research_ledger_verified, true);
});

test('DIALS assignment refuses overlap with a blinded context trial', async t => {
  const { store } = await setup(t);
  createPilot(store);
  const state = store.snapshot();
  state.cognition.self_model.context_trials.push({ id: 'active-trial', status: 'active', intervention: 'goal_access' });
  const overlapping = createIntelligenceStore({ initialState: state, filePath: null, db: {},
    isDbReady: () => false, getCognitiveParameterRecord: () => parameters.defaultRecord() });
  await overlapping.init();
  assert.equal(overlapping.assignCognitiveParameterStudy({
    eligible: true, surface: 'slack', unit_key: 'overlap-unit',
  }), null);
});

test('an external global parameter change aborts the active study before another exposure', async t => {
  const { store, setParameterRecord } = await setup(t);
  createPilot(store);
  const baseline = parameters.defaultRecord();
  const changed = parameters.createRevision(baseline, { memory: { salience: { default: 0.35 } } }, {
    updatedBy: 'John', note: 'External change during test', now: new Date('2026-07-19T00:00:00Z'),
  }).record;
  setParameterRecord(changed);
  assert.equal(store.assignCognitiveParameterStudy({
    eligible: true, surface: 'slack', unit_key: 'after-global-change',
  }), null);
  const study = store.cognitiveParameterStudiesSnapshot({ research: true }).studies[0];
  assert.equal(study.status, 'aborted');
  assert.equal(study.terminal.reason, 'external_parameter_change_automatic_rollback');
  assert.equal(study.authority.global_document_mutated, false);
  assert.equal(study.audit.complete_chain_verified, true);
});

test('confirmation cannot start without a replay-valid supported pilot', async t => {
  const { store } = await setup(t);
  assert.throws(() => createPilot(store, {
    id: 'premature-confirmation', study_phase: 'confirmatory',
    replicates_study_id: 'missing-pilot',
  }), /requires one replay-valid supported pilot/);
});

test('foreground assignment reuses the broadcast mutation and stays within a tiny local overhead', async () => {
  const db = { getState: async () => null, setState: async () => {} };
  const make = async active => {
    const store = createIntelligenceStore({ filePath: 'unused', db, isDbReady: () => true,
      getCognitiveParameterRecord: () => parameters.defaultRecord() });
    await store.init();
    if (active) createPilot(store, { maximum_assignments: 80 });
    return store;
  };
  const baseline = await make(false);
  const study = await make(true);
  const measure = (store, active) => {
    const values = [];
    for (let index = 0; index < 30; index++) {
      const started = process.hrtime.bigint();
      store.runGlobalBroadcast({ query: 'launch qa status evidence', surface: 'slack',
        cognitiveParameterStudiesEnabled: active, cognitiveParameterUnitKey: `turn-${index}` });
      values.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return values.sort((left, right) => left - right)[28];
  };
  const baselineP95 = measure(baseline, false);
  const studyP95 = measure(study, true);
  assert.ok(studyP95 - baselineP95 < 20,
    `DIALS p95 local overhead must stay below 20ms (baseline ${baselineP95.toFixed(2)}ms, study ${studyP95.toFixed(2)}ms)`);
});
