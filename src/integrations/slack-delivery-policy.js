'use strict';

const DELIVERY_MODES = Object.freeze(['auto', 'thread', 'thread_broadcast', 'channel', 'dm']);
const SHARED_MATERIALITY = new Set([
  'blocker',
  'correction',
  'deadline_risk',
  'decision',
  'incident',
  'material',
  'material_outcome',
  'material_update',
  'milestone',
  'shared_deliverable',
  'urgent_risk',
]);
const ALWAYS_VISIBLE = new Set(['correction', 'incident', 'urgent_risk']);

function slackTimestampMs(value) {
  const seconds = Number.parseFloat(String(value || ''));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function normalizeDeliveryMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  return DELIVERY_MODES.includes(mode) ? mode : 'auto';
}

function normalizeMateriality(value) {
  return String(value || 'routine').trim().toLowerCase().replaceAll(/[\s-]+/g, '_').slice(0, 80)
    || 'routine';
}

function resolveSlackDelivery({
  channelType,
  threadTs = null,
  sourceTs = null,
  deliveryMode = 'auto',
  materiality = 'routine',
  proactive = false,
  now = Date.now(),
  staleAfterMs = 2 * 60 * 60 * 1000,
} = {}) {
  const mode = normalizeDeliveryMode(deliveryMode);
  const normalizedMateriality = normalizeMateriality(materiality);
  const normalizedChannelType = String(channelType || '').trim().toLowerCase();
  const isDm = normalizedChannelType === 'im'
    || normalizedChannelType === 'mpim'
    || mode === 'dm';
  const sourceMs = slackTimestampMs(sourceTs || threadTs);
  const ageMs = sourceMs === null ? null : Math.max(0, Number(now) - sourceMs);
  const stale = ageMs !== null && ageMs >= Math.max(60_000, Number(staleAfterMs) || 0);
  const shared = SHARED_MATERIALITY.has(normalizedMateriality);

  if (isDm) {
    return {
      mode: 'dm',
      thread_ts: null,
      reply_broadcast: false,
      reason: 'direct_messages_stay_inline',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (mode === 'channel') {
    return {
      mode: 'channel',
      thread_ts: null,
      reply_broadcast: false,
      reason: 'explicit_channel_delivery',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (mode === 'thread') {
    return {
      mode: threadTs ? 'thread' : 'channel',
      thread_ts: threadTs || null,
      reply_broadcast: false,
      reason: threadTs ? 'explicit_thread_delivery' : 'thread_unavailable',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (mode === 'thread_broadcast') {
    return {
      mode: threadTs ? 'thread_broadcast' : 'channel',
      thread_ts: threadTs || null,
      reply_broadcast: Boolean(threadTs),
      reason: threadTs ? 'explicit_thread_broadcast' : 'thread_unavailable',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (!threadTs) {
    return {
      mode: 'channel',
      thread_ts: null,
      reply_broadcast: false,
      reason: 'no_thread_context',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (proactive) {
    return {
      mode: 'thread_broadcast',
      thread_ts: threadTs,
      reply_broadcast: true,
      reason: 'proactive_contribution_should_be_visible',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  if (ALWAYS_VISIBLE.has(normalizedMateriality) || (shared && stale)) {
    return {
      mode: 'thread_broadcast',
      thread_ts: threadTs,
      reply_broadcast: true,
      reason: ALWAYS_VISIBLE.has(normalizedMateriality)
        ? 'material_update_requires_channel_visibility'
        : 'material_update_resurfaced_from_stale_thread',
      materiality: normalizedMateriality,
      source_age_ms: ageMs,
    };
  }
  return {
    mode: 'thread',
    thread_ts: threadTs,
    reply_broadcast: false,
    reason: shared ? 'recent_material_update_kept_in_context' : 'routine_update_kept_in_context',
    materiality: normalizedMateriality,
    source_age_ms: ageMs,
  };
}

module.exports = {
  DELIVERY_MODES,
  SHARED_MATERIALITY,
  slackTimestampMs,
  normalizeDeliveryMode,
  normalizeMateriality,
  resolveSlackDelivery,
};
