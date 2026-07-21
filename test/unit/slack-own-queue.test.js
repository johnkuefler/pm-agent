'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-slack-queue-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test } = require('../../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('Slack can queue Nora-owned biweekly work without a Teamwork lookup', async () => {
  let stored;
  const tool = __test.buildNoraQueueTaskTool({
    channel: 'D123', threadTs: '1784638332.688619', user: 'UJOHN',
    now: () => new Date('2026-07-21T18:30:00.000Z'),
    add: task => { stored = task; return 'nora-test-task'; },
  });
  const result = await tool.execute({
    action: 'Finalize the agenda', detail: 'Use the established thread requirements.',
    destination_channel: 'C07PV5G7T2N', interval_weeks: 2, local_time: '09:00',
  });
  assert.equal(result.ok, true);
  assert.equal(result.recurrence, 'every:2:weeks:09:00');
  assert.equal(result.scheduled_for, '2026-08-04T14:00:00.000Z');
  assert.equal(stored.assignee, 'Nora');
  assert.equal(stored.source_channel, 'slack:D123');
  assert.equal(stored.source_thread_ts, '1784638332.688619');
  assert.match(stored.detail, /C07PV5G7T2N/);
});

test('tool loop executes an exact tool call only once', async () => {
  let calls = 0;
  const responses = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { query: 'agenda' } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'lookup', input: { query: 'agenda' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I used the first result.' }] },
  ];
  const result = await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'lookup' }] }, {}, {
    lookup: async () => { calls++; return { ok: true }; },
  }, 4, { post: async () => ({ data: responses.shift() }) });
  assert.equal(calls, 1);
  assert.equal(result.response.data.content[0].text, 'I used the first result.');
});

test('tool loop caps varied discovery calls by tool name', async () => {
  let calls = 0;
  const responses = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't4', name: 'find', input: { query: 'one' } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't5', name: 'find', input: { query: 'two' } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't6', name: 'find', input: { query: 'three' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I could not find a matching project.' }] },
  ];
  await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'find' }] }, {}, {
    find: async () => { calls++; return []; },
  }, 4, { toolCallLimits: { find: 2 }, post: async () => ({ data: responses.shift() }) });
  assert.equal(calls, 2);
});
