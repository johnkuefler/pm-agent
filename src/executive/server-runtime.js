'use strict';

const { createExecutiveFirewallRuntime } = require('./runtime');
const { registerFleetSupervisorRuntime } = require('../fleet/runtime');
const { handleExecutiveDecisionReply } = require('./slack-decision');
const { createExecutiveFirewallTools } = require('./tools');

function registerExecutiveOperationsRuntime({ app, requireAuth, requireOperatorAuth, mcpManager,
  db, dataDirectory, databaseReady, writeThrough, intelligence, resolveOwner, postMessage,
  loadProjectControl } = {}) {
  let fleetSupervisor;
  const executiveFirewall = createExecutiveFirewallRuntime({ db, dataDirectory, databaseReady,
    writeThrough, intelligence, resolveOwner, postMessage, loadProjectControl,
    loadFleetSupervisor: () => fleetSupervisor.snapshot() });
  executiveFirewall.register(app, { requireAuth, requireOperatorAuth });
  fleetSupervisor = registerFleetSupervisorRuntime({ app, requireAuth, requireOperatorAuth,
    mcpManager, db, dataDirectory, databaseReady, writeThrough, intelligence, resolveOwner,
    postMessage, handoffCandidates: executiveFirewall.ingestFleetCandidates });
  return { executiveFirewall, fleetSupervisor };
}

module.exports = { registerExecutiveOperationsRuntime, handleExecutiveDecisionReply,
  createExecutiveFirewallTools };
