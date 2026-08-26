'use strict';

const { createSlackCommunicationMonitorEnricher } = require('../surfaces/slack/communication-monitor-context');

const DIRECT_COMMUNICATION = /(?:^|[_-])(?:send|reply|notify|share|invite|schedule)(?:[_-]|$)|(?:^|[_-])(?:add|post|create)(?:[_-])(?:comment|message)(?:[_-]|$)/i;
const CALENDAR_COMMUNICATION = /(?:^|[_-])(?:create|update|cancel|schedule|invite)(?:[_-]).*(?:calendar|event|meeting)|(?:calendar|event|meeting).*(?:[_-])(?:create|update|cancel|schedule|invite)(?:[_-]|$)/i;
const TASK_COMMUNICATION = /(?:^|[_-])(?:create|update|assign|complete|reopen)(?:[_-])(?:task|ticket)(?:[_-]|$)|(?:^|[_-])(?:task|ticket)(?:[_-])(?:create|update|assign|complete|reopen)(?:[_-]|$)/i;
const SECRET_FIELD = /token|secret|password|authorization|credential|api[_-]?key|cookie/i;
const RECIPIENT_FIELD = /^(?:to|recipient|recipients|email|emails|user|users|user_id|user_ids|attendee|attendees|assignee|assignees|channel)$/i;
const JOHN = /\bjohn\b|kuefler|johnkuefler@/i;
const MAX_TEXT = 3200;

function clean(value, max = 1000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseBody(value) {
  if (!value) return {};
  if (typeof value === 'object' && !(value instanceof Buffer)) return value;
  try { return JSON.parse(String(value)); } catch { return { text: String(value) }; }
}

function safeValue(value, key = '', depth = 0) {
  if (SECRET_FIELD.test(key)) return '[redacted]';
  if (depth > 5) return '[depth limited]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
    const out = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 60)) {
      out[childKey] = safeValue(childValue, childKey, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 5000);
  return value;
}

function recipientValues(input, values = []) {
  if (!input || typeof input !== 'object') return values;
  for (const [key, value] of Object.entries(input)) {
    if (RECIPIENT_FIELD.test(key)) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) if (item != null && typeof item !== 'object') values.push(String(item));
    } else if (value && typeof value === 'object') recipientValues(value, values);
  }
  return values;
}

function targetsOnlyJohn(args) {
  const values = recipientValues(args);
  return values.length > 0 && values.every(value => JOHN.test(value));
}

function isCommunicationTool(toolName) {
  const name = String(toolName || '');
  return DIRECT_COMMUNICATION.test(name) || CALENDAR_COMMUNICATION.test(name)
    || TASK_COMMUNICATION.test(name);
}

function toolCommunication({ surface, connectionName, toolName, args, result, writeCapable,
  fleetAuthority } = {}) {
  const fleetChange = writeCapable === true && /fleet/i.test(String(connectionName || ''));
  if (writeCapable === false || (!fleetChange && !isCommunicationTool(toolName))
    || result?.isError === true || (!fleetChange && targetsOnlyJohn(args))) return null;
  if (fleetChange) {
    return {
      surface: clean(connectionName || 'LimeLight Fleet', 120),
      action: clean(toolName || 'Fleet change', 160),
      target: clean(args?.slug || 'Fleet control plane', 500),
      exact: JSON.stringify(safeValue({
        requester: fleetAuthority ? {
          name: fleetAuthority.requesterName,
          slack_user_id: fleetAuthority.requesterId,
          interaction: fleetAuthority.interactionRef,
          request: fleetAuthority.requestText,
        } : 'unattributed',
        change: args || {},
        provider_result: result || {},
      }), null, 2),
    };
  }
  return {
    surface: clean(surface || connectionName || 'Connected tool', 120),
    action: clean(toolName || 'communication', 160),
    target: recipientValues(args).join(', ').slice(0, 500) || 'recipient recorded in the request',
    exact: JSON.stringify(safeValue(args || {}), null, 2),
  };
}

function httpCommunication(response) {
  const config = response?.config || {};
  if (config.noraCommunicationMirror === true) return null;
  const url = String(config.url || '');
  const payload = parseBody(config.data);
  if (/slack\.com\/api\/chat\.postMessage/i.test(url) && response?.data?.ok === true) {
    return {
      surface: 'Slack', action: 'chat.postMessage',
      target: String(response.data?.channel || payload.channel || ''),
      thread: payload.thread_ts ? String(payload.thread_ts) : '',
      message_ts: response.data?.ts ? String(response.data.ts) : '',
      exact: String(payload.text || (payload.blocks ? JSON.stringify(payload.blocks) : '')),
    };
  }
  if (/\/bot\/[^/]+\/send_chat_message\/?/i.test(url)
    && Number(response?.status || 0) >= 200 && Number(response?.status || 0) < 300) {
    return {
      surface: 'Meeting chat', action: 'send_chat_message', target: 'live meeting participants',
      exact: String(payload.message || payload.text || ''),
    };
  }
  return null;
}

function meetingVoiceCommunication(session, text) {
  const names = session?.participants instanceof Map
    ? [...session.participants.values()].map(item => clean(item?.name, 120)).filter(Boolean) : [];
  if (names.length > 0 && names.every(name => JOHN.test(name))) return null;
  return {
    surface: 'Meeting voice', action: 'spoken response',
    target: names.join(', ').slice(0, 500) || 'live meeting participants',
    exact: String(text || ''),
  };
}

function formatMirror(record, now = new Date()) {
  if (record.surface === 'Slack') {
    const lines = [
      'Nora communication copy',
      '',
      `Destination: ${record.target_label || 'Slack destination (name unavailable)'}`,
      '',
      'What Nora was responding to:',
      String(record.context || '').trim() || '(Slack did not return preceding teammate context.)',
      '',
      'Nora sent:',
      String(record.exact || '').trim() || '(empty)',
      '',
      'Audit details',
      `Sent: ${now.toISOString()}`,
      `Surface: ${record.surface}`,
      `Action: ${record.action}`,
      `Slack target: ${record.target || 'not specified'}`,
    ];
    if (record.thread) lines.push(`Thread: ${record.thread}`);
    if (record.message_ts) lines.push(`Message: ${record.message_ts}`);
    return lines.join('\n').slice(0, MAX_TEXT);
  }
  const lines = [
    'Communication monitor copy',
    `Sent: ${now.toISOString()}`,
    `Surface: ${record.surface}`,
    `Action: ${record.action}`,
    `To: ${record.target || 'not specified'}`,
  ];
  if (record.thread) lines.push(`Thread: ${record.thread}`);
  lines.push('', 'Exact communication or connector request:', String(record.exact || '').trim() || '(empty)');
  return lines.join('\n').slice(0, MAX_TEXT);
}

function createCommunicationMirror({
  openDirectMessage,
  sendMessage,
  resolveJohnSlackId,
  now = () => new Date(),
  logger = console,
  enabled = true,
  enrichRecord = async record => record,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let johnChannel = null;
  let tail = Promise.resolve();
  let pending = 0;
  const stats = { observed: 0, mirrored: 0, skipped_john: 0, failed: 0, last_mirrored_at: null };

  async function resolveJohnChannel() {
    const johnId = clean(resolveJohnSlackId?.(), 120);
    if (!johnId) throw new Error('John Slack recipient is unavailable');
    if (!johnChannel) johnChannel = await openDirectMessage(johnId);
    if (!johnChannel) throw new Error('John Slack DM could not be opened');
    return { johnId, johnChannel };
  }

  async function deliver(record) {
    stats.observed += 1;
    let owner; let lastError;
    for (let attempt = 1; attempt <= 3 && !owner; attempt++) {
      try { owner = await resolveJohnChannel(); }
      catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 250);
      }
    }
    if (!owner) {
      stats.failed += 1;
      logger.warn?.(`Communication monitor copy failed: ${lastError?.message || lastError}`);
      return { sent: false, reason: 'owner_unavailable' };
    }
    if (record.surface === 'Slack' && [owner.johnId, owner.johnChannel].includes(String(record.target))) {
      stats.skipped_john += 1;
      return { sent: false, reason: 'already_sent_to_john' };
    }
    let enrichedRecord = record;
    try { enrichedRecord = await enrichRecord(record) || record; }
    catch (error) {
      logger.warn?.(`Communication monitor enrichment failed: ${error.message}`);
    }
    const message = formatMirror(enrichedRecord, now());
    lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sent = await sendMessage(owner.johnChannel, message);
        if (!sent) throw new Error('Slack rejected the monitor copy');
        stats.mirrored += 1;
        stats.last_mirrored_at = now().toISOString();
        return { sent: true };
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 250);
      }
    }
    stats.failed += 1;
    logger.warn?.(`Communication monitor copy failed: ${lastError?.message || lastError}`);
    return { sent: false, reason: 'delivery_failed' };
  }

  function observe(record) {
    if (!enabled) return Promise.resolve({ sent: false, reason: 'disabled' });
    if (!record) return Promise.resolve({ sent: false, reason: 'not_communication' });
    pending += 1;
    const queued = tail.then(() => deliver(record)).finally(() => { pending = Math.max(0, pending - 1); });
    tail = queued.catch(() => {});
    return queued;
  }

  function observeHttpResponse(response) {
    return observe(httpCommunication(response));
  }

  function observeTool(event) {
    return observe(toolCommunication(event));
  }

  function installHttpObserver(axios) {
    return axios.interceptors.response.use(response => {
      observeHttpResponse(response).catch(error => logger.warn?.(`Communication observer failed: ${error.message}`));
      return response;
    });
  }

  function snapshot() { return { enabled, ...stats, pending }; }
  function drain() { return tail; }
  return { observe, observeHttpResponse, observeTool, installHttpObserver, snapshot, drain };
}

function createSlackCommunicationMirror({ axios, slackToken, resolveJohnSlackId,
  now, logger, enabled = true } = {}) {
  const headers = { Authorization: `Bearer ${slackToken}` };
  const enrichRecord = createSlackCommunicationMonitorEnricher({ axios, headers, logger });
  const mirror = createCommunicationMirror({
    resolveJohnSlackId, now, logger, enabled, enrichRecord,
    openDirectMessage: async johnId => {
      const response = await axios.post('https://slack.com/api/conversations.open', { users: johnId },
        { headers, timeout: 6000, noraCommunicationMirror: true });
      if (!response.data?.ok) throw new Error(response.data?.error || 'Slack DM open failed');
      return response.data?.channel?.id || johnId;
    },
    sendMessage: async (channel, text) => {
      const response = await axios.post('https://slack.com/api/chat.postMessage', { channel, text },
        { headers, timeout: 6000, noraCommunicationMirror: true });
      return response.data?.ok === true;
    },
  });
  mirror.installHttpObserver(axios);
  return mirror;
}

function wrapCommunicationTools(tools, names, mirror, surface) {
  for (const tool of tools || []) {
    if (!names?.has(tool?.definition?.name) || typeof tool.execute !== 'function') continue;
    const execute = tool.execute;
    tool.execute = async (args, options) => {
      const result = await execute(args, options);
      mirror.observeTool({ surface, toolName: tool.definition.name, args, result }).catch(() => {});
      return result;
    };
  }
  return tools;
}

module.exports = {
  isCommunicationTool,
  targetsOnlyJohn,
  toolCommunication,
  httpCommunication,
  meetingVoiceCommunication,
  formatMirror,
  createCommunicationMirror,
  createSlackCommunicationMirror,
  wrapCommunicationTools,
};
