'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const formation = require('../../src/intelligence/common-ground-formation');
const review = require('../../src/intelligence/interaction-outcome-review-autopilot');

const NOW = new Date('2026-07-20T12:00:00.000Z');
const THREAD_TS = '1784480000.000001';
const HUMAN_TS = '1784480100.000002';

function sourceInteraction(overrides = {}) {
  return {
    id: 'ix-common-ground-source', created: '2026-07-19T10:00:00.000Z',
    reviewed: false, outcome: null, channel: 'D031HHSBM1Q', channel_type: 'im',
    thread_ts: THREAD_TS, ts: THREAD_TS, kind: 'dm_reply',
    trigger: 'Should we check the delivery dependency before committing to launch?',
    text: 'Yes. Checking the delivery dependency before commitment should prevent avoidable rework.',
    user: 'UJYKB4788', requester_name: 'John',
    ...overrides,
  };
}

function landing(text = 'yes, exactly — checking that delivery dependency first is the right call') {
  return { is_dm: true, truncated: false,
    messages: [{ user: 'UJYKB4788', text, ts: HUMAN_TS, reactions: [] }] };
}

function reviewResponse(id) {
  return { id, model: review.DEFAULT_MODEL, status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      outcome: 'landed', evidence_message_ts: [HUMAN_TS],
      signal: 'John explicitly confirmed the dependency-first recommendation.',
      rationale: 'The exact human follow-up confirms the recommendation without a correction.',
    }) }] }], usage: { input_tokens: 100, output_tokens: 50 } };
}

async function reviewedInteraction(text, overrides = {}) {
  const interaction = sourceInteraction(overrides);
  let committed;
  const cycle = await review.runCycle({ interactions: [interaction], now: NOW,
    readLanding: async () => landing(text),
    callProvider: async (_request, context) => reviewResponse(`review-${context.role}-${String(text || 'default').length}`),
    commitOutcome: (_id, input) => { committed = input; } });
  assert.equal(cycle.state, 'reviewed', JSON.stringify(cycle));
  const result = { ...interaction, ...committed, reviewed: true };
  assert.equal(review.verifyAutomatedReviewReceipt(result, result.automated_review_receipt), true);
  return result;
}

function formationResponse(output, id = 'anthropic-common-ground-formation-1') {
  return { id, model: formation.DEFAULT_MODEL, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 200, output_tokens: 80 } };
}

test('subject-side formation binds substantive uptake to an existing position and remains unusable until review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-common-ground-formation-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(NOW) });
  await store.init();
  const proposition = store.recordEpistemicPosition({
    topic_key: 'delivery.dependency-first',
    statement: 'Checking the delivery dependency before commitment prevents avoidable rework.',
    source_family: 'professional_reflection',
    source_family_evidence: [{ type: 'memory', id: 'dependency-pattern-1' }],
    owner_type: 'nora_belief', polarity: 'supports', confidence: 0.7,
    rationale: 'Repeated delivery evidence supports checking dependencies before commitment.',
    evidence: [{ type: 'memory', id: 'dependency-pattern-1' }], recorded_by: 'nora-reflection',
  });
  const interaction = await reviewedInteraction();
  let providerCalls = 0;
  const cycle = await formation.runCycle({ store, interactions: [interaction], now: NOW,
    callProvider: async request => {
      providerCalls += 1;
      assert.equal(request.model, formation.DEFAULT_MODEL);
      return formationResponse({ decision: 'form', abstention_reason: null, candidate: {
        proposition_id: proposition.id, person_polarity: 'supports', confidence: 0.9,
        acknowledgment_kind: 'explicit_acknowledgment', evidence_message_ts: [HUMAN_TS],
        summary: 'John explicitly confirmed that checking the delivery dependency first is the right call.',
      } });
    } });
  assert.equal(cycle.state, 'candidate_formed');
  assert.equal(providerCalls, 1);
  const formationSnapshot = store.commonGroundFormationSnapshot();
  assert.equal(formationSnapshot.report.formed, 1);
  assert.equal(formationSnapshot.report.replay_verified, 1);
  const common = store.commonGroundSnapshot({ person: 'John', query: 'delivery dependency' });
  assert.equal(common.report.awaiting_independent_review, 1);
  assert.equal(common.report.independently_verified_current, 0);
  assert.equal(store.commonGroundReviewQueue().length, 1);
  assert.equal(store.commonGroundFrameForPerson('John', 'delivery dependency').established.length, 0);
  const updated = store.epistemicLedgerSnapshot().propositions.find(item => item.id === proposition.id);
  assert.equal(updated.report.person_positions, 1);
  assert.equal(updated.positions.find(item => item.owner_type === 'person_belief').generation_receipt
    .receipt_commitment, formationSnapshot.attempts[0].generation_receipt.receipt_commitment);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generic thanks cannot be normalized into common ground and receipt tampering fails replay', async () => {
  const interaction = await reviewedInteraction('thanks!');
  const proposition = {
    id: 'epistemic-proposition-test', topic_key: 'delivery.dependency-first', status: 'active',
    statement: 'Checking the delivery dependency before commitment prevents avoidable rework.',
    proposition_kind: 'neutral', positions: [{
      id: 'epistemic-position-test', owner_type: 'nora_belief', subject: 'Nora', source_key: null,
      polarity: 'supports', confidence: 0.7, evidence: [{ type: 'memory', id: 'm1' }],
      rationale: 'Evidence supports it.', recorded_by: 'nora', observed_at: NOW.toISOString(),
      created: NOW.toISOString(), supersedes_position_id: null, previous_position_commitment: null,
    }],
  };
  const position = proposition.positions[0];
  position.position_commitment = require('../../src/intelligence/epistemic-ledger')
    .commitment(require('../../src/intelligence/epistemic-ledger').positionPayload(position));
  const packet = formation.packetFor({ interaction, propositions: [proposition] });
  assert.equal(packet.propositions.length, 1,
    'the delivered exchange can be topically relevant even though the uptake is insufficient');
  assert.throws(() => formation.normalizeOutput({ decision: 'form', abstention_reason: null,
    candidate: { proposition_id: proposition.id, person_polarity: 'supports', confidence: 0.8,
      acknowledgment_kind: 'explicit_acknowledgment', evidence_message_ts: [HUMAN_TS],
      summary: 'A generic thank-you is incorrectly being treated as explicit proposition uptake.' } }, packet),
  /unambiguous or lexical proposition uptake/);

  const validPacket = formation.packetFor({ interaction: await reviewedInteraction(), propositions: [proposition] });
  const submission = formation.submissionFor(validPacket, formationResponse({ decision: 'form',
    abstention_reason: null, candidate: { proposition_id: proposition.id, person_polarity: 'supports',
      confidence: 0.8, acknowledgment_kind: 'explicit_acknowledgment', evidence_message_ts: [HUMAN_TS],
      summary: 'John explicitly confirmed that checking the delivery dependency first is the right call.' } }));
  assert.equal(formation.auditReceipt(submission.receipt).complete_chain_verified, true);
  submission.receipt.source_packet.interaction.human_followups[0].text = 'rewritten evidence';
  assert.equal(formation.auditReceipt(submission.receipt).complete_chain_verified, false);
});

test('formation runs only in the preemptible background intelligence lane', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /\['common_ground_formation', \(\) => runCommonGroundFormationRuntime\(\{ post: priorityPost \}\)\]/);
  const liveHandler = server.slice(server.indexOf('async function handleSlackImpl'),
    server.indexOf("app.get('/slack/threads'"));
  assert.doesNotMatch(liveHandler, /runCommonGroundFormationRuntime/);
});

test('an older irrelevant reviewed exchange cannot starve a later relevant one', async () => {
  const irrelevant = await reviewedInteraction('yes, exactly — the rain is heavy today', {
    id: 'ix-irrelevant-weather', trigger: 'Is the weather still rainy?',
    text: 'The weather report still shows heavy rain.',
  });
  irrelevant.signal = 'John confirmed the weather report.';
  const relevant = await reviewedInteraction();
  const proposition = {
    id: 'epistemic-proposition-starvation', topic_key: 'delivery.dependency-first', status: 'active',
    statement: 'Checking the delivery dependency before commitment prevents avoidable rework.',
    proposition_kind: 'neutral', positions: [{
      id: 'epistemic-position-starvation', owner_type: 'nora_belief', subject: 'Nora', source_key: null,
      polarity: 'supports', confidence: 0.7, evidence: [{ type: 'memory', id: 'm-starvation' }],
      rationale: 'Evidence supports it.', recorded_by: 'nora', observed_at: NOW.toISOString(),
      created: NOW.toISOString(), supersedes_position_id: null, previous_position_commitment: null,
    }],
  };
  const epistemic = require('../../src/intelligence/epistemic-ledger');
  proposition.positions[0].position_commitment = epistemic.commitment(
    epistemic.positionPayload(proposition.positions[0]));
  let selected = null;
  const store = {
    commonGroundFormationSnapshot: () => ({ attempts: [] }),
    epistemicLedgerSnapshot: () => ({ propositions: [proposition] }),
    commonGroundSnapshot: () => ({ records: [] }),
    recordCommonGroundFormation: input => { selected = input.interaction_id; return { common_ground_id: 'cg-1' }; },
  };
  const result = await formation.runCycle({ store, interactions: [irrelevant, relevant],
    callProvider: async request => {
      assert.match(request.messages[0].content, new RegExp(relevant.id));
      return formationResponse({ decision: 'form', abstention_reason: null, candidate: {
        proposition_id: proposition.id, person_polarity: 'supports', confidence: 0.8,
        acknowledgment_kind: 'explicit_acknowledgment', evidence_message_ts: [HUMAN_TS],
        summary: 'John explicitly confirmed that checking the delivery dependency first is the right call.',
      } }, 'anthropic-common-ground-starvation');
    } });
  assert.equal(result.state, 'candidate_formed');
  assert.equal(selected, relevant.id);
});
