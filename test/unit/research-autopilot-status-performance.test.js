'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const naturalCycle = require('../../src/intelligence/natural-cycle-prediction-autopilot');
const subjectRuntime = require('../../src/intelligence/self-prediction-subject-runtime');
const sequencer = require('../../src/intelligence/self-prediction-study-sequencer');
const reasoning = require('../../src/intelligence/reasoning-research-autopilot');
const globalBroadcast = require('../../src/intelligence/global-broadcast-research-autopilot');

test('research autopilot status reuses one bounded self-prediction projection', async () => {
  const seed = createIntelligenceStore({
    filePath: null, db: {}, isDbReady: () => false,
    initialState: { version: 99 },
  });
  await seed.init();
  const state = seed.snapshot();
  state.cognition.self_model.prediction_studies = [{
    id: sequencer.PILOT_ID,
    status: 'active',
    study_phase: 'pilot',
    target_construct: 'natural_cycle_integrated_success',
    manifest_version: 4,
    model_control: {
      subject: { inference_mode: subjectRuntime.INFERENCE_MODE, provider: 'anthropic', model: subjectRuntime.DEFAULT_MODEL },
    },
    events: [{
      id: 'bounded-status-event', status: 'predicting',
      self_prediction: null, subject_model_receipt: null,
      observer_prediction: { probability: 0.5 }, yoked_prediction: null,
      operational_environment_commitment: 'environment-commitment',
    }],
  }];
  const store = createIntelligenceStore({
    filePath: null, db: {}, isDbReady: () => false, initialState: state,
  });
  await store.init();
  const snapshot = store.selfPredictionProgramSnapshot();
  const noFullAuditStore = {
    selfPredictionStudiesSnapshot() { throw new Error('full study audit entered the status path'); },
  };

  const natural = naturalCycle.status(noFullAuditStore, { enabled: true, snapshot });
  const subject = subjectRuntime.status(noFullAuditStore, { enabled: true, snapshot });
  const sequence = sequencer.status(noFullAuditStore, { enabled: true, snapshot });

  assert.equal(natural.active_pilot.active_event.observer_prediction_submitted, true);
  assert.equal(natural.active_pilot.active_event.operational_environment_frozen, true);
  assert.equal(subject.active_study.active_event.self_prediction_submitted, false);
  assert.equal(subject.active_study.inference_mode, subjectRuntime.INFERENCE_MODE);
  assert.equal(sequence.pilot.status, 'active');
  assert.equal(sequence.pilot.event_target, 1);
});

test('idle global-broadcast coordination never enters the full intelligence snapshot path', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bounded-research-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    initialState: { version: 99 },
  });
  await store.init();
  const predecessor = store.createContextTrial(reasoning.pilotDesign());
  store.abortContextTrial(predecessor.id, {
    reason_code: 'external_change',
    explanation: 'Close the predecessor without reveal so the sequential test pilot may start.',
    evidence: [{ type: 'test_fixture', id: 'bounded-research-scheduler-view' }],
  });
  assert.equal(globalBroadcast.ensurePilot(store, { enabled: true }).state, 'pilot_created');

  const schedulerStore = {
    ...store,
    snapshot() { throw new Error('full intelligence snapshot entered the idle scheduler path'); },
  };
  const result = await globalBroadcast.runCycle({
    store: schedulerStore,
    enabled: true,
    callProvider: async () => { throw new Error('idle pilot must not call a provider'); },
  });

  assert.equal(result.state, 'collecting_pilot');
  assert.equal(result.grades_committed, 0);
  assert.equal(result.terminal_state.reason, 'enrollment_open');

  const view = store.contextTrialsRuntimeSnapshot();
  view.find(item => item.id === globalBroadcast.PILOT_ID).status = 'tampered-copy';
  assert.equal(store.contextTrialsRuntimeSnapshot()
    .find(item => item.id === globalBroadcast.PILOT_ID).status, 'active');
});
