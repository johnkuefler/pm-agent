'use strict';

function persistenceFingerprint(memory) {
  return JSON.stringify([
    memory?.fact || '', memory?.project || '', memory?.added || null, memory?.source || null,
    memory?.source_bot_id || null, typeof memory?.salience === 'number' ? memory.salience : 0.3,
    Number(memory?.recall_count) || 0, memory?.last_recalled || null,
    memory?.kind, memory?.confidence, memory?.status, memory?.source_ref,
    memory?.valid_from, memory?.valid_until, memory?.last_verified,
    memory?.verification_count, memory?.supersedes, memory?.contradicted_by,
    memory?.sensitivity, memory?.emotional_weight, memory?.social_weight,
  ]);
}

function captureMemoryPersistence(items = []) {
  return new Map(items.filter(item => item?.id)
    .map(item => [item.id, persistenceFingerprint(item)]));
}

function diffMemoryPersistence(before = new Map(), items = []) {
  const currentIds = new Set();
  const upserts = [];
  for (let ord = 0; ord < items.length; ord += 1) {
    const item = items[ord];
    if (!item?.id || !item.fact) continue;
    currentIds.add(item.id);
    if (before.get(item.id) !== persistenceFingerprint(item)) upserts.push({ item, ord });
  }
  const deleted_ids = [...before.keys()].filter(id => !currentIds.has(id));
  return { upserts, deleted_ids };
}

module.exports = { captureMemoryPersistence, diffMemoryPersistence, persistenceFingerprint };
