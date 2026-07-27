const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMemoryRecord, memoryIsActive, memoryPromptLine, normalizeCommitment } = require('../../src/intelligence/models');
const { assessUncertainty, detectRepairNeed, initiativeDecision, meetingTurnDecision, scoreMeetingContribution } = require('../../src/intelligence/policy');
const { runBench } = require('../../src/intelligence/bench');
const { scoreWorkspace } = require('../../src/intelligence/cognition');
const { renderInnerThreadContext, workspaceCapacityForAssignment, higherOrderMonitorEnabled, attentionDirectiveModeForAssignment } = require('../../src/intelligence/self-model');

test('Memory v2 enriches legacy facts without changing their text', () => {
  const memory = normalizeMemoryRecord({ fact: 'Launch is May 14', source: 'meeting', added: '2026-07-11' });
  assert.equal(memory.fact, 'Launch is May 14');
  assert.equal(memory.kind, 'fact');
  assert.equal(memory.status, 'active');
  assert.equal(memory.confidence, 0.85);
  assert.equal(memoryIsActive(memory), true);
});

test('Memory v2 infers non-factual kinds and exposes uncertainty only when useful', () => {
  const inference = normalizeMemoryRecord({ fact: 'The launch is probably moving', source: 'meeting' });
  assert.equal(inference.kind, 'inference');
  assert.match(memoryPromptLine(inference), /inference/);
  assert.match(memoryPromptLine({ fact: 'Confirmed', confidence: 0.95 }), /^- Confirmed$/);
});

test('expired and superseded memories stay out of active context', () => {
  assert.equal(memoryIsActive({ fact: 'Old', status: 'superseded' }), false);
  assert.equal(memoryIsActive({ fact: 'Expired', status: 'active', valid_until: '2020-01-01' }), false);
});

test('commitments preserve owner, beneficiary, evidence, and follow-up state', () => {
  const commitment = normalizeCommitment({ what: 'Send the recap', owner: 'Nora', beneficiary: 'John', evidence: { channel: 'slack', id: '1' } });
  assert.equal(commitment.status, 'open');
  assert.equal(commitment.follow_up, true);
  assert.equal(commitment.evidence.channel, 'slack');
});

test('uncertainty policy verifies disputed, changing, and high-stakes claims', () => {
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.9, status: 'disputed' }] }).verify, true);
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.99 }], highStakes: true }).verify, true);
  assert.equal(assessUncertainty({ memories: [{ confidence: 0.98, status: 'active' }] }).verify, false);
});

test('meeting judgment speaks when addressed and yields to human exchanges', () => {
  assert.equal(scoreMeetingContribution({ named: true }).shouldSpeak, true);
  assert.equal(scoreMeetingContribution({ named: true, someoneInterruptedNora: true }).shouldSpeak, false);
  assert.equal(scoreMeetingContribution({ humansTalkingToEachOther: true }).shouldSpeak, false);
  assert.equal(scoreMeetingContribution({ directQuestion: true }).shouldSpeak, false);
  assert.equal(scoreMeetingContribution({ directQuestion: true, continuation: true }).shouldSpeak, true);
  assert.equal(meetingTurnDecision({ candidate: false, named: true }).shouldSpeak, false);
  assert.equal(meetingTurnDecision({ candidate: true, named: true }).shouldSpeak, true);
});

test('initiative requires both value and remaining social budget', () => {
  assert.equal(initiativeDecision({ value: 1, urgency: 1, confidence: 1, interruptionCost: 0, budgetRemaining: 1 }).allowed, true);
  assert.equal(initiativeDecision({ value: 1, urgency: 1, confidence: 1, interruptionCost: 0, budgetRemaining: 0 }).allowed, false);
});

test('repair policy distinguishes corrections from unchanged evidence', () => {
  assert.equal(detectRepairNeed({ priorClaim: 'May 14', newEvidence: 'May 21' }).needed, true);
  assert.equal(detectRepairNeed({ priorClaim: 'May 14', newEvidence: 'May 14' }).needed, false);
});

test('Nora Bench passes every grounded judgment scenario', () => {
  const report = runBench();
  assert.ok(report.total >= 12);
  assert.equal(report.passed, report.total, report.results.filter(item => !item.passed).map(item => item.id).join(', '));
});

test('blinded continuity ablation removes only the inner thread context', () => {
  const full = renderInnerThreadContext('I am still thinking about the launch.', { intervention: 'inner_thread_presence', condition: 'full' });
  const ablated = renderInnerThreadContext('I am still thinking about the launch.', { intervention: 'inner_thread_presence', condition: 'ablated' });
  assert.match(full, /still thinking about the launch/);
  assert.equal(ablated, '');
  assert.match(full, /private context that makes you continuous/);
  assert.equal(renderInnerThreadContext('Unrelated genuine prior context.', { intervention: 'continuity_context', condition: 'ablated' }), '');
  assert.match(renderInnerThreadContext('Unrelated genuine prior context.', { intervention: 'continuity_context', condition: 'shuffled' }), /Unrelated genuine prior context/);
  const lineage = renderInnerThreadContext({
    protocol_version: 2, content: 'Byte-identical verified handoff text.', content_commitment: 'content-hash',
    binding: { temporal_relation: 'replay_verified_latest_handoff', record_commitment: 'record-hash', sequence: 4, cycle_id: 'cycle-4' },
  }, { intervention: 'continuity_context', condition: 'verified_self_bound' });
  assert.match(lineage, /Candidate predecessor-state note/);
  assert.match(lineage, /byte-identical across study arms/);
  assert.match(lineage, /replay-verified as Nora's latest committed handoff/);
  assert.match(lineage, /not evidence of uninterrupted awareness or phenomenal consciousness/);
});

test('workspace-capacity intervention creates graded access without changing unrelated trials', () => {
  assert.equal(workspaceCapacityForAssignment({ intervention: 'workspace_capacity', condition: 'full' }), 7);
  assert.equal(workspaceCapacityForAssignment({ intervention: 'workspace_capacity', condition: 'half' }), 3);
  assert.equal(workspaceCapacityForAssignment({ intervention: 'workspace_capacity', condition: 'ablated' }), 0);
  assert.equal(workspaceCapacityForAssignment({ intervention: 'inner_thread_presence', condition: 'ablated' }), 7);
});

test('higher-order lesion disables only the monitor flag', () => {
  assert.equal(higherOrderMonitorEnabled({ intervention: 'higher_order_monitor', condition: 'full' }), true);
  assert.equal(higherOrderMonitorEnabled({ intervention: 'higher_order_monitor', condition: 'ablated' }), false);
  assert.equal(higherOrderMonitorEnabled({ intervention: 'inner_thread_presence', condition: 'ablated' }), true);
});

test('attention-schema control changes only the effective workspace modulation target', () => {
  const state = {
    commitments: [
      {
        id: 'target', what: 'Target commitment', owner: 'Nora', status: 'open',
        authority_class: 'bounded', provenance_status: 'server_internal',
        source_chain_verified: true,
      },
      {
        id: 'control-a', what: 'Control commitment A', owner: 'Nora', status: 'open',
        authority_class: 'bounded', provenance_status: 'server_internal',
        source_chain_verified: true,
      },
      {
        id: 'control-b', what: 'Control commitment B', owner: 'Nora', status: 'open',
        authority_class: 'bounded', provenance_status: 'server_internal',
        source_chain_verified: true,
      },
    ],
    episodes: [], experiments: [], relationships: [], traces: [], cycles: [],
    cognition: {
      drives: {}, surprises: [], mind_changes: [], development: [], recurrent_signals: [],
      attention_schema: { directives: [{
        id: 'directive-1', status: 'active', target: { type: 'commitment', id: 'target' }, boost: 3,
      }] },
    },
  };
  const now = new Date('2026-07-12T12:00:00Z');
  const targeted = scoreWorkspace(state, { attentionDirectiveMode: 'targeted_boost' }, now);
  const sham = scoreWorkspace(state, { attentionDirectiveMode: 'sham_boost', attentionShamSeed: 'unit-1' }, now);
  const repeatedSham = scoreWorkspace(state, { attentionDirectiveMode: 'sham_boost', attentionShamSeed: 'unit-1' }, now);
  const absent = scoreWorkspace(state, { attentionDirectiveMode: 'no_boost' }, now);

  assert.deepEqual(targeted.modulation[0].target, { type: 'commitment', id: 'target' });
  assert.deepEqual(targeted.modulation[0].configured_target, { type: 'commitment', id: 'target' });
  assert.notDeepEqual(sham.modulation[0].target, sham.modulation[0].configured_target);
  assert.deepEqual(sham.modulation, repeatedSham.modulation);
  assert.deepEqual(absent.modulation, []);
  assert.deepEqual(state.cognition.attention_schema.directives[0].target, { type: 'commitment', id: 'target' });
  assert.equal(attentionDirectiveModeForAssignment({ intervention: 'attention_schema_control', condition: 'sham_boost' }), 'sham_boost');
  assert.equal(attentionDirectiveModeForAssignment({ intervention: 'workspace_capacity', condition: 'ablated' }), 'targeted_boost');
});
