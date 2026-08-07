'use strict';

const {
  DEFAULT_MEMORY_POLICY,
  buildMemoryDigest,
  dayKey,
  planMemoryRetention,
} = require('../intelligence/memory-lifecycle');

function createMemoryMaintenance({
  loadMemory,
  mutateMemory,
  loadDigest = async () => null,
  saveDigest = async () => {},
  policy = DEFAULT_MEMORY_POLICY,
  now = () => new Date(),
} = {}) {
  if (typeof loadMemory !== 'function' || typeof mutateMemory !== 'function') {
    throw new TypeError('memory maintenance requires loadMemory and mutateMemory');
  }
  let digest = null;
  let inFlight = null;

  async function hydrate() {
    const stored = await loadDigest();
    if (stored && stored.version === 1 && typeof stored.text === 'string') digest = stored;
    return digest;
  }

  async function run({ force = false, at = now() } = {}) {
    if (inFlight) return inFlight;
    if (!force && digest?.generated_for === dayKey(at)) {
      return { ran: false, digest, expired: 0 };
    }
    inFlight = (async () => {
      const initial = loadMemory();
      const plan = planMemoryRetention(initial, at, policy);
      let current = initial;
      if (plan.updates.length) {
        const updateById = new Map(plan.updates.map(update => [update.id, update]));
        const result = await mutateMemory(items => {
          let applied = 0;
          for (const item of items) {
            const update = updateById.get(item.id);
            if (!update || item.status !== 'active') continue;
            Object.assign(item, update);
            applied += 1;
          }
          return applied;
        });
        current = result.memory;
      }
      const nextDigest = buildMemoryDigest(current, at, policy);
      await saveDigest(nextDigest);
      digest = nextDigest;
      return { ran: true, digest, expired: plan.updates.length,
        examined: plan.examined };
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  }

  function currentDigest() {
    return digest;
  }

  function snapshot() {
    return { digest, running: Boolean(inFlight), policy: { ...policy } };
  }

  return { currentDigest, hydrate, run, snapshot };
}

module.exports = { createMemoryMaintenance };
