'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { READING_LIBRARY, validateLibrarySourceContent, seedReadingLibrary } =
  require('../../scripts/seed-reading-library');

function fixture(source) {
  return `The Project Gutenberg eBook of ${source.title}
Title: ${source.title}
Author: ${source.author}
Release date: January 1, 2000 [eBook #${source.ebook_id}]
${source.start_marker}
${'A rights-reviewed source paragraph about judgment, responsibility, and inquiry. '.repeat(30)}
${source.end_marker}`;
}

function response(body, { status = 200, text = false } = {}) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(body),
    text: async () => text ? body : JSON.stringify(body) };
}

test('curated library is diverse, bounded, and frozen to reviewed Project Gutenberg downloads', () => {
  assert.equal(READING_LIBRARY.length, 5);
  assert.equal(new Set(READING_LIBRARY.map(item => item.author)).size, 5);
  for (const source of READING_LIBRARY) {
    assert.match(source.source_url, /^https:\/\/www\.gutenberg\.org\/cache\/epub\//);
    assert.match(source.catalog_url, /^https:\/\/www\.gutenberg\.org\/ebooks\//);
    assert.match(source.expected_content_commitment, /^[a-f0-9]{64}$/);
    assert.equal(source.rights_basis, 'public_domain');
  }
});

test('library validation rejects substitution and binds identity before admission', () => {
  const source = { ...READING_LIBRARY[0], minimum_chars: 500, maximum_chars: 10000,
    expected_content_commitment: null };
  const validated = validateLibrarySourceContent(source, fixture(source));
  assert.ok(validated.chars > 500);
  assert.match(validated.content_commitment, /^[a-f0-9]{64}$/);
  assert.throws(() => validateLibrarySourceContent(source, fixture({ ...source,
    author: 'Substituted Author' })), /identity validation/);
});

test('library seed admits only missing validated works and never exposes its credential', async () => {
  const first = { ...READING_LIBRARY[0], minimum_chars: 500, maximum_chars: 10000,
    expected_content_commitment: null };
  const second = { ...READING_LIBRARY[1], minimum_chars: 500, maximum_chars: 10000,
    expected_content_commitment: null };
  const calls = [];
  const result = await seedReadingLibrary({ baseUrl: 'https://nora.example/', apiKey: 'secret',
    sources: [first, second], fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', authorization: options.headers?.Authorization,
        body: options.body });
      if (url === 'https://nora.example/developmental-reading') {
        return response({ sources: [{ id: 'already-there', source_url: first.source_url }] });
      }
      if (url === second.source_url) return response(fixture(second), { text: true });
      return response({ source: { id: 'new-source', title: second.title,
        source_url: second.source_url } });
    } });
  assert.equal(result.seeded_count, 1);
  assert.equal(result.existing_count, 1);
  assert.equal(calls.filter(call => call.url === first.source_url).length, 0);
  const post = calls.find(call => call.url === 'https://nora.example/developmental-reading/sources');
  assert.equal(post.authorization, 'Bearer secret');
  const body = JSON.parse(post.body);
  assert.equal(body.title, second.title);
  assert.equal(body.rights_basis, 'public_domain');
  assert.equal(body.expected_content_commitment, undefined);
  assert.equal(body.apiKey, undefined);
  assert.ok(calls.filter(call => call.url.startsWith('https://nora.example'))
    .every(call => call.authorization === 'Bearer secret'));
});
