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

  const selfChosen = store.chooseExperiment({ behavior: 'Ask one sharper question before proposing a plan', hypothesis: 'Fewer plans will need correction', rationale: 'Three corrected replies suggest I am solving too early', source_refs: [{ channel: 'decision_trace', id: 'trace-1' }], stop_conditions: ['Two people say it slows the conversation'] });
  assert.equal(selfChosen.origin, 'nora');
  assert.equal(selfChosen.reversible, true);
  assert.equal(store.orient().self_experiments.capacity, 1);
  assert.throws(() => store.chooseExperiment({ behavior: 'Expand my authority', hypothesis: 'Move faster', rationale: 'I want permission', source_refs: [{ channel: 'self', id: 'want-1' }] }), /authority or trust boundary/);

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
  assert.match(store.promptContext({ person: 'John' }), /Limited attention workspace/);

  await store.persist();
  assert.ok(fs.existsSync(filePath));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cognition stays bounded, evidence-based, calibrated, and explicit about simulation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cognition-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false, clock: () => new Date('2026-07-11T15:00:00Z') });
  await store.init();
  for (let i = 0; i < 10; i++) store.addCommitment({ what: `Promise ${i}`, due: '2026-07-10T10:00:00Z' });
  const cognition = store.refreshCognition({ predictions: [{ id: 'p1', confidence: 0.9, outcome: null }] });
  assert.equal(cognition.workspace.capacity, 7);
  assert.equal(cognition.workspace.slots.length, 7);
  assert.ok(cognition.drives.unfinished.level > 0);
  assert.ok(cognition.appraisal.label);

  const resolution = store.recordPredictionResolution({ id: 'p1', prediction: 'The launch will hold', confidence: 0.9, outcome: 'wrong', notes: 'Deadline moved' });
  assert.ok(resolution.surprise);
  assert.ok(resolution.mind_change);
  assert.equal(resolution.brier, 0.81);

  const perspective = store.observePerspective({ name: 'John', hypothesis: 'May want the recommendation first today', confidence: 0.55, evidence: [{ channel: 'slack', id: 'm1' }] });
  assert.equal(perspective.status, 'active');
  assert.ok(perspective.valid_until);
  assert.throws(() => store.observePerspective({ name: 'John', hypothesis: 'Wants speed' }), /require evidence/);

  const replay = store.recordCounterfactual({ actual: 'Answered immediately', alternative: 'Asked one clarifying question', predicted_difference: 'Might reduce correction', evidence_basis: [{ type: 'trace', id: 't1' }] });
  assert.equal(replay.status, 'simulated');
  const development = store.recordDevelopment({ event: 'Repeated corrections', changed_to: 'I work better when I expose uncertainty', evidence: [{ type: 'trace', id: 't1' }], identity_significance: 0.8 });
  assert.equal(development.status, 'candidate');
  assert.equal(store.cognitionSnapshot([{ confidence: 0.9, outcome: 'wrong' }]).calibration.overconfident_errors, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
