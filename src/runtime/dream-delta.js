'use strict';

function fingerprint(value) {
  return JSON.stringify(value);
}

function captureDreamPersistence(dreams = []) {
  return new Map(dreams.filter(dream => dream?.id).map(dream => [dream.id, fingerprint(dream)]));
}

function diffDreamPersistence(before = new Map(), dreams = []) {
  const currentIds = new Set();
  const upserts = [];
  for (const dream of dreams) {
    if (!dream?.id) continue;
    currentIds.add(dream.id);
    if (before.get(dream.id) !== fingerprint(dream)) {
      upserts.push(JSON.parse(JSON.stringify(dream)));
    }
  }
  return { upserts, deleted_ids: [...before.keys()].filter(id => !currentIds.has(id)) };
}

module.exports = { captureDreamPersistence, diffDreamPersistence };
