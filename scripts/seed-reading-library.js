'use strict';

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const READING_LIBRARY = Object.freeze([
  {
    ebook_id: '37423', title: 'How We Think', author: 'John Dewey', source_kind: 'book',
    source_url: 'https://www.gutenberg.org/cache/epub/37423/pg37423.txt',
    catalog_url: 'https://www.gutenberg.org/ebooks/37423', rights_basis: 'public_domain',
    rights_note: 'Project Gutenberg ebook #37423 reports public domain in the USA; original United States publication 1910.',
    expected_content_commitment: '6e95b44ef156e985516b3990f52e2db2edea1d5d112e43ef03ea659c6c925bd9',
    minimum_chars: 400000, maximum_chars: 500000,
    start_marker: '*** START OF THE PROJECT GUTENBERG EBOOK HOW WE THINK ***',
    end_marker: '*** END OF THE PROJECT GUTENBERG EBOOK HOW WE THINK ***',
  },
  {
    ebook_id: '15487', title: 'Democracy and Social Ethics', author: 'Jane Addams', source_kind: 'book',
    source_url: 'https://www.gutenberg.org/cache/epub/15487/pg15487.txt',
    catalog_url: 'https://www.gutenberg.org/ebooks/15487', rights_basis: 'public_domain',
    rights_note: 'Project Gutenberg ebook #15487 reports public domain in the USA; original United States publication 1902.',
    expected_content_commitment: 'b5f929d60254e7f12b03091107de0ec90fe7c21ac85f32ed61b5db451f744e54',
    minimum_chars: 280000, maximum_chars: 350000,
    start_marker: '*** START OF THE PROJECT GUTENBERG EBOOK DEMOCRACY AND SOCIAL ETHICS ***',
    end_marker: '*** END OF THE PROJECT GUTENBERG EBOOK DEMOCRACY AND SOCIAL ETHICS ***',
  },
  {
    ebook_id: '6435', title: 'The Principles of Scientific Management',
    author: 'Frederick Winslow Taylor', source_kind: 'book',
    source_url: 'https://www.gutenberg.org/cache/epub/6435/pg6435.txt',
    catalog_url: 'https://www.gutenberg.org/ebooks/6435', rights_basis: 'public_domain',
    rights_note: 'Project Gutenberg ebook #6435 reports public domain in the USA; original United States publication 1911.',
    expected_content_commitment: '787192d0ff8c3aad289cc95f00b5e9df87a388b4938228f6b7013a8f363208f1',
    minimum_chars: 200000, maximum_chars: 270000,
    start_marker: '*** START OF THE PROJECT GUTENBERG EBOOK THE PRINCIPLES OF SCIENTIFIC MANAGEMENT ***',
    end_marker: '*** END OF THE PROJECT GUTENBERG EBOOK THE PRINCIPLES OF SCIENTIFIC MANAGEMENT ***',
  },
  {
    ebook_id: '84', title: 'Frankenstein; or, the modern prometheus',
    author: 'Mary Wollstonecraft Shelley', source_kind: 'book',
    source_url: 'https://www.gutenberg.org/cache/epub/84/pg84.txt',
    catalog_url: 'https://www.gutenberg.org/ebooks/84', rights_basis: 'public_domain',
    rights_note: 'Project Gutenberg ebook #84 reports public domain in the USA; this is the 1818 text.',
    expected_content_commitment: '327cf30217178aed19e61ae478bf6500ba784eade6ad6b6c98318640daf8b6c1',
    minimum_chars: 400000, maximum_chars: 500000,
    start_marker: '*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN; OR, THE MODERN PROMETHEUS ***',
    end_marker: '*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN; OR, THE MODERN PROMETHEUS ***',
  },
  {
    ebook_id: '408', title: 'The Souls of Black Folk', author: 'W. E. B. Du Bois', source_kind: 'book',
    source_url: 'https://www.gutenberg.org/cache/epub/408/pg408.txt',
    catalog_url: 'https://www.gutenberg.org/ebooks/408', rights_basis: 'public_domain',
    rights_note: 'Project Gutenberg ebook #408 reports public domain in the USA; original United States publication 1903.',
    expected_content_commitment: '10e8e79bc43ac34a8a074b0fb2a554b12b0a3d3306916c5e8915f188561bacc6',
    minimum_chars: 380000, maximum_chars: 480000,
    start_marker: '*** START OF THE PROJECT GUTENBERG EBOOK THE SOULS OF BLACK FOLK ***',
    end_marker: '*** END OF THE PROJECT GUTENBERG EBOOK THE SOULS OF BLACK FOLK ***',
  },
]);

function normalizeDownload(value) { return String(value || '').replace(/\r\n?/g, '\n').trim(); }

function validateLibrarySourceContent(source, value, {
  expectedCommitment = source.expected_content_commitment,
} = {}) {
  const content = normalizeDownload(value);
  const markers = [
    `Title: ${source.title}`, `Author: ${source.author}`,
    `[eBook #${source.ebook_id}]`, source.start_marker, source.end_marker,
  ];
  const missing = markers.filter(marker => !content.includes(marker));
  if (missing.length || content.length < source.minimum_chars || content.length > source.maximum_chars) {
    throw new Error(`${source.title} failed frozen identity validation${missing.length
      ? `; missing ${missing.join(', ')}` : ''}`);
  }
  const contentCommitment = crypto.createHash('sha256').update(content).digest('hex');
  if (expectedCommitment && contentCommitment !== expectedCommitment) {
    throw new Error(`${source.title} changed from its reviewed frozen commitment`);
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

function admissionPayload(source, content) {
  return {
    title: source.title, author: source.author, source_kind: source.source_kind,
    source_url: source.source_url, rights_basis: source.rights_basis,
    rights_note: source.rights_note, admitted_by: 'deployment-curator', content,
  };
}

async function seedReadingLibrary({
  baseUrl = process.env.NORA_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.NORA_API_KEY,
  fetchImpl = globalThis.fetch,
  validateOnly = false,
  sources = READING_LIBRARY,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('reading library seed requires fetch');
  if (!validateOnly && !apiKey) throw new Error('NORA_API_KEY is required to seed the reading library');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const existing = validateOnly ? [] : ((await fetchJson(`${normalizedBase}/developmental-reading`, {
    apiKey, fetchImpl, timeoutMs: 90000,
  })).sources || []);
  const results = [];
  for (const source of sources) {
    const admitted = existing.find(item => item.source_url === source.source_url);
    if (admitted) {
      results.push({ seeded: false, reason: 'already_admitted', source: admitted });
      continue;
    }
    const sourceResponse = await fetchImpl(source.source_url, {
      headers: { 'User-Agent': 'Nora developmental-reading curator/2.0' },
      signal: AbortSignal.timeout(90000),
    });
    if (!sourceResponse.ok) throw new Error(`${source.title} download failed with HTTP ${sourceResponse.status}`);
    const validated = validateLibrarySourceContent(source, await sourceResponse.text());
    if (validateOnly) {
      results.push({ seeded: false, reason: 'validation_only', title: source.title,
        chars: validated.chars, content_commitment: validated.content_commitment });
      continue;
    }
    const response = await fetchJson(`${normalizedBase}/developmental-reading/sources`, {
      apiKey, fetchImpl, method: 'POST', timeoutMs: 120000,
      body: admissionPayload(source, validated.content),
    });
    results.push({ seeded: true, source: response.source,
      downloaded_chars: validated.chars,
      downloaded_content_commitment: validated.content_commitment });
  }
  return { seeded_count: results.filter(item => item.seeded).length,
    existing_count: results.filter(item => item.reason === 'already_admitted').length,
    validated_count: results.filter(item => item.reason === 'validation_only').length,
    results };
}

async function main() {
  try {
    const result = await seedReadingLibrary({ validateOnly: process.argv.includes('--validate-only') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Reading library seed failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { DEFAULT_BASE_URL, READING_LIBRARY, normalizeDownload,
  validateLibrarySourceContent, admissionPayload, seedReadingLibrary };
