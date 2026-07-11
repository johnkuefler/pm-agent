const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('intelligence upgrades preserve Nora expressive personality anchors', () => {
  const prompt = fs.readFileSync(path.resolve(__dirname, '../../nora-prompt.md'), 'utf8');
  for (const anchor of [
    "you're one of them", 'casual, warm, quick', 'Default: talk', 'The one-sentence reflex is the AI tell',
    'Let conversations die', '[silence]', 'Your takes', 'ask like a teammate',
  ]) assert.match(prompt, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
