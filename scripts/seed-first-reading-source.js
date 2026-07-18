'use strict';

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const EXPECTED_CONTENT_COMMITMENT = 'd07dc296e790942c5a9847adad29c5030dff70de2dcb0063f9b07d13e1876ebe';
const SOURCE = Object.freeze({
  title: 'The New State: Group Organization the Solution of Popular Government',
  author: 'Mary Parker Follett',
  source_kind: 'book',
  source_url: 'https://www.gutenberg.org/cache/epub/73755/pg73755.txt',
  rights_basis: 'public_domain',
  rights_note: 'Project Gutenberg ebook #73755 reports public domain in the USA; original United States publication 1918.',
  admitted_by: 'deployment-curator',
});

function validateSourceContent(value, { expectedCommitment = EXPECTED_CONTENT_COMMITMENT } = {}) {
  const content = String(value || '').replace(/\r\n?/g, '\n').trim();
  const required = [
    'The Project Gutenberg eBook of The new state',
    'Author: Mary Parker Follett',
    '[eBook #73755]',
    '*** START OF THE PROJECT GUTENBERG EBOOK THE NEW STATE ***',
    '*** END OF THE PROJECT GUTENBERG EBOOK THE NEW STATE ***',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length || content.length < 500000 || content.length > 1500000) {
    throw new Error(`first reading source failed frozen identity validation${missing.length
      ? `; missing ${missing.join(', ')}` : ''}`);
  }
  const contentCommitment = crypto.createHash('sha256').update(content).digest('hex');
  if (expectedCommitment && contentCommitment !== expectedCommitment) {
    throw new Error('first reading source content changed from its reviewed frozen commitment');
  }
  return { content, chars: content.length, content_commitment: contentCommitment };
}

async function fetchJson(url, { apiKey, fetchImpl, method = 'GET', body = null,
  timeoutMs = 30000 } = {}) {
  const response = await fetchImpl(url, {
    method, headers: { Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method} ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function seedFirstReadingSource({
  baseUrl = process.env.NORA_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.NORA_API_KEY,
  fetchImpl = globalThis.fetch,
  validateOnly = false,
  expectedContentCommitment = EXPECTED_CONTENT_COMMITMENT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('first reading source seed requires fetch');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  if (!validateOnly) {
    if (!apiKey) throw new Error('NORA_API_KEY is required to seed the first reading source');
    const existing = await fetchJson(`${normalizedBase}/developmental-reading`, {
      apiKey, fetchImpl, timeoutMs: 90000,
    });
    const found = (existing.sources || []).find(item => item.source_url === SOURCE.source_url);
    if (found) return { seeded: false, reason: 'already_admitted', source: found };
  }
  const sourceResponse = await fetchImpl(SOURCE.source_url, {
    headers: { 'User-Agent': 'Nora developmental-reading curator/1.0' },
    signal: AbortSignal.timeout(90000),
  });
  if (!sourceResponse.ok) throw new Error(`source download failed with HTTP ${sourceResponse.status}`);
  const validated = validateSourceContent(await sourceResponse.text(), {
    expectedCommitment: expectedContentCommitment,
  });
  if (validateOnly) return { seeded: false, reason: 'validation_only',
    chars: validated.chars, content_commitment: validated.content_commitment };
  const admitted = await fetchJson(`${normalizedBase}/developmental-reading/sources`, {
    apiKey, fetchImpl, method: 'POST', timeoutMs: 120000,
    body: { ...SOURCE, content: validated.content },
  });
  return { seeded: true, source: admitted.source,
    downloaded_chars: validated.chars,
    downloaded_content_commitment: validated.content_commitment };
}

async function main() {
  try {
    const result = await seedFirstReadingSource({
      validateOnly: process.argv.includes('--validate-only'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`First reading source seed failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { DEFAULT_BASE_URL, EXPECTED_CONTENT_COMMITMENT, SOURCE,
  validateSourceContent, seedFirstReadingSource };
