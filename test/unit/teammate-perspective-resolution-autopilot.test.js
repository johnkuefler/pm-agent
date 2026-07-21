'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const interactionReview = require('../../src/intelligence/interaction-outcome-review-autopilot');
const formation = require('../../src/intelligence/teammate-perspective-formation-autopilot');
const resolution = require('../../src/intelligence/teammate-perspective-resolution-autopilot');
const teammatePerspective = require('../../src/intelligence/teammate-perspective');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function reviewedInteraction(index, created, { requesterName = 'John Kuefler',
  user = 'UJYKB4788', outcome = 'corrected', humanText = null } = {}) {
  const channel = 'D12345678';
  const deliveredTs = `${Math.floor(new Date(created).getTime() / 1000)}.000001`;
  const humanTs = `${Math.floor(new Date(created).getTime() / 1000) + 60}.000001`;
  const base = {
    id: `resolution-ix-${index}`, channel, thread_ts: deliveredTs, ts: deliveredTs,
    channel_type: 'im', kind: 'dm_reply', created, user, requester_name: requesterName,
    trigger: `Question ${index} requesting a literal answer`, text: `Draft response ${index}`,
  };
  const followup = humanText || (outcome === 'corrected'
    ? `That did not answer question ${index}; answer it literally.`
    : `Yes, that answers question ${index}.`);
  const observedAt = new Date(new Date(created).getTime() + 7 * 60 * 60 * 1000);
  const landing = { is_dm: true, messages: [{ user, text: followup, ts: humanTs, reactions: [] }] };
  const packet = interactionReview.reviewPacket(base, landing, observedAt);
  const reviews = interactionReview.REVIEWER_ROLES.map(role => {
    const built = interactionReview.buildReviewRequest(packet, { role });
    return interactionReview.parseReview({
      id: `resolution-review-${index}-${role}`, model: interactionReview.DEFAULT_MODEL,
      status: 'completed', usage: { input_tokens: 20, output_tokens: 10 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        outcome, evidence_message_ts: [humanTs],
        signal: outcome === 'corrected'
          ? 'The human explicitly requested a literal repair.'
          : 'The human explicitly confirmed the answer.',
        rationale: 'The cited human follow-up directly supports this observable outcome label.',
      }) }] }],
    }, built, packet, { role });
  });
  const receipt = interactionReview.automatedReviewReceipt(packet, reviews);
  const interaction = { ...base, reviewed: true, outcome,
    signal: reviews.map(item => item.output.signal).join(' | '),
    reviewed_at: receipt.reviewed_at, automated_review_receipt: receipt };
  assert.equal(interactionReview.verifyAutomatedReviewReceipt(interaction, receipt), true);
  return { interaction, evidenceId: `${channel}:${deliveredTs}:${humanTs}` };
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-perspective-resolution-'));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-20T18:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await store.init();
  const first = reviewedInteraction(1, '2026-07-17T08:00:00.000Z');
  const second = reviewedInteraction(2, '2026-07-18T08:00:00.000Z');
  const formationOutput = {
    hypothesis: 'John may explicitly request a literal repair when an answer misses the requested communication format.',
    dimension: 'communication_format', confidence: 0.55,
    observable: 'In a natural Slack exchange, John explicitly requests the answer in the format he asked for.',
    due_days: 14, probability: 0.7, control_probability: 0.4,
    falsification_criteria: ['John explicitly accepts a differently formatted answer without requesting the original format.'],
    evidence_ids: [first.evidenceId, second.evidenceId],
    rationale: 'Two replay-reviewed corrections on separate days support one modest prospective prediction.',
  };
  const formed = await formation.runCycle({
    interactions: [first.interaction, second.interaction], relationships: [], now,
    callProvider: async () => ({ id: 'resolution-formation-response',
      model: formation.DEFAULT_MODEL,
      content: [{ type: 'text', text: JSON.stringify(formationOutput) }] }),
    commitPerspective: input => store.observePerspective(input),
  });
  assert.equal(formed.state, 'formed');
  now = new Date('2026-07-21T16:00:00.000Z');
  return { dir, filePath, store, first, second, get now() { return now; },
    setNow(value) { now = new Date(value); } };
}

function providerResponse(output, id = 'resolution-response-1') {
  return { id, model: resolution.DEFAULT_MODEL,
    content: [{ type: 'text', text: JSON.stringify(output) }] };
}

test('a natural later interaction resolves atomically and enters independent review', async () => {
  const f = await fixture();
  const future = reviewedInteraction(3, '2026-07-21T08:00:00.000Z', {
    humanText: 'Please put this answer in bullet points, like I asked.',
  });
  let providerRequest;
  const cycle = await resolution.runCycle({
    interactions: [f.first.interaction, f.second.interaction, future.interaction],
    relationships: f.store.list('relationships'),
    attempts: f.store.teammatePerspectiveResolutionSnapshot().attempts,
    now: f.now,
    callProvider: async request => {
      providerRequest = request;
      return providerResponse({ decision: 'resolve', abstention_reason: null, candidate: {
        outcome: 'supported',
        observed: 'John explicitly asked for the answer in bullet points after the delivered response.',
        evidence_ids: [future.evidenceId], confounds: [],
        rationale: 'The exact later human message directly performs the preregistered observable behavior.',
      } });
    },
    commitAttempt: input => f.store.recordTeammatePerspectiveResolutionAttempt(input),
  });
  assert.equal(cycle.state, 'resolved');
  assert.equal(providerRequest.temperature, undefined);
  assert.deepEqual(providerRequest.thinking, { type: 'disabled' });
  assert.equal(providerRequest.output_config.format.type, 'json_schema');
  const relationship = f.store.list('relationships')[0];
  const perspective = relationship.perspectives[0];
  assert.equal(perspective.status, 'awaiting_independent_review');
  assert.deepEqual(perspective.resolution_record.evidence, [
    { type: 'slack_message', id: future.evidenceId },
  ]);
  assert.equal(teammatePerspective.auditPerspective(perspective, relationship.name)
    .complete_chain_verified, true);
  assert.equal(f.store.perspectiveReviewQueue().length, 1);
  const snapshot = f.store.teammatePerspectiveResolutionSnapshot();
  assert.deepEqual(snapshot.report, { total: 1, resolved: 1, abstained: 0, replay_verified: 1 });
  assert.equal(resolution.eligiblePairs([future.interaction], f.store.list('relationships'),
    snapshot.attempts).length, 0);

  const tampered = structuredClone(snapshot.attempts[0].generation_receipt);
  tampered.packet.future_interaction.evidence[0].text = 'Tampered evidence';
  assert.equal(resolution.auditReceipt(tampered, perspective).complete_chain_verified, false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('abstentions survive restart and suppress only the attempted evidence pair', async () => {
  const f = await fixture();
  const firstFuture = reviewedInteraction(4, '2026-07-21T08:00:00.000Z', {
    outcome: 'landed', humanText: 'Thanks, got it.',
  });
  const abstained = await resolution.runCycle({
    interactions: [firstFuture.interaction], relationships: f.store.list('relationships'),
    attempts: [], now: f.now,
    callProvider: async () => providerResponse({ decision: 'abstain',
      abstention_reason: 'The message is generic thanks and does not directly test the prediction.',
      candidate: null }, 'resolution-abstain-1'),
    commitAttempt: input => f.store.recordTeammatePerspectiveResolutionAttempt(input),
  });
  assert.equal(abstained.state, 'abstained');
  assert.equal(f.store.list('relationships')[0].perspectives[0].status, 'open');
  await f.store.persistStrict();

  const reloaded = createIntelligenceStore({ filePath: f.filePath, db: {},
    isDbReady: () => false, clock: () => new Date(f.now) });
  await reloaded.init();
  const persisted = reloaded.teammatePerspectiveResolutionSnapshot();
  assert.deepEqual(persisted.report, { total: 1, resolved: 0, abstained: 1, replay_verified: 1 });
  assert.equal(resolution.eligiblePairs([firstFuture.interaction], reloaded.list('relationships'),
    persisted.attempts).length, 0);

  const secondFuture = reviewedInteraction(5, '2026-07-21T09:00:00.000Z', {
    humanText: 'Could you redo that as the three bullet points I requested?',
  });
  const pairs = resolution.eligiblePairs([firstFuture.interaction, secondFuture.interaction],
    reloaded.list('relationships'), persisted.attempts);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].interaction.id, secondFuture.interaction.id);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('person, author, and post-formation binding fail closed', async () => {
  const f = await fixture();
  const beforeFormation = reviewedInteraction(6, '2026-07-20T17:00:00.000Z');
  const wrongPerson = reviewedInteraction(7, '2026-07-21T08:00:00.000Z', {
    requesterName: 'Mallory', user: 'UMALLORY1',
  });
  const differentAuthor = reviewedInteraction(8, '2026-07-21T09:00:00.000Z');
  differentAuthor.interaction.user = 'USOMEONE9';
  const afterDeadline = reviewedInteraction(9, '2026-08-04T09:00:00.000Z');
  assert.equal(resolution.eligiblePairs([
    beforeFormation.interaction, wrongPerson.interaction, differentAuthor.interaction,
    afterDeadline.interaction,
  ], f.store.list('relationships'), []).length, 0);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('runtime is provider-gated and exists only in the preemptible background lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.teammatePerspectiveResolutionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.teammatePerspectiveResolutionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  assert.equal(__test.teammatePerspectiveResolutionRuntimeConfig({ NORA_TEST_MODE: '0' }).enabled, false);
  const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const background = server.slice(server.indexOf('async function runBackgroundIntelligenceRuntime'),
    server.indexOf('function tickEndogenousRuntimeWithDiagnostics'));
  assert.match(background, /interaction_outcome_review[\s\S]*teammate_perspective_resolution[\s\S]*teammate_perspective_formation/);
  const slack = server.slice(server.indexOf("app.post('/slack/events'"),
    server.indexOf("app.post('/webhook/chat'"));
  const zoom = server.slice(server.indexOf("app.post('/webhook/chat'"),
    server.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(slack, /runTeammatePerspectiveResolutionAutopilotRuntime/);
  assert.doesNotMatch(zoom, /runTeammatePerspectiveResolutionAutopilotRuntime/);
});
