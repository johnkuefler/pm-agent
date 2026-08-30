'use strict';

// Everything that talks to the Slack Web API: reading threads and channel history, resolving user
// and channel names, posting messages, and reactions. Network I/O lives here so the policy layer
// above stays pure and the handler above that stays about conversation rather than transport.

const axios = require('axios');
const { slackMessageAllText } = require('./conversation-policy');
const { SLACK_TABLE_FORMATTING_INSTRUCTION, normalizeSlackMrkdwn,
  formatSlackMessagePayload } = require('./table-format');

// Resolve a Slack user ID to a real display name via users.info. Cached in-memory for
// 24h so repeat lookups within the same hot session don't hammer Slack's API. Returns
// null on failure, and handleSlack falls back to the bare user ID.
const slackUserIdentityCache = {};

const SLACK_USER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getSlackUserIdentity(userId, { signal = undefined } = {}) {
  if (!userId) return null;
  const cached = slackUserIdentityCache[userId];
  if (cached && (Date.now() - cached.ts) < SLACK_USER_CACHE_TTL_MS) return cached.identity;
  try {
    const r = await axios.get(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      timeout: 5000, signal,
    });
    if (!r.data?.ok) {
      console.warn(`Slack users.info not ok for ${userId}: ${r.data?.error}`);
      return null;
    }
    const member = r.data.user || {};
    const profile = member.profile || {};
    const name = profile.real_name || profile.display_name || member.real_name || member.name || null;
    const identity = Object.freeze({
      id: String(member.id || userId), name,
      isBot: member.is_bot === true, isAppUser: member.is_app_user === true,
      deleted: member.deleted === true,
      fullMember: member.is_restricted !== true && member.is_ultra_restricted !== true,
    });
    slackUserIdentityCache[userId] = { identity, ts: Date.now() };
    return identity;
  } catch (err) {
    if (!signal?.aborted) console.warn('Slack users.info lookup failed:', err.message);
    return null;
  }
}

async function getSlackUserName(userId, options = {}) {
  return (await getSlackUserIdentity(userId, options))?.name || null;
}

// Convert Slack's wire formatting to readable text: <@U123> → @name, <url|label> → "label (url)",
// <url> → url, <#C123|chan> → #chan. Used when feeding fetched thread messages to Claude.
async function cleanSlackText(text, resolveUserName = getSlackUserName) {
  let t = text || '';
  // Resolve user mentions to names (collect, resolve, replace)
  const mentions = [...new Set((t.match(/<@([A-Z0-9]+)>/g) || []).map(m => m.slice(2, -1)))];
  for (const uid of mentions) {
    const name = await resolveUserName(uid);
    t = t.replace(new RegExp(`<@${uid}>`, 'g'), name ? `@${name}` : '@someone');
  }
  t = t.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');           // channel refs
  t = t.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, '$2 ($1)'); // labeled links
  t = t.replace(/<(https?:\/\/[^>]+)>/g, '$1');             // bare links
  return t.trim();
}

// Fetch the full Slack thread (conversations.replies) so Nora has the WHOLE conversation,
// including messages posted before she was mentioned, which her in-memory history misses.
// Returns the raw Slack message array (newest-inclusive) or null on failure (e.g. missing
// channels:history scope), in which case the caller falls back to in-memory history.
async function fetchSlackThread(channel, threadTs, { signal = undefined } = {}) {
  try {
    const r = await axios.get(`https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=50`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 6000, signal,
    });
    if (!r.data || !r.data.ok) { console.warn('conversations.replies not ok:', r.data && r.data.error); return null; }
    return Array.isArray(r.data.messages) ? r.data.messages : null;
  } catch (err) {
    if (!signal?.aborted) console.warn('fetchSlackThread failed:', err.message);
    return null;
  }
}

// Pull the recent channel conversation (conversations.history) so an explicit request sees
// the surrounding discussion, not just the single top-level message that triggered handling. A
// non-threaded channel message has no "thread," so fetchSlackThread would return just that one
// line and Nora would be reacting with zero context. Returns the raw Slack messages in
// chronological order (oldest→newest, ending with the trigger) or null on failure.
async function fetchSlackChannelHistory(channel, latestTs, limit = 12,
  { signal = undefined } = {}) {
  try {
    const params = new URLSearchParams({ channel, limit: String(limit), inclusive: 'true' });
    if (latestTs) params.set('latest', latestTs);
    const r = await axios.get(`https://slack.com/api/conversations.history?${params.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 6000, signal,
    });
    if (!r.data || !r.data.ok) { console.warn('conversations.history not ok:', r.data && r.data.error); return null; }
    const msgs = Array.isArray(r.data.messages) ? r.data.messages : [];
    return msgs.slice().reverse(); // history returns newest→oldest; flip to chronological
  } catch (err) {
    if (!signal?.aborted) console.warn('fetchSlackChannelHistory failed:', err.message);
    return null;
  }
}

// Turn a fetched Slack thread into Claude message history: each message becomes a labeled
// user turn (or assistant, for Nora's own posts), with link-unfurl previews folded in so she
// sees what a shared link was about even before we fetch the page. Consecutive same-role
// turns are merged (the Messages API wants clean alternation at the boundaries).
async function buildSlackThreadHistory(messages, noraUserId, { signal = undefined } = {}) {
  // Resolve every participant and mention concurrently behind one bounded caller budget. The old
  // per-message sequence could multiply Slack users.info latency across a busy first-contact thread.
  const userIds = new Set();
  for (const message of messages) {
    if (message?.user) userIds.add(message.user);
    for (const mention of String(message?.text || '').matchAll(/<@([A-Z0-9]+)>/g)) userIds.add(mention[1]);
  }
  const resolvedNames = new Map(await Promise.all([...userIds]
    .map(async userId => [userId, await getSlackUserName(userId, { signal })])));
  const resolveFromSnapshot = async userId => resolvedNames.get(userId) || null;
  const turns = [];
  for (const m of messages) {
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') continue;
    const isNora = noraUserId && m.user === noraUserId;
    let content = await cleanSlackText(m.text || '', resolveFromSnapshot);
    const unfurls = (m.attachments || [])
      .filter(a => a.title || a.text || a.fallback)
      .map(a => `[shared link preview] ${(a.title || '').trim()}${a.text ? ': ' + a.text.trim() : (a.fallback ? ': ' + a.fallback.trim() : '')}`.trim());
    if (unfurls.length) content += (content ? '\n' : '') + unfurls.join('\n');
    if (!content.trim()) continue;
    const role = isNora ? 'assistant' : 'user';
    let label = '';
    if (!isNora) { const name = resolvedNames.get(m.user); label = `[${name || 'teammate'}]: `; }
    const merged = `${label}${content}`;
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += `\n${merged}`;
    } else {
      turns.push({ role, content: merged });
    }
  }
  // The Messages API requires the first turn to be 'user'. Drop any leading assistant turns.
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

async function resolveSlackChannelByName(name) {
  const clean = String(name || '').replace(/^#/, '').trim().toLowerCase();
  if (!clean) return null;
  if (!_slackChanByName || Date.now() - _slackChanByNameAt > 600000) {
    const map = {}; let cursor = '';
    try {
      do {
        const r = await axios.get(`https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 8000 });
        if (!r.data || !r.data.ok) break;
        for (const c of (r.data.channels || [])) if (c.name) map[c.name.toLowerCase()] = c.id;
        cursor = r.data.response_metadata?.next_cursor || '';
      } while (cursor);
      if (Object.keys(map).length) { _slackChanByName = map; _slackChanByNameAt = Date.now(); }
    } catch (e) { console.warn('channel list failed:', e.message); }
  }
  return (_slackChanByName && _slackChanByName[clean]) || null;
}

async function resolveSlackUserByName(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  if (!_slackUserByName || Date.now() - _slackUserByNameAt > 600000) {
    const map = {}; let cursor = '';
    try {
      do {
        const r = await axios.get(`https://slack.com/api/users.list?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 8000 });
        if (!r.data || !r.data.ok) break;
        for (const u of (r.data.members || [])) {
          if (u.deleted || u.is_bot) continue;
          const real = (u.real_name || u.profile?.real_name || '').toLowerCase();
          const disp = (u.profile?.display_name || '').toLowerCase();
          if (real) map[real] = u.id;
          if (disp) map[disp] = u.id;
          if (u.name) map[u.name.toLowerCase()] = u.id;
        }
        cursor = r.data.response_metadata?.next_cursor || '';
      } while (cursor);
      if (Object.keys(map).length) { _slackUserByName = map; _slackUserByNameAt = Date.now(); }
    } catch (e) { console.warn('users list failed:', e.message); }
  }
  if (!_slackUserByName) return null;
  if (_slackUserByName[q]) return _slackUserByName[q];
  const hit = Object.keys(_slackUserByName).find(k => k.split(' ')[0] === q || k.startsWith(q + ' '));
  return hit ? _slackUserByName[hit] : null;
}

// Post a requested Slack reply to a channel or user, threaded if given.
async function postSlackMessageReceipt(target, text, threadTs, { post = axios.post } = {}) {
  if (!target || !text) return { ok: false, error: 'target and text are required' };
  let channelId = target;
  if (String(target).startsWith('U')) {
    const dm = await post('https://slack.com/api/conversations.open', { users: target }, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 5000,
    }).catch(() => null);
    channelId = dm?.data?.channel?.id || target;
  }
  const payload = { channel: channelId, ...formatSlackMessagePayload(text) };
  if (threadTs) payload.thread_ts = threadTs;
  const r = await post('https://slack.com/api/chat.postMessage', payload, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 5000,
  }).catch(e => ({ data: { ok: false, error: e.message } }));
  return { ok: r.data?.ok === true, channel: r.data?.channel || channelId,
    ts: r.data?.ts || null, error: r.data?.error || null };
}

function slackHistoryBoundary(value, field) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return raw;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error(`${field} must be a valid date, timestamp, or Slack message timestamp`);
    error.statusCode = 400;
    throw error;
  }
  return (date.getTime() / 1000).toFixed(6);
}

async function readSlackChannelWindow(channel, {
  since = null, until = null, limit = 200, signal = undefined, get = axios.get,
  resolveUserName = getSlackUserName, resolveName = resolveChannelName,
} = {}) {
  const channelId = String(channel || '').trim();
  if (!/^[CG][A-Z0-9]+$/.test(channelId)) {
    const error = new Error('task Slack source must be a channel ID');
    error.statusCode = 400;
    throw error;
  }
  const oldest = slackHistoryBoundary(since, 'since');
  if (!oldest) {
    const error = new Error('since is required for a task-scoped Slack history read');
    error.statusCode = 400;
    throw error;
  }
  const latest = slackHistoryBoundary(until, 'until');
  const maximum = Math.max(1, Math.min(500, Number(limit) || 200));
  const rawMessages = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({
      channel: channelId,
      limit: String(Math.min(200, maximum - rawMessages.length)),
      inclusive: 'true',
    });
    if (oldest) params.set('oldest', oldest);
    if (latest) params.set('latest', latest);
    if (cursor) params.set('cursor', cursor);
    const response = await get(`https://slack.com/api/conversations.history?${params.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      timeout: 6000,
      signal,
    });
    if (!response.data?.ok) {
      const error = new Error(`Slack history read failed: ${response.data?.error || 'unknown error'}`);
      error.statusCode = 502;
      throw error;
    }
    rawMessages.push(...(Array.isArray(response.data.messages) ? response.data.messages : []));
    cursor = response.data.response_metadata?.next_cursor || '';
  } while (cursor && rawMessages.length < maximum);

  const messages = rawMessages.slice(0, maximum).sort((a, b) => Number(a.ts) - Number(b.ts));
  const userIds = [...new Set(messages.map(message => message.user).filter(Boolean))];
  const names = new Map(await Promise.all(userIds.map(async userId =>
    [userId, await resolveUserName(userId)])));
  const cleaned = await Promise.all(messages.map(async message => {
    const text = await cleanSlackText(slackMessageAllText(message),
      async userId => names.get(userId) || null);
    const timestamp = Number(message.ts);
    return {
      ts: message.ts || null,
      datetime: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
      user_id: message.user || null,
      user_name: message.user ? names.get(message.user) || null : message.username || null,
      bot_id: message.bot_id || null,
      text,
      thread_ts: message.thread_ts || null,
    };
  }));
  return {
    channel_id: channelId,
    channel_name: await resolveName(channelId),
    since: oldest,
    until: latest,
    count: cleaned.length,
    messages: cleaned,
  };
}

async function postSlackMessage(target, text, threadTs, options = {}) {
  return (await postSlackMessageReceipt(target, text, threadTs, options)).ok;
}

let _slackReactionCapability = 'unknown';

async function trySlackReaction(channel, timestamp, emoji, post = axios.post) {
  if (!channel || !timestamp || !emoji) return { reacted: false, reason: 'missing_target' };
  if (_slackReactionCapability === 'missing_scope') return { reacted: false, reason: 'missing_scope_cached' };
  try {
    const response = await post('https://slack.com/api/reactions.add',
      { channel, name: emoji, timestamp },
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 1500 });
    if (response.data?.ok) {
      _slackReactionCapability = 'available';
      return { reacted: true, reason: null };
    }
    const reason = response.data?.error || 'unknown_error';
    if (reason === 'missing_scope') {
      if (_slackReactionCapability !== 'missing_scope') {
        console.log('Slack reactions are unavailable (missing reactions:write); using a one-emoji message fallback');
      }
      _slackReactionCapability = 'missing_scope';
      return { reacted: false, reason };
    }
    console.warn('reactions.add failed:', reason);
    return { reacted: false, reason };
  } catch (error) {
    console.warn('reactions.add error:', error.message);
    return { reacted: false, reason: error.message };
  }
}

function resetSlackReactionCapabilityForTest() {
  _slackReactionCapability = 'unknown';
}

// In-memory cache of Slack channel ID → channel name. Channel names rarely change so we
// cache indefinitely per process; restarts just rebuild the cache on first hit. Returns
// the cached name on hit, calls Slack conversations.info on miss, and writes either
// the resolved name (success) or null (failure: bot not in channel, archived, etc.) so
// we don't keep re-asking. Failures will retry on next process restart.
const slackChannelNameCache = {};

async function resolveChannelName(channelId) {
  if (!channelId) return null;
  if (Object.prototype.hasOwnProperty.call(slackChannelNameCache, channelId)) {
    return slackChannelNameCache[channelId];
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return null;
  try {
    const r = await axios.get(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
      timeout: 5000
    });
    const name = (r.data && r.data.ok && r.data.channel && r.data.channel.name) || null;
    slackChannelNameCache[channelId] = name;
    return name;
  } catch (err) {
    slackChannelNameCache[channelId] = null;
    return null;
  }
}

// Resolve names for a list of channel IDs in parallel. Cache hits are instant; misses
// fan out to Slack with one request per channel (Slack doesn't expose a batch info call).
async function resolveChannelNames(channelIds) {
  const unique = [...new Set(channelIds.filter(Boolean))];
  const entries = await Promise.all(unique.map(async id => [id, await resolveChannelName(id)]));
  return Object.fromEntries(entries);
}

module.exports = {
  getSlackUserIdentity,
  getSlackUserName,
  cleanSlackText,
  fetchSlackThread,
  fetchSlackChannelHistory,
  readSlackChannelWindow,
  buildSlackThreadHistory,
  resolveSlackChannelByName,
  resolveSlackUserByName,
  postSlackMessageReceipt,
  postSlackMessage,
  trySlackReaction,
  resetSlackReactionCapabilityForTest,
  resolveChannelName,
  resolveChannelNames,
  SLACK_TABLE_FORMATTING_INSTRUCTION,
  normalizeSlackMrkdwn,
  formatSlackMessagePayload,
};
