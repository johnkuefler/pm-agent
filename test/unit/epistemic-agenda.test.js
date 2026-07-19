'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agenda = require('../../src/intelligence/epistemic-agenda');
const { createIntelligenceStore } = require('../../src/intelligence/store');

let now = new Date('2026-07-18T12:00:00.000Z');

function memories(extra = []) {
  return [
    { id: 'ownerless-alpha', added: '2026-07-17', project: 'Alpha', source: 'auto', kind: 'fact', status: 'active',
      fact: 'Three dated launch tasks remained at zero percent until an assignee was added.' },
    { id: 'ownerless-beta', added: '2026-07-15', project: 'Beta', source: 'meeting', kind: 'fact', status: 'active',
      fact: 'The team advanced an undated task after naming one accountable owner during review.' },
    { id: 'scope-gamma', added: '2026-07-16', project: 'Gamma', source: 'slack', kind: 'fact', status: 'active',
      fact: 'A scoped launch with explicit ownership reached review despite a later target date.' },
    ...extra,
  ];
}

function response(request, output, id = 'msg-agenda-1') {
  return { id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 400, output_tokens: 130 } };
}

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-epistemic-agenda-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();
  return { dir, store };
}

function formationOutput() {
  return {
    action: 'form',
    reason: 'The records create a useful tension between schedule metadata and accountable ownership.',
    topic_key: 'delivery.ownership-vs-date',
    question: 'When delivery work is under pressure, does explicit ownership predict movement better than the presence of a due date?',
    why_it_matters: 'A reliable answer would change which missing field Nora escalates first during delivery review.',
    current_best_answer: 'The limited evidence currently favors explicit ownership, but project complexity could explain the pattern.',
    confidence: 0.6, interest_score: 0.82,
    next_evidence: 'Naturally encountered cases where dated ownerless work moves, or owned undated work stalls, would weaken the current answer.',
    evidence_ids: ['ownerless-alpha', 'ownerless-beta', 'scope-gamma'],
  };
}

test('a question persists through replay-verified evidence-bound formation and revision', async () => {
  const { dir, store } = await makeStore();
  const formed = await agenda.runCycle({ store, memories: memories(), now,
    callProvider: async request => response(request, formationOutput()) });
  assert.equal(formed.state, 'committed');
  assert.equal(formed.action, 'form');

  let snapshot = store.epistemicAgendaSnapshot({ includeAttempts: true });
  assert.equal(snapshot.report.open, 1);
  assert.equal(snapshot.audit.complete_chain_verified, true);
  assert.equal(snapshot.report.replay_verified_attempts, 1);
  assert.equal(snapshot.protocol.foreground_provider_calls, false);
  assert.equal(snapshot.protocol.connector_actions, false);
  assert.match(snapshot.questions[0].question, /ownership predict movement/);

  now = new Date('2026-07-18T19:00:00.000Z');
  const newRecord = { id: 'counterexample-delta', added: '2026-07-18', project: 'Delta', source: 'slack', kind: 'fact', status: 'active',
    fact: 'A dated ownerless compliance task advanced because an automated dependency completed it.' };
  const prior = snapshot.questions[0];
  const revisedOutput = {
    action: 'update',
    reason: 'The new record is a bounded counterexample and lowers confidence without defeating the ownership pattern.',
    topic_key: prior.topic_key, question: prior.question, why_it_matters: prior.why_it_matters,
    current_best_answer: 'Explicit ownership still appears useful for human-coordinated work, but automated work can move without it.',
    confidence: 0.52, interest_score: 0.76,
    next_evidence: 'More naturally encountered automated and human-coordinated cases would show whether the distinction holds.',
    evidence_ids: ['counterexample-delta'],
  };
  const updated = await agenda.runCycle({ store, memories: memories([newRecord]), now,
    callProvider: async request => response(request, revisedOutput, 'msg-agenda-2') });
  assert.equal(updated.action, 'update');
  snapshot = store.epistemicAgendaSnapshot({ includeAttempts: true });
  assert.equal(snapshot.questions[0].confidence, 0.52);
  assert.equal(snapshot.questions[0].history.length, 2);
  assert.equal(snapshot.audit.complete_chain_verified, true);
  assert.equal(snapshot.report.replay_verified_attempts, 2);

  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'sustained_epistemic_agenda');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.provider_receipt_verified_attempts, 2);
  assert.equal(indicator.evidence.foreground_provider_calls, 0);

  await store.persist();
  const reloaded = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await reloaded.init();
  assert.equal(reloaded.epistemicAgendaSnapshot().audit.complete_chain_verified, true);
  assert.equal(reloaded.epistemicAgendaSnapshot().questions[0].confidence, 0.52);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formation fails closed for one context, external evidence, duplicates, and provider receipt tampering', async () => {
  const packet = agenda.packetFor({ memories: memories(), questions: [], now, mode: 'form' });
  const outside = { ...formationOutput(), evidence_ids: ['ownerless-alpha', 'missing'] };
  assert.throws(() => agenda.normalizeOutput(outside, packet), /outside its committed packet/);

  const oneContext = agenda.packetFor({ memories: memories().slice(0, 2).map((item, index) => ({
    ...item, id: `same-${index}`, added: '2026-07-18', project: 'Same',
  })), questions: [], now, mode: 'form' });
  assert.throws(() => agenda.normalizeOutput({ ...formationOutput(), evidence_ids: ['same-0', 'same-1'] }, oneContext),
    /two dates or projects/);

  const duplicatePacket = agenda.packetFor({ memories: memories(), questions: [{
    id: 'existing', status: 'open', ...formationOutput(), created_at: now.toISOString(), updated_at: now.toISOString(),
  }], now, mode: 'form' });
  assert.throws(() => agenda.normalizeOutput(formationOutput(), duplicatePacket), /must not duplicate/);

  const submission = agenda.submissionFor(packet,
    response(agenda.requestFor(packet).request, formationOutput()));
  assert.equal(agenda.auditReceipt(submission.receipt).complete_chain_verified, true);
  const tampered = structuredClone(submission.receipt);
  tampered.output.confidence = 0.4;
  assert.equal(agenda.auditReceipt(tampered).complete_chain_verified, false);
});

test('a relevant question can enter ordinary PM judgment with a replay-valid access and outcome receipt', async () => {
  now = new Date('2026-07-18T12:00:00.000Z');
  const { dir, store } = await makeStore();
  await agenda.runCycle({ store, memories: memories(), now,
    callProvider: async request => response(request, formationOutput()) });

  const query = 'Should explicit ownership predict movement better when Alpha delivery is under pressure?';
  const selected = store.promptContext({ query, returnContextReceipt: true });
  assert.match(selected.text, /Relevant question from your sustained epistemic agenda/);
  assert.equal(selected.context_receipt.epistemic_agenda_questions.length, 1);
  const packet = selected.context_receipt.epistemic_agenda_questions[0];
  assert.match(packet.question, /ownership predict movement/);
  assert.ok(packet.matched_terms.includes('ownership'));

  const unrelated = store.promptContext({ query: 'Please summarize the current project status.',
    returnContextReceipt: true });
  assert.doesNotMatch(unrelated.text, /sustained epistemic agenda/);
  assert.deepEqual(unrelated.context_receipt.epistemic_agenda_questions, []);
  const experimentallySealed = store.promptContext({ query, includeEpistemicAgenda: false,
    returnContextReceipt: true });
  assert.deepEqual(experimentallySealed.context_receipt.epistemic_agenda_questions, []);

  const interaction = {
    id: 'interaction-agenda-access-1', created: now.toISOString(),
    channel: 'C0123456789', ts: '1784385600.000001', thread_ts: '1784385600.000001',
    trigger: query, text: 'I would escalate the missing owner first and keep the date as supporting context.',
  };
  const application = await store.recordEpistemicAgendaAccessApplication(interaction, packet);
  assert.equal(application.access_claim, 'question_was_available_in_prompt_not_proven_used');
  assert.equal(application.observational_outcome_eligible, true);
  assert.equal(store.epistemicAgendaAccessAudit(application).complete_chain_verified, true);
  assert.equal('trigger' in application, false);
  assert.equal('text' in application, false);

  const reviewed = { ...interaction, reviewed: true, reviewed_at: '2026-07-18T12:05:00.000Z',
    outcome: 'appreciated', signal: 'The prioritization was useful.' };
  const resolved = await store.resolveEpistemicAgendaAccessOutcome(reviewed);
  assert.equal(resolved.resolution.success, true);
  const access = store.epistemicAgendaAccessSnapshot({ includeRecords: true });
  assert.equal(access.report.replay_verified_applications, 1);
  assert.equal(access.report.resolved_applications, 1);
  assert.equal(access.report.scored_outcomes, 1);
  assert.equal(access.report.successes, 1);
  assert.equal(access.applications[0].audit.source_question_replay_verified, true);

  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'sustained_epistemic_agenda');
  assert.equal(indicator.evidence.replay_verified_natural_access_applications, 1);
  assert.equal(indicator.evidence.natural_access_outcome_projection.successes, 1);

  const tampered = structuredClone(access.applications[0]);
  tampered.prompt_packet.question = 'A different question';
  assert.equal(store.epistemicAgendaAccessAudit(tampered).complete_chain_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relevance selection is local, bounded, and fast enough for foreground use', async () => {
  now = new Date('2026-07-18T12:00:00.000Z');
  const { dir, store } = await makeStore();
  await agenda.runCycle({ store, memories: memories(), now,
    callProvider: async request => response(request, formationOutput()) });
  const started = process.hrtime.bigint();
  for (let index = 0; index < 1000; index += 1) {
    const packets = store.epistemicAgendaPromptPackets(
      'Does explicit ownership predict movement under pressure?');
    assert.equal(packets.length, 1);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `1000 local selections took ${elapsedMs.toFixed(1)}ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime remains disabled in test mode, without credentials, or by explicit switch', () => {
  const { __test } = require('../../server');
  assert.equal(__test.epistemicAgendaRuntimeConfig({ ANTHROPIC_API_KEY: 'configured' }).enabled, true);
  assert.equal(__test.epistemicAgendaRuntimeConfig({ ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1' }).enabled, false);
  assert.equal(__test.epistemicAgendaRuntimeConfig({ ANTHROPIC_API_KEY: 'configured', NORA_EPISTEMIC_AGENDA: '0' }).enabled, false);
  assert.equal(__test.epistemicAgendaRuntimeConfig({}).enabled, false);
});

test('cooldown and no-new-evidence paths make no provider call', async () => {
  now = new Date('2026-07-18T12:00:00.000Z');
  const { dir, store } = await makeStore();
  await agenda.runCycle({ store, memories: memories(), now,
    callProvider: async request => response(request, formationOutput()) });
  let calls = 0;
  const cooled = await agenda.runCycle({ store, memories: memories(),
    now: new Date('2026-07-18T13:00:00.000Z'), callProvider: async () => { calls += 1; } });
  assert.equal(cooled.state, 'cooldown');
  assert.equal(calls, 0);
  now = new Date('2026-07-18T19:00:00.000Z');
  const noEvidence = await agenda.runCycle({ store, memories: memories(), now,
    callProvider: async () => { calls += 1; } });
  assert.equal(noEvidence.state, 'no_new_evidence');
  assert.equal(calls, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
