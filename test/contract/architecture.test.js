const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Documentation alone has never stopped this codebase from regrowing its monolith. These are the
// enforceable versions of the rules in CLAUDE.md. Each is a ratchet: it may improve, never regress.
// If one fails, the fix is almost always to put the code somewhere better, not to raise the number.

function walk(dir, filter, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, found);
    else if (filter(full)) found.push(full);
  }
  return found;
}

// This file states the forbidden patterns as literals in order to search for them, so it is not a
// subject of its own scans.
const testFiles = walk(path.join(ROOT, 'test'), file => file.endsWith('.test.js'))
  .filter(file => file !== __filename);

// Every direct read re-pins code to server.js and blocks extraction. There is one correct way to
// read the server's source in a test, and it is the shared helper.
test('no test reads server.js directly instead of through the shared helper', () => {
  const offenders = testFiles.filter(file =>
    /readFileSync\([^)]*['"`]server\.js['"`]/.test(fs.readFileSync(file, 'utf8'))
      || /readFileSync\([^)]*server\.js/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map(file => path.relative(ROOT, file)), [],
    'use require("../helpers/server-source").readServerSource() so extraction stays invisible to source-text assertions');
});

// server.js only shrinks. A change that needs new server-side behavior has somewhere to put it:
// src/surfaces for extracted surface code, src/routes for route groups, src/ for everything else.
const SERVER_LINE_CEILING = 16524;
test('server.js does not grow', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split(/\r?\n/).length - 1;
  assert.ok(lines <= SERVER_LINE_CEILING,
    `server.js grew to ${lines} lines (ceiling ${SERVER_LINE_CEILING}). Put new code in src/, and lower the ceiling when you extract.`);
});

// Em dashes keep arriving through automated changes. The count may fall, never rise.
const EM_DASH_CEILING = { 'server.js': 238, src: 240 };
test('em dash count never increases', () => {
  const serverDashes = (fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/—/g) || []).length;
  assert.ok(serverDashes <= EM_DASH_CEILING['server.js'],
    `server.js gained em dashes (${serverDashes} > ${EM_DASH_CEILING['server.js']}). Use a comma, a colon, or a second sentence.`);
  const srcDashes = walk(path.join(ROOT, 'src'), file => file.endsWith('.js'))
    .reduce((total, file) => total + (fs.readFileSync(file, 'utf8').match(/—/g) || []).length, 0);
  assert.ok(srcDashes <= EM_DASH_CEILING.src,
    `src/ gained em dashes (${srcDashes} > ${EM_DASH_CEILING.src}). Use a comma, a colon, or a second sentence.`);
});

// The helper's contract: extracted surface code has to be reachable as server source, or hundreds
// of behavioral assertions quietly stop covering it while still passing.
test('extracted surface code is covered by the server source helper', () => {
  const { readServerSource } = require('../helpers/server-source');
  const source = readServerSource();
  const surfaces = walk(path.join(ROOT, 'src', 'surfaces'), file => file.endsWith('.js'));
  assert.ok(surfaces.length > 0, 'src/surfaces should hold the code extracted out of server.js');
  for (const file of surfaces) {
    assert.ok(source.includes(fs.readFileSync(file, 'utf8')),
      `${path.relative(ROOT, file)} is not present in readServerSource(); source-text contracts would stop covering it`);
  }
});

// A surface module that reaches back into server.js is not extracted, it is entangled. Requiring
// upward would also be a cycle, since server.js requires these.
test('surface modules never require server.js', () => {
  const offenders = walk(path.join(ROOT, 'src'), file => file.endsWith('.js'))
    .filter(file => /require\(['"`][^'"`]*\bserver(\.js)?['"`]\)/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map(file => path.relative(ROOT, file)), [],
    'modules under src/ must not require the server; pass what they need in instead');
});
