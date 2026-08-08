'use strict';

const { createFleetSupervisor, STATE_KEY } = require('./supervisor');
const { createFleetSupervisorPersistence } = require('./persistence');
const { registerFleetSupervisorRoutes } = require('../routes/fleet-supervisor');

function registerFleetSupervisorRuntime({
  app,
  requireAuth,
  requireOperatorAuth,
  mcpManager,
  db,
  dataDirectory,
  databaseReady,
  writeThrough,
  intelligence,
  resolveOwner,
  postMessage,
} = {}) {
  const persistence = createFleetSupervisorPersistence({
    db, stateKey: STATE_KEY, dataDirectory, databaseReady, writeThrough,
  });
  const supervisor = createFleetSupervisor({
    mcpManager,
    loadState: persistence.load,
    saveState: persistence.save,
    getInterruptionBudget: () => intelligence.initiativeStatus('cowork:proactive'),
    spendInterruption: metadata => intelligence.spendInitiative('cowork:proactive', metadata),
    notifyHuman: async message => {
      const target = resolveOwner();
      return target ? postMessage(target, message) : false;
    },
  });
  registerFleetSupervisorRoutes(app, { requireAuth, requireOperatorAuth, supervisor });
  return supervisor;
}

module.exports = { registerFleetSupervisorRuntime };
