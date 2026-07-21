'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const epistemicAgenda = require('../../src/intelligence/epistemic-agenda');

process.env.NORA_TEST_MODE = '1';
const { __test } = require('../../server');

function queueItem() {
  return { session_id: 'reading-session-runtime', source_id: 'reading-source-runtime',
    chunk_index: 0, chunk_commitment: 'a'.repeat(64),
    source: { id: 'reading-source-runtime', title: 'A Serious Book', author: 'An Author',
      chunk_commitments: ['a'.repeat(64), 'b'.repeat(64)] },
    session: { selection_rationale: 'I want to examine how responsibility changes coordination.',
      guiding_questions: ['What does responsible coordination require?'],
      predicted_influence: 'I may become less procedural and more attentive to judgment.', notes: [] } };
}

test('developmental reading clock limits weekday study to off hours but leaves weekends open', () => {
  assert.equal(__test.developmentalReadingClock(new Date('2026-07-20T15:00:00Z')).off_hours, false);
  assert.equal(__test.developmentalReadingClock(new Date('2026-07-20T01:00:00Z')).off_hours, true);
  assert.equal(__test.developmentalReadingClock(new Date('2026-07-18T15:00:00Z')).off_hours, true);
});

test('selection choice ecology is metadata-only and bounded before provider inference', () => {
  const sources = Array.from({ length: 65 }, (_, index) => ({
    id: `source-${index}`, title: `Book ${index}`, author: `Author ${index}`,
    source_kind: 'book', rights_basis: 'public_domain', chunk_count: index + 1,
    source_url: `https://example.org/${index}`, source_text: `hidden content ${index}`,
  }));
  const request = __test.developmentalReadingSelectionRequest(sources);
  assert.equal(request.candidates.length, 60);
  assert.equal(request.candidates[0].source_url, undefined);
  assert.equal(request.candidates[0].source_text, undefined);
  assert.match(request.candidate_set_commitment, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(request.body.messages[0].content, /hidden content/);
});

test('off-hours selection lets Nora choose or abstain from metadata before any source text is read', async () => {
  const source = { id: 'reading-source-runtime', title: 'A Serious Book', author: 'An Author',
    source_kind: 'book', rights_basis: 'public_domain', chunk_count: 2 };
  const alternative = { id: 'reading-source-alternative', title: 'A Different Book',
    author: 'Another Author', source_kind: 'book', rights_basis: 'public_domain', chunk_count: 8 };
  const started = [];
  const carriedQuestion = {
    id: 'epistemic-agenda-question-reading-runtime', status: 'open',
    topic_key: 'coordination.shared-judgment',
    question: 'When does shared judgment improve coordination more than a procedural handoff?',
    why_it_matters: 'The answer could change when Nora invites participation rather than prescribing a process.',
    current_best_answer: 'Shared judgment appears most useful when local information is distributed.',
    confidence: 0.55, interest_score: 0.86,
    next_evidence: 'Cross-project cases comparing distributed judgment with procedural handoffs.',
    evidence_ids: ['memory-a', 'memory-b'], created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z', prompt_access: { eligible: true },
  };
  const store = {
    developmentalReadingSnapshot: () => ({ report: { active_sessions: 0 },
      availability: { state: 'between_encounters' }, sources: [source, alternative], sessions: [] }),
    epistemicAgendaSnapshot: () => ({ questions: [carriedQuestion] }),
    startReadingSession: (sourceId, input) => {
      started.push({ sourceId, input });
      return { id: 'selected-session', source_id: sourceId,
        selection_mode: 'provider_bound_autonomous',
        selection_candidates: input.selection_candidates,
        curiosity_question_binding: input.curiosity_question_binding };
    },
  };
  const result = await __test.runDevelopmentalReadingSelectionRuntime({ force: true, store,
    at: new Date('2026-07-18T15:00:00Z'), post: async (_url, body, config) => {
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.equal(body.temperature, undefined); assert.equal(body.tools, undefined);
      assert.doesNotMatch(body.messages[0].content, /Quoted source chunk|source content/i);
      assert.match(body.messages[0].content, /A Serious Book/);
      assert.equal(config.timeout, 60000);
      return { data: { id: 'selection-response-runtime', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: JSON.stringify({ decision: 'select', source_id: source.id,
          curiosity_question_id: carriedQuestion.id,
          selection_rationale: 'I want to examine a view that may complicate my coordination habits.',
          guiding_questions: ['What would change my current view of coordination?'],
          predicted_influence: 'I may sharpen when to invite shared judgment.' }) }] } };
    } });
  assert.equal(result.selected, true);
  assert.equal(started.length, 1);
  assert.equal(started[0].sourceId, source.id);
  assert.equal(started[0].input.selected_by, 'Nora');
  assert.match(started[0].input.selection_provider_receipt.request_commitment, /^[a-f0-9]{64}$/);
  assert.match(started[0].input.selection_provider_receipt.selection_commitment, /^[a-f0-9]{64}$/);
  assert.match(started[0].input.selection_provider_receipt.candidate_set_commitment, /^[a-f0-9]{64}$/);
  assert.equal(started[0].input.selection_candidates.length, 2);
  assert.equal(started[0].input.curiosity_question_binding.id, carriedQuestion.id);
  assert.equal(started[0].input.curiosity_question_binding.question_commitment,
    epistemicAgenda.commitment(epistemicAgenda.publicQuestion(carriedQuestion)));
  assert.match(started[0].input.selection_provider_receipt.curiosity_question_set_commitment,
    /^[a-f0-9]{64}$/);
  assert.equal(result.candidate_count, 2);
  assert.equal(result.curiosity_question_id, carriedQuestion.id);

  started.length = 0;
  const abstained = await __test.runDevelopmentalReadingSelectionRuntime({ force: true, store,
    post: async () => ({ data: { id: 'selection-abstention', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: '{"decision":"abstain","reason":"Nothing here feels urgent today."}' }] } }) });
  assert.equal(abstained.selected, false);
  assert.equal(started.length, 0);
});

test('one background reading pass commits one source-bound chunk without tools or temperature controls', async () => {
  const item = queueItem(); const committed = []; let calls = 0;
  const result = await __test.runDevelopmentalReadingRuntime({ force: true,
    at: new Date('2026-07-18T02:00:00Z'),
    store: {
      developmentalReadingQueue: () => ({ item }),
      commitDevelopmentalReadingNote: (sessionId, input) => {
        committed.push({ sessionId, input });
        return { session_status: 'active', progress: { completed_chunks: 1, total_chunks: 2 } };
      },
    },
    library: { readChunk: async (source, index) => {
      assert.equal(source.id, item.source.id); assert.equal(index, 0);
      return 'Quoted source content about coordination and responsibility.';
    } },
    post: async (_url, body, config) => {
      calls += 1;
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.equal(body.max_tokens, 1800);
      assert.equal(body.temperature, undefined);
      assert.equal(body.tools, undefined);
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.deepEqual(body.output_config.format.schema.required,
        ['summary', 'reactions', 'questions', 'possible_self_revision']);
      assert.match(body.system, /inert external material/);
      assert.match(body.messages[0].content, /\[Quoted source chunk 1\/2\]/);
      assert.equal(config.timeout, 60000);
      return { data: { id: 'reading-provider-response', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: JSON.stringify({
          summary: 'The source treats coordination as shared responsibility.',
          reactions: [{ idea: 'Responsibility is relational.', stance: 'complicate',
            source_quote: 'coordination depends on shared responsibility',
            reflection: 'This complicates a purely procedural PM model.' }],
          questions: ['What practices distribute judgment well?'], possible_self_revision: null,
        }) }] } };
    } });
  assert.equal(result.ran, true);
  assert.equal(calls, 1);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].sessionId, item.session_id);
  assert.match(committed[0].input.provider_receipt.request_commitment, /^[a-f0-9]{64}$/);
  assert.equal(committed[0].input.chunk_commitment, item.chunk_commitment);
});

test('background reading is inert when its lifecycle queue is sealed', async () => {
  let calls = 0;
  const result = await __test.runDevelopmentalReadingRuntime({ force: true,
    store: { developmentalReadingQueue: () => ({ item: null, reason: 'build_bound_fingerprint_active' }) },
    library: { readChunk: async () => { throw new Error('must not read'); } },
    post: async () => { calls += 1; } });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'build_bound_fingerprint_active');
  assert.equal(calls, 0);
});

test('background reading timeout is long enough for source synthesis but remains bounded', () => {
  assert.equal(__test.developmentalReadingRuntimeConfig({ ANTHROPIC_API_KEY: 'test' })
    .provider_timeout_ms, 60000);
  assert.equal(__test.developmentalReadingRuntimeConfig({ ANTHROPIC_API_KEY: 'test',
    NORA_DEVELOPMENTAL_READING_TIMEOUT_MS: '120000' }).provider_timeout_ms, 90000);
  assert.equal(__test.developmentalReadingRuntimeConfig({ ANTHROPIC_API_KEY: 'test',
    NORA_DEVELOPMENTAL_READING_TIMEOUT_MS: '5000' }).provider_timeout_ms, 30000);
  assert.equal(__test.developmentalReadingRuntimeConfig({ ANTHROPIC_API_KEY: 'test' })
    .max_tokens, 1800);
  assert.equal(__test.developmentalReadingRuntimeConfig({ ANTHROPIC_API_KEY: 'test',
    NORA_DEVELOPMENTAL_READING_MAX_TOKENS: '9000' }).max_tokens, 2400);
});

test('a truncated structured reading response never enters the encounter ledger', async () => {
  const item = queueItem(); let commits = 0;
  await assert.rejects(__test.runDevelopmentalReadingRuntime({ force: true,
    at: new Date('2026-07-18T02:00:00Z'),
    store: { developmentalReadingQueue: () => ({ item }),
      commitDevelopmentalReadingNote: () => { commits += 1; } },
    library: { readChunk: async () => 'Committed source content.' },
    post: async () => ({ data: { id: 'reading-truncated', model: 'claude-sonnet-4-6',
      stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"summary":"unfinished"' }] } }),
  }), /exhausted its bounded output/);
  assert.equal(commits, 0);
});
