'use strict';

const MAX_SLACK_AUDIT_TEXT_CHARS = 100000;

function cleanText(value, max = MAX_SLACK_AUDIT_TEXT_CHARS) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max);
}

function slackAuditInteractionId(channel, eventTs) {
  const cleanChannel = cleanText(channel, 120)?.trim();
  const cleanTs = cleanText(eventTs, 80)?.trim();
  if (!cleanChannel || !cleanTs) return null;
  return `slack:${cleanChannel}:${cleanTs}`;
}

function shouldAuditSlackInbound(event, { joinedThread = false } = {}) {
  if (!event || event.bot_id || event.subtype === 'bot_message') return false;
  if (event.channel_type === 'im' || event.channel_type === 'mpim') return true;
  if (event.type === 'app_mention') return true;
  return !!event.thread_ts && joinedThread;
}

function createSlackConversationAudit({ db, databaseReady = () => true, logger = console } = {}) {
  if (!db) throw new Error('Slack conversation audit requires a database adapter');

  async function persist(label, work) {
    if (!databaseReady()) return false;
    try {
      await work();
      return true;
    } catch (error) {
      // Observability must never become the reason Nora fails to answer a person. Production
      // requires Postgres before accepting traffic, so this is a containment path for a transient
      // write failure rather than an alternate source of truth.
      logger.warn(`Slack conversation audit ${label} failed: ${error.message}`);
      return false;
    }
  }

  async function recordInbound({ interactionId, slackEventId, channelId, channelType, threadTs,
    inboundTs, userId, inboundText, metadata = {} } = {}) {
    const id = interactionId || slackAuditInteractionId(channelId, inboundTs);
    if (!id) return { interaction_id: null, persisted: false };
    const persisted = await persist('inbound write', () => db.upsertSlackConversationAudit({
      interaction_id: id,
      slack_event_id: cleanText(slackEventId, 160),
      channel_id: cleanText(channelId, 120),
      channel_type: cleanText(channelType, 40),
      thread_ts: cleanText(threadTs, 80),
      inbound_ts: cleanText(inboundTs, 80),
      user_id: cleanText(userId, 120),
      inbound_text: cleanText(inboundText) || '',
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
    }));
    return { interaction_id: id, persisted };
  }

  async function mark(interactionId, patch = {}) {
    const id = cleanText(interactionId, 300)?.trim();
    if (!id) return false;
    const cleanPatch = { ...patch };
    const textFields = {
      handling_status: 80,
      response_kind: 40,
      response_text: MAX_SLACK_AUDIT_TEXT_CHARS,
      user_name: 240,
      channel_name: 240,
      error: 2000,
    };
    for (const [field, max] of Object.entries(textFields)) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        cleanPatch[field] = cleanText(patch[field], max);
      }
    }
    if (patch.response_slack_timestamps !== undefined) {
      cleanPatch.response_slack_timestamps = Array.isArray(patch.response_slack_timestamps)
        ? patch.response_slack_timestamps.slice(0, 10).map(value => cleanText(value, 80)).filter(Boolean)
        : [];
    }
    return persist('outcome update', () => db.updateSlackConversationAudit(id, cleanPatch));
  }

  return { recordInbound, mark };
}

module.exports = {
  MAX_SLACK_AUDIT_TEXT_CHARS,
  slackAuditInteractionId,
  shouldAuditSlackInbound,
  createSlackConversationAudit,
};
