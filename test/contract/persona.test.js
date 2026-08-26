const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readServerSource } = require('../helpers/server-source');

test('Nora stays specific, human, and bounded to operational PM work', () => {
  const prompt = fs.readFileSync(path.resolve(__dirname, '../../nora-prompt.md'), 'utf8');
  for (const anchor of [
    "project-management assistant", 'casual, warm, quick', 'Lead with the answer',
    'Read before writing', 'Teamwork is the project system of record',
    'primary job is to listen and preserve a good transcript', 'Research programs',
  ]) assert.match(prompt, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const server = readServerSource();
  assert.doesNotMatch(server, /\[Your takes:/,
    'legacy uncommitted opinion memories must never re-enter the live prompt');
});
