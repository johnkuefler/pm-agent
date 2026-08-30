'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskSlackSourceTool } = require('../../src/runtime/task-slack-source-tool');

test('scheduled task receives a read tool fixed to its recorded Slack source', async () => {
  const calls = [];
  const tool = createTaskSlackSourceTool({
    id: 'task-agenda', metadata: { slack_read_channel: 'C07NMUBDP1R' },
  }, async (channel, options) => { calls.push({ channel, options }); return { count: 1 }; });

  assert.equal(tool.definition.name, 'nora_read_task_slack_source');
  const result = await tool.execute({ since: '2026-08-19', limit: 50 });
  assert.deepEqual(calls, [{ channel: 'C07NMUBDP1R',
    options: { since: '2026-08-19', until: null, limit: 50 } }]);
  assert.equal(result.count, 1);
});

test('scheduled task gets no Slack read tool without a fixed source', () => {
  assert.equal(createTaskSlackSourceTool({ id: 'task-other' }, async () => ({})), null);
});
