'use strict';

const CONTEXT_LIMIT = 1200;

function clean(value, max = CONTEXT_LIMIT) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isHumanMessage(message) {
  return Boolean(message?.user && message?.text)
    && !message.bot_id && !message.app_id && message.subtype !== 'bot_message';
}

function createSlackCommunicationMonitorEnricher({ axios, headers, logger = console } = {}) {
  const destinationCache = new Map();
  const userCache = new Map();

  async function slackGet(method, params) {
    const query = new URLSearchParams(params).toString();
    const response = await axios.get(`https://slack.com/api/${method}?${query}`, {
      headers, timeout: 6000, noraCommunicationMirror: true,
    });
    if (!response.data?.ok) throw new Error(`${method}: ${response.data?.error || 'Slack lookup failed'}`);
    return response.data;
  }

  async function resolveUserName(userId) {
    if (!userId) return '';
    if (userCache.has(userId)) return userCache.get(userId);
    try {
      const data = await slackGet('users.info', { user: userId });
      const user = data.user || {};
      const profile = user.profile || {};
      const name = clean(profile.real_name || profile.display_name || user.real_name || user.name, 120);
      userCache.set(userId, name);
      return name;
    } catch (error) {
      logger.warn?.(`Communication monitor could not resolve Slack user ${userId}: ${error.message}`);
      userCache.set(userId, '');
      return '';
    }
  }

  async function resolveDestination(target) {
    if (!target) return 'Slack destination (not specified)';
    if (destinationCache.has(target)) return destinationCache.get(target);
    let label = 'Slack destination (name unavailable)';
    try {
      if (/^U[A-Z0-9]+$/i.test(target)) {
        const name = await resolveUserName(target);
        if (name) label = `DM with ${name}`;
      } else {
        const data = await slackGet('conversations.info', { channel: target });
        const channel = data.channel || {};
        if (channel.is_im || /^D[A-Z0-9]+$/i.test(target)) {
          const name = await resolveUserName(channel.user);
          if (name) label = `DM with ${name}`;
        } else if (channel.name) {
          label = channel.is_mpim ? `Group DM ${clean(channel.name, 120)}` : `#${clean(channel.name, 120)}`;
        }
      }
    } catch (error) {
      logger.warn?.(`Communication monitor could not resolve Slack destination ${target}: ${error.message}`);
    }
    destinationCache.set(target, label);
    return label;
  }

  async function describeMessage(message) {
    const author = await resolveUserName(message?.user);
    const text = clean(message?.text, 800);
    return author ? `${author}: ${text}` : text;
  }

  async function resolveContext(record) {
    if (!record.target) return '';
    try {
      if (record.thread) {
        const data = await slackGet('conversations.replies', {
          channel: record.target, ts: record.thread, limit: '50',
        });
        const messages = (Array.isArray(data.messages) ? data.messages : [])
          .filter(message => message.ts !== record.message_ts && isHumanMessage(message));
        if (!messages.length) return '';
        const original = messages[0];
        const latest = messages[messages.length - 1];
        if (original.ts === latest.ts) return await describeMessage(original);
        return [
          `Original thread: ${await describeMessage(original)}`,
          `Latest teammate message: ${await describeMessage(latest)}`,
        ].join('\n');
      }
      if (!record.message_ts) return '';
      const data = await slackGet('conversations.history', {
        channel: record.target, latest: record.message_ts, inclusive: 'false', limit: '20',
      });
      const prior = (Array.isArray(data.messages) ? data.messages : []).find(isHumanMessage);
      return prior ? `Most recent teammate message before Nora sent this: ${await describeMessage(prior)}` : '';
    } catch (error) {
      logger.warn?.(`Communication monitor could not load Slack context: ${error.message}`);
      return '';
    }
  }

  return async function enrichSlackCommunication(record) {
    if (record?.surface !== 'Slack') return record;
    const [targetLabel, context] = await Promise.all([
      resolveDestination(record.target), resolveContext(record),
    ]);
    return { ...record, target_label: targetLabel,
      context: String(context || '').trim().slice(0, CONTEXT_LIMIT) };
  };
}

module.exports = { createSlackCommunicationMonitorEnricher };
