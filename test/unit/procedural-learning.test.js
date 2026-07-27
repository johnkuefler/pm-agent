const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const proceduralLearning = require('../../src/intelligence/procedural-learning');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const capabilityBoundary = require('../../src/intelligence/capability-boundary');

function reviewedInteraction(index, outcome, procedureSelection = null) {
  const ts = `178440${String(index).padStart(4, '0')}.000001`;
  return {
    id: `ix-procedure-${index}`,
    channel: 'C123456789', thread_ts: ts, ts,
    trigger: 'Can you give me the project status and deadline?',
    text: 'The current status is bounded by the verified source; I will call out uncertainty.',
    requester_name: `Teammate ${index % 3}`, user: `U${String(index).padStart(8, '0')}`,
    created: `2026-07-${String(1 + (index % 15)).padStart(2, '0')}T15:00:00.000Z`,
    reviewed: true, reviewed_at: `2026-07-${String(1 + (index % 15)).padStart(2, '0')}T16:00:00.000Z`,
    outcome, signal: `reviewed outcome ${outcome}`,
    ...(procedureSelection ? { procedure_selection: procedureSelection,
      procedure_exposure_ids: procedureSelection.procedures.map(item => item.id) } : {}),
  };
}

test('SELECT deterministically explores relevant candidates with a bounded prompt receipt', () => {
  const record = proceduralLearning.createRecord({
    id: 'proc-candidate', condition_txt: 'status requests with uncertain deadlines',
    action_txt: 'lead with the verified status and label the unresolved deadline explicitly',
    task_families: ['project_status_retrieval'],
    origin: { type: 'learning', id: 'm-learning-1' },
    source_refs: [{ type: 'interaction', id: 'ix-source-1' }],
  }, new Date('2026-07-17T00:00:00.000Z'));
  let selected = null;
  for (let index = 0; index < 100 && !selected; index++) {
    const attempt = proceduralLearning.select([record], [], {
      query: 'What is the project status and deadline?', selectionKey: `turn-${index}`,
      now: new Date('2026-07-17T01:00:00.000Z'), includeCandidates: true,
    });
    if (attempt.records.length) selected = attempt;
  }
  assert.ok(selected, 'bounded candidate exploration should expose an eligible candidate');
  assert.equal(selected.records[0].id, record.id);
  assert.equal(selected.receipt.procedures[0].selection_mode, 'candidate_exploration');
  assert.equal(proceduralLearning.verifySelectionReceipt(selected.receipt), true);
  assert.ok(proceduralLearning.render(selected.records).length < 600, 'SELECT prompt delta must stay below 600 chars');
  assert.equal(proceduralLearning.select([record], [], {
    query: 'Write a friendly hello', selectionKey: 'irrelevant', includeCandidates: true,
  }).records.length, 0);
});

test('SELECT learns from replay-bound exposure outcomes and promotes only against same-family controls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-procedures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-17T12:00:00.000Z');
  const sourceMemory = [{ id: 'm-learning-status', source: 'learning', status: 'active',
    fact: 'Lead with verified status and label deadline uncertainty.' }];
  const sourceInteractions = [
    { id: 'ix-evidence-1', reviewed: true, outcome: 'landed' },
    { id: 'ix-evidence-2', reviewed: true, outcome: 'appreciated' },
  ];
  const makeStore = () => createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now), getMemory: () => sourceMemory, getInteractions: () => sourceInteractions });
  const store = makeStore();
  await store.init();
  const created = store.createProcedure({
    id: 'proc-status-clarity', condition_txt: 'status requests with uncertain deadlines',
    action_txt: 'lead with verified status and explicitly label unresolved deadline uncertainty',
    task_families: ['project_status_retrieval'],
    origin: { type: 'learning', id: 'm-learning-status' },
    source_refs: [{ type: 'interaction', id: 'ix-evidence-1' }, { type: 'interaction', id: 'ix-evidence-2' }],
  });
  assert.equal(created.status, 'candidate');
  assert.equal(created.audit.complete_chain_verified, true);
  assert.deepEqual(store.activeProcedureSourceLearningIds(), ['m-learning-status']);

  // Twelve unexposed same-family controls: seven positive and five negative (58.3%).
  for (let index = 1; index <= 12; index++) {
    const interaction = reviewedInteraction(index, index <= 7 ? 'landed' : 'corrected');
    store.syncCapabilityBoundaryOutcomes([interaction]);
    const captured = store.recordProcedureInteractionOutcome(interaction);
    assert.equal(captured.added, true);
  }

  // Eight positive candidate exposures. The exact server selection receipt is carried into review.
  for (let offset = 0; offset < 8; offset++) {
    let selection = null;
    for (let attempt = 0; attempt < 100 && !selection; attempt++) {
      const candidate = store.procedureContextSelection({
        query: 'Can you give me the project status and deadline?',
        selectionKey: `candidate-${offset}-${attempt}`, includeCandidates: true,
      });
      if (candidate.records.some(item => item.id === created.id)) selection = candidate;
    }
    assert.ok(selection?.receipt);
    const interaction = reviewedInteraction(20 + offset, 'appreciated', selection.receipt);
    store.syncCapabilityBoundaryOutcomes([interaction]);
    store.recordProcedureInteractionOutcome(interaction);
  }

  const before = store.procedureStatsSnapshot();
  const projection = before.projections.find(item => item.procedure_id === created.id);
  assert.equal(projection.observed.decisive_samples, 8);
  assert.equal(projection.control.decisive_samples, 12);
  assert.equal(projection.recommendation, 'promote');
  const pass = store.runProcedureSelectionPass({ note: 'Eight positive candidate exposures cleared the preregistered gate.',
    evidence: [{ type: 'interaction_window', id: 'ix-procedure-1:ix-procedure-27' }] });
  assert.equal(pass.report.changed, 1);
  assert.equal(store.procedureStatsSnapshot().procedures.find(item => item.id === created.id).status, 'active');
  assert.throws(() => store.changeProcedureStatus(created.id, 'retired', {
    actor: 'nora', note: 'attempt to bypass the measured retirement gate',
  }), /measured retirement gate/);

  const prompt = store.promptContext({
    query: 'Can you give me the project status and deadline?', channel: 'slack',
    procedureSelectionKey: 'active-turn', includeProcedureCandidates: true, returnContextReceipt: true,
  });
  assert.match(prompt.text, /\[Selected work procedures\]/);
  assert.match(prompt.text, /explicitly label unresolved deadline uncertainty/);
  assert.equal(prompt.context_receipt.procedure_selection.procedures[0].id, created.id);
  assert.ok(proceduralLearning.render([store.snapshot().cognition.procedural_learning.procedures[0]]).length < 600);

  const duplicate = reviewedInteraction(27, 'appreciated', prompt.context_receipt.procedure_selection);
  // A different selection receipt for the already-recorded interaction is rejected rather than rewriting history.
  assert.throws(() => store.recordProcedureInteractionOutcome(duplicate), /different or invalid procedure outcome|capability outcome ledger/);

  now = new Date('2026-07-18T12:00:00.000Z');
  const variant = store.createProcedure({
    id: 'proc-status-clarity-v2', variant_of: created.id,
    action_txt: 'open with verified status, then name the deadline uncertainty and next check',
    origin: { type: 'learning_variant', id: created.id },
    source_refs: [{ type: 'procedure', id: created.id }],
  });
  assert.equal(variant.variant_of, created.id);
  assert.throws(() => store.createProcedure({
    variant_of: created.id, action_txt: 'another weekly mutation',
    origin: { type: 'learning_variant', id: created.id }, source_refs: [{ type: 'procedure', id: created.id }],
  }), /at most one procedure variant/);
  await store.persistStrict();

  const reloaded = makeStore();
  await reloaded.init();
  const replay = reloaded.procedureStatsSnapshot();
  assert.equal(replay.report.active, 1);
  assert.equal(replay.report.candidate, 1);
  assert.equal(replay.report.replay_verified_outcomes, 20);
  assert.equal(replay.procedures.every(item => item.audit.complete_chain_verified), true);
  assert.equal(replay.selection_passes.length, 1);
  assert.equal(replay.selection_passes[0].audit.complete_chain_verified, true);
});

test('SELECT stays local and bounded with the full retained procedure and outcome population', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/intelligence/procedural-learning.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|axios|callProvider|anthropic)\b/i,
    'live procedure selection must not add a provider or network call');
  const procedures = Array.from({ length: 300 }, (_, index) => {
    const record = proceduralLearning.createRecord({
      id: `proc-load-${index}`, condition_txt: `status deadline request pattern ${index % 10}`,
      action_txt: `lead with verified status pattern ${index % 10} and preserve uncertainty`,
      task_families: ['project_status_retrieval'],
      origin: { type: 'load_test', id: `source-${index}` },
      source_refs: [{ type: 'interaction', id: `source-${index}` }],
    }, new Date('2026-07-01T00:00:00.000Z'));
    record.status = index < 12 ? 'active' : 'candidate';
    return record;
  });
  const outcomes = [];
  for (let index = 0; index < 1500; index++) {
    const interaction = reviewedInteraction(1000 + index, index % 4 ? 'landed' : 'corrected');
    const sourceOutcome = capabilityBoundary.recordFromInteraction(interaction);
    const procedure = procedures[index % 12];
    const receipt = {
      protocol_version: 1, id: `selection-load-${index}`, selected_at: interaction.created,
      task_family: 'project_status_retrieval', query_commitment: proceduralLearning.commitment(interaction.trigger),
      selection_key_commitment: proceduralLearning.commitment(`load-${index}`),
      procedures: [{ id: procedure.id, content_commitment: procedure.creation_commitment,
        status_at_selection: 'active', selection_mode: 'active', relevance: 0.8 }],
    };
    receipt.selection_commitment = proceduralLearning.commitment(receipt);
    outcomes.push(proceduralLearning.createInteractionOutcome(sourceOutcome, receipt));
  }
  const selectionIndex = proceduralLearning.buildSelectionIndex(procedures, outcomes,
    new Date('2026-07-17T01:00:00.000Z'));
  proceduralLearning.select(procedures, outcomes, {
    query: 'What is the project status and deadline for this request pattern 1?', selectionKey: 'warmup',
    selectionIndex,
  });
  // What this actually protects: with the index in hand, selection must not walk the outcome
  // population to recompute fitness. That is the difference between a bounded local lookup and an
  // O(procedures x outcomes) scan on every live turn.
  //
  // This used to assert wall-clock milliseconds, which measures the machine as much as the code. It
  // failed at 3,044ms under a loaded test run and passed at 262ms alone, so it reported load rather
  // than regressions. Counting reads of the outcome array measures the property directly and gives
  // the same answer on a busy laptop and an idle one.
  const countReads = list => {
    const stats = { reads: 0 };
    const proxy = new Proxy(list, { get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) stats.reads += 1;
      return Reflect.get(target, prop, receiver);
    } });
    return { proxy, stats };
  };
  const query = 'What is the project status and deadline for this request pattern 1?';
  const indexed = countReads(outcomes);
  proceduralLearning.select(procedures, indexed.proxy, { query, selectionKey: 'indexed', selectionIndex });
  const scanned = countReads(outcomes);
  proceduralLearning.select(procedures, scanned.proxy, { query, selectionKey: 'scanned' });
  assert.ok(scanned.stats.reads > 0, 'the unindexed path must actually consult the outcome population');
  assert.ok(indexed.stats.reads * 10 < scanned.stats.reads,
    'the selection index must keep live selection off the outcome population; '
    + `indexed read ${indexed.stats.reads}, unindexed read ${scanned.stats.reads}`);
});
