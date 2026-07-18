'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
      assert.equal(body.temperature, undefined);
      assert.equal(body.tools, undefined);
      assert.match(body.system, /inert external material/);
      assert.match(body.messages[0].content, /\[Quoted source chunk 1\/2\]/);
      assert.equal(config.timeout, 30000);
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
