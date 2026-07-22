'use strict';

function fingerprint(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function captureMarkerPersistence(markers = {}) {
  return new Map(Object.entries(markers).map(([key, value]) => [key, fingerprint(value)]));
}

function diffMarkerPersistence(before = new Map(), markers = {}) {
  const upserts = [];
  for (const [key, value] of Object.entries(markers)) {
    if (before.get(key) !== fingerprint(value)) {
      upserts.push({ key, value: JSON.parse(JSON.stringify(value)) });
    }
  }
  const current = new Set(Object.keys(markers));
  return { upserts, deleted_keys: [...before.keys()].filter(key => !current.has(key)) };
}

module.exports = { captureMarkerPersistence, diffMarkerPersistence };
