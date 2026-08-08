'use strict';

const fs = require('fs');
const path = require('path');

function createFleetSupervisorPersistence({
  db,
  stateKey,
  dataDirectory,
  databaseReady = () => false,
  writeThrough = async (name, work) => work(),
} = {}) {
  if (!db || !stateKey || !dataDirectory) throw new Error('db, stateKey, and dataDirectory are required');
  const filePath = path.join(dataDirectory, 'nora-fleet-supervisor.json');

  async function load() {
    if (databaseReady()) return db.getState(stateKey);
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return null; }
  }

  async function save(state) {
    if (databaseReady()) {
      return writeThrough('fleet-supervisor', () => db.setState(stateKey, state), { strict: true });
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, filePath);
  }

  return { load, save, filePath };
}

module.exports = { createFleetSupervisorPersistence };
