'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeDeliveryMode,
  resolveSlackDelivery,
  slackTimestampMs,
} = require('../../src/integrations/slack-delivery-policy');

const NOW = 1_800_000_000_000;
const slackTs = milliseconds => String(milliseconds / 1000);

test('routine Slack follow-ups stay in their original thread', () => {
  const threadTs = slackTs(NOW - 24 * 60 * 60 * 1000);
  assert.deepEqual(resolveSlackDelivery({
    channelType: 'channel',
    threadTs,
    sourceTs: threadTs,
    materiality: 'routine',
    now: NOW,
  }), {
    mode: 'thread',
    thread_ts: threadTs,
    reply_broadcast: false,
    reason: 'routine_update_kept_in_context',
    materiality: 'routine',
    source_age_ms: 24 * 60 * 60 * 1000,
  });
});

test('material outcomes resurface from stale threads without losing context', () => {
  const threadTs = slackTs(NOW - 3 * 60 * 60 * 1000);
  const decision = resolveSlackDelivery({
    channelType: 'channel',
    threadTs,
    materiality: 'shared deliverable',
    now: NOW,
  });
  assert.equal(decision.mode, 'thread_broadcast');
  assert.equal(decision.thread_ts, threadTs);
  assert.equal(decision.reply_broadcast, true);
  assert.equal(decision.reason, 'material_update_resurfaced_from_stale_thread');
});

test('corrections and urgent risks are channel-visible even in a fresh thread', () => {
  for (const materiality of ['correction', 'urgent-risk']) {
    const decision = resolveSlackDelivery({
      channelType: 'channel',
      threadTs: slackTs(NOW - 60_000),
      materiality,
      now: NOW,
    });
    assert.equal(decision.mode, 'thread_broadcast');
    assert.equal(decision.reply_broadcast, true);
    assert.equal(decision.reason, 'material_update_requires_channel_visibility');
  }
});

test('proactive contributions are anchored and visible while DMs remain inline', () => {
  const threadTs = slackTs(NOW - 10_000);
  const proactive = resolveSlackDelivery({
    channelType: 'channel',
    threadTs,
    proactive: true,
    now: NOW,
  });
  assert.equal(proactive.mode, 'thread_broadcast');
  assert.equal(proactive.reply_broadcast, true);

  const dm = resolveSlackDelivery({
    channelType: 'im',
    threadTs,
    deliveryMode: 'thread_broadcast',
    materiality: 'urgent_risk',
    now: NOW,
  });
  assert.equal(dm.mode, 'dm');
  assert.equal(dm.thread_ts, null);
  assert.equal(dm.reply_broadcast, false);
});

test('explicit delivery modes win and invalid modes fall back to auto', () => {
  const threadTs = slackTs(NOW - 10_000);
  assert.equal(resolveSlackDelivery({
    channelType: 'channel',
    threadTs,
    deliveryMode: 'channel',
    now: NOW,
  }).thread_ts, null);
  assert.equal(resolveSlackDelivery({
    channelType: 'channel',
    threadTs,
    deliveryMode: 'thread_broadcast',
    now: NOW,
  }).reply_broadcast, true);
  assert.equal(normalizeDeliveryMode('not-real'), 'auto');
  assert.equal(slackTimestampMs('1700000000.125'), 1_700_000_000_125);
});
