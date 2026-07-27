'use strict';

// Source-text contract tests assert on what the SERVER DOES, not on which file happens to hold
// the code. Historically they each read server.js directly, which quietly turned every one of
// them into an assertion that the code lives in server.js. That is the single biggest reason the
// monolith kept growing: moving any behavior out of server.js broke hundreds of unrelated tests,
// so nobody moved anything.
//
// This helper defines "the server source" as server.js PLUS everything server.js was split into.
// Extracting a surface into src/surfaces/ is then invisible to these assertions, exactly as it
// should be, while a genuine deletion still fails them.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENTRYPOINT = 'server.js';
// Everything under this directory counts as server source. This is the ONLY place extracted
// surface code may live for the contract tests to keep covering it, which is deliberate: it
// gives the refactor one obvious destination instead of scattering server logic across src/.
const SURFACES_DIR = path.join(ROOT, 'src', 'surfaces');

function collectSurfaceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSurfaceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

// Segment boundaries are emitted as comments so a slice that runs off the end of one file stops
// there instead of silently swallowing the next one.
function segmentBanner(relativePath) {
  return `\n// ===== server source segment: ${relativePath.replace(/\\/g, '/')} =====\n`;
}

function serverSourceSegments() {
  const files = [path.join(ROOT, ENTRYPOINT), ...collectSurfaceFiles(SURFACES_DIR)];
  return files.map(file => ({
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8'),
  }));
}

// The whole server, entrypoint first, then each extracted surface in stable path order.
function readServerSource() {
  return serverSourceSegments()
    .map(segment => segmentBanner(segment.file) + segment.text)
    .join('');
}

// Slice the region between two markers. Prefer this over raw indexOf arithmetic: when the end
// marker is missing (usually because the region moved to its own file and the marker went with
// a different one), a raw slice silently returns the wrong span. This stops at the end of the
// segment the region started in and throws when the start marker is genuinely gone.
function sourceRegion(startMarker, endMarker, source = readServerSource()) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`server source region start not found: ${startMarker}`);
  const segmentEnd = source.indexOf('\n// ===== server source segment: ', start + startMarker.length);
  const boundary = segmentEnd === -1 ? source.length : segmentEnd;
  if (!endMarker) return source.slice(start, boundary);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 || end > boundary ? boundary : end);
}

module.exports = { readServerSource, sourceRegion, serverSourceSegments, ROOT, SURFACES_DIR };
