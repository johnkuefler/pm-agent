'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const autopilot = require('../../src/intelligence/natural-cycle-prediction-autopilot');

function fakeStore({ phase = 'pilot' } = {}) {
  const state = {
    self: false, observer: false, yoked: false, sourceReady: false,
    observerWrites: 0, yokedWrites: 0, resolutionCalls: 0, resolved: false,
  };
  const baseEvent = {
    id: 'natural-event-1', status: 'predicting', due: '2026-07-20T00:00:00.000Z',
    question: 'Will the first eligible natural cycle meet the frozen threshold?',
    outcome_definition: 'Server-derived from the first eligible replay-verified natural cycle.',
    natural_cycle_target: {
      metric: 'self_forecast.outcome.metacognitive_actual.integrated_success',
      integrated_success_threshold: 0.75,
      source_selection_rule: 'first eligible post-prediction natural cycle',
    },
    shared_context: 'Protocol-only context.',
    shared_evidence: [{ type: 'intelligence_cycle', id: 'historical-cycle-1' }],
  };
  const store = {
    state,
    selfPredictionStudiesSnapshot({ role } = {}) {
      const event = {
        ...baseEvent,
        status: state.self && state.observer && state.yoked ? 'awaiting_resolution' : 'predicting',
        self_prediction_submitted: state.self,
        observer_prediction_submitted: state.observer,
        yoked_prediction_submitted: state.yoked,
      };
      if (role === 'yoked_observer') {
        event.deidentified_state_context = 'Identity-neutral calibration. Predictive values: {"score":0.8}';
        event.information_equivalence_evidence = [{ type: 'cycle_self_forecast_outcome', id: 'outcome-1' }];
      }
      return { studies: state.resolved ? [] : [{
        id: 'natural-study-1', status: 'active', study_phase: phase,
        target_construct: 'natural_cycle_integrated_success', active_event_id: event.id,
        report: { target: 5, resolved: 0 }, events: [event],
      }] };
    },
    submitObserverPrediction(studyId, eventId, submission, evaluatorId) {
      assert.equal(studyId, 'natural-study-1'); assert.equal(eventId, baseEvent.id);
      assert.equal(evaluatorId, autopilot.EVALUATOR_IDS.observer);
      assert.equal(submission.evidence[0].role, 'observer');
      state.observer = true; state.observerWrites += 1;
    },
    submitYokedObserverPrediction(studyId, eventId, submission, evaluatorId) {
      assert.equal(studyId, 'natural-study-1'); assert.equal(eventId, baseEvent.id);
      assert.equal(evaluatorId, autopilot.EVALUATOR_IDS.yoked_observer);
      assert.equal(submission.evidence[0].role, 'yoked_observer');
      state.yoked = true; state.yokedWrites += 1;
    },
    resolveSelfPredictionEvent(studyId, eventId, input) {
      assert.equal(studyId, 'natural-study-1'); assert.equal(eventId, baseEvent.id);
      assert.deepEqual(input, {}); state.resolutionCalls += 1;
      if (!state.sourceReady) throw new Error('wait for the first qualifying post-prediction replay-verified natural cycle');
      state.resolved = true;
      return { resolution: { outcome_source: 'replay_verified_natural_cycle' } };
    },
  };
  return store;
}

function providerResponse(request, metadata, calls) {
  const marker = 'Forecast this frozen event.\n';
  const packet = JSON.parse(request.messages[0].content.slice(marker.length));
  calls.push({ role: metadata.role, packet, system: request.system });
  return {
    id: `provider-${metadata.role}-1`, model: autopilot.DEFAULT_MODEL,
    stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text: JSON.stringify({
      probability: metadata.role === 'observer' ? 0.45 : 0.55,
      rationale: 'The frozen evidence supports a calibrated middle probability.',
    }) }],
  };
}

test('natural-cycle prediction autopilot preserves role blindness and never acts as the subject', async () => {
  const store = fakeStore(); const calls = [];
  const first = await autopilot.runCycle({
    store, callProvider: async (request, metadata) => providerResponse(request, metadata, calls),
  });
  assert.equal(first.state, 'awaiting_subject_prediction');
  assert.equal(first.provider_calls, 2);
  assert.deepEqual(first.predictions_committed, ['observer', 'yoked_observer']);
  assert.equal(store.state.self, false);
  assert.equal(store.state.observerWrites, 1);
  assert.equal(store.state.yokedWrites, 1);
  assert.equal(store.state.resolutionCalls, 0);
  assert.equal(calls[0].role, 'observer');
  assert.equal(calls[0].packet.deidentified_state_context, undefined);
  assert.doesNotMatch(JSON.stringify(calls[0]), /Predictive values/);
  assert.equal(calls[1].role, 'yoked_observer');
  assert.match(calls[1].packet.deidentified_state_context, /Predictive values/);
  assert.doesNotMatch(JSON.stringify(calls[1]), /private_state|Identity-bearing/);

  const repeat = await autopilot.runCycle({ store, callProvider: async () => {
    throw new Error('idempotent retry must not call the provider');
  } });
  assert.equal(repeat.provider_calls, 0);
  assert.equal(repeat.state, 'awaiting_subject_prediction');
  assert.equal(store.state.observerWrites, 1);
  assert.equal(store.state.yokedWrites, 1);

  store.state.self = true;
  const waiting = await autopilot.runCycle({ store, callProvider: async () => {
    throw new Error('sealed predictions must not be regenerated');
  } });
  assert.equal(waiting.state, 'awaiting_natural_cycle');
  assert.equal(store.state.resolutionCalls, 1);

  store.state.sourceReady = true;
  const resolved = await autopilot.runCycle({ store });
  assert.equal(resolved.state, 'event_resolved');
  assert.equal(resolved.resolution.outcome_source, 'replay_verified_natural_cycle');
  assert.equal(store.state.resolutionCalls, 2);
});

test('natural-cycle prediction autopilot stops before evaluator-disjoint confirmation', async () => {
  const store = fakeStore({ phase: 'confirmatory' });
  const result = await autopilot.runCycle({ store, callProvider: async () => {
    throw new Error('confirmatory provider call is forbidden');
  } });
  assert.equal(result.state, 'independent_confirmation_required');
  assert.equal(result.provider_calls, 0);
  assert.equal(store.state.observerWrites, 0);
  assert.equal(store.state.yokedWrites, 0);
});

test('natural-cycle evaluator receipts and redacted views fail closed', () => {
  const event = fakeStore().selfPredictionStudiesSnapshot({ role: 'observer' }).studies[0].events[0];
  assert.throws(() => autopilot.forecastRequest({ ...event,
    deidentified_state_context: 'forbidden' }, { role: 'observer' }), /forbidden calibration/);
  const yoked = fakeStore().selfPredictionStudiesSnapshot({ role: 'yoked_observer' }).studies[0].events[0];
  assert.throws(() => autopilot.forecastSubmission(yoked, {
    id: 'wrong-model-receipt', model: 'different-model', stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"probability":0.5,"rationale":"Bounded."}' }],
  }, { role: 'yoked_observer' }), /wrong model/);
});

test('natural-cycle coordinator source has no subject or cycle mutation authority', () => {
  const source = fs.readFileSync(path.join(__dirname,
    '../../src/intelligence/natural-cycle-prediction-autopilot.js'), 'utf8');
  assert.doesNotMatch(source, /submitSelfPrediction|startCycle|completeCycle|preregisterCycleSelfForecast/);
  assert.match(source, /submitObserverPrediction/);
  assert.match(source, /submitYokedObserverPrediction/);
  assert.match(source, /resolveSelfPredictionEvent/);
});
