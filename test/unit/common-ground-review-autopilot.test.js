'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const commonGround = require('../../src/intelligence/common-ground');
const autopilot = require('../../src/intelligence/common-ground-review-autopilot');

async function fixture(suffix = 'a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-common-ground-review-'));
  const now = new Date('2026-07-16T12:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  let proposition = store.recordEpistemicPosition({
    topic_key: `launch.readiness.${suffix}`, statement: 'The launch is ready for approval.',
    source_family: `launch-thread-${suffix}`,
    source_family_evidence: [{ type: 'slack_thread', id: `thread-${suffix}` }],
    owner_type: 'nora_belief', polarity: 'supports', confidence: 0.65,
    rationale: 'Nora provisionally supports launch readiness from the checked work.',
    evidence: [{ type: 'decision_trace', id: `nora-${suffix}` }], recorded_by: 'nora-runtime',
  });
  const nora = proposition.positions.find(item => item.owner_type === 'nora_belief');
  proposition = store.recordEpistemicPosition({
    topic_key: `launch.readiness.${suffix}`, statement: 'The launch is ready for approval.',
    owner_type: 'person_belief', subject: 'John', polarity: 'supports', confidence: 0.85,
    rationale: 'John explicitly restated that the launch is ready for approval.',
    evidence: [{ type: 'slack_message', id: `john-position-${suffix}` }], recorded_by: 'nora-runtime',
  });
  const john = proposition.positions.find(item => item.owner_type === 'person_belief');
  const evidenceId = `C12345678:1784201000.00000${suffix === 'a' ? '1' : '2'}:1784201000.00000${suffix === 'a' ? '1' : '2'}`;
  const candidate = store.recordCommonGround({
    proposition_id: proposition.id, person: 'John', nora_position_id: nora.id,
    person_position_id: john.id, acknowledgment_kind: 'accurate_restatement',
    summary: 'John accurately restated that the launch is ready and asked to route it for approval.',
    evidence: [{ type: 'slack_message', id: evidenceId }],
    expires_at: '2026-08-15T12:00:00.000Z',
  });
  return { dir, store, candidate, evidenceId };
}

function modelResponse({ role, evidenceId, outcome = 'verified' }) {
  const check = outcome === 'verified' ? 'confirmed'
    : outcome === 'not_verified' ? 'contradicted' : 'unresolved';
  const output = {
    outcome, person_identity_match: check, statement_match: check, uptake_kind_match: check,
    evidence_assessments: [{ evidence_id: evidenceId,
      supports_uptake: outcome === 'verified',
      observation: outcome === 'verified'
        ? 'John explicitly restates launch readiness and coordinates the approval handoff.'
        : 'The exact message does not establish the claimed uptake.' }],
    rationale: outcome === 'verified'
      ? 'The verified author explicitly restates the proposition and uses it to coordinate approval.'
      : outcome === 'not_verified'
        ? 'The cited message concretely contradicts the claimed person, meaning, and uptake.'
        : 'The exact cited wording leaves the claimed person, meaning, and uptake unresolved.',
  };
  return {
    id: `resp-common-ground-${role}-${outcome}`, model: autopilot.DEFAULT_MODEL,
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify(output) }] }], usage: { input_tokens: 90, output_tokens: 60 },
  };
}

test('provider-disjoint consensus replays exact Slack evidence and commits a tamper-evident review', async () => {
  const { dir, store, candidate, evidenceId } = await fixture('a');
  const before = autopilot.status(store, { enabled: true, model: autopilot.DEFAULT_MODEL });
  assert.equal(before.pending_total, 1);
  assert.equal(before.pending_replayable, 1);
  const requests = [];
  const result = await autopilot.runCycle({
    store,
    readEvidence: async ref => ({
      evidence_ref: ref, channel: 'C12345678', thread_ts: '1784201000.000001',
      message_ts: '1784201000.000001', author_id: 'UJYKB4788', author_name: 'John Kuefler',
      author_name_verified: true,
      text: 'Yes, the launch is ready for approval. Please route it to Maya.', edited_ts: null,
    }),
    callProvider: async (request, meta) => {
      requests.push({ request, meta });
      return modelResponse({ role: meta.role, evidenceId });
    },
  });
  assert.equal(result.state, 'reviewed');
  assert.equal(result.reviewed, 1);
  assert.equal(autopilot.status(store, { enabled: true }).pending_total, 0);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.request.store === false));
  assert.ok(requests.every(item => item.request.text.format.type === 'json_schema'
    && item.request.text.format.strict === true));
  assert.ok(requests.every(item => !JSON.stringify(item.request).includes('"condition":')),
    'the reviewer packet does not disclose a condition value');

  const record = store.commonGroundSnapshot({ person: 'John', query: 'launch ready approval' })
    .records.find(item => item.id === candidate.id);
  assert.equal(record.status, 'independently_verified');
  assert.equal(record.audit.final_evidence_eligible, true);
  assert.equal(record.audit.automated_review_receipt_verified, true);
  assert.equal(record.independent_review.automated_review_receipt.reviews.length, 2);
  assert.equal(record.independent_review.automated_review_receipt.provider, 'openai');
  assert.equal(record.independent_review.automated_review_receipt.subject_provider, 'anthropic');
  assert.equal(store.commonGroundFrameForPerson('John', 'launch ready approval').established.length, 1);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'interactional_common_ground');
  assert.equal(indicator.evidence.provider_disjoint_consensus_reviews, 1);

  const receipt = JSON.parse(JSON.stringify(record.independent_review.automated_review_receipt));
  receipt.reviews[0].output_commitment = '0'.repeat(64);
  assert.equal(commonGround.validAutomatedReviewReceipt(receipt, record.independent_review.evidence,
    record.independent_review.outcome, record.independent_review.evaluator_id), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reviewer disagreement becomes inconclusive and unreplayable Slack evidence stays pending', async () => {
  const { dir, store, evidenceId } = await fixture('b');
  const result = await autopilot.runCycle({
    store,
    readEvidence: async ref => ({
      evidence_ref: ref, channel: 'C12345678', thread_ts: '1784201000.000002',
      message_ts: '1784201000.000002', author_id: 'UJYKB4788', author_name: 'John Kuefler',
      author_name_verified: true, text: 'The launch is ready for approval.', edited_ts: null,
    }),
    callProvider: async (_request, meta) => modelResponse({ role: meta.role, evidenceId,
      outcome: meta.role === 'evidence_first' ? 'verified' : 'unclear' }),
  });
  assert.equal(result.reviewed, 1);
  const reviewed = store.commonGroundSnapshot({ person: 'John' }).records[0];
  assert.equal(reviewed.status, 'inconclusive');
  assert.equal(reviewed.audit.complete_chain_verified, true);
  assert.equal(reviewed.audit.final_evidence_eligible, false);

  assert.equal(commonGround.parseSlackEvidenceRef({ type: 'slack_message', id: '1784201000.000002' }), null);
  assert.equal(commonGround.parseSlackEvidenceRef({ type: 'slack_message',
    id: 'C12345678:1784201000.000003:1784201000.000002' }), null);
  assert.equal(commonGround.validFormationEvidence([
    { type: 'slack_message', id: 'missing-channel-and-thread' },
  ]), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Slack source reader resolves the exact canonical human message and fails closed on bots', async () => {
  const { __test } = require('../../server');
  assert.equal(__test.commonGroundReviewAutopilotRuntimeConfig({
    OPENAI_API_KEY: 'configured', SLACK_BOT_TOKEN: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.commonGroundReviewAutopilotRuntimeConfig({
    OPENAI_API_KEY: 'configured', SLACK_BOT_TOKEN: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const ref = { type: 'slack_message',
    id: 'C12345678:1784202000.000001:1784202000.000002' };
  const get = async url => {
    assert.match(String(url), /conversations\.replies/);
    return { data: { ok: true, messages: [
      { ts: '1784202000.000001', user: 'UOTHER', text: 'Thread root' },
      { ts: '1784202000.000002', user: 'UJYKB4788', text: 'I agree; route this for approval.' },
    ] } };
  };
  const snapshot = await __test.readCommonGroundSlackEvidence(ref, {
    get, resolveUserName: async id => id === 'UJYKB4788' ? 'John Kuefler' : null,
  });
  assert.equal(snapshot.message_ts, '1784202000.000002');
  assert.equal(snapshot.author_name, 'John Kuefler');
  assert.equal(snapshot.author_name_verified, true);
  assert.equal(snapshot.text, 'I agree; route this for approval.');

  await assert.rejects(() => __test.readCommonGroundSlackEvidence(ref, {
    get: async () => ({ data: { ok: true, messages: [{ ts: '1784202000.000002',
      user: 'UBOT', bot_id: 'BBOT', text: 'I agree.' }] } }),
    resolveUserName: async () => 'Bot',
  }), /attributable human Slack message/);
});
