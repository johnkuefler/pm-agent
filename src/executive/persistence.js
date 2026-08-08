'use strict';

const fs = require('fs');
const path = require('path');
const firewall = require('./firewall');

function createExecutiveFirewallPersistence({ db, stateKey = firewall.STATE_KEY, dataDirectory,
  databaseReady = () => false, writeThrough } = {}) {
  const filePath = path.join(dataDirectory, 'nora-executive-firewall.json');
  let cache = null;
  let writeQueue = Promise.resolve();

  function load() {
    if (cache) return firewall.normalizeState(cache);
    try { cache = firewall.normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { cache = firewall.emptyState(); }
    return firewall.normalizeState(cache);
  }

  async function hydrate() {
    if (databaseReady()) {
      const stored = await db.getState(stateKey);
      cache = firewall.normalizeState(stored || cache || firewall.emptyState());
    } else {
      load();
    }
    return firewall.normalizeState(cache);
  }

  function save(value) {
    const normalized = firewall.normalizeState(value);
    cache = normalized;
    const operation = async () => {
      if (databaseReady()) {
        await writeThrough(stateKey, () => db.setState(stateKey, normalized), { strict: true });
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2));
        fs.renameSync(temporary, filePath);
      }
      return normalized;
    };
    const queued = writeQueue.then(operation);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  return { load, hydrate, save, filePath };
}

module.exports = { createExecutiveFirewallPersistence };
