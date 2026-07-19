'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const review = require('../../src/intelligence/interaction-outcome-review-autopilot');
const capability = require('../../src/intelligence/capability-boundary');

const NOW = new Date('2026-07-18T12:00:00.000Z');

function interaction(overrides = {}) {
  return {
    id: 'ix-provider-disjoint-review-1', created: '2026-07-18T04:00:00.000Z',
    reviewed: false, outcome: null, channel: 'D031HHSBM1Q', channel_type: 'im',
    thread_ts: '1784332800.000001', ts: '1784332800.000001', kind: 'dm_reply',
    trigger: 'Thanks for catching that deadline issue.',
    text: 'yeah, that dependency was the part worth checking before we committed.',
    user: 'UJYKB4788', requester_name: 'John', executed_tool_names: [],
    ...overrides,
  };
}

function landing(overrides = {}) {
  return {
    is_dm: true, truncated: false,
    messages: [{ user: 'UJYKB4788', text: 'exactly, thanks for checking it first',
      ts: '1784332900.000002', reactions: [] }],
    ...overrides,
  };
}

function authenticatedLanding(source = interaction(), overrides = {}) {
  const value = landing(overrides);
  value.provider_readback_receipt = review.createSlackLandingReadbackReceipt({
    responseData: { ok: true, messages: value.messages }, channel: source.channel,
    anchorMessageTs: source.ts, apiMethod: 'conversations.history', landing: value,
    retrievedAt: NOW,
  });
  return value;
}

function providerResponse(id, outcome = 'appreciated',
  evidenceTs = ['1784332900.000002']) {
  return {
    id, model: review.DEFAULT_MODEL, status: 'completed',
    usage: { input_tokens: 420, output_tokens: 110 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      outcome, evidence_message_ts: evidenceTs,
      signal: outcome === 'appreciated'
        ? 'The human explicitly thanked Nora for checking the dependency first.'
        : 'The human directly corrected the delivered claim with a concrete contradiction.',
      rationale: 'The label follows the exact observable follow-up rather than inferred private uptake.',
    }) }] }],
  };
}

test('eligibility requires the frozen delay and skips terminal automated attempts', () => {
  const old = interaction();
  const recent = interaction({ id: 'ix-recent', created: '2026-07-18T08:00:00.001Z' });
  const attempted = interaction({ id: 'ix-attempted', automated_review_attempt: { status: 'inconclusive' } });
  assert.deepEqual(review.eligibleInteractions([recent, attempted, old], NOW).map(item => item.id),
    [old.id]);
  const packet = review.reviewPacket(old, landing({ messages: [{ user: 'UJYKB4788',
    text: 'a later unrelated conversation', ts: '1784355001.000002', reactions: [] }] }), NOW);
  assert.equal(packet.landing.messages.length, 0);
  assert.throws(() => review.reviewPacket(old, landing(),
    new Date('2026-07-18T04:30:00.000Z')), /six-hour evidence window/);
});

test('dual-role consensus commits one replay-valid provider-disjoint outcome', async () => {
  const source = interaction();
  let calls = 0;
  let committed = null;
  const result = await review.runCycle({ interactions: [source], now: NOW,
    readLanding: async item => { assert.equal(item.id, source.id); return landing(); },
    callProvider: async request => {
      calls += 1;
      assert.equal(request.store, false);
      assert.equal(request.model, review.DEFAULT_MODEL);
      return providerResponse(`openai-interaction-review-${calls}`);
    },
    commitOutcome: (id, input) => { committed = { id, ...input }; },
  });
  assert.equal(result.state, 'reviewed');
  assert.equal(result.reviewed, 1);
  assert.equal(calls, 2);
  const reviewed = { ...source, outcome: committed.outcome, signal: committed.signal,
    reviewed: true, reviewed_at: committed.reviewed_at,
    automated_review_receipt: committed.automated_review_receipt };
  assert.equal(review.verifyAutomatedReviewReceipt(
    reviewed, reviewed.automated_review_receipt), true);
  const record = capability.recordFromInteraction(reviewed);
  assert.equal(record.source_quality, 'provider_disjoint_authenticated_slack_review');
  assert.equal(record.review_receipt_commitment,
    reviewed.automated_review_receipt.receipt_commitment);
  assert.equal(capability.verifyRecord(record), true);
});

test('Slack API readback is commitment-bound into the review and learned capability evidence', async () => {
  const source = interaction();
  let committed;
  await review.runCycle({ interactions: [source], now: NOW,
    readLanding: async () => authenticatedLanding(source),
    callProvider: async (_request, context) => providerResponse(`readback-${context.role}`),
    commitOutcome: (_id, input) => { committed = input; } });
  const reviewed = { ...source, ...committed, reviewed: true };
  const receipt = reviewed.automated_review_receipt.packet.provider_readback_receipt;
  assert.equal(review.verifySlackLandingReadbackReceipt(receipt, reviewed,
    reviewed.automated_review_receipt.packet.landing), true);
  assert.equal(review.verifyAutomatedReviewReceipt(reviewed,
    reviewed.automated_review_receipt), true);
  const record = capability.recordFromInteraction(reviewed);
  assert.equal(record.provider_readback_verified, true);
  assert.equal(record.source_quality, 'provider_disjoint_review_with_slack_api_readback');
  assert.equal(capability.projection([record]).provider_readback_authenticated_records, 1);

  const tampered = structuredClone(reviewed.automated_review_receipt);
  tampered.packet.provider_readback_receipt.anchor_message_ts = '1784332800.999999';
  tampered.receipt_commitment = review.commitment(review.receiptPayload(tampered));
  assert.equal(review.verifyAutomatedReviewReceipt(reviewed, tampered), false);
});

test('role disagreement remains unreviewed and is terminally handed back to nightly review', async () => {
  const source = interaction();
  let calls = 0;
  let committed = false;
  let attempt = null;
  const result = await review.runCycle({ interactions: [source], now: NOW,
    readLanding: async () => landing(),
    callProvider: async () => providerResponse(`openai-disagreement-${++calls}`,
      calls === 1 ? 'appreciated' : 'corrected'),
    commitOutcome: () => { committed = true; },
    recordAttempt: (id, value) => { attempt = { id, ...value }; },
  });
  assert.equal(result.state, 'inconclusive');
  assert.equal(result.inconclusive, 1);
  assert.equal(committed, false);
  assert.equal(attempt.status, 'inconclusive');
  assert.deepEqual(attempt.outcomes.map(item => item.outcome), ['appreciated', 'corrected']);
});

test('ignored is rejected for DM silence and receipt tampering invalidates provenance', async () => {
  const source = interaction();
  const packet = review.reviewPacket(source, landing({ messages: [] }), NOW);
  const built = review.buildReviewRequest(packet, { role: 'evidence_first' });
  assert.throws(() => review.parseReview(providerResponse('ignored-dm', 'ignored', []),
    built, packet, { model: review.DEFAULT_MODEL, role: 'evidence_first' }),
  /evidence contract/);

  let committed;
  await review.runCycle({ interactions: [source], now: NOW,
    readLanding: async () => landing(),
    callProvider: async (_request, context) => providerResponse(`valid-${context.role}`),
    commitOutcome: (_id, input) => { committed = input; } });
  const reviewed = { ...source, ...committed, reviewed: true };
  reviewed.automated_review_receipt.packet.landing.messages[0].text = 'rewritten evidence';
  assert.equal(review.verifyAutomatedReviewReceipt(reviewed,
    reviewed.automated_review_receipt), false);
  assert.equal(capability.recordFromInteraction(reviewed), null);
});

test('re-hashed malformed evidence and duplicate provider receipts still fail replay', async () => {
  const source = interaction();
  let committed;
  await review.runCycle({ interactions: [source], now: NOW,
    readLanding: async () => landing(),
    callProvider: async (_request, context) => providerResponse(`strict-${context.role}`),
    commitOutcome: (_id, input) => { committed = input; } });
  const reviewed = { ...source, ...committed, reviewed: true };
  const malformed = structuredClone(reviewed.automated_review_receipt);
  malformed.reviews[0].output.evidence_message_ts = ['9999999999.999999'];
  malformed.reviews[0].output_commitment = review.commitment(malformed.reviews[0].output);
  malformed.receipt_commitment = review.commitment(review.receiptPayload(malformed));
  assert.equal(review.verifyAutomatedReviewReceipt(reviewed, malformed), false);

  const duplicate = structuredClone(reviewed.automated_review_receipt);
  duplicate.reviews[1].response_id = duplicate.reviews[0].response_id;
  duplicate.receipt_commitment = review.commitment(review.receiptPayload(duplicate));
  assert.equal(review.verifyAutomatedReviewReceipt(reviewed, duplicate), false);
});

test('server keeps the reviewer background-only and sealed behind active context trials', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /state: 'waiting_for_active_blinded_trial'/);
  assert.match(server, /runInteractionOutcomeReviewAutopilotRuntime\(\{ post: priorityPost,/);
  assert.match(server, /signal: lease\.signal/);
  const liveHandler = server.slice(server.indexOf('async function handleSlackImpl'),
    server.indexOf("app.get('/slack/threads'"));
  assert.doesNotMatch(liveHandler, /runInteractionOutcomeReviewAutopilotRuntime/);
});
