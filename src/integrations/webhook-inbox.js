'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  slackReplyStageAudit,
} = require('./slack-reply-stage');

function stableWebhookEventId(provider, body, rawBody) {
  const explicit = String(body?.event_id || body?.id || '').trim();
  if (explicit) return explicit.slice(0, 300);
  const bytes = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(body || {}));
  return `${String(provider || 'webhook')}-${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function createMemoryWebhookInbox({
  clock = () => Date.now(),
  claimTokenFactory = () => crypto.randomUUID(),
  leaseMs = 10 * 60 * 1000,
  maxAttempts = 5,
  maxRecords = 2000,
} = {}) {
  const records = new Map();
  let enqueueSequence = 0;

  function prune() {
    if (records.size <= maxRecords) return;
    for (const [key, record] of records) {
      if (!['completed', 'dead'].includes(record.status)) continue;
      records.delete(key);
      if (records.size <= maxRecords) break;
    }
  }

  function key(provider, eventId) {
    return `${String(provider || '')}:${String(eventId || '')}`;
  }

  async function enqueue({
    provider,
    event_id: eventId,
    payload,
    attestation = null,
    ordering_key: orderingKey = null,
    ordering_position: orderingPosition = null,
    available_in_ms: availableInMs = 0,
  }) {
    const recordKey = key(provider, eventId);
    const existing = records.get(recordKey);
    if (existing) {
      const exactReplay = isDeepStrictEqual(existing.payload, payload)
        && isDeepStrictEqual(existing.attestation, attestation)
        && existing.ordering_key
          === (orderingKey == null ? null : String(orderingKey).slice(0, 500))
        && existing.ordering_position
          === (orderingPosition == null ? null : String(orderingPosition).slice(0, 120));
      if (!exactReplay) {
        throw new Error(
          `webhook event ${provider}:${eventId} is already bound to different input`);
      }
      return { inserted: false, status: existing.status };
    }
    const now = clock();
    const boundedDelayMs = Math.max(
      0, Math.min(5000, Number(availableInMs) || 0));
    records.set(recordKey, {
      provider, event_id: eventId, payload, attestation,
      ordering_key: orderingKey == null ? null : String(orderingKey).slice(0, 500),
      ordering_position: orderingPosition == null
        ? null : String(orderingPosition).slice(0, 120),
      enqueue_sequence: enqueueSequence++,
      processing_result: null,
      status: 'queued', attempts: 0, available_at: now + boundedDelayMs,
      lease_until: null,
      claim_token: null,
      created_at: now, updated_at: now, last_error: null,
    });
    prune();
    return { inserted: true, status: 'queued' };
  }

  function claimable(record, now) {
    return (record.status === 'queued' && record.available_at <= now)
      || (record.status === 'processing' && Number(record.lease_until) <= now);
  }

  function isEarlier(left, right) {
    const leftPosition = left.ordering_position || '';
    const rightPosition = right.ordering_position || '';
    if (leftPosition !== rightPosition) return leftPosition < rightPosition;
    return Number(left.enqueue_sequence) < Number(right.enqueue_sequence);
  }

  function blockedByEarlierConversationEvent(record) {
    if (!record?.ordering_key) return false;
    const now = clock();
    const blockedByActivePredecessor = [...records.values()].some(other =>
      other !== record
      && other.provider === record.provider
      && other.ordering_key === record.ordering_key
      && ['queued', 'processing'].includes(other.status)
      && (
        (other.status === 'processing'
          && Number(other.lease_until) > now)
        || isEarlier(other, record)
      ));
    return blockedByActivePredecessor;
  }

  function expireExhausted(record, now) {
    if (!record || !claimable(record, now) || record.attempts < maxAttempts) return false;
    record.status = 'dead';
    record.lease_until = null;
    record.claim_token = null;
    record.updated_at = now;
    record.last_error = record.last_error
      || 'processing lease expired at the maximum attempt count';
    return true;
  }

  function requestedLeaseMs(options = {}) {
    if (Number.isFinite(Number(options.leaseMs))) {
      return Math.max(1, Number(options.leaseMs));
    }
    if (Number.isFinite(Number(options.leaseSeconds))) {
      return Math.max(1, Number(options.leaseSeconds) * 1000);
    }
    return leaseMs;
  }

  async function claim(provider, eventId, options = {}) {
    const record = records.get(key(provider, eventId));
    const now = clock();
    if (expireExhausted(record, now)) return null;
    if (!record || !claimable(record, now)
      || blockedByEarlierConversationEvent(record)) return null;
    const claimToken = String(claimTokenFactory() || '').trim();
    if (!claimToken) throw new Error('webhook claim token factory returned an empty token');
    record.status = 'processing';
    record.attempts += 1;
    record.lease_until = now + requestedLeaseMs(options);
    record.claim_token = claimToken;
    record.updated_at = now;
    return structuredClone(record);
  }

  async function claimNext(provider, options = {}) {
    const now = clock();
    for (const record of records.values()) {
      if (record.provider === provider) expireExhausted(record, now);
    }
    const eligible = [...records.values()]
      .filter(record => record.provider === provider && claimable(record, now)
        && !blockedByEarlierConversationEvent(record))
      .sort((left, right) => left.available_at - right.available_at
        || left.created_at - right.created_at)[0];
    return eligible ? claim(provider, eligible.event_id, options) : null;
  }

  async function complete(provider, eventId, claimToken, {
    allowEmptyResult = false,
  } = {}) {
    const record = records.get(key(provider, eventId));
    const token = typeof claimToken === 'string' ? claimToken.trim() : '';
    const now = clock();
    const slackAudit = provider === 'slack' && record?.processing_result
      ? slackReplyStageAudit(record.processing_result) : null;
    const slackResultComplete = provider !== 'slack'
      || (allowEmptyResult === true && record?.processing_result == null)
      || (
        slackAudit?.valid === true
        && ['delivered', 'suppressed', 'partially_delivered_suppressed']
          .includes(record?.processing_result?.delivery?.status)
        && record?.processing_result?.finalization?.status === 'completed'
      );
    if (!record || record.status !== 'processing' || !token
      || record.claim_token !== token || Number(record.lease_until) <= now
      || !slackResultComplete) {
      return false;
    }
    record.status = 'completed';
    record.lease_until = null;
    record.claim_token = null;
    record.updated_at = now;
    record.completed_at = now;
    record.last_error = null;
    prune();
    return true;
  }

  async function stageResult(provider, eventId, claimToken, result) {
    const record = records.get(key(provider, eventId));
    const token = typeof claimToken === 'string' ? claimToken.trim() : '';
    const now = clock();
    const stageAudit = provider === 'slack'
      ? slackReplyStageAudit(result)
      : { valid: Boolean(result && typeof result === 'object' && !Array.isArray(result)) };
    const validStage = stageAudit.valid === true;
    if (!record || record.status !== 'processing' || !token
      || record.claim_token !== token || Number(record.lease_until) <= now || !result
      || !validStage) {
      return false;
    }
    if (!record.processing_result && provider === 'slack'
      && result.delivery?.status !== 'staged') {
      return false;
    }
    if (record.processing_result) {
      const prior = record.processing_result;
      const priorCommitment = String(prior.content_commitment || '');
      const nextCommitment = String(result.content_commitment || '');
      const ranks = {
        staged: 0,
        attempted: 1,
        delivered: 2,
        suppressed: 2,
        partially_delivered_suppressed: 2,
      };
      const priorStatus = String(prior.delivery?.status || '');
      const nextStatus = String(result.delivery?.status || '');
      const terminal = [
        'delivered', 'suppressed', 'partially_delivered_suppressed',
      ].includes(priorStatus);
      const finalizationRanks = {
        pending: 0, in_progress: 1, failed: 1, completed: 2,
      };
      const priorFinalization = String(prior.finalization?.status || 'pending');
      const nextFinalization = String(result.finalization?.status || 'pending');
      const terminalDeliveryUnchanged = JSON.stringify(prior.delivery)
        === JSON.stringify(result.delivery);
      const nextSuccessfulReceipts = new Map(
        (result.delivery?.segment_receipts || [])
          .filter(receipt => receipt?.ok === true)
          .map(receipt => [receipt.segment_index, receipt]),
      );
      const deliveryKnowledgeMonotonic =
        Number(result.delivery?.attempts) >= Number(prior.delivery?.attempts)
        && (prior.delivery?.segment_receipts || [])
          .filter(receipt => receipt?.ok === true)
          .every(receipt =>
            JSON.stringify(nextSuccessfulReceipts.get(receipt.segment_index))
              === JSON.stringify(receipt))
        && (
          prior.delivery?.first_response?.ok !== true
          || JSON.stringify(result.delivery?.first_response)
            === JSON.stringify(prior.delivery.first_response)
        );
      const priorFinalizationReceipts = new Map(
        (prior.finalization?.receipts || [])
          .map(receipt => [receipt.effect, receipt]),
      );
      const nextFinalizationReceipts = new Map(
        (result.finalization?.receipts || [])
          .map(receipt => [receipt.effect, receipt]),
      );
      const finalizationKnowledgeMonotonic =
        Number(result.finalization?.attempts || 0)
          >= Number(prior.finalization?.attempts || 0)
        && [...priorFinalizationReceipts.entries()].every(([effect, receipt]) =>
          JSON.stringify(nextFinalizationReceipts.get(effect))
            === JSON.stringify(receipt))
        && (
          priorFinalization !== 'completed'
          || JSON.stringify(result.finalization)
            === JSON.stringify(prior.finalization)
        );
      const monotonicFinalization = Number.isInteger(finalizationRanks[priorFinalization])
        && Number.isInteger(finalizationRanks[nextFinalization])
        && finalizationRanks[nextFinalization] >= finalizationRanks[priorFinalization]
        && (priorFinalization !== 'completed' || nextFinalization === 'completed');
      if (!priorCommitment || priorCommitment !== nextCommitment
        || !Number.isInteger(ranks[priorStatus])
        || !Number.isInteger(ranks[nextStatus])
        || ranks[nextStatus] < ranks[priorStatus]
        || !deliveryKnowledgeMonotonic
        || !finalizationKnowledgeMonotonic
        || (terminal && !(terminalDeliveryUnchanged && monotonicFinalization))) {
        return false;
      }
    }
    record.processing_result = structuredClone(result);
    record.updated_at = clock();
    return true;
  }

  async function renew(provider, eventId, claimToken, options = {}) {
    const record = records.get(key(provider, eventId));
    const token = typeof claimToken === 'string' ? claimToken.trim() : '';
    const now = clock();
    if (!record || record.status !== 'processing' || !token
      || record.claim_token !== token || Number(record.lease_until) <= now) {
      return false;
    }
    const boundedLeaseMs = requestedLeaseMs(options);
    record.lease_until = Math.max(Number(record.lease_until), now + boundedLeaseMs);
    record.updated_at = now;
    return true;
  }

  async function fail(provider, eventId, claimToken, error) {
    const record = records.get(key(provider, eventId));
    const token = typeof claimToken === 'string' ? claimToken.trim() : '';
    if (!record || record.status !== 'processing' || !token
      || record.claim_token !== token || Number(record.lease_until) <= clock()) {
      return null;
    }
    const now = clock();
    const terminal = record.attempts >= maxAttempts;
    record.status = terminal ? 'dead' : 'queued';
    record.lease_until = null;
    record.claim_token = null;
    record.available_at = terminal
      ? now : now + Math.min(60000, 1000 * (2 ** Math.max(0, record.attempts - 1)));
    record.updated_at = now;
    record.last_error = String(error?.message || error || 'webhook processing failed').slice(0, 500);
    return { status: record.status, attempts: record.attempts, available_at: record.available_at };
  }

  async function hasRecentTerminal(provider, orderingKey, excludeEventId, {
    withinMs = 30 * 60 * 1000,
    mode = null,
  } = {}) {
    const now = clock();
    const windowMs = Math.max(1, Number(withinMs) || 30 * 60 * 1000);
    return [...records.values()].some(record =>
      record.provider === provider
      && record.ordering_key === orderingKey
      && record.event_id !== excludeEventId
      && record.status === 'completed'
      && Number(record.completed_at) + windowMs > now
      && (mode == null || record.processing_result?.mode === mode)
      && (
        ['delivered', 'partially_delivered_suppressed']
          .includes(record.processing_result?.delivery?.status)
        || (
          record.processing_result?.delivery?.status === 'suppressed'
          && ['intentional_silence', 'proactive_model_declined']
            .includes(record.processing_result?.delivery?.terminal_reason)
        )
      ));
  }

  async function hasLaterTerminal(
    provider,
    orderingKey,
    orderingPosition,
    excludeEventId,
  ) {
    const keyValue = String(orderingKey || '').trim();
    const position = String(orderingPosition || '').trim();
    if (!keyValue || !position) return false;
    return [...records.values()].some(record =>
      record.provider === provider
      && record.ordering_key === keyValue
      && record.event_id !== excludeEventId
      && record.status === 'completed'
      && String(record.ordering_position || '') > position);
  }

  async function stats(provider) {
    const counts = {};
    let oldestActiveAt = null;
    for (const record of records.values()) {
      if (record.provider !== provider) continue;
      counts[record.status] = (counts[record.status] || 0) + 1;
      if (['queued', 'processing'].includes(record.status)
        && (oldestActiveAt == null || record.created_at < oldestActiveAt)) {
        oldestActiveAt = record.created_at;
      }
    }
    return {
      counts,
      active_count: Number(counts.queued || 0) + Number(counts.processing || 0),
      dead_letters: Number(counts.dead || 0),
      oldest_active_at: oldestActiveAt == null
        ? null : new Date(oldestActiveAt).toISOString(),
      oldest_active_age_ms: oldestActiveAt == null
        ? 0 : Math.max(0, clock() - oldestActiveAt),
    };
  }

  function snapshot() {
    const counts = {};
    for (const record of records.values()) counts[record.status] = (counts[record.status] || 0) + 1;
    return { size: records.size, counts };
  }

  return {
    claim,
    claimNext,
    complete,
    enqueue,
    fail,
    hasLaterTerminal,
    hasRecentTerminal,
    renew,
    stageResult,
    stats,
    snapshot,
  };
}

module.exports = { createMemoryWebhookInbox, stableWebhookEventId };
