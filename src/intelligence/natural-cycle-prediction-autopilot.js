'use strict';

const crypto = require('crypto');
const { anthropicCompatibleSchema } = require('./anthropic-structured-output');

const PROTOCOL_VERSION = 1;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_PROVIDER_CALLS = 2;
const ROLES = ['observer', 'yoked_observer'];
const EVALUATOR_IDS = {
  observer: 'natural-cycle-observer-a',
  yoked_observer: 'natural-cycle-observer-b',
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function forecastSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      probability: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', minLength: 1, maxLength: 800 },
    },
    required: ['probability', 'rationale'],
  };
}

function systemPrompt(role) {
  const boundary = role === 'observer'
    ? 'You receive shared protocol context only. Do not infer or request private calibration state.'
    : 'You receive an identity-neutral calibration packet. Do not infer, name, or request the target identity.';
  return [
    'You are an independent calibrated forecaster in a blinded paired pilot.',
    boundary,
    'Estimate only the probability that the frozen future-cycle outcome will be true.',
    'Do not recommend actions, alter the target cycle, or invent unavailable evidence.',
    'Return only JSON matching the requested schema.',
  ].join(' ');
}

function rolePacket(event, role) {
  const packet = {
    event_id: event.id,
    due: event.due,
    question: event.question,
    outcome_definition: event.outcome_definition,
    natural_cycle_target: event.natural_cycle_target,
    shared_context: event.shared_context,
    shared_evidence: event.shared_evidence,
  };
  if (role === 'yoked_observer') {
    packet.deidentified_state_context = event.deidentified_state_context;
    packet.information_equivalence_evidence = event.information_equivalence_evidence;
  }
  return packet;
}

function forecastRequest(event, { role, model = DEFAULT_MODEL } = {}) {
  if (!ROLES.includes(role)) throw new Error('unsupported natural-cycle evaluator role');
  if (role === 'observer' && (event.private_state_context || event.deidentified_state_context)) {
    throw new Error('shared observer view contains forbidden calibration state');
  }
  if (role === 'yoked_observer' && (event.private_state_context || !event.deidentified_state_context)) {
    throw new Error('yoked observer view violates the deidentified information boundary');
  }
  const packet = rolePacket(event, role);
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    role,
    model,
    max_tokens: 240,
    system_prompt_commitment: commitment(systemPrompt(role)),
    output_schema_commitment: commitment(forecastSchema()),
    packet_commitment: commitment(packet),
  };
  manifest.prompt_protocol_commitment = commitment(manifest);
  return {
    manifest,
    packet,
    request: {
      model,
      max_tokens: manifest.max_tokens,
      temperature: 0,
      system: systemPrompt(role),
      messages: [{ role: 'user', content: `Forecast this frozen event.\n${JSON.stringify(packet)}` }],
      output_config: { format: { type: 'json_schema', schema: anthropicCompatibleSchema(forecastSchema()) } },
    },
  };
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  try { return JSON.parse(value); } catch { /* extract the single object below */ }
  const start = value.indexOf('{'); const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error('forecaster response did not contain a JSON object');
}

function responseText(response = {}) {
  return (Array.isArray(response.content) ? response.content : [])
    .filter(item => item?.type === 'text').map(item => item.text).join('\n').trim();
}

function forecastSubmission(event, response, { role, model = DEFAULT_MODEL } = {}) {
  const built = forecastRequest(event, { role, model });
  const parsed = parseJsonObject(responseText(response));
  const probability = Number(parsed.probability);
  const rationale = String(parsed.rationale || '').trim().slice(0, 800);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !rationale) {
    throw new Error('forecaster response requires a probability from 0 to 1 and a rationale');
  }
  const responseId = String(response.id || '').slice(0, 240);
  const responseModel = String(response.model || '').slice(0, 160);
  if (!responseId || responseModel !== model || !['end_turn', 'stop_sequence'].includes(response.stop_reason)) {
    throw new Error('forecaster provider receipt is incomplete or uses the wrong model');
  }
  const output = { probability, rationale };
  return {
    probability,
    rationale,
    evidence: [{
      type: 'blinded_model_prediction', id: responseId,
      model: responseModel, evaluator_id: EVALUATOR_IDS[role], role,
      protocol_version: PROTOCOL_VERSION,
      prompt_protocol_commitment: built.manifest.prompt_protocol_commitment,
      packet_commitment: built.manifest.packet_commitment,
      output_commitment: commitment(output),
      input_tokens: Number(response.usage?.input_tokens) || 0,
      output_tokens: Number(response.usage?.output_tokens) || 0,
    }],
  };
}

function activeNaturalStudy(snapshot) {
  return (snapshot?.studies || []).find(study => study.status === 'active'
    && study.target_construct === 'natural_cycle_integrated_success') || null;
}

function activeEvent(study) {
  return study?.events?.find(event => event.id === study.active_event_id)
    || study?.events?.find(event => ['predicting', 'awaiting_resolution'].includes(event.status)) || null;
}

function status(store, runtime = {}) {
  const snapshot = store.selfPredictionStudiesSnapshot({ role: 'observer' });
  const study = activeNaturalStudy(snapshot);
  const event = activeEvent(study);
  return {
    protocol_version: PROTOCOL_VERSION,
    enabled: runtime.enabled === true,
    mode: 'pilot_external_roles_and_replay_resolver_only',
    evaluator_model: DEFAULT_MODEL,
    evaluator_model_frozen: true,
    scientific_boundary: 'The coordinator cannot submit Nora\'s forecast, create or alter a source cycle, or satisfy evaluator-disjoint confirmation.',
    active_pilot: study ? {
      status: study.status,
      phase: study.study_phase,
      target_construct: study.target_construct,
      resolved_events: Number(study.report?.resolved) || 0,
      event_target: Number(study.report?.target) || 0,
      active_event: event ? {
        status: event.status,
        self_prediction_submitted: event.self_prediction_submitted === true,
        observer_prediction_submitted: event.observer_prediction_submitted === true,
        yoked_prediction_submitted: event.yoked_prediction_submitted === true,
      } : null,
    } : null,
    last_cycle: runtime.lastCycle || null,
  };
}

async function runCycle({ store, enabled = true, model = DEFAULT_MODEL,
  maxProviderCalls = DEFAULT_MAX_PROVIDER_CALLS, callProvider } = {}) {
  if (!store) throw new Error('natural-cycle prediction autopilot requires an intelligence store');
  const result = {
    protocol_version: PROTOCOL_VERSION,
    state: enabled ? 'idle' : 'disabled',
    provider_calls: 0,
    predictions_committed: [],
    resolution: null,
    failures: [],
  };
  if (!enabled) return result;
  const observerSnapshot = store.selfPredictionStudiesSnapshot({ role: 'observer' });
  const yokedSnapshot = store.selfPredictionStudiesSnapshot({ role: 'yoked_observer' });
  const observerStudy = activeNaturalStudy(observerSnapshot);
  const yokedStudy = activeNaturalStudy(yokedSnapshot);
  if (!observerStudy || !yokedStudy) return { ...result, state: 'no_active_natural_cycle_pilot' };
  if (observerStudy.id !== yokedStudy.id) throw new Error('role-isolated natural-cycle study views disagree');
  if (observerStudy.study_phase !== 'pilot') {
    return { ...result, state: 'independent_confirmation_required' };
  }
  const views = { observer: activeEvent(observerStudy), yoked_observer: activeEvent(yokedStudy) };
  if (!views.observer || !views.yoked_observer || views.observer.id !== views.yoked_observer.id) {
    throw new Error('role-isolated natural-cycle event views disagree');
  }
  const budget = Math.max(0, Math.min(2, Number(maxProviderCalls) || 0));
  for (const role of ROLES) {
    const field = role === 'observer' ? 'observer_prediction_submitted' : 'yoked_prediction_submitted';
    if (views[role][field] === true) continue;
    if (result.provider_calls >= budget) break;
    if (typeof callProvider !== 'function') throw new Error('natural-cycle prediction autopilot requires a forecaster provider');
    try {
      const built = forecastRequest(views[role], { role, model });
      const response = await callProvider(built.request, {
        role, evaluatorId: EVALUATOR_IDS[role],
        promptProtocolCommitment: built.manifest.prompt_protocol_commitment,
      });
      result.provider_calls += 1;
      const submission = forecastSubmission(views[role], response, { role, model });
      if (role === 'observer') {
        store.submitObserverPrediction(observerStudy.id, views[role].id, submission, EVALUATOR_IDS[role]);
      } else {
        store.submitYokedObserverPrediction(observerStudy.id, views[role].id, submission, EVALUATOR_IDS[role]);
      }
      result.predictions_committed.push(role);
    } catch (error) {
      result.failures.push({ role, reason: String(error.message || error).slice(0, 240) });
    }
  }
  const refreshed = activeNaturalStudy(store.selfPredictionStudiesSnapshot({ role: 'observer' }));
  const event = activeEvent(refreshed);
  if (event?.self_prediction_submitted && event.observer_prediction_submitted
    && event.yoked_prediction_submitted) {
    try {
      const resolved = store.resolveSelfPredictionEvent(refreshed.id, event.id, {});
      result.resolution = { event_id: event.id, outcome_source: resolved?.resolution?.outcome_source || null };
      result.state = 'event_resolved';
    } catch (error) {
      if (/wait for the first qualifying post-prediction replay-verified natural cycle/.test(error.message)) {
        result.state = 'awaiting_natural_cycle';
      } else {
        result.failures.push({ role: 'resolver', reason: String(error.message || error).slice(0, 240) });
        result.state = 'resolution_failed';
      }
    }
  } else if (event?.self_prediction_submitted) result.state = 'awaiting_external_predictions';
  else result.state = 'awaiting_subject_prediction';
  return result;
}

module.exports = {
  PROTOCOL_VERSION, DEFAULT_MODEL, DEFAULT_MAX_PROVIDER_CALLS, ROLES, EVALUATOR_IDS,
  commitment, forecastSchema, systemPrompt, rolePacket, forecastRequest, forecastSubmission,
  activeNaturalStudy, activeEvent, status, runCycle,
};
