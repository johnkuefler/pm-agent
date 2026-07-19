'use strict';

const crypto = require('node:crypto');
const interactionOutcomeReview = require('./interaction-outcome-review-autopilot');

const PROTOCOL_VERSION = 1;
const POSITIVE_OUTCOMES = new Set(['landed', 'appreciated']);
const OBSERVED_OUTCOMES = new Set(['landed', 'appreciated', 'corrected', 'neutral', 'ignored']);
const MIN_DIRECTIONAL_SAMPLES = 8;
const MIN_RELIABLE_SAMPLES = 20;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function classifyTask(text, executedToolNames = []) {
  const value = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  const tools = Array.isArray(executedToolNames) ? executedToolNames.map(String) : [];
  if (tools.length || /\b(?:create|add|update|change|move|mark|complete|reopen)\b.{0,45}\b(?:task|milestone|project|comment|stage)\b|\b(?:send|post|dm)\b.{0,45}\b(?:message|note|update|slack)\b|\bjoin\b.{0,30}\b(?:meeting|zoom|call)\b|\bupload\b/.test(value)) return 'action_execution';
  if (/\b(?:analy[sz]e|analysis|strategy|strategic|plan|planning|tradeoffs?|recommend|prioriti[sz]e|risk|root cause|compare|decision)\b/.test(value)) return 'planning_analysis';
  if (/\b(?:draft|write|rewrite|edit|summari[sz]e|review|outline|compose|proofread)\b/.test(value)) return 'writing_synthesis';
  if (/\b(?:status|due|overdue|deadline|timeline|milestone|task|project|owner|assigned|capacity|booked|bandwidth|workload)\b/.test(value)) return 'project_status_retrieval';
  if (/\b(?:meeting|call|transcript)\b.*\b(?:discuss|said|decid|cover|remember|notes?)\b|\bwhat did we (?:discuss|say|decide)\b/.test(value)) return 'meeting_memory_retrieval';
  if (/\b(?:search|look up|lookup|research|latest|current|find online|on the web)\b/.test(value)) return 'external_research';
  if (value.length <= 140 && /^(?:hey|hi|hello|thanks|thank you|ty|nice|great|cool|okay|ok|yep|yeah|good (?:morning|night)|whats up|hows it going)\b/.test(value)) return 'social_interaction';
  return 'general_coordination';
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

function recordFromInteraction(interaction = {}) {
  const outcome = String(interaction.outcome || '').toLowerCase();
  const evidenceRef = canonicalSlackRef(interaction);
  if (interaction.reviewed !== true || !interaction.id || !interaction.trigger || !interaction.text
    || !interaction.reviewed_at || !OBSERVED_OUTCOMES.has(outcome) || !evidenceRef) return null;
  const automatedReceipt = interaction.automated_review_receipt || null;
  if (automatedReceipt
    && !interactionOutcomeReview.verifyAutomatedReviewReceipt(interaction, automatedReceipt)) return null;
  const providerReadbackReceipt = automatedReceipt?.packet?.provider_readback_receipt || null;
  const providerReadbackVerified = Boolean(providerReadbackReceipt
    && interactionOutcomeReview.verifySlackLandingReadbackReceipt(providerReadbackReceipt,
      interaction, automatedReceipt.packet.landing));
  const taskFamily = classifyTask(interaction.trigger, interaction.executed_tool_names);
  const scored = POSITIVE_OUTCOMES.has(outcome) || outcome === 'corrected';
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    id: `capability-outcome:${String(interaction.id).slice(0, 180)}`,
    interaction_id: String(interaction.id).slice(0, 180),
    task_family: taskFamily,
    task_commitment: commitment(String(interaction.trigger)),
    response_commitment: commitment(String(interaction.text)),
    outcome,
    scored,
    success: scored ? POSITIVE_OUTCOMES.has(outcome) : null,
    signal_commitment: commitment(String(interaction.signal || '')),
    evidence_ref: evidenceRef,
    requester_commitment: commitment(String(interaction.user || interaction.requester_name || 'unknown')),
    channel_commitment: commitment(evidenceRef.id.split(':')[0]),
    delivered_at: String(interaction.created || '').slice(0, 40) || null,
    reviewed_at: String(interaction.reviewed_at).slice(0, 40),
    source_quality: providerReadbackVerified
      ? 'provider_disjoint_review_with_slack_api_readback'
      : automatedReceipt ? 'provider_disjoint_authenticated_slack_review'
      : 'authenticated_subject_adjacent_slack_review',
    review_receipt_commitment: automatedReceipt?.receipt_commitment || null,
    ...(providerReadbackReceipt ? {
      provider_readback_verified: providerReadbackVerified,
      provider_readback_receipt_commitment: providerReadbackReceipt.receipt_commitment || null,
    } : {}),
  };
  return { ...manifest, content_commitment: commitment(manifest) };
}

function verifyRecord(record) {
  if (!record?.id || record.protocol_version !== PROTOCOL_VERSION || !record.content_commitment) return false;
  const manifest = JSON.parse(JSON.stringify(record));
  delete manifest.content_commitment; delete manifest.audit;
  return commitment(manifest) === record.content_commitment;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function familyProjection(records, family) {
  const familyRecords = records.filter(record => record.task_family === family && record.scored);
  const successes = familyRecords.filter(record => record.success === true).length;
  const corrections = familyRecords.length - successes;
  const interval = wilson(successes, familyRecords.length);
  const requesters = new Set(familyRecords.map(record => record.requester_commitment)).size;
  const channels = new Set(familyRecords.map(record => record.channel_commitment)).size;
  const days = new Set(familyRecords.map(record => String(record.reviewed_at).slice(0, 10))).size;
  let status = 'collecting';
  if (familyRecords.length >= MIN_DIRECTIONAL_SAMPLES && requesters >= 2 && days >= 2) {
    if (corrections / familyRecords.length >= 0.2 || interval.upper < 0.8) status = 'verification_required';
    else if (familyRecords.length >= MIN_RELIABLE_SAMPLES && requesters >= 3 && days >= 3
      && interval.lower >= 0.65) status = 'provisionally_reliable';
    else status = 'mixed_uncertain';
  }
  return {
    family, status, scored_samples: familyRecords.length, successes, corrections,
    observed_success_rate: familyRecords.length ? successes / familyRecords.length : null,
    success_interval_95: interval, distinct_requesters: requesters,
    distinct_channels: channels, distinct_review_days: days,
    recommendation: status === 'provisionally_reliable' ? 'act_within_scope'
      : status === 'verification_required' ? 'verify_or_ask'
        : 'verify_before_commitment',
  };
}

function projection(records = []) {
  const verified = records.filter(verifyRecord);
  const providerReadbackAuthenticated = verified
    .filter(record => record.provider_readback_verified === true
      && /^[a-f0-9]{64}$/.test(String(record.provider_readback_receipt_commitment || ''))).length;
  const families = [...new Set(verified.map(record => record.task_family))].sort();
  const byFamily = Object.fromEntries(families.map(family => [family, familyProjection(verified, family)]));
  return {
    protocol_version: PROTOCOL_VERSION,
    evidence_status: providerReadbackAuthenticated
      ? 'observational_provider_readback_authenticated' : 'observational_subject_adjacent',
    causal_status: 'not_causally_tested',
    replay_verified_records: verified.length,
    provider_readback_authenticated_records: providerReadbackAuthenticated,
    scored_records: verified.filter(record => record.scored).length,
    families: byFamily,
  };
}

function requiredCapabilityKeys(taskFamily, query) {
  const text = String(query || '').toLowerCase();
  if (taskFamily === 'project_status_retrieval') return ['teamwork_read'];
  if (taskFamily === 'meeting_memory_retrieval') return ['meeting_records'];
  if (taskFamily === 'external_research') return ['web_search'];
  if (taskFamily !== 'action_execution') return [];
  if (/\bjoin\b.{0,30}\b(?:meeting|zoom|call)\b/.test(text)) return ['join_meeting'];
  if (/\b(?:send|post|dm)\b/.test(text)) return ['slack_send'];
  return ['teamwork_write'];
}

function align(query, affordanceFrame, learnedProjection) {
  const taskFamily = classifyTask(query);
  const family = learnedProjection?.families?.[taskFamily] || familyProjection([], taskFamily);
  const required = requiredCapabilityKeys(taskFamily, query);
  const capabilityEvidenceAvailable = Array.isArray(affordanceFrame?.capabilities);
  const capabilities = capabilityEvidenceAvailable ? affordanceFrame.capabilities : [];
  const missing = capabilityEvidenceAvailable ? required.filter(key => !capabilities.some(item => item.key === key
    && ['available', 'conditional'].includes(item.availability))) : [];
  const unverified = capabilityEvidenceAvailable ? [] : required;
  const recommendation = missing.length ? 'state_limit_or_handoff'
    : unverified.length ? 'verify_current_affordance' : family.recommendation;
  return { task_family: taskFamily, learned_boundary: family,
    required_capability_keys: required, missing_capability_keys: missing,
    unverified_capability_keys: unverified, recommendation };
}

module.exports = {
  PROTOCOL_VERSION, MIN_DIRECTIONAL_SAMPLES, MIN_RELIABLE_SAMPLES,
  canonicalJson, commitment, classifyTask, canonicalSlackRef, recordFromInteraction,
  verifyRecord, wilson, familyProjection, projection, requiredCapabilityKeys, align,
};
