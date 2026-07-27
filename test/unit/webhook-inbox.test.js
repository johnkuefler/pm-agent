'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMemoryWebhookInbox,
  stableWebhookEventId,
} = require('../../src/integrations/webhook-inbox');
const {
  createSlackReplyStage,
  requiredSlackFinalizationEffects,
  updateSlackReplyStageDelivery,
  updateSlackReplyStageFinalization,
} = require('../../src/integrations/slack-reply-stage');

function acknowledgedStage(stage, {
  ts = '1.2',
  channel = stage.channel,
} = {}) {
  return updateSlackReplyStageDelivery(stage, {
    status: 'delivered',
    segmentReceipts: stage.segments.map((_, segmentIndex) => ({
      method: 'chat.postMessage',
      segment_index: segmentIndex,
      ok: true,
      ts: segmentIndex === 0 ? ts : `${ts}-${segmentIndex}`,
      channel,
    })),
    firstResponse: { ok: true, ts, channel },
  });
}

function finalizedStage(stage) {
  return updateSlackReplyStageFinalization(stage, {
    status: 'completed',
    receipts: requiredSlackFinalizationEffects(stage).map(effect => ({
      effect,
      ok: true,
      at: '2026-07-26T12:00:00.000Z',
    })),
    now: new Date('2026-07-26T12:00:00.000Z'),
  });
}

async function stageHarmlessTerminal(inbox, eventId, claimToken) {
  let stage = createSlackReplyStage({
    turn_ref: `slack:C1:${eventId}`,
    channel: 'C1',
    user: 'U1',
    trigger_ts: eventId,
    channel_type: 'channel',
    thread_ts: eventId,
    user_line: '[User]: ignored event',
    segments: ['[no public response delivered: harmless ignore]'],
    interaction_entry: { kind: 'silence', history_mode: 'omit' },
    extraction: { eligible: false },
  });
  assert.equal(await inbox.stageResult(
    'slack', eventId, claimToken, stage), true);
  stage = updateSlackReplyStageDelivery(stage, {
    status: 'suppressed',
    terminalReason: 'harmless_ignore',
  });
  assert.equal(await inbox.stageResult(
    'slack', eventId, claimToken, stage), true);
  stage = finalizedStage(stage);
  assert.equal(await inbox.stageResult(
    'slack', eventId, claimToken, stage), true);
  return stage;
}

test('stable webhook IDs prefer provider delivery IDs and hash identical unsigned payloads', () => {
  assert.equal(stableWebhookEventId('slack', { event_id: 'Ev123' }, Buffer.from('x')), 'Ev123');
  const first = stableWebhookEventId('slack', { event: { ts: '1' } }, Buffer.from('same bytes'));
  const second = stableWebhookEventId('slack', { event: { ts: 'different' } }, Buffer.from('same bytes'));
  assert.equal(first, second);
  assert.match(first, /^slack-[a-f0-9]{64}$/);
});

test('inbox atomically deduplicates, leases, retries, and terminates poison events', async () => {
  let now = 1000;
  const inbox = createMemoryWebhookInbox({
    clock: () => now,
    leaseMs: 100,
    maxAttempts: 2,
  });
  const input = {
    provider: 'slack',
    event_id: 'Ev1',
    payload: { event_id: 'Ev1', event: { type: 'message' } },
  };
  assert.deepEqual(await inbox.enqueue(input), { inserted: true, status: 'queued' });
  assert.deepEqual(await inbox.enqueue(input), { inserted: false, status: 'queued' });
  const first = await Promise.all([
    inbox.claim('slack', 'Ev1'),
    inbox.claim('slack', 'Ev1'),
  ]);
  assert.equal(first.filter(Boolean).length, 1);
  const firstClaim = first.find(Boolean);
  assert.equal(firstClaim.attempts, 1);
  assert.match(firstClaim.claim_token, /^[0-9a-f-]{36}$/);
  assert.equal(await inbox.claim('slack', 'Ev1'), null);
  assert.equal(await inbox.stageResult('slack', 'Ev1', 'stale-token',
    { kind: 'slack_reply', segments: ['wrong'] }), false);
  const stagedReply = createSlackReplyStage({
    turn_ref: 'slack:C1:Ev1',
    channel: 'C1',
    user: 'U1',
    trigger_ts: 'Ev1',
    channel_type: 'channel',
    thread_ts: 'Ev1',
    user_line: '[User]: stable request',
    segments: ['stable reply'],
  });
  assert.equal(await inbox.stageResult(
    'slack', 'Ev1', firstClaim.claim_token, stagedReply), true);
  const retry = await inbox.fail('slack', 'Ev1', firstClaim.claim_token,
    new Error('temporary'));
  assert.equal(retry.status, 'queued');
  assert.equal(await inbox.claim('slack', 'Ev1'), null);
  now = retry.available_at;
  const secondClaim = await inbox.claimNext('slack');
  assert.equal(secondClaim.attempts, 2);
  assert.deepEqual(secondClaim.processing_result,
    stagedReply);
  assert.notEqual(secondClaim.claim_token, firstClaim.claim_token);
  assert.equal((await inbox.fail('slack', 'Ev1', secondClaim.claim_token, 'poison')).status,
    'dead');
  assert.equal(await inbox.claimNext('slack'), null);
});

test('expired processing leases are recoverable while completed deliveries remain deduplicated', async () => {
  let now = 0;
  const inbox = createMemoryWebhookInbox({ clock: () => now, leaseMs: 50 });
  await inbox.enqueue({ provider: 'slack', event_id: 'Ev2', payload: {} });
  const expiredClaim = await inbox.claim('slack', 'Ev2');
  assert.ok(expiredClaim);
  now = 51;
  const activeClaim = await inbox.claimNext('slack');
  assert.equal(activeClaim.attempts, 2);
  assert.notEqual(activeClaim.claim_token, expiredClaim.claim_token);
  assert.equal(await inbox.complete('slack', 'Ev2', expiredClaim.claim_token), false);
  assert.equal(await inbox.fail('slack', 'Ev2', expiredClaim.claim_token, 'stale'), null);
  await stageHarmlessTerminal(inbox, 'Ev2', activeClaim.claim_token);
  assert.equal(await inbox.complete('slack', 'Ev2', activeClaim.claim_token), true);
  assert.equal((await inbox.enqueue({ provider: 'slack', event_id: 'Ev2', payload: {} })).status,
    'completed');
  assert.equal(await inbox.claim('slack', 'Ev2'), null);
});

test('crash-only lease expiry reaches the attempt cap without fail()', async () => {
  let now = 0;
  const inbox = createMemoryWebhookInbox({
    clock: () => now,
    leaseMs: 10,
    maxAttempts: 2,
  });
  await inbox.enqueue({ provider: 'slack', event_id: 'Ev-crash', payload: {} });
  const first = await inbox.claim('slack', 'Ev-crash');
  assert.equal(first.attempts, 1);
  now = 11;
  const second = await inbox.claim('slack', 'Ev-crash');
  assert.equal(second.attempts, 2);
  now = 22;
  assert.equal(await inbox.claim('slack', 'Ev-crash'), null);
  assert.equal(await inbox.claimNext('slack'), null);
  assert.equal(inbox.snapshot().counts.dead, 1);
});

test('a failed conversation turn blocks newer turns until its terminal retry', async () => {
  let now = 0;
  const inbox = createMemoryWebhookInbox({ clock: () => now, leaseMs: 100 });
  const ordered = (eventId, position) => inbox.enqueue({
    provider: 'slack',
    event_id: eventId,
    payload: { event: { type: 'message' } },
    ordering_key: 'dm:D1',
    ordering_position: position,
  });
  await ordered('turn-a', '00000000000000000001.000000000');
  const firstA = await inbox.claim('slack', 'turn-a');
  const retryA = await inbox.fail('slack', 'turn-a', firstA.claim_token, 'temporary');
  await ordered('turn-b', '00000000000000000002.000000000');
  assert.equal(await inbox.claim('slack', 'turn-b'), null,
    'the newer turn cannot overtake an older backoff');
  assert.equal(await inbox.claimNext('slack'), null);
  now = retryA.available_at;
  const secondA = await inbox.claimNext('slack');
  assert.equal(secondA.event_id, 'turn-a');
  await stageHarmlessTerminal(inbox, 'turn-a', secondA.claim_token);
  await inbox.complete('slack', 'turn-a', secondA.claim_token);
  const turnB = await inbox.claimNext('slack');
  assert.equal(turnB.event_id, 'turn-b');
});

test('an expired owner cannot renew after a replacement claim rotates the fence', async () => {
  let now = 0;
  const inbox = createMemoryWebhookInbox({ clock: () => now, leaseMs: 10 });
  await inbox.enqueue({ provider: 'slack', event_id: 'lease-turn', payload: {} });
  const ownerA = await inbox.claim('slack', 'lease-turn');
  now = 11;
  const ownerB = await inbox.claim('slack', 'lease-turn');
  assert.notEqual(ownerB.claim_token, ownerA.claim_token);
  assert.equal(await inbox.renew(
    'slack', 'lease-turn', ownerA.claim_token, { leaseMs: 30 }), false);
  assert.equal(await inbox.renew(
    'slack', 'lease-turn', ownerB.claim_token, { leaseMs: 5 }), true);
  now = 17;
  assert.equal(await inbox.claim('slack', 'lease-turn'), null,
    'renewal cannot shorten the existing lease');
  now = 22;
  assert.ok(await inbox.claim('slack', 'lease-turn'));
});

test('staged results preserve one content commitment and monotonic terminal state', async () => {
  const inbox = createMemoryWebhookInbox();
  await inbox.enqueue({ provider: 'slack', event_id: 'stage-turn', payload: {} });
  const claim = await inbox.claim('slack', 'stage-turn');
  const staged = createSlackReplyStage({
    turn_ref: 'slack:C1:1.1',
    channel: 'C1',
    user: 'U1',
    trigger_ts: '1.1',
    channel_type: 'channel',
    thread_ts: '1.1',
    user_line: '[User]: hello',
    segments: ['Hello.'],
  });
  assert.equal(await inbox.stageResult(
    'slack', 'stage-turn', claim.claim_token, staged), true);
  const conflicting = createSlackReplyStage({
    ...staged,
    reply: undefined,
    segments: ['Different.'],
  });
  assert.equal(await inbox.stageResult(
    'slack', 'stage-turn', claim.claim_token, conflicting), false);
  const delivered = acknowledgedStage(staged);
  assert.equal(await inbox.stageResult(
    'slack', 'stage-turn', claim.claim_token, delivered), true);
  const downgrade = updateSlackReplyStageDelivery(staged, {
    status: 'attempted',
    segmentReceipts: [{
      method: 'chat.postMessage', segment_index: 0, ok: false,
    }],
  });
  assert.equal(await inbox.stageResult(
    'slack', 'stage-turn', claim.claim_token, downgrade), false);
});

test('a durable proactive-channel cooldown is discoverable before a newer turn runs', async () => {
  let now = 0;
  const inbox = createMemoryWebhookInbox({ clock: () => now });
  const enqueue = (id, position) => inbox.enqueue({
    provider: 'slack',
    event_id: id,
    payload: {},
    ordering_key: 'proactive-channel:C1',
    ordering_position: position,
  });
  await enqueue('user-a', '0001');
  await enqueue('user-b', '0002');
  const first = await inbox.claim('slack', 'user-a');
  assert.equal(await inbox.claim('slack', 'user-b'), null);
  const stage = createSlackReplyStage({
    turn_ref: 'slack:C1:1.1',
    channel: 'C1',
    user: 'UA',
    trigger_ts: '1.1',
    channel_type: 'channel',
    mode: 'proactive',
    thread_ts: '1.1',
    user_line: '[User A]: status',
    segments: ['Verified fact.'],
  });
  const delivered = acknowledgedStage(stage);
  const finalized = finalizedStage(delivered);
  await inbox.stageResult('slack', 'user-a', first.claim_token, stage);
  await inbox.stageResult('slack', 'user-a', first.claim_token, delivered);
  await inbox.stageResult('slack', 'user-a', first.claim_token, finalized);
  await inbox.complete('slack', 'user-a', first.claim_token);
  assert.equal(await inbox.hasRecentTerminal(
    'slack', 'proactive-channel:C1', 'user-b',
    { withinMs: 100, mode: 'proactive' }), true);
  assert.equal((await inbox.claim('slack', 'user-b')).event_id, 'user-b',
    'the newer event is claimed now so the worker can terminally suppress it');
  now = 101;
  assert.equal(await inbox.hasRecentTerminal(
    'slack', 'proactive-channel:C1', 'future-user',
    { withinMs: 100, mode: 'proactive' }), false);
});
