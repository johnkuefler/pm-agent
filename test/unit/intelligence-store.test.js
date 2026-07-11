const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

test('intelligence store connects commitments, episodes, relationships, traces, learning, and budgets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-intelligence-'));
  const filePath = path.join(dir, 'state.json');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-11T15:00:00Z') });
  await store.init();

  const commitment = store.addCommitment({ what: 'Send recap', task_id: 'task-1' });
  assert.equal(store.addCommitment({ what: 'Duplicate', task_id: 'task-1' }).id, commitment.id);
  assert.equal(store.updateCommitment(commitment.id, { status: 'fulfilled' }).status, 'fulfilled');

  const episode = store.recordEpisodeEvent({ correlation: 'slack:C1:1', actor: 'Nora', text: 'I will check', channel: 'slack' });
  store.recordEpisodeEvent({ correlation: 'slack:C1:1', actor: 'John', text: 'Thanks', channel: 'slack' });
  assert.equal(store.get('episodes', episode.id).events.length, 2);
  store.recordEpisodeEvent({ correlation: 'slack:C1:1', record_event: false, summary: 'John asked Nora to check launch readiness.', open_loop: { what: 'Confirm launch readiness', owner: 'Nora' } });
  assert.match(store.promptContext({ person: 'John', query: 'launch readiness', channel: 'slack:C1' }), /Relevant conversation continuity/);

  store.observeRelationship({ name: 'John', observation: 'Prefers the recommendation first', confidence: 0.9 });
  const trace = store.recordTrace({ action: 'reply', decision: 'responded', reasons: ['direct question'], interaction_id: 'ix-1' });
  assert.equal(store.updateTraceOutcome(null, { interaction_id: 'ix-1', outcome: 'landed', signal: 'John used the answer' }).id, trace.id);
  assert.equal(store.get('traces', trace.id).outcome, 'landed');
  const experiment = store.createExperiment({ behavior: 'Lead with the answer', hypothesis: 'Replies will land better' });
  store.recordExperimentSample({ experiment_id: experiment.id, outcome: 'landed', value: 1 });
  assert.equal(store.get('experiments', experiment.id).samples.length, 1);
  assert.equal(store.evaluateExperiment(experiment.id, { conclude: true }).status, 'active');
  for (let i = 0; i < 4; i++) store.recordExperimentSample({ experiment_id: experiment.id, outcome: 'landed', value: 1 });
  assert.equal(store.evaluateExperiment(experiment.id, { conclude: true }).status, 'retained');

  const overdue = store.addCommitment({ what: 'Overdue promise', due: '2026-07-10T10:00:00Z', episode_id: episode.id });
  const orientation = store.orient();
  assert.ok(orientation.commitments.overdue.some(item => item.id === overdue.id));
  assert.ok(orientation.episodes.open.some(item => item.id === episode.id));
  const started = store.startCycle({ holder: 'test' });
  assert.ok(started.cycle.orientation.overdue_commitments.includes(overdue.id));
  assert.equal(store.completeCycle(started.cycle.id, { summary: 'Handled it', actions: [{ type: 'commitment', id: overdue.id }] }).status, 'completed');

  store.setInitiativeBudget('slack:C1', 1);
  assert.equal(store.spendInitiative('slack:C1').allowed, true);
  assert.equal(store.spendInitiative('slack:C1').allowed, false);
  assert.match(store.promptContext({ person: 'John' }), /Open commitments|relationship observations|behavior experiments/);

  await store.persist();
  assert.ok(fs.existsSync(filePath));
  fs.rmSync(dir, { recursive: true, force: true });
});
