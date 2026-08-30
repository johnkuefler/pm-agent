'use strict';

function createTaskSlackSourceTool(task, readSlackSource) {
  const channel = String(task?.metadata?.slack_read_channel || '').trim();
  if (!channel || typeof readSlackSource !== 'function') return null;
  return {
    definition: {
      name: 'nora_read_task_slack_source',
      description: `Read the exact Slack channel recorded as this task's source (${channel}). This is a bounded evidence read for the current queued task, not general Slack search.`,
      input_schema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Required lower date or timestamp bound.' },
          until: { type: 'string', description: 'Optional upper date or timestamp bound.' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['since'],
      },
    },
    execute: async input => readSlackSource(channel, {
      since: input?.since,
      until: input?.until || null,
      limit: input?.limit || 200,
    }),
  };
}

module.exports = { createTaskSlackSourceTool };
