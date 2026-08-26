'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackConversationAudit, slackAuditInteractionId, shouldAuditSlackInbound } =
  require('../../src/surfaces/slack/conversation-audit');
const { registerSlackConversationRoutes } =
  require('../../src/routes/registerSlackConversationRoutes');

test('Slack audit identity deduplicates retries for the same channel message', () => {
  assert.equal(slackAuditInteractionId('C123', '1787768000.001'),
    'slack:C123:1787768000.001');
  assert.equal(slackAuditInteractionId('', '1787768000.001'), null);
});

test('Slack audit includes DMs, mentions, and joined-thread follow-ups but not channel chatter', () => {
  assert.equal(shouldAuditSlackInbound({ type: 'message', channel_type: 'im' }), true);
  assert.equal(shouldAuditSlackInbound({ type: 'app_mention', channel_type: 'channel' }), true);
  assert.equal(shouldAuditSlackInbound({ type: 'message', channel_type: 'channel', thread_ts: '1' },
    { joinedThread: true }), true);
  assert.equal(shouldAuditSlackInbound({ type: 'message', channel_type: 'channel' }), false);
  assert.equal(shouldAuditSlackInbound({ type: 'message', channel_type: 'im', bot_id: 'B1' }), false);
});

test('Slack audit persists the inbound message and terminal response outcome', async () => {
  const calls = { inbound: [], updates: [] };
  const audit = createSlackConversationAudit({
    db: {
      upsertSlackConversationAudit: async item => calls.inbound.push(item),
      updateSlackConversationAudit: async (id, patch) => calls.updates.push({ id, patch }),
    },
  });
  const receipt = await audit.recordInbound({
    channelId: 'D123', channelType: 'im', inboundTs: '1787768000.001', userId: 'U1',
    inboundText: 'Can you check this?', slackEventId: 'Ev1',
  });
  assert.equal(receipt.persisted, true);
  assert.equal(calls.inbound[0].interaction_id, 'slack:D123:1787768000.001');
  assert.equal(calls.inbound[0].inbound_text, 'Can you check this?');

  await audit.mark(receipt.interaction_id, {
    handling_status: 'delivered', response_kind: 'message', response_text: 'Yes.',
    response_slack_timestamps: ['1787768001.001'], responded: true,
  });
  assert.equal(calls.updates[0].id, receipt.interaction_id);
  assert.deepEqual(calls.updates[0].patch.response_slack_timestamps, ['1787768001.001']);
  assert.equal(calls.updates[0].patch.responded, true);
});

test('Slack audit failure never blocks the live response path', async () => {
  const warnings = [];
  const audit = createSlackConversationAudit({
    db: { upsertSlackConversationAudit: async () => { throw new Error('database restart'); } },
    logger: { warn: message => warnings.push(message) },
  });
  const result = await audit.recordInbound({ channelId: 'D1', inboundTs: '1', inboundText: 'Hi' });
  assert.equal(result.persisted, false);
  assert.match(warnings[0], /database restart/);
});

function routeHarness(rows) {
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)) };
  registerSlackConversationRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    db: { listSlackConversationAudit: async filters => {
      routeHarness.filters = filters;
      return rows.map(item => ({ ...item }));
    } },
    resolveChannelNames: async () => ({ C1: 'project-alpha' }),
    resolveUserName: async () => 'Mallory',
  });
  return routes.get('/slack/conversations');
}

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    json(value) { this.body = value; return this; },
  };
}

test('authenticated troubleshooting route returns human channel and user names', async () => {
  const handler = routeHarness([{
    interaction_id: 'slack:C1:1', channel_id: 'C1', channel_type: 'channel', user_id: 'U1',
    inbound_text: 'What changed?', handling_status: 'delivered',
  }]);
  const res = response();
  await handler({ query: { limit: '25', q: 'changed' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.conversations[0].channel_name, 'project-alpha');
  assert.equal(res.body.conversations[0].user_name, 'Mallory');
  assert.equal(routeHarness.filters.limit, 25);
  assert.equal(routeHarness.filters.q, 'changed');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});
