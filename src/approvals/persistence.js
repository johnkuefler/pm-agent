'use strict';

const fs = require('fs');
const path = require('path');
const actions = require('./teammate-actions');

function createTeammateApprovalPersistence({ db, stateKey = actions.STATE_KEY, dataDirectory,
  databaseReady = () => false, writeThrough } = {}) {
  const filePath = path.join(dataDirectory, 'nora-teammate-approvals.json');
  let cache = null;
  let writeQueue = Promise.resolve();

  function load() {
    if (cache) return actions.normalizeState(cache);
    try { cache = actions.normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { cache = actions.emptyState(); }
    return actions.normalizeState(cache);
  }

  async function hydrate() {
    if (databaseReady()) cache = actions.normalizeState(await db.getState(stateKey) || cache || actions.emptyState());
    else load();
    return actions.normalizeState(cache);
  }

  function save(value) {
    const normalized = actions.normalizeState(value); cache = normalized;
    const operation = async () => {
      if (databaseReady()) await writeThrough(stateKey,
        () => db.setState(stateKey, normalized), { strict: true });
      else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2));
        fs.renameSync(temporary, filePath);
      }
      return normalized;
    };
    const queued = writeQueue.then(operation); writeQueue = queued.catch(() => {}); return queued;
  }

  return { load, hydrate, save, filePath };
}

module.exports = { createTeammateApprovalPersistence };
