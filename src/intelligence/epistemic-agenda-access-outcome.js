'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const POSITIVE_OUTCOMES = new Set(['landed', 'appreciated']);
const OBSERVED_OUTCOMES = new Set(['landed', 'appreciated', 'corrected', 'neutral', 'ignored']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function canonicalSlackRef(interaction = {}) {
  const channel = String(interaction.channel || '').replace(/^slack:/i, '');
  const messageTs = String(interaction.ts || '');
  const threadTs = String(interaction.thread_ts || messageTs);
  if (!/^[CDG][A-Z0-9]{8,}$/.test(channel)
    || !/^\d{10,}\.\d{6}$/.test(threadTs) || !/^\d{10,}\.\d{6}$/.test(messageTs)) return null;
  if (BigInt(messageTs.replace('.', '')) < BigInt(threadTs.replace('.', ''))) return null;
  return { type: 'slack_message', id: `${channel}:${threadTs}:${messageTs}` };
}

function normalizePacket(packet = {}) {
  const value = clone(packet);
  const requiredText = ['id', 'topic_key', 'question', 'current_best_answer', 'next_evidence'];
  if (requiredText.some(key => !String(value[key] || '').trim())
    || value.status !== 'open'
    || !Number.isFinite(Number(value.confidence))
    || !Number.isFinite(Number(value.interest_score))
    || !Number.isInteger(Number(value.evidence_count)) || value.evidence_count < 2
    || !/^[a-f0-9]{64}$/.test(String(value.question_commitment || ''))
    || !Array.isArray(value.matched_terms) || value.matched_terms.length < 1
    || value.matched_terms.length > 8 || value.matched_terms.some(term => !/^[a-z0-9-]{3,40}$/.test(term))
    || !Number.isFinite(Number(value.relevance_score)) || value.relevance_score < 1) {
    throw new Error('epistemic agenda prompt packet is incomplete');
  }
  value.confidence = Number(value.confidence);
  value.interest_score = Number(value.interest_score);
  value.evidence_count = Number(value.evidence_count);
  value.relevance_score = Number(value.relevance_score);
  value.matched_terms = [...new Set(value.matched_terms.map(String))].sort();
  return value;
}

function createApplication({ interaction = {}, promptPacket = null, experimentalContextRefs = [] } = {}) {
  const evidenceRef = canonicalSlackRef(interaction);
  if (!interaction.id || !interaction.trigger || !interaction.text || !evidenceRef) {
    throw new Error('epistemic agenda access requires a canonical delivered Slack interaction');
  }
  const packet = normalizePacket(promptPacket);
  const contextRefs = [...new Set((experimentalContextRefs || []).map(String).filter(Boolean))].sort().slice(0, 20);
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    id: `epistemic-agenda-access:${String(interaction.id).slice(0, 180)}`,
    interaction_id: String(interaction.id).slice(0, 180),
    delivered_at: String(interaction.created || '').slice(0, 40) || null,
    evidence_ref: evidenceRef,
    request_commitment: commitment(String(interaction.trigger)),
    response_commitment: commitment(String(interaction.text)),
    prompt_packet: packet,
    prompt_packet_commitment: commitment(packet),
    experimental_context_refs: contextRefs,
    experimental_context_active: contextRefs.length > 0,
    observational_outcome_eligible: contextRefs.length === 0,
    access_claim: 'question_was_available_in_prompt_not_proven_used',
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
    const packet = normalizePacket(record.prompt_packet);
    const contextRefs = [...new Set((record.experimental_context_refs || []).map(String).filter(Boolean))]
      .sort().slice(0, 20);
    return canonicalJson(packet) === canonicalJson(record.prompt_packet)
      && record.prompt_packet_commitment === commitment(packet)
      && canonicalJson(contextRefs) === canonicalJson(record.experimental_context_refs)
      && record.experimental_context_active === (contextRefs.length > 0)
      && record.observational_outcome_eligible === !record.experimental_context_active
      && record.evidence_ref?.type === 'slack_message'
      && /^[CDG][A-Z0-9]{8,}:\d{10,}\.\d{6}:\d{10,}\.\d{6}$/.test(String(record.evidence_ref.id || ''))
      && /^[a-f0-9]{64}$/.test(String(record.request_commitment || ''))
      && /^[a-f0-9]{64}$/.test(String(record.response_commitment || ''))
      && record.access_claim === 'question_was_available_in_prompt_not_proven_used';
  } catch { return false; }
}

function outcomeResolution(interaction = {}, application = {}) {
  const outcome = String(interaction.outcome || '').toLowerCase();
  if (!verifyApplication(application) || interaction.reviewed !== true
    || String(interaction.id) !== application.interaction_id || !interaction.reviewed_at
    || !OBSERVED_OUTCOMES.has(outcome)) {
    throw new Error('epistemic agenda access outcome requires a reviewed matching interaction');
  }
  const eligible = application.observational_outcome_eligible === true;
  const scored = eligible && (POSITIVE_OUTCOMES.has(outcome) || outcome === 'corrected');
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    interaction_id: application.interaction_id,
    application_content_commitment: application.content_commitment,
    prompt_packet_commitment: application.prompt_packet_commitment,
    question_id: application.prompt_packet.id,
    outcome, eligible, scored,
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
    && resolution.question_id === application.prompt_packet.id
    && resolution.interaction_id === application.interaction_id
    && OBSERVED_OUTCOMES.has(resolution.outcome)
    && resolution.eligible === eligible && resolution.scored === scored
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
  const verified = applications.filter(item => verifyApplication(item)
    && (!item.resolution || verifyResolution(item.resolution, item)));
  const scored = verified.filter(item => item.resolution?.scored === true);
  const successes = scored.filter(item => item.resolution.success === true).length;
  return {
    protocol_version: PROTOCOL_VERSION,
    evidence_status: 'observational_prompt_access_not_use_or_causal_effect',
    replay_verified_applications: verified.length,
    eligible_applications: verified.filter(item => item.observational_outcome_eligible).length,
    experimental_context_applications: verified.filter(item => item.experimental_context_active).length,
    resolved_applications: verified.filter(item => item.resolution).length,
    scored_outcomes: scored.length, successes, corrections: scored.length - successes,
    observed_success_rate: scored.length ? successes / scored.length : null,
    success_interval_95: wilson(successes, scored.length),
    represented_question_ids: [...new Set(verified.map(item => item.prompt_packet.id))].sort(),
  };
}

module.exports = { PROTOCOL_VERSION, POSITIVE_OUTCOMES, OBSERVED_OUTCOMES, canonicalJson,
  commitment, clone, canonicalSlackRef, normalizePacket, createApplication, applicationManifest,
  verifyApplication, outcomeResolution, verifyResolution, wilson, outcomeProjection };
