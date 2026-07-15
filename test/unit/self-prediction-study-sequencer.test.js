'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sequencer = require('../../src/intelligence/self-prediction-study-sequencer');
const subjectRuntime = require('../../src/intelligence/self-prediction-subject-runtime');
const modelControl = require('../../src/intelligence/self-prediction-model-control');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function sourceMoment(index, overrides = {}) {
  return {
    id: `moment-${index}`, cycle_id: `cycle-${index}`, status: 'completed',
    finished: `2026-07-15T0${index}:20:00.000Z`,
    audit: { evidence_eligible: true },
    self_forecast: {
      protocol_version: 4,
      outcome: {
        self_score: { composite: 0.7 + index / 100 },
        self_state_score: { composite: 0.75 + index / 100 },
        substrate_score: { composite: 0.9 },
        metacognitive_actual: {
          integrated_score: 0.825 + index / 200,
          integrated_success: true,
          largest_error_domain: index % 2 ? 'action_count' : 'substrate',
        },
      },
    },
    ...overrides,
  };
}

function fakeStore({ studies = [], moments = Array.from({ length: 6 }, (_, index) => sourceMoment(index + 1)),
  environment = null } = {}) {
  const state = { studies, moments, creates: [] };
  return {
    state,
    operationalEnvironmentStatus() {
      return environment || {
        program_environment_attested: true,
        software_revision: 'release-sha-1', routine_commitment: 'a'.repeat(64),
      };
    },
    experienceStreamSnapshot() { return { moments: state.moments }; },
    selfPredictionStudiesSnapshot() { return { studies: state.studies }; },
    createSelfPredictionStudy(input) {
      state.creates.push(input);
      const normalized = modelControl.normalize(input.model_control);
      const created = {
        id: input.id, status: 'active', manifest_version: 4,
        role_model_control: {
          inference_mode: normalized.subject.inference_mode,
          provider: normalized.subject.provider, model: normalized.subject.model,
        },
        report: { target: input.events.length, resolved: 0 },
        corpus_commitment: 'b'.repeat(64),
        model_control_commitment: normalized.control_commitment,
      };
      state.studies.push(created);
      return created;
    },
  };
}

function predictiveValues(context) {
  return context.slice(context.indexOf('Predictive values: ') + 'Predictive values: '.length);
}

test('sequencer freezes five independent identity-label-only event pairs', () => {
  const store = fakeStore();
  const prepared = sequencer.preregistration(store, {
    now: new Date('2026-07-15T12:00:00.000Z'),
  });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.input.events.length, sequencer.PILOT_EVENT_COUNT);
  assert.deepEqual(prepared.input.events.map(event => event.private_state_evidence[0].id),
    ['moment-2', 'moment-3', 'moment-4', 'moment-5', 'moment-6']);
  assert.equal(new Set(prepared.input.events.flatMap(event => [
    JSON.stringify(event.shared_evidence[0]),
    JSON.stringify(event.private_state_evidence[0]),
    JSON.stringify(event.information_equivalence_evidence[0]),
  ])).size, sequencer.PILOT_EVENT_COUNT * 3);
  for (const event of prepared.input.events) {
    assert.equal(predictiveValues(event.private_state_context),
      predictiveValues(event.deidentified_state_context));
    assert.match(event.private_state_context, /for Nora/);
    assert.match(event.deidentified_state_context, /target agent/);
    assert.equal(event.due, '2026-07-22T12:00:00.000Z');
  }
  const frozen = modelControl.normalize(prepared.input.model_control);
  assert.equal(frozen.subject.inference_mode, subjectRuntime.INFERENCE_MODE);
  assert.equal(frozen.subject.model, subjectRuntime.DEFAULT_MODEL);
  assert.equal(frozen.comparators.relationship, 'same_model');
  assert.equal(frozen.comparators.observer.model, frozen.subject.model);
  assert.equal(frozen.comparators.yoked_observer.model, frozen.subject.model);
  assert.equal(sequencer.calibrationValues({ self_forecast: {
    protocol_version: 4, outcome: { metacognitive_actual: { integrated_success: false } },
  } }).substrate_score, null, 'missing calibration values remain missing rather than becoming zero');
});

test('sequencer waits for an active study and preregisters exactly once afterward', () => {
  const active = { id: 'existing-v3-pilot', status: 'active' };
  const store = fakeStore({ studies: [active] });
  const waiting = sequencer.ensurePilot({ store });
  assert.equal(waiting.state, 'waiting_for_active_study');
  assert.equal(store.state.creates.length, 0);

  active.status = 'completed';
  const created = sequencer.ensurePilot({
    store, now: new Date('2026-07-15T12:00:00.000Z'),
  });
  assert.equal(created.state, 'pilot_preregistered');
  assert.equal(created.study_id, sequencer.PILOT_ID);
  assert.equal(store.state.creates.length, 1);
  assert.equal(store.state.creates[0].study_phase, 'pilot');
  assert.equal(store.state.creates[0].target_construct, 'natural_cycle_integrated_success');

  const repeat = sequencer.ensurePilot({ store });
  assert.equal(repeat.state, 'pilot_active');
  assert.equal(store.state.creates.length, 1);
});

test('sequencer preregistration is accepted atomically by the real research store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-prediction-sequencer-'));
  const now = new Date('2026-07-15T12:00:00.000Z');
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    clock: () => new Date(now),
    getOperationalEnvironment: () => ({
      software_revision: 'sequencer-release-sha', routine_commitment: 'c'.repeat(64),
      process_epoch_id: 'sequencer-test-epoch',
    }),
  });
  await store.init();
  store.experienceStreamSnapshot = () => ({
    moments: Array.from({ length: 5 }, (_, index) => sourceMoment(index + 1)),
  });
  const result = sequencer.ensurePilot({ store, now });
  assert.equal(result.state, 'pilot_preregistered');
  const study = store.selfPredictionStudiesSnapshot({ role: 'subject' }).studies[0];
  assert.equal(study.id, sequencer.PILOT_ID);
  assert.equal(study.manifest_version, 4);
  assert.equal(study.event_target, 5);
  assert.equal(study.role_model_control.inference_mode, subjectRuntime.INFERENCE_MODE);
  assert.equal(study.role_model_control.model, subjectRuntime.DEFAULT_MODEL);
  assert.equal(study.events.length, 1, 'the live subject view reveals only the randomized active event');
  assert.equal(study.events[0].private_state_evidence[0].type, 'experience_moment');
});

test('sequencer fails closed without attested deployment state or five replay-valid v4 sources', () => {
  const unattested = fakeStore({ environment: {
    program_environment_attested: false, software_revision: null, routine_commitment: null,
  } });
  assert.equal(sequencer.ensurePilot({ store: unattested }).state,
    'awaiting_program_environment_attestation');

  const insufficient = fakeStore({ moments: [
    sourceMoment(1),
    sourceMoment(2, { audit: { evidence_eligible: false } }),
    sourceMoment(3, { self_forecast: { protocol_version: 3, outcome: {
      metacognitive_actual: { integrated_success: true },
    } } }),
  ] });
  const result = sequencer.ensurePilot({ store: insufficient });
  assert.equal(result.state, 'awaiting_replay_verified_protocol_v4_sources');
  assert.equal(result.source_count, 1);
  assert.equal(result.source_target, 5);
  assert.equal(insufficient.state.creates.length, 0);
});

test('sequencer never replaces a terminal pilot or creates source cycles', () => {
  for (const terminal of ['completed', 'aborted']) {
    const store = fakeStore({ studies: [{ id: sequencer.PILOT_ID, status: terminal }] });
    const result = sequencer.ensurePilot({ store });
    assert.equal(result.state, `pilot_${terminal}`);
    assert.equal(store.state.creates.length, 0);
  }
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../../src/intelligence/self-prediction-study-sequencer.js'), 'utf8');
  assert.doesNotMatch(source, /startCycle|completeCycle|preregisterCycleSelfForecast/);
  assert.match(source, /createSelfPredictionStudy/);
});

test('server enrolls before subject and observer inference in each research tick', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const enrollAt = server.indexOf('selfPredictionStudySequencer.ensurePilot({');
  const subjectAt = server.indexOf('selfPredictionSubjectRuntime.runCycle({');
  const observerAt = server.indexOf('naturalCyclePredictionAutopilot.runCycle({');
  assert.ok(enrollAt >= 0 && subjectAt > enrollAt && observerAt > subjectAt);
});
