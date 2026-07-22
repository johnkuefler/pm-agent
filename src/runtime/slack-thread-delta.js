'use strict';

function fingerprint(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function captureSlackThreadPersistence(threads = {}) {
  return new Map(Object.entries(threads).map(([key, value]) => [key, fingerprint(value)]));
}

function diffSlackThreadPersistence(before = new Map(), threads = {}) {
  const upserts = [];
  for (const [key, value] of Object.entries(threads)) {
    if (before.get(key) !== fingerprint(value)) {
      upserts.push({ key, value: JSON.parse(JSON.stringify(value || {})) });
    }
  }
  const current = new Set(Object.keys(threads));
  return { upserts, deleted_keys: [...before.keys()].filter(key => !current.has(key)) };
}

module.exports = { captureSlackThreadPersistence, diffSlackThreadPersistence };
