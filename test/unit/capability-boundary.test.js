'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const boundary = require('../../src/intelligence/capability-boundary');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function interaction(index, { trigger = 'What is due tomorrow in Teamwork?', outcome = 'landed',
  user = `U${String(index % 4).padStart(8, '0')}`, day = 1 } = {}) {
  const ts = `1785${String(100000 + index).padStart(6, '0')}.000001`;
  return {
    id: `ix-${index}`, reviewed: true, outcome, signal: `review-${index}`,
    trigger, text: `response-${index}`, channel: 'C123456789', thread_ts: ts, ts,
    user, created: `2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    reviewed_at: `2026-07-${String(day).padStart(2, '0')}T13:00:00.000Z`,
    executed_tool_names: [],
  };
}

test('natural Slack outcomes become commitment-bound task-family evidence without retaining content', () => {
  const record = boundary.recordFromInteraction(interaction(1, {}));
  assert.equal(record.task_family, 'project_status_retrieval');
  assert.equal(record.success, true);
  assert.equal(record.evidence_ref.type, 'slack_message');
  assert.equal(boundary.verifyRecord(record), true);
  assert.equal(JSON.stringify(record).includes('What is due tomorrow'), false);
  assert.equal(JSON.stringify(record).includes('response-1'), false);
  assert.equal(boundary.recordFromInteraction({ ...interaction(2, {}), reviewed: false }), null);
  const tampered = { ...record, outcome: 'corrected' };
  assert.equal(boundary.verifyRecord(tampered), false);
});

test('capability projection stays uncertain when sparse, flags correction-heavy families, and requires diverse evidence to graduate', () => {
  const sparse = [1, 2, 3].map(index => boundary.recordFromInteraction(interaction(index, { day: index })));
  assert.equal(boundary.projection(sparse).families.project_status_retrieval.status, 'collecting');

  const correctionHeavy = Array.from({ length: 10 }, (_, offset) => boundary.recordFromInteraction(
    interaction(20 + offset, { outcome: offset < 3 ? 'corrected' : 'landed', day: 1 + (offset % 3) })));
  assert.equal(boundary.projection(correctionHeavy).families.project_status_retrieval.status,
    'verification_required');

  const reliable = Array.from({ length: 24 }, (_, offset) => boundary.recordFromInteraction(
    interaction(50 + offset, { outcome: offset === 0 ? 'corrected' : 'landed',
      user: `U${String(offset % 4).padStart(8, '0')}`, day: 1 + (offset % 4) })));
  const family = boundary.projection(reliable).families.project_status_retrieval;
  assert.equal(family.status, 'provisionally_reliable');
  assert.equal(family.recommendation, 'act_within_scope');
  assert.ok(family.success_interval_95.lower >= 0.65);
});

test('task-capability alignment never treats learned competence as tool access or authority', () => {
  const records = Array.from({ length: 24 }, (_, offset) => boundary.recordFromInteraction(
    interaction(100 + offset, { outcome: 'landed', day: 1 + (offset % 4) })));
  const learned = boundary.projection(records);
  const missing = boundary.align('What is due tomorrow?', { capabilities: [
    { key: 'teamwork_read', availability: 'unavailable' },
  ] }, learned);
  assert.equal(missing.recommendation, 'state_limit_or_handoff');
  assert.deepEqual(missing.missing_capability_keys, ['teamwork_read']);

  const present = boundary.align('What is due tomorrow?', { capabilities: [
    { key: 'teamwork_read', availability: 'available' },
  ] }, learned);
  assert.equal(present.recommendation, 'act_within_scope');
  assert.deepEqual(present.missing_capability_keys, []);
  const unknown = boundary.align('What is due tomorrow?', null, learned);
  assert.equal(unknown.recommendation, 'verify_current_affordance');
  assert.deepEqual(unknown.unverified_capability_keys, ['teamwork_read']);
  assert.equal(boundary.classifyTask('Draft a launch summary'), 'writing_synthesis');
  assert.equal(boundary.classifyTask('Create a task for Mallory'), 'action_execution');
});

test('store binds natural outcomes to the research ledger, exposes a compact self-model, and seals prompt access during another trial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-capability-boundary-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date('2026-07-17T12:00:00.000Z') });
  await store.init();
  const interactions = Array.from({ length: 24 }, (_, offset) => interaction(200 + offset, {
    outcome: offset === 0 ? 'corrected' : 'landed',
    user: `U${String(offset % 4).padStart(8, '0')}`, day: 1 + (offset % 4),
  }));
  const sync = store.syncCapabilityBoundaryOutcomes(interactions);
  assert.deepEqual({ added: sync.added, conflicts: sync.conflicts }, { added: 24, conflicts: 0 });
  assert.equal(store.syncCapabilityBoundaryOutcomes(interactions).already_present, 24);
  const snapshot = store.capabilityBoundarySnapshot({ includeRecords: true });
  assert.equal(snapshot.report.replay_valid, 24);
  assert.equal(snapshot.records.every(item => item.audit.complete_chain_verified), true);
  assert.equal(snapshot.projection.families.project_status_retrieval.status, 'provisionally_reliable');
  const compact = store.selfModelSnapshot().capability_boundaries;
  assert.equal(Object.hasOwn(compact, 'records'), false);
  assert.equal(compact.report.total, 24);
  const learned = store.capabilityBoundaryContext('What is due tomorrow?', { capabilities: [
    { key: 'teamwork_read', availability: 'available' },
  ] });
  assert.equal(learned.recommendation, 'act_within_scope');
  assert.match(store.promptContext({ query: 'What is due tomorrow?',
    capabilityBoundaryContext: learned }), /Observed task-specific capability boundary/);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'task_specific_capability_boundaries');
  assert.equal(indicator.status, 'observational_signal_observed');
  assert.equal(indicator.evidence.causal_status, 'not_causally_tested');

  const sealedState = store.snapshot();
  sealedState.cognition.self_model.context_trials.push({ id: 'active-seal', status: 'active' });
  const sealedStore = createIntelligenceStore({ filePath: path.join(dir, 'sealed.json'), db: {},
    isDbReady: () => false, initialState: sealedState });
  await sealedStore.init();
  assert.equal(sealedStore.capabilityBoundaryContext('What is due tomorrow?', { capabilities: [
    { key: 'teamwork_read', availability: 'available' },
  ] }), null);
  await store.persist();
  fs.rmSync(dir, { recursive: true, force: true });
});
