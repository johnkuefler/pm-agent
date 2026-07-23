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

test('tool loop actively bounds a stalled provider and returns a terminal fallback shape', async () => {
  const started = Date.now();
  const result = await __test.runClaudeToolLoop({ messages: [] }, {}, {}, 1, {
    deadlineMs: 15,
    providerTimeoutMs: 1000,
    post: async () => new Promise(() => {}),
  });
  assert.equal(result.response.data.stop_reason, 'interactive_deadline');
  assert.deepEqual(result.response.data.content, []);
  assert.ok(Date.now() - started < 250);
});

test('foreground priority aborts a background tool-loop provider request', async () => {
  const controller = new AbortController();
  const pending = __test.runClaudeToolLoop({ messages: [] }, {}, {}, 1, {
    deadlineMs: 5000,
    providerTimeoutMs: 4000,
    signal: controller.signal,
    post: async (_url, _body, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const reason = new Error('background intelligence preempted by slack');
  reason.code = 'background_preempted';
  controller.abort(reason);
  await assert.rejects(pending, error =>
    error.code === 'background_preempted' && /preempted by slack/.test(error.message));
});

test('durable background writes flush their selection receipt before the connector starts', async () => {
  let releaseSelection;
  let persistenceCalls = 0;
  let writeCalls = 0;
  const responses = [
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'durable-write-1', name: 'write_update', input: {} },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Updated.' }] },
  ];
  const pending = __test.runClaudeToolLoop(
    { messages: [], tools: [{ name: 'write_update' }] }, {}, {
      write_update: async () => { writeCalls += 1; return { ok: true }; },
    }, 2, {
      deadlineMs: 5000,
      providerTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      writeStartMinimumMs: 1000,
      writeToolNames: ['write_update'],
      durableWriteReceipts: true,
      persistActionReceipt: async () => {
        persistenceCalls += 1;
        if (persistenceCalls === 1) {
          await new Promise(resolve => { releaseSelection = resolve; });
        }
      },
      origin: { kind: 'railway_hourly', interaction_ref: 'task-write-ahead' },
      post: async () => ({ data: responses.shift() }),
    });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persistenceCalls, 1);
  assert.equal(writeCalls, 0, 'the remote side effect must wait for durable write-ahead state');
  releaseSelection();
  const result = await pending;
  assert.deepEqual(result.firedTools, ['write_update']);
  assert.equal(writeCalls, 1);
  assert.equal(persistenceCalls, 2, 'the successful outcome must also be durable');
});

test('a timed-out durable write remains uncertain so a restart cannot repeat it', async () => {
  const responses = [
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'uncertain-write-1', name: 'deliver_result', input: {} },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Could not verify the update.' }] },
  ];
  await __test.runClaudeToolLoop(
    { messages: [], tools: [{ name: 'deliver_result' }] }, {}, {
      deliver_result: async () => {
        const error = new Error('connector timed out after dispatch');
        error.code = 'ETIMEDOUT';
        throw error;
      },
    }, 2, {
      deadlineMs: 5000,
      providerTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      writeStartMinimumMs: 1000,
      writeToolNames: ['deliver_result'],
      durableWriteReceipts: true,
      persistActionReceipt: async () => {},
      origin: { kind: 'railway_hourly', interaction_ref: 'task-uncertain-write' },
      post: async () => ({ data: responses.shift() }),
    });
  const history = __test.nativeTaskExecutionHistory('task-uncertain-write');
  assert.equal(history.succeeded_writes.length, 0);
  assert.equal(history.uncertain_writes.length, 1);
  assert.equal(history.uncertain_writes[0].status, 'selected');
});

test('tool loop preserves completed tool evidence when a follow-up provider call times out', async () => {
  let calls = 0;
  const result = await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'lookup' }] }, {}, {
    lookup: async () => ({ found: true }),
  }, 2, {
    deadlineMs: 20,
    providerTimeoutMs: 1000,
    post: async () => {
      calls += 1;
      if (calls === 1) return { data: { stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'bounded-tool', name: 'lookup', input: {} }] } };
      return new Promise(() => {});
    },
  });
  assert.deepEqual(result.firedTools, ['lookup']);
  assert.equal(result.response.data.stop_reason, 'tool_use');
});

test('tool loop bounds a stalled read tool and preserves time for a final answer', async () => {
  let providerCalls = 0;
  const started = Date.now();
  const result = await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'slow_read' }] }, {}, {
    slow_read: async (_args, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }, 2, {
    // Leave enough wall-clock slack for this assertion to remain deterministic when the broader
    // suite is exercising persistence and projections in parallel.
    deadlineMs: 250,
    providerTimeoutMs: 60,
    toolTimeoutMs: 40,
    post: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? { data: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'slow', name: 'slow_read', input: {} }] } }
        : { data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The live lookup timed out, so I could not verify it.' }] } };
    },
  });
  assert.equal(providerCalls, 2);
  assert.deepEqual(result.firedTools, []);
  assert.equal(result.response.data.content[0].text, 'The live lookup timed out, so I could not verify it.');
  assert.ok(Date.now() - started < 500);
});

test('tool loop does not start a write without a safe completion window', async () => {
  let writes = 0;
  let providerCalls = 0;
  const result = await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'write_task' }] }, {}, {
    write_task: async () => { writes += 1; return { ok: true }; },
  }, 2, {
    deadlineMs: 40,
    providerTimeoutMs: 20,
    writeStartMinimumMs: 1000,
    writeToolNames: ['write_task'],
    post: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? { data: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'write_task', input: {} }] } }
        : { data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I did not start that change because the live window closed.' }] } };
    },
  });
  assert.equal(writes, 0);
  assert.deepEqual(result.firedTools, []);
  assert.equal(result.response.data.content[0].text, 'I did not start that change because the live window closed.');
});

test('tool loop does not report an executor error result as a completed tool', async () => {
  let providerCalls = 0;
  const result = await __test.runClaudeToolLoop({ messages: [], tools: [{ name: 'write_task' }] }, {}, {
    write_task: async () => ({ error: 'connector refused the write' }),
  }, 2, {
    deadlineMs: 5000,
    providerTimeoutMs: 1000,
    writeStartMinimumMs: 1000,
    writeToolNames: ['write_task'],
    post: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? { data: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'failed-write', name: 'write_task', input: {} }] } }
        : { data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The connector refused the change.' }] } };
    },
  });
  assert.deepEqual(result.firedTools, []);
});
