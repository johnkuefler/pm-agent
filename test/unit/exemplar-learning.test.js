const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const exemplarLearning = require('../../src/intelligence/exemplar-learning');
const capabilityBoundary = require('../../src/intelligence/capability-boundary');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function reviewedInteraction(index, outcome, exemplarSelection = null, overrides = {}) {
  const ts = `178450${String(index).padStart(4, '0')}.000001`;
  return {
    id: `ix-exemplar-${index}`, channel: 'C123456789', thread_ts: ts, ts,
    trigger: 'Could you draft a concise project update?',
    text: 'I led with the verified point and kept the update concise.',
    requester_name: `Teammate ${index % 3}`, user: `U${String(index).padStart(8, '0')}`,
    created: `2026-07-${String(1 + (index % 15)).padStart(2, '0')}T15:00:00.000Z`,
    reviewed: true, reviewed_at: `2026-07-${String(1 + (index % 15)).padStart(2, '0')}T16:00:00.000Z`,
    outcome, signal: `reviewed ${outcome}`,
    ...(exemplarSelection ? { exemplar_selection: exemplarSelection,
      exemplar_exposure_ids: exemplarSelection.exemplars.map(item => item.id) } : {}),
    ...overrides,
  };
}

const cleanSourcePrivacy = {
  financial_content_absent: true, external_locator_absent: true,
  stable_identifier_absent: true, embedded_instruction_absent: true,
  proper_noun_overlap_absent: true,
};

test('exemplar admission is source-derived, privacy-minimized, and prompt bounded', () => {
  const interaction = reviewedInteraction(1, 'appreciated');
  const source = capabilityBoundary.recordFromInteraction(interaction);
  const record = exemplarLearning.createRecord({
    id: 'ex-positive', source_interaction_id: interaction.id,
    situation: 'draft a concise project update',
    guidance: 'lead with the verified point and keep the update compact',
    task_families: ['writing_synthesis'], source_privacy_review: cleanSourcePrivacy,
  }, source, new Date('2026-07-17T00:00:00.000Z'));
  assert.equal(record.valence, 'positive');
  assert.equal(record.privacy_review.source_content_stored, false);
  assert.equal(exemplarLearning.verifyRecord(record), true);
  const selected = exemplarLearning.select([record], [], {
    query: 'Draft a concise project update for me', selectionKey: 'turn-1',
    now: new Date('2026-07-17T01:00:00.000Z'),
  });
  assert.equal(selected.records[0].id, record.id);
  assert.equal(exemplarLearning.verifySelectionReceipt(selected.receipt), true);
  assert.ok(exemplarLearning.render(selected.records).length < 420);
  assert.doesNotMatch(exemplarLearning.render(selected.records), /ix-exemplar|C123456789|Teammate/);
  assert.equal(exemplarLearning.select([record], [], {
    query: 'Write a launch announcement', selectionKey: 'irrelevant-writing',
  }).records.length, 0, 'same-family but lexically irrelevant exemplars must stay latent');

  assert.throws(() => exemplarLearning.createRecord({
    source_interaction_id: interaction.id, situation: 'client budget update 500',
    guidance: 'include the exact fee', task_families: ['writing_synthesis'],
    source_privacy_review: cleanSourcePrivacy,
  }, source), /privacy floor/);
  assert.equal(exemplarLearning.privacyAuditText('quoted fee is \u20ac50').passed, false);
  assert.throws(() => exemplarLearning.createRecord({
    source_interaction_id: interaction.id, situation: 'draft an update',
    guidance: 'keep it short', task_families: ['writing_synthesis'],
    source_privacy_review: { ...cleanSourcePrivacy, external_locator_absent: false },
  }, source), /privacy floor/);
});

test('exemplar exposures replay and retire only after confident underperformance', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-exemplars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');
  let now = new Date('2026-07-17T12:00:00.000Z');
  const interactions = [
    reviewedInteraction(100, 'appreciated'),
    reviewedInteraction(101, 'corrected', null, {
      text: 'I buried the verified point under too much setup.',
    }),
  ];
  const makeStore = () => createIntelligenceStore({ filePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now), getInteractions: () => interactions });
  const store = makeStore(); await store.init();
  store.syncCapabilityBoundaryOutcomes(interactions);
  assert.throws(() => store.createExemplar({ source_interaction_id: interactions[1].id,
    situation: 'draft a project update', guidance: 'repeat the teammate correction next time',
    task_families: ['writing_synthesis'] }), /privacy floor/);
  const positive = store.createExemplar({ id: 'ex-positive-update', source_interaction_id: interactions[0].id,
    situation: 'draft a concise project update', guidance: 'lead with the verified point and keep it compact',
    task_families: ['writing_synthesis'] });
  const contrast = store.createExemplar({ id: 'ex-contrast-update', source_interaction_id: interactions[1].id,
    situation: 'draft a project update with too much setup', guidance: 'avoid setup that buries the verified point',
    task_families: ['writing_synthesis'] });
  assert.equal(positive.audit.complete_chain_verified, true);
  assert.equal(contrast.valence, 'contrast');

  const selected = store.exemplarContextSelection({ query: 'Draft a concise project update', selectionKey: 'selected' });
  assert.equal(selected.records.length, 2);
  assert.deepEqual(new Set(selected.records.map(item => item.valence)), new Set(['positive', 'contrast']));
  const prompt = store.promptContext({ query: 'Draft a concise project update', channel: 'slack',
    includeExemplars: true, exemplarSelectionKey: 'prompt', returnContextReceipt: true });
  assert.match(prompt.text, /\[Relevant past work patterns\]/);
  assert.equal(prompt.context_receipt.exemplar_selection.exemplars.length, 2);
  assert.throws(() => store.retireExemplar(positive.id, { actor: 'nora', note: 'too early' }), /measured retirement gate/);

  for (let index = 1; index <= 12; index++) {
    const interaction = reviewedInteraction(200 + index, 'appreciated');
    store.syncCapabilityBoundaryOutcomes([interaction]);
    store.recordExemplarInteractionOutcome(interaction);
  }
  for (let index = 1; index <= 10; index++) {
    const receipt = store.exemplarContextSelection({ query: 'Draft a concise project update', selectionKey: `miss-${index}` }).receipt;
    const interaction = reviewedInteraction(300 + index, 'corrected', receipt);
    store.syncCapabilityBoundaryOutcomes([interaction]);
    store.recordExemplarInteractionOutcome(interaction);
  }
  const before = store.exemplarStatsSnapshot();
  assert.equal(before.report.replay_verified_outcomes, 22);
  assert.equal(before.projections.every(item => item.recommendation === 'retire'), true);
  const pass = store.runExemplarSelectionPass({ note: 'Ten misses underperformed twelve positive controls.' });
  assert.equal(pass.report.changed, 2);
  assert.equal(store.exemplarStatsSnapshot().report.retired, 2);
  await store.persistStrict();
  const reloaded = makeStore(); await reloaded.init();
  assert.equal(reloaded.exemplarStatsSnapshot().exemplars.every(item => item.audit.complete_chain_verified), true);
  assert.equal(reloaded.exemplarStatsSnapshot().selection_passes[0].audit.complete_chain_verified, true);
});

test('exemplar retrieval stays local and fast at retained population limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/intelligence/exemplar-learning.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|axios|callProvider|anthropic|pgvector|embed)\b/i);
  const records = Array.from({ length: 300 }, (_, index) => {
    const interaction = reviewedInteraction(1000 + index, index % 2 ? 'appreciated' : 'corrected');
    return exemplarLearning.createRecord({ id: `ex-load-${index}`,
      source_interaction_id: interaction.id, situation: `draft concise project update pattern ${index % 10}`,
      guidance: `use generalized response shape ${index % 10}`,
      task_families: ['writing_synthesis'], source_privacy_review: cleanSourcePrivacy,
    }, capabilityBoundary.recordFromInteraction(interaction), new Date('2026-07-01T00:00:00.000Z'));
  });
  const outcomes = [];
  for (let index = 0; index < 1500; index++) {
    const interaction = reviewedInteraction(2000 + index, index % 4 ? 'landed' : 'corrected');
    const chosen = records[index % records.length];
    const receipt = { protocol_version: 1, id: `ex-selection-load-${index}`,
      selected_at: interaction.created, task_family: 'writing_synthesis',
      query_commitment: exemplarLearning.commitment(interaction.trigger),
      selection_key_commitment: exemplarLearning.commitment(`load-${index}`),
      exemplars: [{ id: chosen.id, content_commitment: chosen.creation_commitment,
        valence: chosen.valence, relevance: 0.8 }] };
    receipt.selection_commitment = exemplarLearning.commitment(receipt);
    outcomes.push(exemplarLearning.createInteractionOutcome(capabilityBoundary.recordFromInteraction(interaction), receipt));
  }
  const selectionIndex = exemplarLearning.buildSelectionIndex(records, outcomes, new Date('2026-07-17T01:00:00.000Z'));
  const started = performance.now();
  for (let index = 0; index < 50; index++) exemplarLearning.select(records, outcomes, {
    query: 'Draft a concise project update pattern 1', selectionKey: `hot-${index}`, selectionIndex,
  });
  const meanMs = (performance.now() - started) / 50;
  assert.ok(meanMs < 30, `local exemplar selection should average under 30ms; observed ${meanMs.toFixed(2)}ms`);
});
