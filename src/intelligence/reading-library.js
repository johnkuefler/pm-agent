'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The authenticated source-ingestion route has a dedicated 8 MiB request envelope.
// Larger works can be admitted as explicitly titled volumes.
const MAX_CONTENT_CHARS = 1500000;
const TARGET_CHUNK_CHARS = 12000;

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function normalizeContent(value) {
  const content = String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (content.length < 500 || content.length > MAX_CONTENT_CHARS) {
    throw new Error('reading source content must contain 500 to 1,500,000 characters');
  }
  return content;
}

function chunksFor(content, target = TARGET_CHUNK_CHARS) {
  const paragraphs = normalizeContent(content).split(/\n{2,}/);
  const chunks = []; let current = '';
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      push();
      for (let offset = 0; offset < paragraph.length;) {
        let end = Math.min(paragraph.length, offset + target);
        const prior = paragraph.charCodeAt(end - 1);
        const next = paragraph.charCodeAt(end);
        if (prior >= 0xD800 && prior <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end += 1;
        chunks.push(paragraph.slice(offset, end).trim());
        offset = end;
      }
    } else if (!current || current.length + paragraph.length + 2 <= target) {
      current += `${current ? '\n\n' : ''}${paragraph}`;
    } else { push(); current = paragraph; }
  }
  push();
  return chunks.filter(Boolean);
}

function createReadingLibrary({ directory }) {
  const root = path.resolve(directory);
  async function ingest(content) {
    const normalized = normalizeContent(content);
    const contentCommitment = sha(normalized);
    const id = `reading-source-${contentCommitment.slice(0, 16)}`;
    const chunks = chunksFor(normalized);
    const chunkCommitments = chunks.map(sha);
    const sourceDir = path.join(root, id);
    const existed = await fs.promises.stat(sourceDir).then(() => true).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await Promise.all(chunks.map((chunk, index) => fs.promises.writeFile(
      path.join(sourceDir, `${String(index).padStart(4, '0')}.txt`), chunk, 'utf8')));
    return { id, content_commitment: contentCommitment, content_chars: normalized.length,
      chunk_commitments: chunkCommitments, created: !existed };
  }
  async function readChunk(source, index) {
    const safeId = String(source?.id || '');
    if (!/^reading-source-[a-f0-9]{16}$/.test(safeId)) throw new Error('invalid reading source id');
    if (!Number.isInteger(index) || index < 0 || index >= source.chunk_commitments.length) {
      throw new Error('invalid reading chunk index');
    }
    const file = path.join(root, safeId, `${String(index).padStart(4, '0')}.txt`);
    const chunk = await fs.promises.readFile(file, 'utf8');
    if (sha(chunk) !== source.chunk_commitments[index]) throw new Error('reading source chunk failed integrity');
    return chunk;
  }
  async function discard(manifest) {
    if (manifest?.created !== true) return false;
    const safeId = String(manifest.id || '');
    if (!/^reading-source-[a-f0-9]{16}$/.test(safeId)) throw new Error('invalid reading source id');
    await fs.promises.rm(path.join(root, safeId), { recursive: true, force: true });
    return true;
  }
  return { root, ingest, readChunk, discard };
}

module.exports = { MAX_CONTENT_CHARS, TARGET_CHUNK_CHARS, normalizeContent, chunksFor,
  createReadingLibrary };
