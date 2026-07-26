'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const interactionReview = require('../../src/intelligence/interaction-outcome-review-autopilot');
const formation = require('../../src/intelligence/teammate-perspective-formation-autopilot');
const teammatePerspective = require('../../src/intelligence/teammate-perspective');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { readServerSource } = require('../helpers/server-source');

function reviewedInteraction(index, created, outcome = 'corrected') {
  const channel = 'C12345678';
  const deliveredTs = `${Math.floor(new Date(created).getTime() / 1000)}.000001`;
  const humanTs = `${Math.floor(new Date(created).getTime() / 1000) + 60}.000001`;
  const base = {
    id: `ix-${index}`, channel, thread_ts: deliveredTs, ts: deliveredTs,
    channel_type: 'im', kind: 'dm_reply', created,
    requester_name: 'John', trigger: `Question ${index} requesting a literal answer`,
    text: `Draft response ${index}`,
  };
  const observedAt = new Date(new Date(created).getTime() + 7 * 60 * 60 * 1000);
  const landing = { is_dm: true, messages: [{ user: 'U12345678',
    text: outcome === 'corrected' ? `That did not answer question ${index}; answer it literally.` : `Yes, that answers question ${index}.`,
    ts: humanTs, reactions: [] }] };
  const packet = interactionReview.reviewPacket(base, landing, observedAt);
  const reviews = interactionReview.REVIEWER_ROLES.map(role => {
    const built = interactionReview.buildReviewRequest(packet, { role });
    const parsed = interactionReview.parseReview({
      id: `resp-${index}-${role}`, model: interactionReview.DEFAULT_MODEL,
      status: 'completed', usage: { input_tokens: 20, output_tokens: 10 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        outcome, evidence_message_ts: [humanTs],
        signal: outcome === 'corrected' ? 'The human explicitly requested a literal repair.' : 'The human explicitly confirmed the answer.',
        rationale: 'The cited human follow-up directly supports this observable outcome label.',
      }) }] }],
    }, built, packet, { role });
    return parsed;
  });
  const receipt = interactionReview.automatedReviewReceipt(packet, reviews);
  const interaction = { ...base, reviewed: true, outcome,
    signal: reviews.map(item => item.output.signal).join(' | '),
    reviewed_at: receipt.reviewed_at, automated_review_receipt: receipt };
  assert.equal(interactionReview.verifyAutomatedReviewReceipt(interaction, receipt), true);
  return { interaction, evidenceId: `${channel}:${deliveredTs}:${humanTs}` };
}

test('replay-reviewed outcomes can form one bounded Nora-authored prospective teammate prediction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-perspective-formation-'));
  const now = new Date('2026-07-20T18:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  const first = reviewedInteraction(1, '2026-07-17T08:00:00.000Z');
  const second = reviewedInteraction(2, '2026-07-18T08:00:00.000Z');
  const groups = formation.eligibleGroups([first.interaction, second.interaction], [], now);
  assert.equal(groups.length, 1);
  const packet = formation.evidencePacket(groups[0], now);
  const output = {
    hypothesis: 'John may explicitly request a literal repair when an answer substitutes generic small talk for the exact question.',
    dimension: 'clarification_need', confidence: 0.55,
    observable: 'In a naturally occurring Slack exchange, John explicitly redirects an answer back to the literal question.',
    due_days: 14, probability: 0.7, control_probability: 0.4,
    falsification_criteria: ['Comparable exchanges receive no literal-answer correction during the prediction window.'],
    evidence_ids: [first.evidenceId, second.evidenceId],
    rationale: 'Two independently reviewed corrections on separate days support a modest prospective test.',
  };
  let providerRequest = null;
  const cycle = await formation.runCycle({
    interactions: [first.interaction, second.interaction], relationships: [], now,
    callProvider: async request => {
      providerRequest = request;
      return { id: 'anthropic-formation-1', model: formation.DEFAULT_MODEL,
        content: [{ type: 'text', text: JSON.stringify(output) }] };
    },
    commitPerspective: input => store.observePerspective(input),
  });
  assert.equal(cycle.state, 'formed');
  assert.equal(providerRequest.temperature, undefined);
  assert.deepEqual(providerRequest.thinking, { type: 'disabled' });
  assert.equal(providerRequest.output_config.format.type, 'json_schema');
  assert.deepEqual(providerRequest.output_config.format.schema.required,
    formation.outputSchema(formation.evidencePacket(groups[0], now)).required);
  const relationship = store.list('relationships')[0];
  const perspective = relationship.perspectives[0];
  const audit = teammatePerspective.auditPerspective(perspective, relationship.name);
  assert.equal(audit.complete_chain_verified, true);
  assert.equal(teammatePerspective.validFormationAutomation(perspective.formation_record), true);
  assert.equal(perspective.status, 'open');
  assert.equal(perspective.formation_record.prediction.probability, 0.7);
  assert.equal(perspective.formation_record.prediction.control_probability, 0.4);

  const tampered = JSON.parse(JSON.stringify(perspective));
  tampered.formation_record.automation_output.hypothesis = 'Tampered hypothesis';
  assert.equal(teammatePerspective.auditPerspective(tampered, relationship.name).complete_chain_verified, false);
  const tamperedPacket = JSON.parse(JSON.stringify(perspective));
  tamperedPacket.formation_record.automation_packet.source_interactions[0].signal = 'Tampered source signal';
  assert.equal(teammatePerspective.auditPerspective(tamperedPacket, relationship.name).complete_chain_verified, false);
  assert.equal(formation.eligibleGroups([first.interaction, second.interaction],
    store.list('relationships'), now).length, 0, 'open prediction and used evidence prevent repeated formation');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formation abstains without source diversity and rejects invented evidence', () => {
  const first = reviewedInteraction(1, '2026-07-17T08:00:00.000Z');
  const sameDay = reviewedInteraction(2, '2026-07-17T09:00:00.000Z');
  assert.equal(formation.eligibleGroups([first.interaction, sameDay.interaction], [],
    new Date('2026-07-20T18:00:00.000Z')).length, 0);
  const diverse = reviewedInteraction(3, '2026-07-18T08:00:00.000Z');
  const packet = formation.evidencePacket(formation.eligibleGroups(
    [first.interaction, diverse.interaction], [], new Date('2026-07-20T18:00:00.000Z'))[0],
  new Date('2026-07-20T18:00:00.000Z'));
  assert.throws(() => formation.parseOutput(JSON.stringify({
    hypothesis: 'John may request a literal answer when a response misses the exact question.',
    dimension: 'clarification_need', confidence: 0.5,
    observable: 'John explicitly requests a literal repair in a later natural exchange.',
    due_days: 14, probability: 0.7, control_probability: 0.4,
    falsification_criteria: ['No repair occurs in comparable exchanges.'],
    evidence_ids: [first.evidenceId, 'CFAKE0000:1.000001:2.000001'],
    rationale: 'This rationale is long enough but contains an unavailable evidence reference.',
  }), packet), /violates the bounded prospective contract/);
  assert.throws(() => formation.parseOutput(JSON.stringify({
    hypothesis: 'John wants praise and feels anxious when a response is not sufficiently literal.',
    dimension: 'clarification_need', confidence: 0.5,
    observable: 'John explicitly requests a literal repair in a later natural exchange.',
    due_days: 14, probability: 0.7, control_probability: 0.4,
    falsification_criteria: ['No repair occurs in comparable exchanges.'],
    evidence_ids: [first.evidenceId, diverse.evidenceId],
    rationale: 'Two source interactions are cited, but the hypothesis invents a hidden state.',
  }), packet), /violates the bounded prospective contract/);
});

test('runtime enables formation only in the background provider lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.teammatePerspectiveFormationRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.teammatePerspectiveFormationRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  assert.equal(__test.teammatePerspectiveFormationRuntimeConfig({ NORA_TEST_MODE: '0' }).enabled, false);
  const server = readServerSource();
  const background = server.slice(server.indexOf('async function runBackgroundIntelligenceRuntime'),
    server.indexOf('function tickEndogenousRuntimeWithDiagnostics'));
  assert.match(background, /interaction_outcome_review[\s\S]*teammate_perspective_formation/);
  const runtime = server.slice(server.indexOf('async function runTeammatePerspectiveFormationAutopilotRuntime'),
    server.indexOf('async function runProfessionalViewpointReflectionAutopilotRuntime'));
  assert.match(runtime, /intelligence\.teammatePerspectiveStudyActive\(\)/);
  assert.doesNotMatch(runtime, /activeContextTrialsSnapshot\(\)/);
  const slack = server.slice(server.indexOf("app.post('/slack/events'"),
    server.indexOf("app.post('/webhook/chat'"));
  const zoom = server.slice(server.indexOf("app.post('/webhook/chat'"),
    server.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(slack, /runTeammatePerspectiveFormationAutopilotRuntime/);
  assert.doesNotMatch(zoom, /runTeammatePerspectiveFormationAutopilotRuntime/);
});
