'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPECTED_CONTENT_COMMITMENT, SOURCE, validateSourceContent, seedFirstReadingSource } =
  require('../../scripts/seed-first-reading-source');

function bookText() {
  return `The Project Gutenberg eBook of The new state
Author: Mary Parker Follett
Release date: June 2, 2024 [eBook #73755]
*** START OF THE PROJECT GUTENBERG EBOOK THE NEW STATE ***
${'Group organization requires creative participation and responsible disagreement. '.repeat(7000)}
*** END OF THE PROJECT GUTENBERG EBOOK THE NEW STATE ***`;
}

function response(body, { status = 200, text = false } = {}) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(body),
    text: async () => text ? body : JSON.stringify(body) };
}

test('the frozen first source identity rejects partial or substituted content', () => {
  assert.throws(() => validateSourceContent('The New State'), /identity validation/);
  const validated = validateSourceContent(bookText(), { expectedCommitment: null });
  assert.ok(validated.chars > 500000);
  assert.match(validated.content_commitment, /^[a-f0-9]{64}$/);
});

test('the production seed freezes the reviewed public-domain byte commitment', () => {
  assert.match(EXPECTED_CONTENT_COMMITMENT, /^[a-f0-9]{64}$/);
  assert.throws(() => validateSourceContent(bookText()), /changed from its reviewed frozen commitment/);
});

test('the seed validates the exact source and admits it without exposing credentials', async () => {
  const calls = [];
  const result = await seedFirstReadingSource({ baseUrl: 'https://nora.example/', apiKey: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || 'GET', authorization: options.headers?.Authorization,
        body: options.body });
      if (url === 'https://nora.example/developmental-reading') return response({ sources: [] });
      if (url === SOURCE.source_url) return response(bookText(), { text: true });
      return response({ source: { id: 'reading-source-first', title: SOURCE.title } });
    }, expectedContentCommitment: null });
  assert.equal(result.seeded, true);
  assert.equal(calls.at(-1).url, 'https://nora.example/developmental-reading/sources');
  const admitted = JSON.parse(calls.at(-1).body);
  assert.equal(admitted.rights_basis, 'public_domain');
  assert.equal(admitted.content, bookText());
  assert.ok(calls.filter(call => call.url.startsWith('https://nora.example'))
    .every(call => call.authorization === 'Bearer secret'));
});

test('the seed is idempotent and does not redownload an admitted source', async () => {
  let calls = 0;
  const result = await seedFirstReadingSource({ baseUrl: 'https://nora.example', apiKey: 'secret',
    fetchImpl: async url => {
      calls += 1;
      assert.equal(url, 'https://nora.example/developmental-reading');
      return response({ sources: [{ id: 'existing', source_url: SOURCE.source_url }] });
    } });
  assert.equal(result.reason, 'already_admitted');
  assert.equal(calls, 1);
});
