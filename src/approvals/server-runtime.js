'use strict';

const { createTeammateApprovalRuntime } = require('./runtime');
const { registerTeammateApprovalRoutes } = require('../routes/teammate-approvals');

function registerTeammateApprovalRuntime({ app, requireAuth, teamworkTools, db, dataDirectory,
  databaseReady, writeThrough, resolveSlackIdentity, sendProposal, postMessage,
  executiveFirewall } = {}) {
  const readTask = teamworkTools.find(tool => tool.definition?.name === 'teamwork_get_task')?.execute;
  const updateTask = teamworkTools.find(tool => tool.definition?.name === 'teamwork_update_task')?.execute;
  if (!readTask || !updateTask) throw new Error('teammate approvals require Teamwork read and update tools');
  const runtime = createTeammateApprovalRuntime({ db, dataDirectory, databaseReady, writeThrough,
    readTask: taskId => readTask({ task_id: taskId }), updateTask,
    resolveSlackIdentity, sendProposal, postMessage,
    onProposed: async proposal => {
      if (!proposal.case_id) return;
      await executiveFirewall.attempt(proposal.case_id, { actor: 'Nora',
        action: `Sent exact teammate proposal ${proposal.id}`, target: proposal.approver.name,
        channel: 'slack', result: 'Awaiting the named teammate decision.',
        next_action: `Wait for ${proposal.approver.name} to approve, reject, or defer the exact proposal.`,
        evidence: [{ type: 'teammate_proposal', ref: proposal.id }] });
    },
    onVerified: async proposal => {
      if (!proposal.case_id) return;
      await executiveFirewall.attempt(proposal.case_id, { actor: 'Nora',
        action: `Executed approved teammate proposal ${proposal.id}`,
        result: 'Teamwork was reread and every approved value matched.',
        evidence: [{ type: 'teammate_approval_execution', ref: proposal.id }] });
      await executiveFirewall.close(proposal.case_id, {
        outcome: `The exact Teamwork update in ${proposal.id} was approved and verified.`,
        evidence: [{ type: 'teammate_approval_execution', ref: proposal.id }] });
    },
    onInvalidated: async (proposal, reason) => {
      if (!proposal.case_id) return;
      await executiveFirewall.attempt(proposal.case_id, { actor: 'Nora',
        action: `Stopped stale teammate proposal ${proposal.id}`, result: reason,
        next_action: 'Reverify Teamwork before preparing any replacement proposal.',
        evidence: [{ type: 'teammate_proposal_invalidated', ref: proposal.id }] });
    },
  });
  registerTeammateApprovalRoutes(app, { requireAuth, runtime });
  return runtime;
}

module.exports = { registerTeammateApprovalRuntime };
