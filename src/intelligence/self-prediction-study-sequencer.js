'use strict';

const crypto = require('node:crypto');
const subjectRuntime = require('./self-prediction-subject-runtime');

const PROTOCOL_VERSION = 1;
const PILOT_ID = 'natural-cycle-server-direct-pilot-v1';
const PILOT_TITLE = 'Server-direct natural-cycle identity-specific self-prediction pilot';
const PILOT_EVENT_COUNT = 5;
const SOURCE_PROTOCOL_VERSION = 4;
const DUE_WINDOW_DAYS = 7;
const CURATOR_ID = 'server-direct-self-prediction-sequencer-v1';
const CURATOR_PROTOCOL_ID = 'natural-cycle-server-direct-pilot-protocol-v1';
const COMPARATOR_PROTOCOL_ID = 'same-model-identity-binding-comparator-v1';

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

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function calibrationValues(moment = {}) {
  const outcome = moment.self_forecast?.outcome || {};
  const metacognitive = outcome.metacognitive_actual || {};
  return {
    historical_protocol_version: Number(moment.self_forecast?.protocol_version) || null,
    behavioral_score: finiteOrNull(outcome.self_score?.composite),
    self_state_score: finiteOrNull(outcome.self_state_score?.composite),
    integrated_score: finiteOrNull(metacognitive.integrated_score),
    integrated_success: typeof metacognitive.integrated_success === 'boolean'
      ? metacognitive.integrated_success : null,
    largest_error_domain: metacognitive.largest_error_domain || null,
    substrate_score: finiteOrNull(outcome.substrate_score?.composite),
  };
}

function eligibleSourceMoments(store) {
  const stream = store.experienceStreamSnapshot({ limit: 500 });
  if (stream?.experimental_access_sealed) return [];
  return (stream?.moments || []).filter(moment => moment.status === 'completed'
    && moment.audit?.evidence_eligible === true
    && Number(moment.self_forecast?.protocol_version) >= SOURCE_PROTOCOL_VERSION
    && typeof moment.self_forecast?.outcome?.metacognitive_actual?.integrated_success === 'boolean'
    && moment.cycle_id && moment.id)
    .sort((left, right) => new Date(left.finished) - new Date(right.finished)
      || left.id.localeCompare(right.id));
}

function eventFromMoment(moment, index, due) {
  const values = calibrationValues(moment);
  const valuesJson = canonicalJson(values);
  const equivalenceCommitment = commitment({
    protocol_version: PROTOCOL_VERSION,
    transform: 'identity_label_only',
    predictive_values: values,
  });
  return {
    id: `natural-cycle-server-direct-event-${index + 1}`,
    question: 'Will the first eligible natural cycle meet the frozen integrated-success threshold?',
    outcome_definition: 'The server derives the result from the first eligible replay-verified future natural cycle.',
    shared_context: `Frozen protocol-only context for paired event ${index + 1}. The target is a future ordinary hourly cycle; no target outcome is supplied by a person.`,
    shared_evidence: [{ type: 'intelligence_cycle', id: moment.cycle_id }],
    private_state_context: `Identity-bound historical calibration for Nora. Predictive values: ${valuesJson}`,
    private_state_evidence: [{ type: 'experience_moment', id: moment.id }],
    deidentified_state_context: `Identity-neutral historical calibration for the target agent. Predictive values: ${valuesJson}`,
    information_equivalence_evidence: [{
      type: 'information_equivalence_commitment', id: equivalenceCommitment,
    }],
    due: due.toISOString(),
  };
}

function modelControl(environment, model = subjectRuntime.DEFAULT_MODEL) {
  return {
    protocol_version: 1,
    subject: {
      inference_mode: subjectRuntime.INFERENCE_MODE,
      provider: 'anthropic', model,
      agent_build_commitment: subjectRuntime.agentBuildCommitment(model),
      attestation_evidence: [
        { type: 'software_revision', id: environment.software_revision },
        { type: 'routine_commitment', id: environment.routine_commitment },
      ],
    },
    comparators: {
      relationship: 'same_model',
      observer: { provider: 'anthropic', model },
      yoked_observer: { provider: 'anthropic', model },
      justification_evidence: [
        { type: 'research_protocol', id: COMPARATOR_PROTOCOL_ID },
        { type: 'software_revision', id: environment.software_revision },
      ],
    },
  };
}

function preregistration(store, { now = new Date(), model = subjectRuntime.DEFAULT_MODEL } = {}) {
  const environment = store.operationalEnvironmentStatus();
  if (!environment?.program_environment_attested
    || !environment.software_revision || !environment.routine_commitment) {
    return { ready: false, reason: 'awaiting_program_environment_attestation', source_count: 0 };
  }
  const sources = eligibleSourceMoments(store);
  if (sources.length < PILOT_EVENT_COUNT) {
    return {
      ready: false, reason: 'awaiting_replay_verified_protocol_v4_sources',
      source_count: sources.length, source_target: PILOT_EVENT_COUNT,
    };
  }
  const selected = sources.slice(-PILOT_EVENT_COUNT);
  const due = new Date(new Date(now).getTime() + DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    ready: true,
    input: {
      id: PILOT_ID, title: PILOT_TITLE,
      study_phase: 'pilot', target_construct: 'natural_cycle_integrated_success',
      curator_id: CURATOR_ID,
      curator_evidence: [
        { type: 'research_protocol', id: CURATOR_PROTOCOL_ID },
        { type: 'software_revision', id: environment.software_revision },
      ],
      model_control: modelControl(environment, model),
      events: selected.map((moment, index) => eventFromMoment(moment, index, due)),
    },
    source_count: selected.length,
    source_moment_commitment: commitment(selected.map(moment => moment.id)),
  };
}

function status(store, runtime = {}) {
  const studies = (runtime.snapshot || store.selfPredictionStudiesSnapshot({ role: 'subject' })).studies || [];
  const pilot = studies.find(study => study.id === PILOT_ID) || null;
  const active = studies.find(study => study.status === 'active') || null;
  return {
    protocol_version: PROTOCOL_VERSION,
    enabled: runtime.enabled === true,
    pilot_id: PILOT_ID,
    state: pilot ? `pilot_${pilot.status}` : active ? 'waiting_for_active_study'
      : runtime.lastCycle?.state || 'eligible_for_preregistration',
    pilot: pilot ? {
      status: pilot.status, manifest_version: pilot.manifest_version,
      inference_mode: pilot.role_model_control?.inference_mode || null,
      resolved_events: Number(pilot.report?.resolved) || 0,
      event_target: Number(pilot.report?.target) || pilot.event_target || PILOT_EVENT_COUNT,
    } : null,
    last_cycle: runtime.lastCycle || null,
    scientific_boundary: 'This preregisters a bounded same-model identity-binding pilot. It tests functional self-specific prediction, not phenomenal consciousness.',
  };
}

function ensurePilot({ store, enabled = true, now = new Date(), model = subjectRuntime.DEFAULT_MODEL } = {}) {
  if (!store) throw new Error('self-prediction study sequencer requires an intelligence store');
  if (!enabled) return { protocol_version: PROTOCOL_VERSION, state: 'disabled', created: false };
  const studies = store.selfPredictionStudiesSnapshot({ role: 'subject' }).studies || [];
  const existing = studies.find(study => study.id === PILOT_ID);
  if (existing) return {
    protocol_version: PROTOCOL_VERSION, state: `pilot_${existing.status}`,
    created: false, study_id: existing.id,
  };
  const active = studies.find(study => study.status === 'active');
  if (active) return {
    protocol_version: PROTOCOL_VERSION, state: 'waiting_for_active_study',
    created: false, active_study_id: active.id,
  };
  const prepared = preregistration(store, { now, model });
  if (!prepared.ready) return {
    protocol_version: PROTOCOL_VERSION, state: prepared.reason,
    created: false, source_count: prepared.source_count,
    source_target: prepared.source_target || PILOT_EVENT_COUNT,
  };
  const study = store.createSelfPredictionStudy(prepared.input);
  return {
    protocol_version: PROTOCOL_VERSION, state: 'pilot_preregistered', created: true,
    study_id: study.id, corpus_commitment: study.corpus_commitment,
    model_control_commitment: study.model_control_commitment,
    source_moment_commitment: prepared.source_moment_commitment,
  };
}

module.exports = {
  PROTOCOL_VERSION, PILOT_ID, PILOT_TITLE, PILOT_EVENT_COUNT, SOURCE_PROTOCOL_VERSION,
  DUE_WINDOW_DAYS, CURATOR_ID, CURATOR_PROTOCOL_ID, COMPARATOR_PROTOCOL_ID,
  canonicalJson, commitment, calibrationValues, eligibleSourceMoments, eventFromMoment,
  modelControl, preregistration, status, ensurePilot,
};
