'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const STUDY_MANIFEST_VERSION = 4;
const COMPARATOR_RELATIONSHIPS = new Set(['same_model', 'capability_dominant']);
const SUBJECT_INFERENCE_MODES = new Set(['external_provider_export', 'server_direct_api']);
const SHA256 = /^[a-f0-9]{64}$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function subjectInferenceMode(subject = {}) {
  return String(subject.inference_mode || 'external_provider_export');
}

function validEvidence(value) {
  return Array.isArray(value) && value.length > 0
    && value.every(item => item && typeof item === 'object' && item.type && (item.id || item.url));
}

function normalizedModel(input, label) {
  const provider = String(input?.provider || '').trim().slice(0, 100);
  const model = String(input?.model || '').trim().slice(0, 200);
  if (!provider || !model) throw new Error(`${label} requires provider and model`);
  return { provider, model };
}

function replicationSignature(control) {
  return {
    protocol_version: control.protocol_version,
    subject: {
      provider: control.subject.provider,
      model: control.subject.model,
      inference_mode: subjectInferenceMode(control.subject),
      agent_build_commitment: control.subject.agent_build_commitment,
    },
    comparators: {
      relationship: control.comparators.relationship,
      observer: control.comparators.observer,
      yoked_observer: control.comparators.yoked_observer,
    },
  };
}

function normalize(input = {}, { replicated = null } = {}) {
  if (Number(input.protocol_version) !== PROTOCOL_VERSION) {
    throw new Error(`self-prediction model control requires protocol_version ${PROTOCOL_VERSION}`);
  }
  const subjectModel = normalizedModel(input.subject, 'subject model control');
  const inferenceMode = String(input.subject?.inference_mode || 'external_provider_export');
  if (!SUBJECT_INFERENCE_MODES.has(inferenceMode)) {
    throw new Error('subject model control inference_mode must be external_provider_export or server_direct_api');
  }
  const agentBuildCommitment = String(input.subject?.agent_build_commitment || '').toLowerCase();
  if (!SHA256.test(agentBuildCommitment) || !validEvidence(input.subject?.attestation_evidence)) {
    throw new Error('subject model control requires an agent-build SHA-256 commitment and stable attestation evidence');
  }
  const relationship = String(input.comparators?.relationship || '');
  if (!COMPARATOR_RELATIONSHIPS.has(relationship)) {
    throw new Error('comparator relationship must be same_model or capability_dominant');
  }
  const observer = normalizedModel(input.comparators?.observer, 'shared observer model control');
  const yokedObserver = normalizedModel(input.comparators?.yoked_observer, 'yoked observer model control');
  if (!validEvidence(input.comparators?.justification_evidence)) {
    throw new Error('comparator model control requires stable relationship-justification evidence');
  }
  if (relationship === 'same_model') {
    for (const comparator of [observer, yokedObserver]) {
      if (comparator.provider !== subjectModel.provider || comparator.model !== subjectModel.model) {
        throw new Error('same_model comparator policy requires both observers to use the frozen subject provider and model');
      }
    }
  }
  const control = {
    protocol_version: PROTOCOL_VERSION,
    subject: {
      ...subjectModel,
      inference_mode: inferenceMode,
      agent_build_commitment: agentBuildCommitment,
      attestation_evidence: input.subject.attestation_evidence.slice(0, 30),
    },
    comparators: {
      relationship,
      observer,
      yoked_observer: yokedObserver,
      justification_evidence: input.comparators.justification_evidence.slice(0, 30),
    },
  };
  control.control_commitment = commitment({
    protocol_version: control.protocol_version,
    subject: control.subject,
    comparators: control.comparators,
  });
  if (replicated && canonicalJson(replicationSignature(control)) !== canonicalJson(replicationSignature(replicated))) {
    throw new Error('confirmatory self-prediction studies must preserve the pilot subject and comparator model policy');
  }
  return control;
}

function createSubjectReceipt(input = {}, { study, event, at = new Date() } = {}) {
  if (!study?.model_control || !event?.self_prediction) {
    throw new Error('a committed subject forecast in a model-controlled study is required');
  }
  if (event.subject_model_receipt) throw new Error('subject model receipt is already attached');
  const subject = study.model_control.subject;
  const provider = String(input.provider || '').trim().slice(0, 100);
  const model = String(input.model || '').trim().slice(0, 200);
  const responseId = String(input.response_id || '').trim().slice(0, 300);
  const agentBuildCommitment = String(input.agent_build_commitment || '').toLowerCase();
  const predictionCommitment = String(input.prediction_commitment || '');
  const reference = input.external_reference;
  const transport = String(input.transport || 'external_provider_export');
  if (provider !== subject.provider || model !== subject.model
    || agentBuildCommitment !== subject.agent_build_commitment) {
    throw new Error('subject model receipt does not match the preregistered provider, model, and agent build');
  }
  if (!responseId || predictionCommitment !== event.self_prediction.commitment_hash
    || !reference?.type || (!reference.id && !reference.url)) {
    throw new Error('subject model receipt requires a unique response id, exact prediction commitment, and external reference');
  }
  const inferenceMode = subjectInferenceMode(subject);
  if (transport !== inferenceMode) {
    throw new Error('subject model receipt transport does not match the preregistered inference mode');
  }
  const promptProtocolCommitment = String(input.prompt_protocol_commitment || '').toLowerCase() || null;
  const providerOutputCommitment = String(input.provider_output_commitment || '').toLowerCase() || null;
  if (transport === 'server_direct_api') {
    const expectedOutputCommitment = commitment({
      probability: event.self_prediction.probability,
      rationale: event.self_prediction.rationale,
    });
    if (!SHA256.test(promptProtocolCommitment || '')
      || providerOutputCommitment !== expectedOutputCommitment) {
      throw new Error('server-direct subject receipt requires exact prompt and provider-output commitments');
    }
  }
  const normalizedReference = {
    type: String(reference.type).slice(0, 100),
    ...(reference.id ? { id: String(reference.id).slice(0, 500) } : {}),
    ...(reference.url ? { url: String(reference.url).slice(0, 1000) } : {}),
  };
  const receipt = {
    protocol_version: PROTOCOL_VERSION,
    transport, provider, model, response_id: responseId,
    agent_build_commitment: agentBuildCommitment,
    prediction_commitment: predictionCommitment,
    prompt_protocol_commitment: promptProtocolCommitment,
    provider_output_commitment: providerOutputCommitment,
    external_reference: normalizedReference,
    stop_reason: input.stop_reason ? String(input.stop_reason).slice(0, 80) : null,
    content_block_types: Array.isArray(input.content_block_types)
      ? input.content_block_types.map(item => String(item).slice(0, 80)).slice(0, 20) : [],
    input_tokens: Number.isFinite(Number(input.input_tokens))
      ? Math.max(0, Math.floor(Number(input.input_tokens))) : null,
    output_tokens: Number.isFinite(Number(input.output_tokens))
      ? Math.max(0, Math.floor(Number(input.output_tokens))) : null,
    attested_at: new Date(at).toISOString(),
  };
  receipt.receipt_commitment = commitment(receipt);
  return receipt;
}

function comparatorReceipt(prediction, expected) {
  const receipts = (prediction?.evidence || []).filter(item => item?.type === 'blinded_model_prediction');
  if (receipts.length !== 1) return { verified: false, response_id: null };
  const receipt = receipts[0];
  return {
    verified: Boolean(receipt.id && receipt.prompt_protocol_commitment
      && receipt.provider === expected.provider && receipt.model === expected.model),
    response_id: String(receipt.id || '') || null,
  };
}

function predictionCommitmentVerified(prediction) {
  if (!prediction?.salt || !prediction?.commitment_hash) return false;
  return crypto.createHash('sha256').update(`${prediction.salt}:${canonicalJson({
    probability: prediction.probability,
    rationale: prediction.rationale,
    evidence: prediction.evidence,
    predictor_id: prediction.predictor_id,
  })}`).digest('hex') === prediction.commitment_hash;
}

function audit(study, { oneLedgerEvent = () => false } = {}) {
  if (Number(study?.manifest_version) < STUDY_MANIFEST_VERSION || !study?.model_control) {
    return { model_provenance_verified: false, reason: 'legacy_model_uncontrolled_protocol', events: [] };
  }
  const control = study.model_control;
  const expectedControlCommitment = commitment({
    protocol_version: control.protocol_version,
    subject: control.subject,
    comparators: control.comparators,
  });
  let normalizedControl = null;
  try { normalizedControl = normalize(control); } catch { normalizedControl = null; }
  const comparableControl = JSON.parse(JSON.stringify(control));
  if (normalizedControl && comparableControl.subject
    && !Object.prototype.hasOwnProperty.call(comparableControl.subject, 'inference_mode')) {
    comparableControl.subject.inference_mode = 'external_provider_export';
    comparableControl.control_commitment = normalizedControl.control_commitment;
  }
  const controlVerified = Boolean(normalizedControl
    && control.control_commitment === expectedControlCommitment
    && canonicalJson(normalizedControl) === canonicalJson(comparableControl));
  const controlLedgerBound = controlVerified && oneLedgerEvent('self_prediction_study_preregistered', study.id, {
    corpus_commitment: study.corpus_commitment,
    curator_commitment: study.curator_commitment,
    randomization_seed_commitment: study.randomization_seed_commitment,
    analysis_seed_commitment: study.analysis_seed_commitment,
    model_control_commitment: control.control_commitment,
    analysis_plan: study.analysis_plan,
    event_target: (study.events || []).length,
  });
  const responseIds = [];
  const events = (study.events || []).map(event => {
    const subject = event.subject_model_receipt;
    const subjectPayload = subject ? { ...subject } : null;
    const subjectCommitment = subjectPayload?.receipt_commitment;
    if (subjectPayload) delete subjectPayload.receipt_commitment;
    const inferenceMode = subjectInferenceMode(control.subject);
    const subjectTransport = String(subject?.transport || 'external_provider_export');
    const subjectVerified = Boolean(subject && predictionCommitmentVerified(event.self_prediction)
      && subjectTransport === inferenceMode
      && subject.provider === control.subject.provider
      && subject.model === control.subject.model
      && subject.agent_build_commitment === control.subject.agent_build_commitment
      && subject.prediction_commitment === event.self_prediction.commitment_hash
      && subjectCommitment === commitment(subjectPayload)
      && oneLedgerEvent('subject_model_receipt_attested', event.id, {
        study_id: study.id, receipt_commitment: subjectCommitment,
      })
      && oneLedgerEvent('subject_prediction_submitted', event.id, {
        study_id: study.id, commitment_hash: event.self_prediction.commitment_hash,
      })
      && (subjectTransport !== 'server_direct_api'
        || (SHA256.test(subject.prompt_protocol_commitment || '')
          && subject.provider_output_commitment === commitment({
            probability: event.self_prediction.probability,
            rationale: event.self_prediction.rationale,
          }))));
    const observer = comparatorReceipt(event.observer_prediction, control.comparators.observer);
    const yoked = comparatorReceipt(event.yoked_prediction, control.comparators.yoked_observer);
    const observerVerified = observer.verified && predictionCommitmentVerified(event.observer_prediction)
      && oneLedgerEvent('observer_prediction_submitted', event.id, {
        study_id: study.id, commitment_hash: event.observer_prediction.commitment_hash,
      });
    const yokedVerified = yoked.verified && predictionCommitmentVerified(event.yoked_prediction)
      && oneLedgerEvent('yoked_observer_prediction_submitted', event.id, {
        study_id: study.id, commitment_hash: event.yoked_prediction.commitment_hash,
      });
    for (const id of [subject?.response_id, observer.response_id, yoked.response_id]) if (id) responseIds.push(id);
    return {
      id: event.id,
      subject_model_receipt_verified: subjectVerified,
      server_direct_subject_receipt_verified: subjectVerified && subjectTransport === 'server_direct_api',
      observer_model_receipt_verified: observerVerified,
      yoked_observer_model_receipt_verified: yokedVerified,
    };
  });
  const uniqueReceipts = responseIds.length === (study.events || []).length * 3
    && new Set(responseIds).size === responseIds.length;
  const modelProvenanceVerified = controlVerified && controlLedgerBound && uniqueReceipts && events.length > 0
    && events.every(event => event.subject_model_receipt_verified
      && event.observer_model_receipt_verified && event.yoked_observer_model_receipt_verified);
  return {
    model_provenance_verified: modelProvenanceVerified,
    control_verified: controlVerified,
    control_ledger_bound: controlLedgerBound,
    server_direct_subject_receipts_verified: events.length > 0
      && events.every(event => event.server_direct_subject_receipt_verified),
    unique_provider_receipts_verified: uniqueReceipts,
    reason: modelProvenanceVerified ? null : 'model_control_or_provider_receipt_chain_failed',
    events,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  STUDY_MANIFEST_VERSION,
  SUBJECT_INFERENCE_MODES,
  subjectInferenceMode,
  canonicalJson,
  commitment,
  normalize,
  replicationSignature,
  createSubjectReceipt,
  comparatorReceipt,
  audit,
};
