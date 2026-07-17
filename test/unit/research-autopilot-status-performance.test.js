'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const naturalCycle = require('../../src/intelligence/natural-cycle-prediction-autopilot');
const subjectRuntime = require('../../src/intelligence/self-prediction-subject-runtime');
const sequencer = require('../../src/intelligence/self-prediction-study-sequencer');

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
