'use strict';

function fingerprint(value) {
  return JSON.stringify(value);
}

function captureInteractionPersistence(interactions = []) {
  return new Map(interactions.filter(item => item?.id)
    .map(item => [item.id, fingerprint(item)]));
}

function diffInteractionPersistence(before = new Map(), interactions = []) {
  const currentIds = new Set();
  const upserts = [];
  for (const interaction of interactions) {
    if (!interaction?.id) continue;
    currentIds.add(interaction.id);
    if (before.get(interaction.id) !== fingerprint(interaction)) {
      upserts.push(JSON.parse(JSON.stringify(interaction)));
    }
  }
  return { upserts, deleted_ids: [...before.keys()].filter(id => !currentIds.has(id)) };
}

module.exports = { captureInteractionPersistence, diffInteractionPersistence };
