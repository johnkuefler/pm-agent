'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  corpusConfiguration,
  fetchCorpusResource,
  safeAgentSlug,
} = require('../../src/routes/agentic-corpus');

test('agentic corpus credentials remain server-side and HTTPS-only', () => {
  assert.equal(corpusConfiguration({}).enabled, false);
  assert.equal(corpusConfiguration({
    AGENTIC_CORPUS_BASE_URL: 'http://corpus.example',
    AGENTIC_CORPUS_BASIC_AUTH: 'user:secret',
  }).reason, 'https_required');
  const configured = corpusConfiguration({
    AGENTIC_CORPUS_BASE_URL: 'https://corpus.example',
    AGENTIC_CORPUS_USERNAME: 'user',
    AGENTIC_CORPUS_PASSWORD: 'secret',
  });
  assert.equal(configured.enabled, true);
  assert.match(configured.authorization, /^Basic /);
  assert.doesNotMatch(configured.authorization, /secret/);
});

test('corpus proxy authenticates a bounded request without forwarding credentials in its result', async () => {
  let request;
  const result = await fetchCorpusResource('/corpus.md', {
    env: {
      AGENTIC_CORPUS_BASE_URL: 'https://corpus.example',
      AGENTIC_CORPUS_BASIC_AUTH: 'user:secret',
    },
    fetchImpl: async (target, options) => {
      request = { target: String(target), options };
      return {
        ok: true,
        status: 200,
        headers: { get: name => name === 'content-type' ? 'text/markdown' : null },
        arrayBuffer: async () => Buffer.from('# Fleet'),
      };
    },
  });
  assert.equal(request.target, 'https://corpus.example/corpus.md');
  assert.equal(request.options.redirect, 'error');
  assert.equal(Buffer.from(result.bytes).toString('utf8'), '# Fleet');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'authorization'), false);
});

test('corpus proxy fails closed without credentials and validates agent slugs', async () => {
  await assert.rejects(fetchCorpusResource('/corpus.md', {
    env: {},
    fetchImpl: async () => { throw new Error('must not fetch'); },
  }), error => error.status === 503 && error.code === 'credentials_unavailable');
  assert.equal(safeAgentSlug('msg-seo_agent'), 'msg-seo_agent');
  assert.equal(safeAgentSlug('../admin'), null);
});
