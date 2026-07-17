'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const POSITIVE_OUTCOMES = new Set(['landed', 'appreciated']);
const OBSERVED_OUTCOMES = new Set(['landed', 'appreciated', 'corrected', 'neutral', 'ignored']);

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalSlackRef(interaction = {}) {
  const channel = String(interaction.channel || '').replace(/^slack:/i, '');
  const messageTs = String(interaction.ts || '');
  const threadTs = String(interaction.thread_ts || messageTs);
  if (!/^[CDG][A-Z0-9]{8,}$/.test(channel)
    || !/^\d{10,}\.\d{6}$/.test(threadTs) || !/^\d{10,}\.\d{6}$/.test(messageTs)) return null;
  if (BigInt(messageTs.replace('.', '')) < BigInt(threadTs.replace('.', ''))) return null;
  return { type: 'slack_message', id: `${channel}:${threadTs}:${messageTs}` };
}

function normalizeViewpoints(viewpoints = []) {
  if (!Array.isArray(viewpoints) || viewpoints.length < 1 || viewpoints.length > 3) {
    throw new Error('professional viewpoint access requires one to three exact prompt viewpoints');
  }
  const normalized = viewpoints.map(clone).sort((left, right) =>
    String(left.viewpoint_id).localeCompare(String(right.viewpoint_id)));
  const ids = normalized.map(item => String(item.viewpoint_id || ''));
  if (new Set(ids).size !== ids.length || normalized.some(item => !item.viewpoint_id
    || !/^[a-f0-9]{64}$/.test(String(item.source_commitment || ''))
    || !/^[a-f0-9]{64}$/.test(String(item.current_position_commitment || ''))
    || !item.statement || !item.rationale || !item.source_family
    || typeof item.source_family_provenance_verified !== 'boolean')) {
    throw new Error('professional viewpoint access packet is incomplete or duplicated');
  }
  return normalized;
}

function createApplication({ interaction = {}, promptViewpoints = [], activeContextTrialIds = [] } = {}) {
  const evidenceRef = canonicalSlackRef(interaction);
  if (!interaction.id || !interaction.trigger || !interaction.text || !evidenceRef) {
    throw new Error('professional viewpoint access requires a canonical delivered Slack interaction');
  }
  const viewpoints = normalizeViewpoints(promptViewpoints);
  const trialIds = [...new Set((Array.isArray(activeContextTrialIds) ? activeContextTrialIds : [])
    .map(String).filter(Boolean))].sort().slice(0, 20);
  const provenanceVerified = viewpoints.every(item => item.source_family_provenance_verified === true);
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    id: `professional-viewpoint-access:${String(interaction.id).slice(0, 180)}`,
    interaction_id: String(interaction.id).slice(0, 180),
    delivered_at: String(interaction.created || '').slice(0, 40) || null,
    evidence_ref: evidenceRef,
    request_commitment: commitment(String(interaction.trigger)),
    response_commitment: commitment(String(interaction.text)),
    prompt_viewpoints: viewpoints,
    prompt_packet_commitment: commitment(viewpoints),
    active_context_trial_ids: trialIds,
    experimental_context_active: trialIds.length > 0,
    source_provenance_verified: provenanceVerified,
    observational_outcome_eligible: trialIds.length === 0 && provenanceVerified,
    access_claim: 'viewpoint_was_available_in_prompt_not_proven_used',
  };
  return { ...manifest, content_commitment: commitment(manifest), resolution: null };
}

function applicationManifest(record) {
  const value = clone(record); delete value.content_commitment; delete value.resolution; delete value.audit;
  return value;
}

function verifyApplication(record) {
  if (!record?.id || Number(record.protocol_version) !== PROTOCOL_VERSION
    || commitment(applicationManifest(record)) !== record.content_commitment) return false;
  try {
    const viewpoints = normalizeViewpoints(record.prompt_viewpoints);
    const trialIds = [...new Set((Array.isArray(record.active_context_trial_ids)
      ? record.active_context_trial_ids : []).map(String).filter(Boolean))].sort().slice(0, 20);
    return canonicalJson(viewpoints) === canonicalJson(record.prompt_viewpoints)
      && record.prompt_packet_commitment === commitment(viewpoints)
      && canonicalJson(trialIds) === canonicalJson(record.active_context_trial_ids)
      && record.experimental_context_active === (trialIds.length > 0)
      && record.source_provenance_verified === viewpoints.every(item => item.source_family_provenance_verified === true)
      && record.observational_outcome_eligible === (!record.experimental_context_active
        && record.source_provenance_verified)
      && record.evidence_ref?.type === 'slack_message'
      && /^[CDG][A-Z0-9]{8,}:\d{10,}\.\d{6}:\d{10,}\.\d{6}$/.test(
        String(record.evidence_ref?.id || ''))
      && /^[a-f0-9]{64}$/.test(String(record.request_commitment || ''))
      && /^[a-f0-9]{64}$/.test(String(record.response_commitment || ''))
      && record.access_claim === 'viewpoint_was_available_in_prompt_not_proven_used';
  } catch { return false; }
}

function outcomeResolution(interaction = {}, application = {}) {
  const outcome = String(interaction.outcome || '').toLowerCase();
  if (!verifyApplication(application) || interaction.reviewed !== true
    || String(interaction.id) !== application.interaction_id || !interaction.reviewed_at
    || !OBSERVED_OUTCOMES.has(outcome)) {
    throw new Error('professional viewpoint access outcome requires a reviewed matching interaction');
  }
  const eligible = application.observational_outcome_eligible === true;
  const scored = eligible && (POSITIVE_OUTCOMES.has(outcome) || outcome === 'corrected');
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    interaction_id: application.interaction_id,
    application_content_commitment: application.content_commitment,
    prompt_packet_commitment: application.prompt_packet_commitment,
    viewpoint_ids: application.prompt_viewpoints.map(item => item.viewpoint_id),
    outcome,
    eligible,
    scored,
    success: scored ? POSITIVE_OUTCOMES.has(outcome) : null,
    signal_commitment: commitment(String(interaction.signal || '')),
    reviewed_at: String(interaction.reviewed_at).slice(0, 40),
    source_quality: 'authenticated_subject_adjacent_slack_review',
  };
  return { ...manifest, resolution_commitment: commitment(manifest) };
}

function verifyResolution(resolution, application) {
  if (!resolution || !verifyApplication(application)) return false;
  const manifest = clone(resolution); delete manifest.resolution_commitment;
  const eligible = application.observational_outcome_eligible === true;
  const scored = eligible && (POSITIVE_OUTCOMES.has(resolution.outcome)
    || resolution.outcome === 'corrected');
  return commitment(manifest) === resolution.resolution_commitment
    && resolution.application_content_commitment === application.content_commitment
    && resolution.prompt_packet_commitment === application.prompt_packet_commitment
    && resolution.interaction_id === application.interaction_id
    && canonicalJson(resolution.viewpoint_ids)
      === canonicalJson(application.prompt_viewpoints.map(item => item.viewpoint_id))
    && OBSERVED_OUTCOMES.has(resolution.outcome)
    && resolution.eligible === eligible
    && resolution.scored === scored
    && resolution.success === (scored ? POSITIVE_OUTCOMES.has(resolution.outcome) : null)
    && /^[a-f0-9]{64}$/.test(String(resolution.signal_commitment || ''))
    && resolution.source_quality === 'authenticated_subject_adjacent_slack_review';
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = successes / total; const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function outcomeProjection(applications = []) {
  const verified = applications.filter(application => verifyApplication(application)
    && (!application.resolution || verifyResolution(application.resolution, application)));
  const scored = verified.filter(application => application.resolution?.scored === true);
  const successes = scored.filter(application => application.resolution.success === true).length;
  const viewpoints = [...new Set(verified.flatMap(application =>
    application.prompt_viewpoints.map(item => item.viewpoint_id)))].sort();
  return {
    protocol_version: PROTOCOL_VERSION,
    evidence_status: 'observational_prompt_access_not_use_or_causal_effect',
    replay_verified_applications: verified.length,
    experimental_context_applications: verified.filter(item => item.experimental_context_active).length,
    provenance_ineligible_applications: verified.filter(item => !item.source_provenance_verified).length,
    eligible_applications: verified.filter(item => item.observational_outcome_eligible).length,
    resolved_applications: verified.filter(item => item.resolution).length,
    scored_outcomes: scored.length,
    successes,
    corrections: scored.length - successes,
    observed_success_rate: scored.length ? successes / scored.length : null,
    success_interval_95: wilson(successes, scored.length),
    represented_viewpoint_ids: viewpoints,
  };
}

module.exports = {
  PROTOCOL_VERSION, POSITIVE_OUTCOMES, OBSERVED_OUTCOMES, canonicalJson, commitment,
  canonicalSlackRef, normalizeViewpoints, createApplication, applicationManifest,
  verifyApplication, outcomeResolution, verifyResolution, wilson, outcomeProjection,
};
