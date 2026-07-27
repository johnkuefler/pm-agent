'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflection = require('../../src/intelligence/cycle-self-correction-reflection');
const { createIntelligenceStore, emptyState } = require('../../src/intelligence/store');

const NOW = new Date('2026-07-17T18:00:00.000Z');

function completedCycle(id = 'cycle-self-correction-fixture') {
  return {
    id, status: 'completed', started: '2026-07-17T16:00:00.000Z',
    summary: 'A candidate ownership gap was reversed after reading the gating task.',
    experience_moment_id: 'moment-self-correction-fixture',
    actions: [
      { id: 'sweep', type: 'deadline_sweep',
        decision: 'Selected eleven unassigned component tasks as the likely actionable ownership gap.',
        result: 'Eleven unassigned component tasks selected for possible escalation.',
        evidence: 'teamwork-window' },
      { id: 'task-read', type: 'deadline_review',
        decision: 'Read the gating task before escalating and reversed the initial interpretation.',
        result: 'The components were already built by an AI-agent lane; only the ADA design item lacked ownership.',
        evidence: 'task-40439623' },
      { id: 'memory', type: 'memory_write',
        decision: 'Stored the corrected ownership distinction for later sweeps.',
        result: 'Correction memory written.', evidence: 'memory-correction' },
    ],
  };
}

function correctionOutput(cycle = completedCycle()) {
  return {
    decision: 'record', abstention_reason: null,
    correction: {
      statement: 'The eleven unassigned component tasks represented an actionable ownership gap.',
      initial_polarity: 'supports', initial_confidence: 0.72,
      initial_basis: 'The deadline sweep found a coherent cluster of unassigned component work near delivery.',
      initial_action_ref: reflection.actionRef(cycle.id, 0),
      observed_polarity: 'denies', observed_confidence: 0.94,
      evidence_action_refs: [reflection.actionRef(cycle.id, 1)],
      revised_confidence: 0.9,
      revision_basis: 'Reading the gating task showed that the AI-agent lane had already built every component and isolated one different unowned ADA item.',
      future_check: 'Before escalating an unassigned cluster, read one governing task for an alternate ownership lane or completed evidence.',
    },
  };
}

function providerResponse(request, output, id = 'msg-cycle-self-correction') {
  return { id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 650, output_tokens: 220 } };
}

async function fixture(t, cycles = [completedCycle()], configure = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cycle-self-correction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = emptyState();
  initial.cycles = structuredClone(cycles);
  if (configure) configure(initial);
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(NOW), initialState: initial });
  await store.init();
  return store;
}

test('completed-cycle reflection records and closes one replay-bound self-correction', async t => {
  const cycle = completedCycle();
  const store = await fixture(t, [cycle]);
  const run = await reflection.runCycle({ store, cycles: [cycle], now: NOW,
    callProvider: async request => providerResponse(request, correctionOutput(cycle)) });
  assert.equal(run.state, 'self_correction_recorded');
  assert.ok(run.discrepancy_id);

  const lifecycle = store.epistemicSelfCorrectionReflectionSnapshot();
  assert.deepEqual(lifecycle.report, {
    total: 1, recorded: 1, abstained: 0, replay_verified: 1,
    replay_verified_corrections: 1,
  });
  const ledger = store.epistemicLedgerSnapshot();
  assert.equal(ledger.propositions.length, 1);
  assert.equal(ledger.propositions[0].positions.length, 3);
  assert.equal(ledger.propositions[0].audit.complete_chain_verified, true);
  assert.equal(ledger.discrepancies.length, 1);
  assert.equal(ledger.discrepancies[0].status, 'closed');
  assert.equal(ledger.discrepancies[0].audit.complete_chain_verified, true);

  const packet = store.epistemicSelfCorrectionPacket('Should I escalate this unassigned component cluster?');
  assert.equal(packet.length, 1);
  assert.match(packet[0].future_check, /governing task/i);
  const prompt = store.promptContext({ query: 'Should I escalate this unassigned component cluster?',
    channel: 'slack', epistemicContext: store.epistemicContextForAssignment(null,
      'Should I escalate this unassigned component cluster?') });
  assert.match(prompt, /Verified completed-cycle self-corrections/);
  assert.match(prompt, /governing task/i);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'epistemic_self_correction');
  assert.equal(indicator.evidence.replay_verified_cycle_corrections, 1);
  const dashboard = store.dashboardIntelligenceSummary();
  assert.equal(dashboard.cognition.reflection.replay_verified_cycle_self_corrections, 1);
  assert.match(dashboard.brain.reflection.evidence, /1 replay-verified cycle self-corrections/);
});

test('ordinary correction readback stays sealed throughout an active blinded trial', async t => {
  const cycle = completedCycle('cycle-sealed-readback');
  const store = await fixture(t, [cycle], initial => {
    initial.cognition.self_model.context_trials.push({
      id: 'unrelated-active-trial', status: 'active', intervention: 'goal_access',
      assignments: [],
    });
  });
  const run = await reflection.runCycle({ store, cycles: [cycle], now: NOW,
    callProvider: async request => providerResponse(request, correctionOutput(cycle),
      'msg-cycle-sealed-readback') });
  assert.equal(run.state, 'self_correction_recorded',
    'append-only capture can continue without exposing it to the active trial');
  const context = store.epistemicContextForAssignment(null,
    'Should I escalate this unassigned component cluster?');
  assert.deepEqual(context.correction_packet, []);
});

test('abstention is replay-bound, non-operative, and consumes the daily attempt', async t => {
  const cycle = completedCycle('cycle-abstain');
  const store = await fixture(t, [cycle]);
  const run = await reflection.runCycle({ store, cycles: [cycle], now: NOW,
    callProvider: async request => providerResponse(request, {
      decision: 'abstain',
      abstention_reason: 'The later action added detail but did not contradict an explicitly committed earlier position.',
      correction: correctionOutput(cycle).correction,
    }, 'msg-cycle-abstain') });
  assert.equal(run.state, 'abstained');
  assert.equal(store.epistemicLedgerSnapshot().propositions.length, 0);
  assert.equal(store.epistemicSelfCorrectionReflectionSnapshot().report.replay_verified, 1);
  let calls = 0;
  const second = await reflection.runCycle({ store,
    cycles: [cycle, completedCycle('cycle-second')], now: NOW,
    callProvider: async () => { calls += 1; throw new Error('must not call'); } });
  assert.equal(second.state, 'daily_attempt_limit');
  assert.equal(calls, 0);
});

test('normalization rejects hindsight, unordered evidence, and private-state claims', () => {
  const cycle = completedCycle();
  const packet = reflection.packetFor(reflection.cycleSnapshot(cycle));
  const unordered = correctionOutput(cycle);
  unordered.correction.initial_action_ref = reflection.actionRef(cycle.id, 1);
  unordered.correction.evidence_action_refs = [reflection.actionRef(cycle.id, 0)];
  assert.throws(() => reflection.normalizeOutput(unordered, packet), /occur after/);
  const phenomenal = correctionOutput(cycle);
  phenomenal.correction.statement = 'My subjective experience proved the ownership gap was operationally actionable.';
  assert.throws(() => reflection.normalizeOutput(phenomenal, packet), /outside bounded work claims/);
  const missing = correctionOutput(cycle);
  missing.correction.evidence_action_refs = ['cycle-action:outside:9'];
  assert.throws(() => reflection.normalizeOutput(missing, packet), /outside the committed packet/);
});

test('deterministic eligibility admits explicit correction cues without treating them as proof', () => {
  const eligible = completedCycle('cycle-cued');
  const quiet = completedCycle('cycle-quiet');
  quiet.actions[1].decision = 'Read the gating task and documented the current implementation.';
  quiet.actions[1].result = 'The components were already built and one ADA item lacked ownership.';
  quiet.summary = 'A routine review completed.';
  assert.ok(reflection.correctionCueCount(reflection.cycleSnapshot(eligible)) > 0);
  assert.equal(reflection.correctionCueCount(reflection.cycleSnapshot(quiet)), 0);
  assert.equal(reflection.selectSourceCycle([quiet], [], NOW), null);
  assert.equal(reflection.selectSourceCycle([quiet, eligible], [], NOW).id, eligible.id);
  assert.match(reflection.packetFor(reflection.cycleSnapshot(eligible)).eligibility_rule.rule,
    /not evidence/);
});

test('generic contrast language does not spend a reflection call', () => {
  const quiet = completedCycle('cycle-generic-contrast');
  quiet.actions[1].decision = 'Kept the existing flag rather than posting a duplicate reminder.';
  quiet.actions[1].result = 'No new evidence landed and no position changed.';
  quiet.summary = 'The run stayed quiet instead of manufacturing work.';
  assert.equal(reflection.correctionCueCount(reflection.cycleSnapshot(quiet)), 0);
  assert.equal(reflection.selectSourceCycle([quiet], [], NOW), null);
});

test('receipt replay detects output and packet tampering', () => {
  const cycle = completedCycle();
  const packet = reflection.packetFor(reflection.cycleSnapshot(cycle));
  const request = reflection.requestFor(packet).request;
  const submission = reflection.submissionFor(packet,
    providerResponse(request, correctionOutput(cycle)));
  assert.equal(reflection.auditReceipt(submission.receipt).complete_chain_verified, true);
  const tamperedOutput = structuredClone(submission.receipt);
  tamperedOutput.output.correction.future_check = 'Trust the pattern without checking.';
  assert.equal(reflection.auditReceipt(tamperedOutput).complete_chain_verified, false);
  const tamperedPacket = structuredClone(submission.receipt);
  tamperedPacket.source_packet.source_cycle.actions[1].result = 'Rewritten evidence';
  assert.equal(reflection.auditReceipt(tamperedPacket).complete_chain_verified, false);
});

test('foreground correction lookup fails quiet on malformed persisted attempts', async t => {
  const store = await fixture(t, [completedCycle()], initial => {
    initial.cognition.epistemic_self_correction_reflection.attempts.push({
      decision: 'record', generation_receipt: null, completed_at: NOW.toISOString(),
    });
  });
  assert.deepEqual(store.epistemicSelfCorrectionPacket('unassigned component ownership'), []);
  assert.doesNotThrow(() => store.epistemicContextForAssignment(null,
    'unassigned component ownership'));
});

test('runtime keeps cycle self-correction out of Slack and Zoom foreground handlers', () => {
  const { __test } = require('../../server');
  assert.equal(__test.cycleSelfCorrectionReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.cycleSelfCorrectionReflectionRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(source, /\['cycle_self_correction_reflection',[\s\S]*runCycleSelfCorrectionReflectionRuntime/);
  const slack = source.slice(source.indexOf("app.post('/webhook/slack'"), source.indexOf('// Dreams'));
  const zoom = source.slice(source.indexOf('async function processRecallChatWebhook'), source.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(slack, /cycleSelfCorrectionReflection|runCycleSelfCorrectionReflectionRuntime/);
  assert.doesNotMatch(zoom, /cycleSelfCorrectionReflection|runCycleSelfCorrectionReflectionRuntime/);
});
