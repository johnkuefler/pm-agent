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

test('store ledger-binds reading, pauses it during experiments, and enforces a daily budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reading-store-'));
  const interactions = [];
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: (() => { let tick = 0; return () =>
      new Date(Date.parse('2026-07-18T02:00:00Z') + tick++ * 1000); })(),
    getInteractions: () => interactions });
  await store.init();
  const source = store.registerReadingSource({ id: 'reading-source-fedcba0987654321',
    title: 'A Public Domain Work', author: 'An Author', source_kind: 'book',
    source_url: 'https://example.org/work.txt', rights_basis: 'public_domain',
    rights_note: 'Verified public domain edition.', content_commitment: '1'.repeat(64),
    content_chars: 25000, chunk_commitments: ['2'.repeat(64), '3'.repeat(64)], admitted_by: 'John' });
  const session = store.startReadingSession(source.id, { id: 'store-reading-session', selected_by: 'Nora',
    selection_rationale: 'This bears on how I coordinate work.',
    guiding_questions: ['What does responsible coordination require?'],
    predicted_influence: 'It may refine my professional viewpoint.' });
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
  assert.equal(snapshot.report.completed_encounters, 1);
  assert.equal(snapshot.sessions[0].audit.complete_chain_verified, true);
  assert.equal(snapshot.report.provisional_self_revision_candidates, 2);
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
});
