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

  store.observeRelationship({ name: 'John', observation: 'Prefers the recommendation first', confidence: 0.9 });
  store.recordTrace({ action: 'reply', decision: 'responded', reasons: ['direct question'] });
  const experiment = store.createExperiment({ behavior: 'Lead with the answer', hypothesis: 'Replies will land better' });
  store.recordExperimentSample({ experiment_id: experiment.id, outcome: 'landed', value: 1 });
  assert.equal(store.get('experiments', experiment.id).samples.length, 1);
  assert.equal(store.evaluateExperiment(experiment.id, { conclude: true }).status, 'retained');

  store.setInitiativeBudget('slack:C1', 1);
  assert.equal(store.spendInitiative('slack:C1').allowed, true);
  assert.equal(store.spendInitiative('slack:C1').allowed, false);
  assert.match(store.promptContext({ person: 'John' }), /Open commitments|relationship observations|behavior experiments/);

  await store.persist();
  assert.ok(fs.existsSync(filePath));
  fs.rmSync(dir, { recursive: true, force: true });
});
