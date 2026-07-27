'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  commitSlackHistoryTurn,
  createSlackReplyStage,
  restoreSlackHistory,
  slackReplyStageAudit,
  updateSlackReplyStageDelivery,
  MAX_USER_LINE_CHARS,
} = require('../../src/integrations/slack-reply-stage');

function fixture() {
  return createSlackReplyStage({
    turn_ref: 'slack:C1:171234.0001',
    channel: 'C1',
    user: 'U1',
    trigger_ts: '171234.0001',
    channel_type: 'channel',
    mode: 'normal',
    thread_ts: '171234.0001',
    user_line: '[John (Slack: <@U1>)]: What is launch status?',
    segments: ['QA is complete.', 'The release owner is Mallory.'],
  });
}

test('Slack reply stages bind exact ordered segments to the inbound turn', () => {
  const stage = fixture();
  assert.equal(slackReplyStageAudit(stage, {
    turn_ref: 'slack:C1:171234.0001',
    channel: 'C1',
    user: 'U1',
    trigger_ts: '171234.0001',
  }).valid, true);
  const tampered = structuredClone(stage);
  tampered.segments[1] = 'A different retry answer.';
  assert.equal(slackReplyStageAudit(tampered).valid, false);
  assert.match(slackReplyStageAudit(tampered).reason, /text|commitment/);
  assert.equal(slackReplyStageAudit(stage, { channel: 'C2' }).valid, false);
});

test('delivery updates preserve the exact reply commitment and history commits once', () => {
  const stage = fixture();
  const delivered = updateSlackReplyStageDelivery(stage, {
    status: 'delivered',
    segmentReceipts: [
      {
        method: 'chat.postMessage', segment_index: 0, ok: true,
        ts: '171235.0001', channel: 'C1',
      },
      {
        method: 'chat.postMessage', segment_index: 1, ok: true,
        ts: '171235.0002', channel: 'C1',
      },
    ],
    firstResponse: { ok: true, ts: '171235.0001', channel: 'C1' },
    now: new Date('2026-07-26T12:00:00Z'),
  });
  assert.equal(delivered.content_commitment, stage.content_commitment);
  assert.equal(delivered.delivery.status, 'delivered');
  assert.equal(slackReplyStageAudit(delivered).valid, true);
  assert.throws(() => updateSlackReplyStageDelivery(delivered, {
    status: 'attempted',
    segmentReceipts: [],
  }), /cannot transition from delivered to attempted/);

  const history = [];
  assert.equal(commitSlackHistoryTurn(history, stage.user_line, stage.reply).committed, true);
  assert.equal(commitSlackHistoryTurn(history, stage.user_line, stage.reply).idempotent, true);
  assert.equal(history.length, 2);
});

test('failed delivery history can be restored to its exact pre-turn snapshot', () => {
  const history = [{ role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' }];
  const snapshot = structuredClone(history);
  history.push({ role: 'user', content: 'Current question' });
  history.push({ role: 'assistant', content: 'Undelivered answer' });
  assert.equal(restoreSlackHistory(history, snapshot), true);
  assert.deepEqual(history, snapshot);
});

test('valid long Slack inputs stage without a post-generation dead letter', () => {
  const longLine = `User: ${'x'.repeat(5001)}`;
  const stage = createSlackReplyStage({
    turn_ref: 'slack:D1:171234.0001',
    channel: 'D1',
    user: 'U1',
    trigger_ts: '171234.0001',
    channel_type: 'im',
    mode: 'normal',
    user_line: longLine,
    segments: ['I read the full request.'],
  });
  assert.equal(stage.user_line, longLine);
  assert.throws(() => createSlackReplyStage({
    ...stage,
    content_commitment: undefined,
    delivery: undefined,
    user_line: 'x'.repeat(MAX_USER_LINE_CHARS + 1),
  }), /Slack staged user line/);
});

test('the live Slack path stages before egress, replays stages, and rolls back failed history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const webhookProcessor = source.slice(
    source.indexOf('async function processSlackWebhookEvent'),
    source.indexOf('// Thin wrapper:', source.indexOf('async function processSlackWebhookEvent')),
  );
  const earlyRecoveryAt = webhookProcessor.indexOf(
    'if (processingContext?.staged_result)');
  assert.ok(earlyRecoveryAt >= 0,
    'a persisted reply stage must have an early webhook recovery branch');
  assert.ok(earlyRecoveryAt < webhookProcessor.indexOf('recordThreadInbound('),
    'stage recovery must bypass mutable thread-staleness accounting');
  assert.ok(earlyRecoveryAt < webhookProcessor.indexOf('shouldRespond(event)'),
    'stage recovery must bypass mutable Slack routing gates');

  const claimedProcessor = source.slice(
    source.indexOf('async function processClaimedSlackWebhook'),
    source.indexOf('async function processNextSlackWebhookInbox'),
  );
  const terminalGuardAt = claimedProcessor.indexOf(
    "['delivered', 'suppressed', 'partially_delivered_suppressed']");
  const completeAt = claimedProcessor.indexOf(
    ".complete('slack', eventId, record.claim_token, { allowEmptyResult })");
  assert.ok(terminalGuardAt >= 0 && completeAt > terminalGuardAt,
    'the inbox row must not complete while an exact reply stage is nonterminal');
  const cooldownLookupAt = claimedProcessor.indexOf('await inbox.hasRecentTerminal(');
  const modelRouteAt = claimedProcessor.indexOf('await processSlackWebhookEvent(');
  assert.ok(cooldownLookupAt >= 0 && modelRouteAt > cooldownLookupAt,
    'durable proactive cooldown must terminally suppress before model work');
  assert.match(claimedProcessor,
    /terminalReason: 'proactive_cooldown_active'/);

  const handler = source.slice(
    source.indexOf('async function handleSlackImpl'),
    source.indexOf('// Slack thread admin', source.indexOf('async function handleSlackImpl')),
  );
  const stageAt = handler.indexOf(
    'durableReplyStage = await persistSlackReplyStage(durableReplyStage)');
  const postAt = handler.indexOf('await postSlackSegments({', stageAt);
  const finalizerAt = handler.indexOf('await finalizeStagedSlackReply({', postAt);
  assert.ok(stageAt >= 0 && postAt > stageAt,
    'the exact reply must be claim-fenced before Slack sees segment one');
  assert.ok(finalizerAt > postAt,
    'history/follow-up effects must enter the durable finalizer only after delivery');
  const finalizer = source.slice(
    source.indexOf('async function finalizeStagedSlackReply'),
    source.indexOf('async function resumeStagedSlackReplyDelivery'),
  );
  assert.match(finalizer, /commitSlackHistoryTurn\(/,
    'the finalizer owns the idempotent history projection');
  assert.doesNotMatch(handler,
    /status: 'delivered'[\s\S]{0,700}catch \(error\)[\s\S]{0,400}status: 'attempted'/,
    'a delivered-stage persistence failure must never be downgraded to attempted');
  assert.match(handler, /resumeStagedSlackReplyDelivery\(\{/);
  assert.match(handler, /restoreSlackHistory\(mutableHistory, historyBeforeTurn\)/);
  assert.doesNotMatch(handler,
    /history\.push\(\{ role: 'assistant', content: reply \}\)[\s\S]{0,500}postSlackSegments/,
    'an undelivered assistant reply cannot pollute the next generation context');

  const notify = source.slice(
    source.indexOf("app.post('/notify'"),
    source.indexOf('registerMemoryRoutes', source.indexOf("app.post('/notify'")),
  );
  assert.match(notify, /Slack notifications require Idempotency-Key, operation_id, or a UUID client_msg_id/);
  assert.doesNotMatch(notify, /notify-operation:\$\{semanticOperation\}/);
});

test('staged recovery revalidates freshness and revocable hard egress policy', () => {
  const { __test } = require('../../server');
  const now = Date.now();
  const makeStage = (overrides = {}) => createSlackReplyStage({
    turn_ref: 'slack:C1:171234.0001',
    channel: 'C1',
    user: 'U1',
    trigger_ts: '171234.0001',
    channel_type: 'channel',
    mode: 'normal',
    thread_ts: '171234.0001',
    user_line: '[John]: status?',
    segments: ['Ready.'],
    generated_at: new Date(now).toISOString(),
    ...overrides,
  });
  const policy = (stage, overrides = {}) => __test.slackStagedReplyEgressPolicy(stage, {
    now,
    maxAgeMs: 30 * 60 * 1000,
    financialApproved: () => true,
    proactiveEnabled: () => true,
    proactiveCooldownActive: () => false,
    ...overrides,
  });
  assert.equal(policy(makeStage()).allowed, true);
  assert.equal(policy(makeStage({
    generated_at: new Date(now - 31 * 60 * 1000).toISOString(),
  })).reason, 'stage_expired');
  assert.equal(policy(makeStage({
    segments: ['The approved budget is $5,000.'],
  }), { financialApproved: () => false }).reason, 'financial_access_revoked');
  assert.equal(policy(makeStage({ mode: 'proactive' }), {
    proactiveEnabled: () => false,
  }).reason, 'proactive_channel_disabled');
  assert.equal(policy(makeStage({ mode: 'proactive' }), {
    proactiveCooldownActive: () => true,
  }).reason, 'proactive_cooldown_active');
});

test('shared egress policy overrides a stale approving process cache', async () => {
  const { __test } = require('../../server');
  const stage = createSlackReplyStage({
    turn_ref: 'slack:C1:171234.0001',
    channel: 'C1',
    user: 'U1',
    trigger_ts: '171234.0001',
    channel_type: 'channel',
    mode: 'normal',
    thread_ts: '171234.0001',
    user_line: '[John]: budget?',
    segments: ['The budget is $5,000.'],
  });
  const policy = await __test.slackStagedReplySharedEgressPolicy(stage, {
    dbReady: true,
    loadState: async key => {
      assert.equal(key, 'slack_financial_approved');
      return {};
    },
    localFinancialApproved: () => true,
    localProactiveEnabled: () => true,
    localProactiveCooldownActive: () => false,
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, 'financial_access_revoked');
});
