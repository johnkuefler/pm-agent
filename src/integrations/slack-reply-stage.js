'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const MAX_SEGMENTS = 3;
const MAX_SEGMENT_CHARS = 4000;
const MAX_USER_LINE_CHARS = 45000;
const DELIVERY_STATES = Object.freeze([
  'staged', 'attempted', 'delivered', 'suppressed',
  'partially_delivered_suppressed',
]);
const EGRESS_KINDS = Object.freeze(['message', 'reaction', 'silence']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSlackSegmentReceipts(priorReceipts = [], nextReceipts = []) {
  const merged = new Map();
  const accept = receipt => {
    if (!receipt || !Number.isInteger(receipt.segment_index)) return;
    const index = receipt.segment_index;
    const prior = merged.get(index);
    // A provider acknowledgement is monotonic knowledge. A later timeout, lease
    // loss, or callback failure must never erase a segment Slack already accepted.
    if (prior?.ok === true) return;
    merged.set(index, jsonClone(receipt));
  };
  for (const receipt of Array.isArray(priorReceipts) ? priorReceipts : []) accept(receipt);
  for (const receipt of Array.isArray(nextReceipts) ? nextReceipts : []) accept(receipt);
  return [...merged.values()]
    .sort((left, right) => left.segment_index - right.segment_index)
    .slice(0, MAX_SEGMENTS);
}

function boundedText(value, maximum, label) {
  const text = String(value || '').trim();
  if (!text || text.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters`);
  }
  return text;
}

function normalizedCore(input = {}) {
  const segments = Array.isArray(input.segments)
    ? input.segments.map(value => boundedText(value, MAX_SEGMENT_CHARS, 'Slack reply segment'))
    : [];
  if (!segments.length || segments.length > MAX_SEGMENTS) {
    throw new Error(`Slack reply stage requires 1-${MAX_SEGMENTS} segments`);
  }
  const reply = segments.join('\n');
  if (input.reply != null && String(input.reply).trim() !== reply) {
    throw new Error('Slack reply stage text must equal its exact ordered segments');
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    kind: 'slack_reply_delivery',
    turn_ref: boundedText(input.turn_ref, 500, 'Slack turn reference'),
    channel: boundedText(input.channel, 120, 'Slack channel'),
    user: boundedText(input.user, 120, 'Slack user'),
    trigger_ts: input.trigger_ts == null ? null
      : boundedText(input.trigger_ts, 120, 'Slack trigger timestamp'),
    channel_type: String(input.channel_type || '').slice(0, 40),
    mode: String(input.mode || 'normal').slice(0, 40),
    thread_ts: input.thread_ts == null ? null : String(input.thread_ts).slice(0, 120),
    root_thread_ts: input.root_thread_ts == null
      ? null : String(input.root_thread_ts).slice(0, 120),
    user_line: boundedText(input.user_line, MAX_USER_LINE_CHARS, 'Slack staged user line'),
    reply,
    segments,
    generated_at: String(input.generated_at || new Date().toISOString()),
    interaction_entry: input.interaction_entry && typeof input.interaction_entry === 'object'
      ? jsonClone(input.interaction_entry) : null,
    extraction: input.extraction && typeof input.extraction === 'object'
      ? jsonClone(input.extraction) : null,
  };
}

function contentCommitment(core) {
  return crypto.createHash('sha256').update(canonicalJson(core)).digest('hex');
}

function requiredSlackFinalizationEffects(stage) {
  const effects = [];
  const deliveryEffects = stage?.interaction_entry?.delivery_effects || {};
  const successfulReceipts = (stage?.delivery?.segment_receipts || [])
    .filter(receipt => receipt?.ok === true);
  const fullyDelivered = stage?.delivery?.status === 'delivered'
    && successfulReceipts.length === (stage?.segments || []).length;
  const visible = successfulReceipts.length > 0;
  const interactionKind = String(stage?.interaction_entry?.kind || 'reply');
  const assignmentDelivered = fullyDelivered
    && !['reaction', 'silence'].includes(interactionKind);
  const assignmentInterventions = new Set([
    'introspective_perturbation',
    'goal_access',
    'endogenous_attention_selection',
    'global_broadcast',
    'self_model_trust_policy_access',
  ]);
  if (deliveryEffects.prospective_output_monitor_id) {
    effects.push('prospective_output_monitor_delivery');
  }
  const intervention = String(deliveryEffects.intervention || '');
  const activeSpecialAssignment =
    (intervention === 'provider_reasoning_regulation'
      && deliveryEffects.provider_reasoning_regulation_active === true)
    || (intervention === 'reasoning_self_regulation'
      && deliveryEffects.reasoning_self_regulation_active === true)
    || (intervention === 'self_model_access'
      && Number(deliveryEffects.self_model_protocol_version) === 2
      && deliveryEffects.behavioral_self_profile_forecast_active === true);
  if (deliveryEffects.assignment_id
    && (assignmentInterventions.has(intervention)
      || activeSpecialAssignment)) {
    effects.push('context_assignment_delivery');
  }
  if (!assignmentDelivered && deliveryEffects.cognitive_parameter_assignment_id) {
    effects.push('cognitive_parameter_delivery_exclusion');
  }
  if (deliveryEffects.prospective_output_assignment_exclusion === true
    && deliveryEffects.assignment_id
    && ['prospective_output_monitor', 'prospective_output_calibration_access']
      .includes(String(deliveryEffects.intervention || ''))) {
    effects.push('prospective_output_assignment_exclusion');
  }
  if (stage?.mode === 'proactive' && fullyDelivered) {
    effects.push('proactive_initiative_spend');
  }
  if (visible || interactionKind === 'reaction') {
    effects.push('interaction_log');
  }
  if (fullyDelivered
    && !['reaction', 'silence'].includes(interactionKind)
    && stage?.extraction?.eligible === true
    && stage.extraction.source_origin) {
    effects.push('post_interaction_extraction');
  }
  return [...new Set(effects)].sort();
}

function createSlackReplyStage(input = {}) {
  const core = normalizedCore(input);
  return {
    ...core,
    content_commitment: contentCommitment(core),
    delivery: {
      status: 'staged',
      attempts: 0,
      segment_receipts: [],
      first_response: null,
      updated_at: core.generated_at,
    },
    finalization: {
      status: 'pending',
      attempts: 0,
      receipts: [],
      error: null,
      updated_at: core.generated_at,
    },
  };
}

function slackReplyStageAudit(stage, expected = {}) {
  try {
    if (!stage || stage.kind !== 'slack_reply_delivery'
      || stage.protocol_version !== PROTOCOL_VERSION) {
      return { valid: false, reason: 'unsupported_stage' };
    }
    const core = normalizedCore(stage);
    if (stage.content_commitment !== contentCommitment(core)) {
      return { valid: false, reason: 'content_commitment_mismatch' };
    }
    const delivery = stage.delivery;
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      return { valid: false, reason: 'delivery_state_missing' };
    }
    const allowedDeliveryKeys = new Set([
      'status', 'attempts', 'segment_receipts', 'first_response',
      'terminal_reason', 'updated_at', 'transport',
    ]);
    if (Object.keys(delivery).some(key => !allowedDeliveryKeys.has(key))) {
      return { valid: false, reason: 'delivery_state_unknown_field' };
    }
    if (!DELIVERY_STATES.includes(delivery.status)
      || !Number.isInteger(delivery.attempts) || delivery.attempts < 0
      || !Array.isArray(delivery.segment_receipts)
      || delivery.segment_receipts.length > core.segments.length
      || !Number.isFinite(new Date(delivery.updated_at).getTime())) {
      return { valid: false, reason: 'delivery_state_invalid' };
    }
    const seenIndexes = new Set();
    for (const receipt of delivery.segment_receipts) {
      if (!receipt || typeof receipt !== 'object'
        || !Number.isInteger(receipt.segment_index)
        || receipt.segment_index < 0
        || receipt.segment_index >= core.segments.length
        || seenIndexes.has(receipt.segment_index)
        || typeof receipt.ok !== 'boolean') {
        return { valid: false, reason: 'delivery_receipt_invalid' };
      }
      seenIndexes.add(receipt.segment_index);
      const egressKind = stage.interaction_entry?.kind === 'reaction'
        ? 'reaction' : 'message';
      const expectedMethod = egressKind === 'reaction'
        ? ['reactions.add', 'chat.postMessage']
        : ['chat.postMessage'];
      if (!expectedMethod.includes(receipt.method)) {
        return { valid: false, reason: 'delivery_receipt_method_invalid' };
      }
      if (receipt.method === 'chat.postMessage'
        && receipt.ok === true
        && (!String(receipt.ts || '').trim()
          || !String(receipt.channel || '').trim()
          || String(receipt.channel) !== core.channel)) {
        return { valid: false, reason: 'delivery_receipt_identity_missing' };
      }
    }
    if (delivery.status === 'staged' && (delivery.attempts !== 0
      || delivery.segment_receipts.length || delivery.first_response != null)) {
      return { valid: false, reason: 'staged_delivery_has_attempt_data' };
    }
    if (delivery.status === 'attempted' && delivery.attempts < 1) {
      return { valid: false, reason: 'attempted_delivery_missing_attempt' };
    }
    if (delivery.status === 'delivered') {
      const firstReceipt = delivery.segment_receipts
        .find(item => item.segment_index === 0);
      if (delivery.attempts < 1
        || delivery.segment_receipts.length !== core.segments.length
        || core.segments.some((_, index) => {
          const receipt = delivery.segment_receipts
            .find(item => item.segment_index === index);
          return !receipt?.ok;
        })
        || delivery.first_response?.ok !== true
        || !String(delivery.first_response?.ts || '').trim()
        || String(delivery.first_response?.channel || '') !== core.channel
        || String(delivery.first_response?.ts || '')
          !== String(firstReceipt?.ts || '')
        || String(delivery.first_response?.channel || '')
          !== String(firstReceipt?.channel || '')) {
        return { valid: false, reason: 'delivered_state_lacks_provider_receipts' };
      }
    }
    if (['suppressed', 'partially_delivered_suppressed'].includes(delivery.status)) {
      const successfulReceipts = delivery.segment_receipts
        .filter(receipt => receipt.ok).length;
      if (delivery.attempts < 1
        || typeof delivery.terminal_reason !== 'string'
        || !delivery.terminal_reason.trim()
        || delivery.terminal_reason.length > 240) {
        return { valid: false, reason: 'suppressed_state_invalid' };
      }
      if (delivery.status === 'suppressed'
        && (successfulReceipts !== 0 || delivery.first_response != null)) {
        return { valid: false, reason: 'suppressed_state_hides_partial_delivery' };
      }
      if (delivery.status === 'partially_delivered_suppressed'
        && (successfulReceipts < 1 || successfulReceipts >= core.segments.length
          || delivery.first_response?.ok !== true
          || String(delivery.first_response?.channel || '') !== core.channel
          || String(delivery.first_response?.ts || '')
            !== String(delivery.segment_receipts
              .find(item => item.segment_index === 0)?.ts || ''))) {
        return { valid: false, reason: 'partial_suppression_receipts_invalid' };
      }
    } else if (delivery.terminal_reason != null) {
      return { valid: false, reason: 'nonterminal_suppression_reason' };
    }
    if (stage.finalization == null) {
      return { valid: false, reason: 'finalization_state_missing' };
    }
    {
      const finalization = stage.finalization;
      const allowedFinalizationKeys = new Set([
        'status', 'attempts', 'receipts', 'error', 'updated_at', 'completed_at',
      ]);
      if (!finalization || typeof finalization !== 'object'
        || Array.isArray(finalization)
        || Object.keys(finalization)
          .some(key => !allowedFinalizationKeys.has(key))
        || !['pending', 'in_progress', 'completed', 'failed']
          .includes(finalization.status)
        || !Number.isInteger(finalization.attempts)
        || finalization.attempts < 0
        || !Array.isArray(finalization.receipts)
        || finalization.receipts.length > 40
        || !Number.isFinite(new Date(finalization.updated_at).getTime())) {
        return { valid: false, reason: 'finalization_state_invalid' };
      }
      if (finalization.status === 'pending'
        && (finalization.attempts !== 0 || finalization.error != null)) {
        return { valid: false, reason: 'pending_finalization_has_attempt_data' };
      }
      const seenEffects = new Set();
      for (const receipt of finalization.receipts) {
        if (!receipt || typeof receipt !== 'object'
          || typeof receipt.effect !== 'string'
          || !receipt.effect.trim()
          || receipt.effect.length > 120
          || seenEffects.has(receipt.effect)
          || receipt.ok !== true
          || !Number.isFinite(new Date(receipt.at).getTime())) {
          return { valid: false, reason: 'finalization_receipt_invalid' };
        }
        seenEffects.add(receipt.effect);
      }
      if (finalization.status === 'in_progress'
        && (finalization.attempts < 1 || finalization.error != null)) {
        return { valid: false, reason: 'in_progress_finalization_invalid' };
      }
      if (finalization.status === 'completed'
        && (finalization.attempts < 1
          || !Number.isFinite(new Date(finalization.completed_at).getTime())
          || finalization.error != null)) {
        return { valid: false, reason: 'completed_finalization_invalid' };
      }
      if (finalization.status === 'completed') {
        const requiredEffects = requiredSlackFinalizationEffects(stage);
        const recordedEffects = finalization.receipts
          .map(receipt => receipt.effect).sort();
        if (canonicalJson(requiredEffects) !== canonicalJson(recordedEffects)) {
          return { valid: false, reason: 'finalization_effect_manifest_incomplete' };
        }
      }
      if (finalization.status === 'failed'
        && (finalization.attempts < 1
          || typeof finalization.error !== 'string'
          || !finalization.error.trim())) {
        return { valid: false, reason: 'failed_finalization_invalid' };
      }
    }
    for (const [field, value] of Object.entries(expected)) {
      const normalizedExpected = value == null ? null : String(value);
      const actual = stage[field] == null ? null : String(stage[field]);
      if (actual !== normalizedExpected) {
        return { valid: false, reason: `context_mismatch:${field}` };
      }
    }
    return { valid: true, core };
  } catch (error) {
    return { valid: false, reason: String(error?.message || error).slice(0, 240) };
  }
}

function updateSlackReplyStageDelivery(stage, {
  status,
  segmentReceipts = [],
  firstResponse = null,
  terminalReason = null,
  startAttempt = false,
  now = new Date(),
} = {}) {
  const audit = slackReplyStageAudit(stage);
  if (!audit.valid) throw new Error(`Slack reply stage failed audit: ${audit.reason}`);
  const states = DELIVERY_STATES;
  if (!states.includes(status)) {
    throw new Error('Slack reply delivery status is invalid');
  }
  const priorStatus = String(stage.delivery?.status || 'staged');
  if (!states.includes(priorStatus)) {
    throw new Error('Slack reply prior delivery status is invalid');
  }
  if (['delivered', 'suppressed', 'partially_delivered_suppressed']
    .includes(priorStatus) && status !== priorStatus) {
    throw new Error(
      `Slack reply delivery cannot transition from ${priorStatus} to ${status}`);
  }
  if (priorStatus === 'attempted' && status === 'staged') {
    throw new Error('Slack reply delivery cannot transition from attempted to staged');
  }
  const mergedReceipts = mergeSlackSegmentReceipts(
    stage.delivery?.segment_receipts,
    segmentReceipts,
  );
  const priorFirstResponse = stage.delivery?.first_response;
  const durableFirstResponse = priorFirstResponse?.ok === true
    ? jsonClone(priorFirstResponse)
    : (firstResponse && typeof firstResponse === 'object'
      ? jsonClone(firstResponse) : null);
  const beginsFirstAttempt = priorStatus === 'staged' && status !== 'staged';
  const beginsRetryAttempt = startAttempt === true && priorStatus !== 'staged';
  return {
    ...jsonClone(stage),
    delivery: {
      status,
      attempts: Math.max(0, Number(stage.delivery?.attempts) || 0)
        + (beginsFirstAttempt || beginsRetryAttempt ? 1 : 0),
      segment_receipts: mergedReceipts,
      first_response: durableFirstResponse,
      terminal_reason: ['suppressed', 'partially_delivered_suppressed'].includes(status)
        ? boundedText(terminalReason, 240, 'Slack terminal suppression reason')
        : null,
      updated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    },
  };
}

function updateSlackReplyStageFinalization(stage, {
  status,
  receipts = [],
  error = null,
  now = new Date(),
} = {}) {
  const audit = slackReplyStageAudit(stage);
  if (!audit.valid) throw new Error(`Slack reply stage failed audit: ${audit.reason}`);
  if (!['in_progress', 'completed', 'failed'].includes(status)) {
    throw new Error('Slack reply finalization status is invalid');
  }
  const prior = stage.finalization || {
    status: 'pending', attempts: 0, receipts: [], error: null,
  };
  if (prior.status === 'completed') {
    if (status !== 'completed') {
      throw new Error('Slack reply finalization cannot leave completed state');
    }
    return jsonClone(stage);
  }
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const startsAttempt = (
    status === 'in_progress' && prior.status !== 'in_progress'
  ) || (
    status === 'completed' && ['pending', 'failed'].includes(prior.status)
  ) || (
    status === 'failed' && prior.status !== 'in_progress'
  );
  return {
    ...jsonClone(stage),
    finalization: {
      status,
      attempts: Math.max(0, Number(prior.attempts) || 0)
        + (startsAttempt ? 1 : 0),
      receipts: Array.isArray(receipts) ? jsonClone(receipts).slice(0, 40) : [],
      error: status === 'failed'
        ? boundedText(error, 500, 'Slack finalization error') : null,
      updated_at: timestamp,
      ...(status === 'completed' ? { completed_at: timestamp } : {}),
    },
  };
}

function commitSlackHistoryTurn(history, userLine, reply, { maximumMessages = 20 } = {}) {
  if (!Array.isArray(history)) throw new TypeError('Slack history must be an array');
  const userContent = boundedText(
    userLine, MAX_USER_LINE_CHARS, 'Slack staged user line');
  const assistantContent = boundedText(
    reply,
    MAX_SEGMENTS * MAX_SEGMENT_CHARS + (MAX_SEGMENTS - 1),
    'Slack staged reply');
  const priorAssistant = history.at(-1);
  const priorUser = history.at(-2);
  if (priorUser?.role === 'user' && priorUser.content === userContent
    && priorAssistant?.role === 'assistant' && priorAssistant.content === assistantContent) {
    return { committed: false, idempotent: true };
  }
  if (!(history.at(-1)?.role === 'user' && history.at(-1)?.content === userContent)) {
    history.push({ role: 'user', content: userContent });
  }
  history.push({ role: 'assistant', content: assistantContent });
  const boundedMaximum = Math.max(2, Number(maximumMessages) || 20);
  if (history.length > boundedMaximum) {
    history.splice(0, history.length - boundedMaximum);
  }
  return { committed: true, idempotent: false };
}

function restoreSlackHistory(history, snapshot) {
  if (!Array.isArray(history) || !Array.isArray(snapshot)) return false;
  history.splice(0, history.length, ...structuredClone(snapshot));
  return true;
}

module.exports = {
  DELIVERY_STATES,
  EGRESS_KINDS,
  PROTOCOL_VERSION,
  MAX_USER_LINE_CHARS,
  commitSlackHistoryTurn,
  createSlackReplyStage,
  mergeSlackSegmentReceipts,
  requiredSlackFinalizationEffects,
  restoreSlackHistory,
  slackReplyStageAudit,
  updateSlackReplyStageDelivery,
  updateSlackReplyStageFinalization,
};
