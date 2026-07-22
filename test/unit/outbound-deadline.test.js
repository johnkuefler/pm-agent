'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

function javascriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === '.git') return [];
    if (entry.isDirectory()) return javascriptFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

function directAxiosCalls(source) {
  const calls = [];
  const pattern = /axios\.(?:get|post|put|patch|delete|request)\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    let mode = 'code';
    let escaped = false;
    let end = source.length;
    for (let index = open; index < source.length; index++) {
      const char = source[index];
      const next = source[index + 1];
      if (mode === 'line-comment') { if (char === '\n') mode = 'code'; continue; }
      if (mode === 'block-comment') { if (char === '*' && next === '/') { mode = 'code'; index++; } continue; }
      if (mode !== 'code') {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')
          || (mode === 'template' && char === '`')) mode = 'code';
        continue;
      }
      if (char === '/' && next === '/') { mode = 'line-comment'; index++; continue; }
      if (char === '/' && next === '*') { mode = 'block-comment'; index++; continue; }
      if (char === "'") { mode = 'single'; continue; }
      if (char === '"') { mode = 'double'; continue; }
      if (char === '`') { mode = 'template'; continue; }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) { end = index + 1; break; }
    }
    calls.push({ index: match.index, source: source.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return calls;
}

test('every direct backend axios request has a local terminal condition', () => {
  const failures = [];
  const files = [path.join(root, 'server.js'), path.join(root, 'join-meeting.js'),
    ...javascriptFiles(path.join(root, 'src'))];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const lineOffsets = [0];
    for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineOffsets.push(index + 1);
    for (const call of directAxiosCalls(source)) {
      if (/\btimeout\s*:|\bsignal\s*[:,}]/.test(call.source)) continue;
      const line = lineOffsets.findLastIndex(offset => offset <= call.index) + 1;
      failures.push(`${path.relative(root, file)}:${line}`);
    }
  }
  assert.deepEqual(failures, [],
    `outbound requests need an explicit timeout or abort signal: ${failures.join(', ')}`);
});

test('paginated connector loops have a batch deadline, not only per-request deadlines', () => {
  const projects = fs.readFileSync(path.join(root, 'src', 'routes', 'registerProjectRoutes.js'), 'utf8');
  assert.match(projects, /syncDeadlineAt = Date\.now\(\) \+ 30000/);
  assert.match(projects, /Teamwork project sync exceeded 30s total deadline/);
  assert.match(projects, /timeout: Math\.min\(8000, remainingMs\)/);
});
