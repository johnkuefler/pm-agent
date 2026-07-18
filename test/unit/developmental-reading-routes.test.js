'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIntelligenceRoutes } = require('../../src/routes/intelligence');

function harness({ withLibrary = true, rejectSource = false } = {}) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  const calls = { ingest: [], source: [], session: [], discard: [] };
  const store = new Proxy({
    developmentalReadingSnapshot: () => ({ report: { sources: 1, active_sessions: 0 } }),
    registerReadingSource: input => {
      calls.source.push(input);
      if (rejectSource) throw new Error('metadata rejected');
      return { ...input, content_manifest_commitment: 'f'.repeat(64) };
    },
    startReadingSession: (sourceId, input) => {
      calls.session.push({ sourceId, input });
      return { id: 'reading-session-1', source_id: sourceId, status: 'active' };
    },
  }, { get(target, property) { return property in target ? target[property] : () => null; } });
  const readingLibrary = withLibrary ? { ingest: async content => {
    calls.ingest.push(content);
    return { id: 'reading-source-1234567890abcdef', content_commitment: 'a'.repeat(64),
      content_chars: content.length, chunk_commitments: ['b'.repeat(64)], created: true };
    }, discard: async manifest => { calls.discard.push(manifest.id); return true;
  } } : null;
  const auth = (_req, _res, next) => next?.();
  registerIntelligenceRoutes(app, { requireAuth: auth, requireResearchAuth: auth,
    requireEvaluatorAuth: auth, store, readingLibrary });
  async function invoke(method, path, req = {}) {
    const output = { statusCode: 200, body: null };
    const res = {
      status(code) { output.statusCode = code; return this; },
      json(body) { output.body = body; return this; },
    };
    await routes.get(`${method} ${path}`)({ query: {}, params: {}, body: {}, ...req }, res);
    return output;
  }
  return { invoke, calls };
}

test('reading routes expose bounded state and keep admitted source text out of cognition storage', async () => {
  const { invoke, calls } = harness();
  const snapshot = await invoke('GET', '/developmental-reading');
  assert.equal(snapshot.body.report.sources, 1);

  const content = 'source text '.repeat(60);
  const admitted = await invoke('POST', '/developmental-reading/sources', { body: {
    content, title: 'A Work', author: 'An Author', source_kind: 'book',
    source_url: 'https://example.org/work', rights_basis: 'public_domain',
    rights_note: 'Public domain.', admitted_by: 'John',
  } });
  assert.equal(admitted.statusCode, 200);
  assert.equal(calls.ingest[0], content);
  assert.equal(calls.source[0].content, undefined);
  assert.equal(admitted.body.source.content, undefined);
  assert.equal(admitted.body.source.chunk_count, 1);
});

test('reading session selection remains an explicit source-bound act', async () => {
  const { invoke, calls } = harness();
  const response = await invoke('POST', '/developmental-reading/sessions', { body: {
    source_id: 'reading-source-1234567890abcdef', selected_by: 'Nora',
    selection_rationale: 'I want to understand responsibility.',
    guiding_questions: ['What changes good coordination?'],
    predicted_influence: 'I may become more attentive to judgment.',
  } });
  assert.equal(response.body.session.status, 'active');
  assert.equal(calls.session[0].sourceId, 'reading-source-1234567890abcdef');
});

test('source admission fails closed when the filesystem library is unavailable', async () => {
  const response = await harness({ withLibrary: false }).invoke(
    'POST', '/developmental-reading/sources', { body: { content: 'x'.repeat(600) } });
  assert.equal(response.statusCode, 503);
});

test('a newly written source is discarded when metadata admission fails', async () => {
  const { invoke, calls } = harness({ rejectSource: true });
  const response = await invoke('POST', '/developmental-reading/sources', { body: {
    content: 'source '.repeat(100), title: 'Bad metadata',
  } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls.discard, ['reading-source-1234567890abcdef']);
});
