'use strict';

const crypto = require('crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { resolveSlackDelivery } = require('./slack-delivery-policy');

const MAX_NOTIFICATION_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NOTIFICATION_FILE_TIMEOUT_MS = 30000;
const MAX_NOTIFICATION_DNS_TIMEOUT_MS = 5000;

function ipv4AddressIsGlobal(address) {
  const octets = String(address || '').split('.').map(Number);
  if (octets.length !== 4
    || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  return !(a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224);
}

function ipv6Words(address) {
  let value = String(address || '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '').split('%')[0];
  if (!value || !value.includes(':')) return null;
  const dotted = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted) {
    if (net.isIP(dotted) !== 4) return null;
    const bytes = dotted.split('.').map(Number);
    value = value.slice(0, value.length - dotted.length)
      + `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right]
    .map(part => /^[a-f0-9]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN);
  return words.length === 8 && words.every(Number.isInteger) ? words : null;
}

function networkAddressIsGlobal(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  if (family === 4) return ipv4AddressIsGlobal(value);
  const words = family === 6 ? ipv6Words(value) : null;
  if (!words) return false;
  const mappedV4 = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  if (mappedV4 || words.slice(0, 6).every(word => word === 0)) return false;
  if ((words[0] & 0xfe00) === 0xfc00) return false;
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return false;
  if ((words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x0064 && words[1] === 0xff9b
    && words.slice(2, 6).every(word => word === 0)) return false;
  if (words[0] === 0x2001 && words[1] <= 0x01ff) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2002 || words[0] === 0x3fff) return false;
  return (words[0] & 0xe000) === 0x2000;
}

function normalizeResolvedAddress(item) {
  const address = typeof item === 'string' ? item : item?.address;
  const normalizedAddress = String(address || '').trim();
  const actualFamily = net.isIP(normalizedAddress);
  const declaredFamily = Number(typeof item === 'object' ? item?.family : actualFamily);
  if (!actualFamily
    || ((declaredFamily === 4 || declaredFamily === 6) && declaredFamily !== actualFamily)) {
    return null;
  }
  return { address: normalizedAddress, family: actualFamily };
}

function parseNotificationFileUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw slackDeliveryError('Slack notification file URL is invalid', {
      code: 'slack_file_url_rejected',
    });
  }
  if (parsed.protocol !== 'https:') {
    throw slackDeliveryError('Slack notification files must use HTTPS', {
      code: 'slack_file_url_rejected',
    });
  }
  if (parsed.username || parsed.password) {
    throw slackDeliveryError('Slack notification file URLs cannot contain credentials', {
      code: 'slack_file_url_rejected',
    });
  }
  if (parsed.port && parsed.port !== '443') {
    throw slackDeliveryError('Slack notification file URLs must use the standard HTTPS port', {
      code: 'slack_file_url_rejected',
    });
  }
  const hostname = parsed.hostname.toLowerCase()
    .replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw slackDeliveryError('Slack notification file URL hostname is not allowed', {
      code: 'slack_file_url_rejected',
    });
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed;
}

async function resolvePinnedNotificationFileUrl(value, {
  resolveHost = (hostname, options) => dns.lookup(hostname, options),
  resolutionTimeoutMs = MAX_NOTIFICATION_DNS_TIMEOUT_MS,
} = {}) {
  const parsed = parseNotificationFileUrl(value);
  // URL.hostname includes brackets for IPv6 literals on supported Node releases.
  // Keep a normalized host solely for address checks and the pinned lookup.
  const resolutionHostname = parsed.hostname.toLowerCase()
    .replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literalFamily = net.isIP(resolutionHostname);
  let resolved;
  let resolutionTimer;
  try {
    resolved = literalFamily
      ? [{ address: resolutionHostname, family: literalFamily }]
      : await Promise.race([
        Promise.resolve(resolveHost(resolutionHostname, { all: true, verbatim: true })),
        new Promise((_, reject) => {
          resolutionTimer = setTimeout(
            () => reject(new Error('notification file DNS resolution timed out')),
            Math.max(1, Math.min(
              MAX_NOTIFICATION_DNS_TIMEOUT_MS,
              Number(resolutionTimeoutMs) || MAX_NOTIFICATION_DNS_TIMEOUT_MS,
            )),
          );
        }),
      ]);
  } catch (cause) {
    throw slackDeliveryError('Slack notification file hostname could not be resolved safely', {
      code: 'slack_file_url_rejected',
      cause,
    });
  } finally {
    if (resolutionTimer) clearTimeout(resolutionTimer);
  }
  const resolvedItems = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = resolvedItems.map(normalizeResolvedAddress);
  if (!addresses.length || addresses.some(item =>
    !item || !networkAddressIsGlobal(item.address))) {
    throw slackDeliveryError('Slack notification file hostname did not resolve exclusively to public addresses', {
      code: 'slack_file_url_rejected',
    });
  }
  const expectedHostname = resolutionHostname;
  const pinnedLookup = (hostname, options, callback) => {
    const requestedHostname = String(hostname || '').toLowerCase()
      .replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (requestedHostname !== expectedHostname) {
      return callback(new Error('notification file DNS pin hostname mismatch'));
    }
    const requestedFamily = Number(options?.family) || 0;
    const candidates = requestedFamily
      ? addresses.filter(item => item.family === requestedFamily)
      : addresses;
    if (!candidates.length) {
      return callback(new Error('notification file DNS pin has no address for the requested family'));
    }
    if (options?.all) return callback(null, candidates.map(item => ({ ...item })));
    return callback(null, candidates[0].address, candidates[0].family);
  };
  return {
    url: parsed.toString(),
    hostname: expectedHostname,
    addresses: addresses.map(item => ({ ...item })),
    httpsAgent: new https.Agent({ keepAlive: false, lookup: pinnedLookup }),
  };
}

function deterministicSlackClientMsgId(value) {
  const bytes = crypto.createHash('sha256').update(String(value || '')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function segmentedSlackClientMsgId(clientMsgId, segmentIndex) {
  const base = String(clientMsgId || '').trim();
  if (!base) return null;
  // Preserve the existing first-message identifier for callers that already persist it.
  // Follow-on messages derive their own stable UUID from the same operation identity.
  return segmentIndex === 0
    ? base
    : deterministicSlackClientMsgId(`${base}:segment:${segmentIndex}`);
}

function isHttpSuccess(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function slackApiReceipt(response, {
  method = 'slack.api',
  segmentIndex = null,
  attempted = true,
  error = null,
  expectedChannel = null,
} = {}) {
  const httpStatus = Number.isFinite(Number(response?.status))
    ? Number(response.status)
    : null;
  const httpOk = isHttpSuccess(response);
  const slackOk = response?.data?.ok === true;
  const messageTimestamp = response?.data?.ts || null;
  const responseChannel = response?.data?.channel || null;
  const channelMatches = expectedChannel == null
    || String(responseChannel || '') === String(expectedChannel);
  const messageIdentityOk = method !== 'chat.postMessage'
    || (Boolean(messageTimestamp) && Boolean(responseChannel) && channelMatches);
  const providerError = response?.data?.error
    || error
    || (!httpOk ? `http_${httpStatus ?? 'status_unavailable'}`
      : (!slackOk ? 'slack_ok_false'
        : (!messageIdentityOk
          ? (!responseChannel ? 'missing_message_identity'
            : !channelMatches ? 'message_channel_mismatch'
              : 'missing_message_identity')
          : null)));
  return {
    method,
    ...(segmentIndex === null ? {} : { segment_index: segmentIndex }),
    attempted,
    http_status: httpStatus,
    http_ok: httpOk,
    slack_ok: slackOk,
    ok: attempted && httpOk && slackOk && messageIdentityOk,
    ts: messageTimestamp,
    channel: responseChannel,
    error: providerError ? String(providerError).slice(0, 300) : null,
  };
}

function slackDeliveryError(message, {
  code = 'slack_delivery_failed',
  receipt = null,
  receipts = [],
  cause = null,
} = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.slack_receipt = receipt;
  error.delivery_receipts = receipts.length ? receipts : (receipt ? [receipt] : []);
  error.segment_receipts = error.delivery_receipts
    .filter(item => Number.isInteger(item?.segment_index));
  error.delivered_segments = error.segment_receipts.filter(item => item.ok).length;
  error.attempted_segments = error.segment_receipts.filter(item => item.attempted).length;
  error.partial_delivery = error.delivered_segments > 0;
  return error;
}

function requireSlackApiSuccess(response, context = {}) {
  const receipt = slackApiReceipt(response, context);
  if (receipt.ok) return receipt;
  const detail = receipt.error
    || (!receipt.http_ok ? `HTTP ${receipt.http_status ?? 'status unavailable'}` : 'ok=false');
  throw slackDeliveryError(`${receipt.method} failed: ${detail}`, {
    code: 'slack_api_failed',
    receipt,
  });
}

async function callSlackApi(operation, context = {}) {
  let response;
  try {
    response = await operation();
  } catch (cause) {
    const receipt = slackApiReceipt(cause?.response, {
      ...context,
      error: cause?.response?.data?.error || cause?.message || 'request_failed',
    });
    throw slackDeliveryError(`${receipt.method} failed: ${receipt.error || 'request failed'}`, {
      code: 'slack_api_failed',
      receipt,
      cause,
    });
  }
  return { response, receipt: requireSlackApiSuccess(response, context) };
}

function slackUploadTransportReceipt(response, {
  method = 'files.externalUpload',
  attempted = true,
  error = null,
} = {}) {
  const httpStatus = Number.isFinite(Number(response?.status))
    ? Number(response.status)
    : null;
  const httpOk = isHttpSuccess(response);
  const providerError = error
    || (!httpOk ? `http_${httpStatus ?? 'status_unavailable'}` : null);
  return {
    method,
    attempted,
    http_status: httpStatus,
    http_ok: httpOk,
    slack_ok: null,
    ok: attempted && httpOk,
    ts: null,
    channel: null,
    error: providerError ? String(providerError).slice(0, 300) : null,
  };
}

async function callSlackUploadUrl(operation) {
  let response;
  try {
    response = await operation();
  } catch (cause) {
    const receipt = slackUploadTransportReceipt(cause?.response, {
      error: cause?.response?.data?.error || cause?.message || 'request_failed',
    });
    throw slackDeliveryError(`files.externalUpload failed: ${receipt.error || 'request failed'}`, {
      code: 'slack_file_upload_failed',
      receipt,
      cause,
    });
  }
  const receipt = slackUploadTransportReceipt(response);
  if (!receipt.ok) {
    throw slackDeliveryError(`files.externalUpload failed: ${receipt.error}`, {
      code: 'slack_file_upload_failed',
      receipt,
    });
  }
  return { response, receipt };
}

function slackPostPayload({ channel, text, delivery, blocks = null, clientMsgId = null }) {
  const payload = { channel, text };
  if (blocks) payload.blocks = blocks;
  if (delivery?.thread_ts) payload.thread_ts = delivery.thread_ts;
  if (delivery?.reply_broadcast) payload.reply_broadcast = true;
  if (clientMsgId) payload.client_msg_id = String(clientMsgId);
  return payload;
}

async function postSlackSegments({
  channel,
  segments,
  delivery,
  blocks = null,
  post,
  token,
  deadlineAt = Date.now() + 5000,
  maximumRequestMs = 5000,
  minimumRequestMs = 250,
  pauseMs = index => index > 0 ? 900 + Math.floor(Math.random() * 900) : 0,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  onReceipt = null,
  onDurableReceipt = null,
  beforePost = null,
  clientMsgId = null,
  existingReceipts = [],
  existingFirstResponse = null,
} = {}) {
  const messages = (Array.isArray(segments) ? segments : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (!channel || !messages.length || typeof post !== 'function') {
    throw slackDeliveryError('Slack segment delivery requires a channel, message segments, and a post function', {
      code: 'invalid_slack_delivery',
    });
  }

  const successfulExistingReceipts = new Map(
    (Array.isArray(existingReceipts) ? existingReceipts : [])
      .filter(receipt => receipt?.ok === true
        && Number.isInteger(receipt.segment_index))
      .map(receipt => [receipt.segment_index, { ...receipt }]),
  );
  const receipts = [];
  const responses = existingFirstResponse?.ok === true
    ? [{ data: { ...existingFirstResponse } }]
    : [];
  const receiptCallbackErrors = [];
  for (let index = 0; index < messages.length; index++) {
    const existingReceipt = successfulExistingReceipts.get(index);
    if (existingReceipt) {
      receipts.push(existingReceipt);
      continue;
    }
    const delay = Math.max(0, Number(pauseMs(index)) || 0);
    if (delay > 0) {
      const pauseBudgetMs = Number(deadlineAt) - Date.now() - minimumRequestMs;
      if (pauseBudgetMs <= 0) {
        const receipt = slackApiReceipt(null, {
          method: 'chat.postMessage',
          segmentIndex: index,
          attempted: false,
          error: 'delivery_deadline_exceeded',
        });
        receipts.push(receipt);
        throw slackDeliveryError('Slack segmented delivery exceeded its deadline between segments', {
          code: 'slack_delivery_deadline_exceeded',
          receipt,
          receipts,
        });
      }
      await wait(Math.min(delay, pauseBudgetMs));
    }

    const remainingMs = Number(deadlineAt) - Date.now();
    if (remainingMs < minimumRequestMs) {
      const receipt = slackApiReceipt(null, {
        method: 'chat.postMessage',
        segmentIndex: index,
        attempted: false,
        error: 'delivery_deadline_exceeded',
      });
      receipts.push(receipt);
      throw slackDeliveryError('Slack segmented delivery exceeded its deadline before posting', {
        code: 'slack_delivery_deadline_exceeded',
        receipt,
        receipts,
      });
    }

    if (typeof beforePost === 'function') {
      try {
        await beforePost({ segment_index: index, remaining_ms: remainingMs });
      } catch (cause) {
        const receipt = slackApiReceipt(null, {
          method: 'chat.postMessage',
          segmentIndex: index,
          attempted: false,
          error: cause?.code || cause?.message || 'delivery_lease_lost',
        });
        receipts.push(receipt);
        const failed = slackDeliveryError(
          `Slack segmented delivery lost its durable lease before segment ${index + 1}`,
          {
            code: [
              'slack_reply_stage_policy_blocked',
              'slack_reply_stage_policy_unavailable',
            ].includes(cause?.code)
              ? cause.code
              : 'slack_delivery_lease_lost',
            receipt,
            receipts,
            cause,
          },
        );
        failed.first_response = responses[0] || null;
        throw failed;
      }
    }

    try {
      const result = await callSlackApi(() => post(
        'https://slack.com/api/chat.postMessage',
        slackPostPayload({
          channel,
          text: messages[index],
          delivery,
          blocks: index === 0 ? blocks : null,
          clientMsgId: segmentedSlackClientMsgId(clientMsgId, index),
        }),
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: Math.min(maximumRequestMs, remainingMs),
        },
      ), {
        method: 'chat.postMessage',
        segmentIndex: index,
        expectedChannel: channel,
      });
      responses.push(result.response);
      receipts.push(result.receipt);
      if (typeof onReceipt === 'function') {
        try {
          await onReceipt(result.receipt, result.response, index);
        } catch (error) {
          // Metrics/receipt observers run after Slack has acknowledged delivery. Their
          // failure must never turn a successful post into a retryable egress failure.
          receiptCallbackErrors.push({
            segment_index: index,
            error: String(error?.message || error || 'receipt_callback_failed').slice(0, 300),
          });
        }
      }
      if (typeof onDurableReceipt === 'function') {
        try {
          await onDurableReceipt(result.receipt, result.response, index);
        } catch (cause) {
          const failed = slackDeliveryError(
            `Slack acknowledged segment ${index + 1}, but its durable receipt could not be committed`,
            {
              code: 'slack_delivery_receipt_persistence_failed',
              receipt: result.receipt,
              receipts,
              cause,
            },
          );
          failed.delivery_confirmed = true;
          failed.first_response = responses[0] || null;
          throw failed;
        }
      }
    } catch (error) {
      if (error.code === 'slack_delivery_receipt_persistence_failed') {
        throw error;
      }
      const receipt = error.slack_receipt || slackApiReceipt(error?.response, {
        method: 'chat.postMessage',
        segmentIndex: index,
        expectedChannel: channel,
        error: error.message,
      });
      receipts.push(receipt);
      const failed = slackDeliveryError(
        `Slack segmented delivery failed at segment ${index + 1} of ${messages.length}: ${receipt.error || error.message}`,
        {
          code: 'slack_segment_delivery_failed',
          receipt,
          receipts,
          cause: error,
        },
      );
      failed.first_response = responses[0] || null;
      throw failed;
    }
  }

  return {
    ok: true,
    segment_receipts: receipts,
    receipt_callback_errors: receiptCallbackErrors,
    first_response: responses[0] || null,
    last_response: responses.at(-1) || null,
  };
}

async function fetchSlackThreadPages({
  channel,
  threadTs,
  get,
  token,
  signal = undefined,
  deadlineMs = 6000,
  pageSize = 50,
  maxPages = 20,
  now = Date.now,
} = {}) {
  if (!channel || !threadTs || typeof get !== 'function') {
    throw slackDeliveryError('Slack thread pagination requires channel, thread timestamp, and get function', {
      code: 'invalid_slack_thread_fetch',
    });
  }
  const startedAt = now();
  const boundedDeadlineMs = Math.max(25, Math.min(15000, Number(deadlineMs) || 6000));
  const terminalAt = startedAt + boundedDeadlineMs;
  const boundedPageSize = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const boundedMaxPages = Math.max(1, Math.min(40, Number(maxPages) || 20));
  const messages = [];
  const seen = new Set();
  const receipts = [];
  const deadlineController = new AbortController();
  const requestSignal = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, deadlineController.signal])
    : signal || deadlineController.signal;
  let cursor = '';
  let page = 0;
  let deadlineTimer = null;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      const error = slackDeliveryError('conversations.replies exceeded its bounded deadline', {
        code: 'slack_thread_fetch_deadline_exceeded',
        receipts: [...receipts],
      });
      deadlineController.abort(error);
      reject(error);
    }, boundedDeadlineMs);
  });
  const paginate = async () => {
    do {
      if (page >= boundedMaxPages) {
        throw slackDeliveryError(`conversations.replies exceeded its ${boundedMaxPages}-page bound`, {
          code: 'slack_thread_page_limit_exceeded',
          receipts,
        });
      }
      const remainingMs = terminalAt - now();
      if (remainingMs < 10) {
        throw slackDeliveryError('conversations.replies exceeded its bounded deadline', {
          code: 'slack_thread_fetch_deadline_exceeded',
          receipts,
        });
      }
      const params = new URLSearchParams({
        channel: String(channel),
        ts: String(threadTs),
        limit: String(boundedPageSize),
      });
      if (cursor) params.set('cursor', cursor);
      const result = await callSlackApi(() => get(
        `https://slack.com/api/conversations.replies?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: Math.min(6000, remainingMs),
          signal: requestSignal,
        },
      ), { method: 'conversations.replies' });
      receipts.push(result.receipt);
      page += 1;
      for (const message of Array.isArray(result.response.data?.messages)
        ? result.response.data.messages
        : []) {
        const key = String(message?.ts || `${page}:${messages.length}`);
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(message);
      }
      cursor = String(result.response.data?.response_metadata?.next_cursor || '').trim();
    } while (cursor);

    messages.sort((left, right) => Number(left?.ts || 0) - Number(right?.ts || 0));
    return { messages, pages: page, receipts, complete: true };
  };
  try {
    return await Promise.race([paginate(), deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function buildSlackExtractionOrigin({
  channel,
  user,
  threadTs = '',
  triggerTs = null,
  botId = null,
  attestation = null,
} = {}) {
  const rawChannel = String(channel || '').replace(/^slack:/, '');
  const normalizedThread = String(threadTs || '');
  const normalizedTrigger = String(triggerTs || '');
  const anchor = normalizedThread || normalizedTrigger || String(user || '') || rawChannel || 'interaction';
  const debounceKey = `slack:${rawChannel || 'channel'}:${anchor}`;
  return {
    kind: 'slack',
    channel: rawChannel ? `slack:${rawChannel}` : 'slack',
    user: String(user || ''),
    thread_ts: normalizedThread,
    external_id: normalizedTrigger || null,
    bot_id: String(botId || 'nora-slack'),
    source_bot_id: '',
    debounce_key: debounceKey,
    dedupe_key: debounceKey,
    attestation: attestation || null,
  };
}

function selectSlackNotificationTarget({
  channel,
  user,
  deliveryMode,
} = {}) {
  const normalizedDeliveryMode = String(deliveryMode || 'auto').trim().toLowerCase();
  const directMode = normalizedDeliveryMode === 'dm';
  const channelMode = ['channel', 'thread', 'thread_broadcast']
    .includes(normalizedDeliveryMode);
  let target;
  let selectedUser = false;
  if (directMode) {
    if (!user) {
      throw slackDeliveryError('delivery_mode=dm requires an explicit user target', {
        code: 'invalid_slack_notification_target',
      });
    }
    target = user;
    selectedUser = true;
  } else if (channelMode) {
    if (!channel) {
      throw slackDeliveryError(`delivery_mode=${normalizedDeliveryMode} requires an explicit channel target`, {
        code: 'invalid_slack_notification_target',
      });
    }
    target = channel;
  } else {
    if (channel && user) {
      throw slackDeliveryError('channel and user are ambiguous without an explicit delivery_mode', {
        code: 'ambiguous_slack_notification_target',
      });
    }
    target = channel || user;
    selectedUser = Boolean(user);
  }
  return {
    target: target || null,
    selected_user: selectedUser,
    delivery_mode: normalizedDeliveryMode,
  };
}

async function deliverSlackNotification(input = {}, {
  post,
  get,
  token,
  delivery = null,
  onThreadJoined = null,
  controlTimeoutMs = 6000,
  fileTimeoutMs = 15000,
  fileMaxBytes = MAX_NOTIFICATION_FILE_BYTES,
  resolveHost = undefined,
} = {}) {
  const {
    channel,
    user,
    text,
    blocks,
    file_url: fileUrl,
    file_name: fileName,
    thread_ts: threadTs,
    delivery_mode: deliveryMode,
    materiality,
    source_ts: sourceTs,
    channel_type: requestedChannelType,
    client_msg_id: clientMsgId,
  } = input;
  const selectedTarget = selectSlackNotificationTarget({
    channel,
    user,
    deliveryMode,
  });
  const target = selectedTarget.target;
  if (!target || !String(text || '').trim()) {
    throw slackDeliveryError('channel or user, and text are required', {
      code: 'invalid_slack_notification',
    });
  }
  if (typeof post !== 'function') {
    throw slackDeliveryError('Slack notification delivery requires a post function', {
      code: 'invalid_slack_notification',
    });
  }
  const hasFileUrl = Boolean(String(fileUrl || '').trim());
  const hasFileName = Boolean(String(fileName || '').trim());
  if (hasFileUrl !== hasFileName) {
    throw slackDeliveryError('Slack file delivery requires both file_url and file_name', {
      code: 'invalid_slack_notification',
    });
  }
  if (hasFileUrl && typeof get !== 'function') {
    throw slackDeliveryError('Slack file delivery requires a get function', {
      code: 'invalid_slack_notification',
    });
  }
  const boundedFileMaxBytes = Math.max(1, Math.min(
    MAX_NOTIFICATION_FILE_BYTES,
    Number(fileMaxBytes) || MAX_NOTIFICATION_FILE_BYTES,
  ));
  const boundedFileTimeoutMs = Math.max(250, Math.min(
    MAX_NOTIFICATION_FILE_TIMEOUT_MS,
    Number(fileTimeoutMs) || 15000,
  ));
  // Resolve and validate before posting the accompanying text. Invalid or private URLs therefore
  // cannot create a misleading partial Slack delivery, and the connection itself is pinned to
  // the exact public addresses that passed this check.
  const pinnedFile = hasFileUrl
    ? await resolvePinnedNotificationFileUrl(fileUrl, {
      resolveHost,
      resolutionTimeoutMs: Math.min(MAX_NOTIFICATION_DNS_TIMEOUT_MS, boundedFileTimeoutMs),
    })
    : null;

  const deliveryReceipts = [];
  let channelId = String(target);
  const directTarget = selectedTarget.selected_user
    || /^[UD][A-Z0-9]+$/i.test(channelId)
    || requestedChannelType === 'im'
    || requestedChannelType === 'mpim';

  try {
    if (/^U[A-Z0-9]+$/i.test(channelId)) {
      const opened = await callSlackApi(() => post(
        'https://slack.com/api/conversations.open',
        { users: channelId },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: controlTimeoutMs,
        },
      ), { method: 'conversations.open' });
      deliveryReceipts.push(opened.receipt);
      if (!opened.response.data?.channel?.id) {
        const receipt = {
          ...opened.receipt,
          ok: false,
          error: 'missing_channel_id',
        };
        deliveryReceipts[deliveryReceipts.length - 1] = receipt;
        throw slackDeliveryError('conversations.open succeeded without a channel id', {
          code: 'slack_api_invalid_response',
          receipt,
          receipts: deliveryReceipts,
        });
      }
      channelId = opened.response.data.channel.id;
    }

    const resolvedDelivery = delivery || resolveSlackDelivery({
      channelType: directTarget || /^D/i.test(channelId)
        ? 'im'
        : requestedChannelType,
      threadTs,
      sourceTs,
      deliveryMode,
      materiality,
    });
    const posted = await postSlackSegments({
      channel: channelId,
      segments: [text],
      delivery: resolvedDelivery,
      blocks,
      post,
      token,
      deadlineAt: Date.now() + controlTimeoutMs,
      maximumRequestMs: controlTimeoutMs,
      pauseMs: () => 0,
      clientMsgId,
    });
    deliveryReceipts.push(...posted.segment_receipts);

    if (pinnedFile) {
      const fileData = await get(pinnedFile.url, {
        responseType: 'arraybuffer',
        timeout: boundedFileTimeoutMs,
        maxContentLength: boundedFileMaxBytes,
        maxBodyLength: boundedFileMaxBytes,
        maxRedirects: 0,
        validateStatus: () => true,
        httpsAgent: pinnedFile.httpsAgent,
        // A process-level HTTPS proxy would resolve the hostname outside this pinned agent and
        // defeat the same-origin DNS guarantee. File retrieval is intentionally direct.
        proxy: false,
        headers: {
          Accept: 'application/octet-stream, application/pdf, image/*, text/plain, */*',
          // Explicitly mask process-wide Axios defaults. Slack bearer credentials must never
          // accompany an untrusted notification file request.
          Authorization: undefined,
          'Proxy-Authorization': undefined,
          Cookie: undefined,
        },
      });
      if (Number(fileData?.status) >= 300 && Number(fileData?.status) < 400) {
        throw slackDeliveryError('Slack notification file redirects are not accepted', {
          code: 'slack_file_redirect_rejected',
          receipts: deliveryReceipts,
        });
      }
      if (!isHttpSuccess(fileData)) {
        throw slackDeliveryError(`Slack notification file download failed: HTTP ${fileData?.status ?? 'status unavailable'}`, {
          code: 'slack_file_download_failed',
          receipts: deliveryReceipts,
        });
      }
      const fileBytes = Buffer.isBuffer(fileData.data)
        ? fileData.data
        : Buffer.from(fileData.data || []);
      if (fileBytes.byteLength > boundedFileMaxBytes) {
        throw slackDeliveryError(`Slack notification file exceeds the ${boundedFileMaxBytes}-byte limit`, {
          code: 'slack_file_too_large',
          receipts: deliveryReceipts,
        });
      }
      const uploadTicket = await callSlackApi(() => post(
        'https://slack.com/api/files.getUploadURLExternal',
        {
          filename: String(fileName),
          length: fileBytes.byteLength,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: boundedFileTimeoutMs,
        },
      ), { method: 'files.getUploadURLExternal' });
      deliveryReceipts.push(uploadTicket.receipt);
      const uploadUrl = String(uploadTicket.response.data?.upload_url || '');
      const fileId = String(uploadTicket.response.data?.file_id || '');
      if (!uploadUrl || !fileId) {
        const receipt = {
          ...uploadTicket.receipt,
          ok: false,
          error: 'missing_upload_url_or_file_id',
        };
        deliveryReceipts[deliveryReceipts.length - 1] = receipt;
        throw slackDeliveryError('files.getUploadURLExternal succeeded without an upload URL and file id', {
          code: 'slack_api_invalid_response',
          receipt,
          receipts: deliveryReceipts,
        });
      }
      const uploaded = await callSlackUploadUrl(() => post(
        uploadUrl,
        fileBytes,
        {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileBytes.byteLength,
          },
          timeout: boundedFileTimeoutMs,
          maxBodyLength: boundedFileMaxBytes,
        },
      ));
      deliveryReceipts.push(uploaded.receipt);
      const completionPayload = {
        files: [{ id: fileId, title: String(fileName) }],
        channel_id: channelId,
      };
      if (resolvedDelivery.thread_ts) {
        completionPayload.thread_ts = resolvedDelivery.thread_ts;
      }
      const completed = await callSlackApi(() => post(
        'https://slack.com/api/files.completeUploadExternal',
        completionPayload,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: boundedFileTimeoutMs,
        },
      ), { method: 'files.completeUploadExternal' });
      deliveryReceipts.push(completed.receipt);
    }

    const postedTs = posted.first_response?.data?.ts || null;
    const effectiveThread = resolvedDelivery.thread_ts || postedTs;
    if (channelId && !/^D/i.test(channelId) && effectiveThread
      && typeof onThreadJoined === 'function') {
      await onThreadJoined(channelId, effectiveThread);
    }
    return {
      ok: true,
      channel: channelId,
      ts: postedTs,
      delivery: resolvedDelivery,
      delivery_receipts: deliveryReceipts,
    };
  } catch (error) {
    const nested = Array.isArray(error.delivery_receipts)
      ? error.delivery_receipts
      : [];
    error.delivery_receipts = [
      ...deliveryReceipts,
      ...nested.filter(receipt => !deliveryReceipts.includes(receipt)),
    ];
    error.segment_receipts = error.delivery_receipts
      .filter(item => Number.isInteger(item?.segment_index));
    error.delivered_segments = error.segment_receipts.filter(item => item.ok).length;
    error.partial_delivery = error.delivered_segments > 0;
    throw error;
  }
}

module.exports = {
  MAX_NOTIFICATION_FILE_BYTES,
  MAX_NOTIFICATION_FILE_TIMEOUT_MS,
  deterministicSlackClientMsgId,
  segmentedSlackClientMsgId,
  networkAddressIsGlobal,
  parseNotificationFileUrl,
  resolvePinnedNotificationFileUrl,
  isHttpSuccess,
  slackApiReceipt,
  requireSlackApiSuccess,
  callSlackApi,
  slackPostPayload,
  postSlackSegments,
  fetchSlackThreadPages,
  buildSlackExtractionOrigin,
  selectSlackNotificationTarget,
  deliverSlackNotification,
};
