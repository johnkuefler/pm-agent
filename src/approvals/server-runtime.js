'use strict';

const { createTeammateApprovalRuntime } = require('./runtime');
const { registerTeammateApprovalRoutes } = require('../routes/teammate-approvals');

function registerTeammateApprovalRuntime({ app, requireAuth, teamworkTools, db, dataDirectory,
  databaseReady, writeThrough, resolveSlackIdentity, sendProposal, postMessage } = {}) {
  const readTask = teamworkTools.find(tool => tool.definition?.name === 'teamwork_get_task')?.execute;
  const updateTask = teamworkTools.find(tool => tool.definition?.name === 'teamwork_update_task')?.execute;
  if (!readTask || !updateTask) throw new Error('teammate approvals require Teamwork read and update tools');
  const runtime = createTeammateApprovalRuntime({ db, dataDirectory, databaseReady, writeThrough,
    readTask: taskId => readTask({ task_id: taskId }), updateTask,
    resolveSlackIdentity, sendProposal, postMessage,
  });
  registerTeammateApprovalRoutes(app, { requireAuth, runtime });
  return runtime;
}

module.exports = { registerTeammateApprovalRuntime };
