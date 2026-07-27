'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('database initialization provisions a cosine HNSW index for interactive memory recall', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');
  assert.match(source,
    /CREATE INDEX IF NOT EXISTS memory_embedding_hnsw[\s\S]*USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(source, /WITH \(m = 16, ef_construction = 64\)/);
  assert.match(source, /memory HNSW index unavailable; semantic recall will use exact scan/);
});
