'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reading = require('../../src/intelligence/developmental-reading');
const { createReadingLibrary } = require('../../src/intelligence/reading-library');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function output(final = false) {
  return {
    summary: 'The passage contrasts imposed efficiency with judgment grounded in lived circumstances.',
    reactions: [{ idea: 'Coordination cannot be reduced to compliance.', stance: 'agree',
      source_quote: 'coordination grows through shared understanding',
      reflection: 'This sharpens how I should distinguish alignment from mere task obedience.' }],
    questions: ['When does structure help coordination rather than suppress it?'],
    possible_self_revision: { before: 'More process usually improves coordination.',
      after: 'Process helps only when it preserves local judgment and shared understanding.',
      confidence: 0.45, falsifier: 'Repeated work outcomes show more imposed process improves both speed and judgment.' },
    ...(final ? { completion: {
      lasting_ideas: ['Coordination is relational rather than merely procedural.'],
      disagreements: ['The author underweights cases where formal controls protect vulnerable participants.'],
      changed_my_mind: 'I now treat additional process as a hypothesis rather than a default improvement.',
      questions_to_carry: ['Which project rituals increase shared understanding?'],
      expected_work_transfer: 'Ask whether a proposed PM ritual improves shared situational understanding.',
      personality_influence_candidate: 'Become more skeptical of process that cannot name the human coordination gain.',
      counterevidence_needed: 'Outcomes from projects where stricter process improved judgment without reducing candor.',
    } } : {}),
  };
}

test('reading structured-output schema matches the local final and nonfinal contracts', () => {
  const nonfinal = reading.outputSchema();
  assert.deepEqual(nonfinal.required,
    ['summary', 'reactions', 'questions', 'possible_self_revision']);
  assert.equal(nonfinal.properties.reactions.items.properties.stance.enum.length, 4);
  assert.equal(nonfinal.properties.completion, undefined);
  const final = reading.outputSchema({ finalChunk: true });
  assert.ok(final.required.includes('completion'));
  assert.ok(final.properties.completion.required.includes('counterevidence_needed'));
});

test('reading library chunks admitted text and verifies every chunk on readback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reading-library-'));
  const library = createReadingLibrary({ directory: dir });
  const content = `${'A grounded paragraph about coordination and judgment. '.repeat(180)}\n\n${'A second section about responsibility and dissent. '.repeat(180)}`;
  const manifest = await library.ingest(content);
  assert.match(manifest.id, /^reading-source-[a-f0-9]{16}$/);
  assert.ok(manifest.chunk_commitments.length >= 2);
  for (let index = 0; index < manifest.chunk_commitments.length; index += 1) {
    assert.ok((await library.readChunk(manifest, index)).length > 0);
  }
  const file = path.join(dir, manifest.id, '0000.txt');
  fs.appendFileSync(file, 'tamper');
  await assert.rejects(library.readChunk(manifest, 0), /failed integrity/);
});

test('reading chunk boundaries preserve astral characters', () => {
  const content = `${'a'.repeat(11999)}😀${'b'.repeat(600)}`;
  const chunks = require('../../src/intelligence/reading-library').chunksFor(content);
  assert.equal(chunks.join(''), content);
  assert.doesNotMatch(chunks.join(''), /�/);
});

test('a reading encounter is sequential, source-bound, quote-bounded, and never a persona edit', () => {
  const source = reading.createSource({ id: 'reading-source-1234567890abcdef', title: 'The New State',
    author: 'Mary Parker Follett', source_kind: 'book', source_url: 'https://example.org/new-state.txt',
    rights_basis: 'public_domain', rights_note: 'Public domain edition in the United States.',
    content_commitment: 'a'.repeat(64), content_chars: 20000,
    chunk_commitments: ['b'.repeat(64), 'c'.repeat(64)], admitted_by: 'John' },
  new Date('2026-07-18T01:00:00Z'));
  assert.equal(reading.verifySource(source), true);
  const session = reading.createSession(source, { id: 'reading-session-1', selected_by: 'Nora',
    selection_rationale: 'I want a deeper model of coordination than task tracking alone.',
    guiding_questions: ['What makes coordination genuinely shared?'],
    predicted_influence: 'I may become more attentive to participation and local judgment.' },
  new Date('2026-07-18T02:00:00Z'));
  assert.throws(() => reading.appendNote(session, source, { chunk_index: 1,
    chunk_commitment: source.chunk_commitments[1], output: output(), provider_receipt: {
      response_id: 'out-of-order', provider: 'anthropic', model: 'test', request_commitment: 'd'.repeat(64) } }),
  /source order/);
  const first = reading.appendNote(session, source, { chunk_index: 0,
    day_key: '2026-07-18', chunk_commitment: source.chunk_commitments[0], output: output(), provider_receipt: {
      response_id: 'reading-response-1', provider: 'anthropic', model: 'test', request_commitment: 'd'.repeat(64) } });
  assert.equal(first.output.possible_self_revision.confidence, 0.45);
  assert.throws(() => reading.appendNote(structuredClone({ ...session, next_chunk_index: 1 }), source,
    { chunk_index: 1, day_key: '2026-07-18', chunk_commitment: source.chunk_commitments[1],
      output: { ...output(true), reactions: [{ ...output().reactions[0], source_quote: 'word '.repeat(26) }] },
      provider_receipt: { response_id: 'long-quote', provider: 'anthropic', model: 'test',
        request_commitment: 'd'.repeat(64) } }), /twenty-five words/);
  reading.appendNote(session, source, { chunk_index: 1, day_key: '2026-07-19', chunk_commitment: source.chunk_commitments[1],
    output: output(true), provider_receipt: { response_id: 'reading-response-2', provider: 'anthropic',
      model: 'test', request_commitment: 'e'.repeat(64) } });
  assert.equal(session.status, 'completed');
  assert.equal(reading.auditSession(session, source).complete_chain_verified, true);
  session.notes[0].day_key = '2026-07-17';
  assert.equal(reading.auditSession(session, source).complete_chain_verified, false);
  assert.equal(session.encounter.persona_edit, undefined);
  assert.match(session.encounter.epistemic_status, /not a persona edit/);
});

test('autonomous source selection binds the exact provider output without rewriting legacy sessions', () => {
  const source = reading.createSource({ id: 'reading-source-autonomous1', title: 'The New State',
    author: 'Mary Parker Follett', source_kind: 'book', source_url: 'https://example.org/new-state.txt',
    rights_basis: 'public_domain', rights_note: 'Public domain edition.',
    content_commitment: 'a'.repeat(64), content_chars: 20000,
    chunk_commitments: ['b'.repeat(64)], admitted_by: 'John' },
  new Date('2026-07-18T01:00:00Z'));
  const selection = { source_id: source.id,
    selection_rationale: 'I want to test whether group process offers more than task coordination.',
    guiding_questions: ['Where does shared judgment improve project work?'],
    predicted_influence: 'I may become more precise about when participation improves a decision.' };
  const session = reading.createSession(source, { id: 'autonomous-reading-session',
    selected_by: 'Nora', ...selection, selection_provider_receipt: {
      response_id: 'selection-response-1', provider: 'anthropic', model: 'test-model',
      request_commitment: 'c'.repeat(64),
      selection_commitment: reading.commitment(reading.sessionSelectionPayload(selection)),
    } }, new Date('2026-07-18T02:00:00Z'));
  assert.equal(session.protocol_version, reading.PROVIDER_BOUND_SESSION_PROTOCOL_VERSION);
  assert.equal(session.selection_mode, 'provider_bound_autonomous');
  assert.equal(reading.verifySession(session, source), true);
  const tampered = structuredClone(session);
  tampered.selection_rationale = 'A server-authored substitute rationale.';
  assert.equal(reading.verifySession(tampered, source), false);
  const explicit = reading.createSession(source, { id: 'explicit-reading-session', selected_by: 'Nora',
    selection_rationale: selection.selection_rationale, guiding_questions: selection.guiding_questions,
    predicted_influence: selection.predicted_influence }, new Date('2026-07-18T02:00:00Z'));
  assert.equal(explicit.protocol_version, reading.PROTOCOL_VERSION);
  assert.equal(reading.verifySession(explicit, source), true);
});

test('choice-ecology sessions freeze meaningful alternatives without changing legacy receipts', () => {
  const source = reading.createSource({ id: 'reading-source-choiceeco01', title: 'How We Think',
    author: 'John Dewey', source_kind: 'book', source_url: 'https://example.org/how-we-think.txt',
    rights_basis: 'public_domain', rights_note: 'Public domain edition.',
    content_commitment: 'a'.repeat(64), content_chars: 20000,
    chunk_commitments: ['b'.repeat(64)], admitted_by: 'John' },
  new Date('2026-07-18T01:00:00Z'));
  const selection = { source_id: source.id,
    selection_rationale: 'I want to examine a theory of reflective inquiry.',
    guiding_questions: ['What makes reflection corrective rather than circular?'],
    predicted_influence: 'I may become more explicit about how I test an initial judgment.' };
  const candidates = [
    { id: source.id, title: source.title, author: source.author, source_kind: 'book',
      rights_basis: 'public_domain', chunk_count: 1 },
    { id: 'reading-source-alternative2', title: 'A Contrasting Work', author: 'Another Author',
      source_kind: 'book', rights_basis: 'public_domain', chunk_count: 12 },
  ];
  const session = reading.createSession(source, { id: 'choice-ecology-session', selected_by: 'Nora',
    ...selection, selection_candidates: candidates, selection_provider_receipt: {
      response_id: 'selection-response-choice', provider: 'anthropic', model: 'test-model',
      request_commitment: 'c'.repeat(64),
      selection_commitment: reading.commitment(reading.sessionSelectionPayload(selection)),
      candidate_set_commitment: reading.commitment(candidates),
    } }, new Date('2026-07-18T02:00:00Z'));
  assert.equal(session.protocol_version, reading.SESSION_PROTOCOL_VERSION);
  assert.equal(session.selection_candidates.length, 2);
  assert.equal(reading.verifySession(session, source), true);
  const tampered = structuredClone(session);
  tampered.selection_candidates.pop();
  assert.equal(reading.verifySession(tampered, source), false);
  assert.throws(() => reading.createSession(source, { selected_by: 'Nora', ...selection,
    selection_candidates: candidates.filter(item => item.id !== source.id),
    selection_provider_receipt: { response_id: 'outside-choice', provider: 'anthropic', model: 'test',
      request_commitment: 'd'.repeat(64),
      selection_commitment: reading.commitment(reading.sessionSelectionPayload(selection)),
      candidate_set_commitment: reading.commitment(candidates.filter(item => item.id !== source.id)) } }),
  /exact candidate choice ecology/);
});

test('a durable curiosity can commission an exact source encounter without rewriting either choice', () => {
  const source = reading.createSource({ id: 'reading-source-curiosity01', title: 'How We Think',
    author: 'John Dewey', source_kind: 'book', source_url: 'https://example.org/how-we-think.txt',
    rights_basis: 'public_domain', rights_note: 'Public domain edition.',
    content_commitment: 'a'.repeat(64), content_chars: 20000,
    chunk_commitments: ['b'.repeat(64)], admitted_by: 'John' },
  new Date('2026-07-18T01:00:00Z'));
  const question = { id: 'epistemic-agenda-question-curiosity',
    question: 'When does reflective inquiry correct a project judgment rather than rationalize it?',
    question_commitment: 'd'.repeat(64), interest_score: 0.88 };
  const candidates = [{ id: source.id, title: source.title, author: source.author,
    source_kind: 'book', rights_basis: 'public_domain', chunk_count: 1 }];
  const selection = { source_id: source.id, curiosity_question_id: question.id,
    selection_rationale: 'This source may directly complicate the carried question about correction.',
    guiding_questions: ['What distinguishes inquiry from rationalization?'],
    predicted_influence: 'It may sharpen the evidence required before revising a judgment.' };
  const session = reading.createSession(source, { id: 'curiosity-reading-session',
    selected_by: 'Nora', ...selection, selection_candidates: candidates,
    curiosity_question_candidates: [question], curiosity_question_binding: question,
    selection_provider_receipt: {
      response_id: 'selection-response-curiosity', provider: 'anthropic', model: 'test-model',
      request_commitment: 'c'.repeat(64),
      selection_commitment: reading.commitment(reading.sessionSelectionPayload(selection)),
      candidate_set_commitment: reading.commitment(candidates),
      curiosity_question_set_commitment: reading.commitment([question]),
    } }, new Date('2026-07-18T02:00:00Z'));
  assert.equal(session.protocol_version, reading.CURIOSITY_SESSION_PROTOCOL_VERSION);
  assert.equal(session.curiosity_question_binding.id, question.id);
  assert.equal(reading.verifySession(session, source), true);
  const tampered = structuredClone(session);
  tampered.curiosity_question_binding.question = 'A substituted server question?';
  assert.equal(reading.verifySession(tampered, source), false);
  assert.throws(() => reading.createSession(source, { selected_by: 'Nora', ...selection,
    selection_candidates: candidates, curiosity_question_candidates: [question],
    curiosity_question_binding: { ...question, question_commitment: 'e'.repeat(64) },
    selection_provider_receipt: session.selection_provider_receipt }), /exact committed question/);
});

test('store ledger-binds reading, quarantines influence during trials, and enforces a daily budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reading-store-'));
  const interactions = [];
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: (() => { let tick = 0; return () =>
      new Date(Date.parse('2026-07-18T02:00:00Z') + tick++ * 1000); })(),
    getInteractions: () => interactions });
  await store.init();
  assert.deepEqual(store.developmentalReadingSnapshot().availability, {
    state: 'empty', reason: 'no_admitted_sources', background_only: true,
    foreground_priority: 'work_slack_and_zoom_preempt_reading',
    influence_access: { state: 'available', reason: 'no_active_blinded_context_trial',
      acquisition_continues_in_isolation: false },
  });
  const source = store.registerReadingSource({ id: 'reading-source-fedcba0987654321',
    title: 'A Public Domain Work', author: 'An Author', source_kind: 'book',
    source_url: 'https://example.org/work.txt', rights_basis: 'public_domain',
    rights_note: 'Verified public domain edition.', content_commitment: '1'.repeat(64),
    content_chars: 25000, chunk_commitments: ['2'.repeat(64), '3'.repeat(64)], admitted_by: 'John' });
  const trial = store.createContextTrial({ id: 'reading-quarantine-control',
    intervention: 'workspace_capacity',
    hypothesis: 'Workspace capacity affects first-order task quality.',
    outcome_metric: 'first_order_task_quality', surfaces: ['slack'],
    sample_target_per_group: 2 });
  const session = store.startReadingSession(source.id, { id: 'store-reading-session', selected_by: 'Nora',
    selection_rationale: 'This bears on how I coordinate work.',
    guiding_questions: ['What does responsible coordination require?'],
    predicted_influence: 'It may refine my professional viewpoint.' });
  assert.equal(store.developmentalReadingSnapshot().availability.state, 'reading');
  assert.deepEqual(store.developmentalReadingSnapshot().availability.influence_access, {
    state: 'sealed', reason: 'blinded_context_trial_active',
    acquisition_continues_in_isolation: true });
  assert.equal(store.cognitionSnapshot().developmental_reading.experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().developmental_reading.active_session, null);
  const firstQueue = store.developmentalReadingQueue({ day_key: '2026-07-18', daily_budget: 1 });
  assert.equal(firstQueue.item.session_id, session.id);
  store.commitDevelopmentalReadingNote(session.id, { day_key: '2026-07-18', chunk_index: 0,
    chunk_commitment: '2'.repeat(64), output: output(), provider_receipt: {
      response_id: 'store-reading-response-1', provider: 'anthropic', model: 'test-model',
      request_commitment: '4'.repeat(64) } });
  assert.equal(store.developmentalReadingQueue({ day_key: '2026-07-18', daily_budget: 1 }).reason,
    'daily_reading_budget_exhausted');
  store.commitDevelopmentalReadingNote(session.id, { day_key: '2026-07-19', chunk_index: 1,
    chunk_commitment: '3'.repeat(64), output: output(true), provider_receipt: {
      response_id: 'store-reading-response-2', provider: 'anthropic', model: 'test-model',
      request_commitment: '5'.repeat(64) } });
  const snapshot = store.developmentalReadingSnapshot();
  assert.equal(snapshot.availability.state, 'between_encounters');
  assert.equal(snapshot.report.completed_encounters, 1);
  assert.equal(snapshot.sessions[0].audit.complete_chain_verified, true);
  assert.equal(snapshot.sessions[0].source_derived_content_sealed, true);
  assert.equal(snapshot.sessions[0].quarantined_note_count, 2);
  assert.deepEqual(snapshot.sessions[0].notes, []);
  assert.equal(snapshot.sessions[0].encounter.synthesis, undefined);
  assert.equal(snapshot.report.provisional_self_revision_candidates, 2);
  const sealedLiveContext = store.liveActivityContextSnapshot();
  assert.equal(sealedLiveContext.reading.title, 'A Public Domain Work');
  assert.equal(sealedLiveContext.reading.completed_chunks, 2);
  assert.equal(sealedLiveContext.reading.total_chunks, 2);
  assert.equal(sealedLiveContext.reading.last_reflection, null);
  assert.equal(sealedLiveContext.reading.influence_sealed, true);
  const dashboardProjectionStarted = performance.now();
  for (let index = 0; index < 200; index += 1) {
    assert.equal(store.developmentalReadingSnapshot({ sessionLimit: 8 }).sessions.length, 1);
  }
  assert.ok(performance.now() - dashboardProjectionStarted < 250,
    'cached bounded Reading Room projections must remain negligible between state changes');
  const quarantinedPrompt = store.promptContext({ query: 'How should we improve coordination on this project?',
    returnContextReceipt: true });
  assert.doesNotMatch(quarantinedPrompt.text, /Relevant provisional intellectual influence/);
  assert.equal(quarantinedPrompt.context_receipt.developmental_reading_encounters.length, 0);
  store.abortContextTrial(trial.id, { reason_code: 'external_change',
    explanation: 'Test-only closure verifies that quarantined reading influence becomes eligible only after the blinded trial ends.',
    evidence: [{ type: 'test_fixture', id: 'reading-quarantine-control-closure' }] });
  const unsealedSnapshot = store.developmentalReadingSnapshot();
  assert.equal(unsealedSnapshot.sessions[0].notes.length, 2);
  assert.equal(unsealedSnapshot.sessions[0].encounter.synthesis.lasting_ideas.length, 1);
  const unsealedLiveContext = store.liveActivityContextSnapshot();
  assert.equal(unsealedLiveContext.reading.mechanism_verified, true);
  assert.match(unsealedLiveContext.reading.last_reflection, /contrasts imposed efficiency/);
  const prompt = store.promptContext({ query: 'How should we improve coordination on this project?',
    returnContextReceipt: true });
  assert.match(prompt.text, /Relevant provisional intellectual influence/);
  assert.match(prompt.text, /The New State|A Public Domain Work/);
  assert.equal(prompt.context_receipt.developmental_reading_encounters.length, 1);
  assert.equal(store.promptContext({ query: 'What is the weather?', returnContextReceipt: true })
    .context_receipt.developmental_reading_encounters.length, 0);
  const selectionStarted = performance.now();
  for (let index = 0; index < 500; index += 1) {
    store.developmentalReadingInfluenceSnapshot({ query: 'coordination project judgment' });
  }
  assert.ok(performance.now() - selectionStarted < 200,
    'cached reading-lens selection must remain negligible on live surfaces');
  interactions.push({ reviewed: true, outcome: 'landed',
    developmental_reading_exposures: prompt.context_receipt.developmental_reading_encounters });
  const transfer = store.developmentalReadingSnapshot().report.work_transfer;
  assert.deepEqual({ exposed: transfer.exposed_interactions, reviewed: transfer.reviewed_exposures,
    positive: transfer.positive_outcomes, corrected: transfer.corrected_outcomes },
  { exposed: 1, reviewed: 1, positive: 1, corrected: 0 });
  assert.equal(transfer.causal_status, 'observational_only');
  const researchIndicator = store.consciousnessResearchStatus().indicators.find(item =>
    item.id === 'source_bound_intellectual_development');
  assert.equal(researchIndicator.status, 'collecting');
  assert.equal(researchIndicator.evidence.replay_verified_sources, 1);
  assert.equal(researchIndicator.evidence.replay_verified_completed_encounters, 1);
  assert.equal(researchIndicator.evidence.natural_work_transfer.reviewed_exposures, 1);
  assert.match(researchIndicator.evidence.natural_work_transfer.causal_status,
    /prompt access does not establish use/);
});
