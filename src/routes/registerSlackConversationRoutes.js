'use strict';

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function validSince(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function registerSlackConversationRoutes(app, { requireAuth, db, databaseReady = () => true,
  resolveChannelNames = async () => ({}), resolveUserName = async () => null } = {}) {
  if (!db) throw new Error('Slack conversation routes require a database adapter');

  app.get('/slack/conversations', requireAuth, async (req, res) => {
    if (!databaseReady()) return res.status(503).json({ error: 'database unavailable' });
    const limit = integer(req.query?.limit, 100, 1, 250);
    const since = validSince(req.query?.since);
    if (req.query?.since && !since) {
      return res.status(400).json({ error: 'since must be a valid date or timestamp' });
    }
    const filters = {
      limit,
      since,
      channel: String(req.query?.channel || '').trim() || null,
      user: String(req.query?.user || '').trim() || null,
      status: String(req.query?.status || '').trim() || null,
      q: String(req.query?.q || '').trim().slice(0, 500) || null,
    };
    try {
      const conversations = await db.listSlackConversationAudit(filters);
      const channelNames = await resolveChannelNames(conversations.map(item => item.channel_id));
      const userIds = [...new Set(conversations.map(item => item.user_id).filter(Boolean))];
      const userNames = Object.fromEntries(await Promise.all(userIds.map(async userId =>
        [userId, await resolveUserName(userId)])));
      for (const item of conversations) {
        item.channel_name = item.channel_name || channelNames[item.channel_id]
          || ((item.channel_type === 'im' || item.channel_type === 'mpim')
            ? `Direct message with ${item.user_name || userNames[item.user_id] || item.user_id}` : null);
        item.user_name = item.user_name || userNames[item.user_id] || null;
      }
      res.set('Cache-Control', 'private, no-store');
      return res.json({ count: conversations.length, filters, conversations });
    } catch (error) {
      return res.status(500).json({ error: String(error?.message || error).slice(0, 500) });
    }
  });
}

module.exports = { registerSlackConversationRoutes, validSince };
