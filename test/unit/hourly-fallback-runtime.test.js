'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-hourly-fallback-'));
process.env.NORA_TEST_MODE = '1';
process.env.NORA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;
const { __test } = require('../../server');
const { readServerSource } = require('../helpers/server-source');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('scheduled recovery considers only explicit local tasks and missed direct Slack requests', () => {
  const source = __test.checkExplicitScheduledWork.toString();
  assert.match(source, /mode: 'explicit_work_only'/);
  assert.match(source, /Missed explicit Slack request check/);
  assert.doesNotMatch(source, /Teamwork|Gmail|teamworkLane|gmailLane|search_gmail_messages/);
});
test('explicit-work recovery remains scheduled without proactive connector sweeps', () => {
  const source = readServerSource();
  const recoveryStart = source.indexOf("scheduleRecurringRuntimeJob('operational-recovery-cycle'");
  const scheduler = source.slice(recoveryStart);
  assert.ok(recoveryStart >= 0);
  assert.match(scheduler, /await runHourlyFallbackRuntime\(\{ trigger \}\)/);
  assert.doesNotMatch(source, /Fallback Teamwork|Fallback Gmail|sync-from-teamwork/);
});

test('Slack provider readback repairs a lost local thread marker without duplicating a reply', () => {
  const parent = {
    ts: '1784781000.000100',
    reply_users: ['UOTHER', 'UNORA'],
  };
  assert.equal(__test.slackThreadHasNoraReply(parent, [], 'UNORA'), true);
  assert.equal(__test.slackThreadHasNoraReply({ ts: parent.ts }, [
    { ts: parent.ts, user: 'UREQUESTER' },
    { ts: '1784781001.000200', user: 'UNORA' },
  ], 'UNORA'), true);
  assert.equal(__test.slackThreadHasNoraReply({
    ts: '1784781005.000100', thread_ts: parent.ts, reply_users: ['UNORA'],
  }, [
    { ts: '1784781001.000200', user: 'UNORA' },
  ], 'UNORA'), false, 'an older Nora reply must not suppress a later mention in the thread');
  assert.equal(__test.slackThreadHasNoraReply({
    ts: '1784781005.000100', thread_ts: parent.ts, reply_users: ['UNORA'],
  }, [
    { ts: '1784781006.000200', user: 'UNORA' },
  ], 'UNORA'), true);
  assert.equal(__test.slackThreadHasNoraReply({ ts: parent.ts }, [
    { ts: '1784781001.000200', user: 'UOTHER' },
  ], 'UNORA'), false);
});

test('hourly recovery answers one verified missed Slack mention on a bounded guarded path', async () => {
  let captured;
  const result = await __test.recoverUnhandledSlackMention({
    channel: 'C-MISSED',
    is_private: false,
    ts: '1784781000.000100',
    thread_ts: null,
    user: 'U-REQUESTER',
    text: '<@UNORA> can you check the launch date?',
  }, {
    deadlineAt: Date.now() + 60000,
    prioritySnapshot: () => ({ active_interactions: 0, quiet_remaining_ms: 0 }),
    handle: async (...args) => {
      captured = args;
      return { status: 'replied' };
    },
  });
  assert.equal(result.status, 'replied');
  assert.equal(captured[0], 'C-MISSED');
  assert.equal(captured[2], 'can you check the launch date?');
  assert.equal(captured[3], '1784781000.000100');
  assert.equal(captured[5], undefined);
  assert.equal(captured[8].recoveryGuard, true);
  assert.ok(captured[8].terminalAt <= Date.now() + 30000);
});

test('hourly missed-mention recovery yields to a current live interaction', async () => {
  let handled = false;
  const result = await __test.recoverUnhandledSlackMention({
    channel: 'C-BUSY', ts: '1784781002.000100', user: 'U-REQUESTER',
    text: '<@UNORA> check this',
  }, {
    deadlineAt: Date.now() + 60000,
    prioritySnapshot: () => ({ active_interactions: 1, quiet_remaining_ms: 0 }),
    handle: async () => { handled = true; },
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'interactive_priority');
  assert.equal(handled, false);
});

test('native hourly tools cannot complete a task without a successful preceding action', async () => {
  const successful = new Set();
  const task = { id: 'task-safe', status: 'pending', action: 'Draft the update',
    source_channel: '', metadata: { destination_channel: 'C123' } };
  const toolset = __test.nativeHourlyTaskToolset(task, successful);
  assert.equal(toolset.tools.some(tool => tool.name === 'slack_send_message'), false,
    'the unattended runner must not receive an unconstrained Slack destination tool');
  assert.equal(toolset.tools.some(tool => tool.name === 'nora_deliver_task_result'), true);
  const result = await toolset.executors.nora_complete_local_task({ summary: 'done' });
  assert.match(result.error, /no successful external or delivery action/i);
});

test('native hourly task execution finishes one bounded task through an auditable tool chain', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const controller = new AbortController();
  const responses = [
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'work-1', name: 'perform_explicit_work', input: {} },
    ] },
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'complete-1', name: 'nora_complete_local_task',
        input: { summary: 'Delivered the requested result.' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Task completed with receipts.' }] },
  ];
  try {
    const result = await __test.runNativeHourlyTask({
      id: 'task-bounded', action: 'Perform the explicit work', status: 'pending',
    }, {
      deadlineAt: Date.now() + 60000,
      beginBackground: () => ({
        allowed: true, signal: controller.signal,
        wasPreempted: () => false, preemptedBy: () => null, release() {},
      }),
      toolsetFactory: (_task, successful) => ({
        tools: [{ name: 'perform_explicit_work' }, { name: 'nora_complete_local_task' }],
        executors: {
          perform_explicit_work: async () => {
            successful.add('perform_explicit_work');
            return { ok: true, receipt: 'work-receipt' };
          },
          nora_complete_local_task: async () => successful.size
            ? { ok: true } : { error: 'missing evidence' },
        },
        writeToolNames: ['perform_explicit_work', 'nora_complete_local_task'],
        meta: {},
      }),
      post: async () => ({ data: responses.shift() }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, true);
    assert.deepEqual(result.tools_executed,
      ['perform_explicit_work', 'nora_complete_local_task']);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('native task checkpoints back off one blocked item without starving the queue forever', async () => {
  const now = Date.parse('2026-07-23T04:00:00.000Z');
  const task = { id: 'task-retry', action: 'Use an unavailable connector',
    status: 'pending', assignee: 'Nora' };
  const first = await __test.recordNativeTaskAttempt(task, {
    status: 'degraded', completed: false, reason: 'connector unavailable',
    tools_executed: [],
  }, now);
  assert.equal(first.attempts, 1);
  assert.equal(first.next_retry_at, '2026-07-23T05:00:00.000Z');
  assert.equal(__test.nativeTaskReady(task, {
    [__test.nativeTaskAttemptKey(task.id)]: first,
  }, now + 30 * 60 * 1000), false);
  assert.equal(__test.nativeTaskReady(task, {
    [__test.nativeTaskAttemptKey(task.id)]: first,
  }, now + 60 * 60 * 1000), true);

  const completed = await __test.recordNativeTaskAttempt(task, {
    status: 'completed', completed: true, tools_executed: ['receipt'],
  }, now + 60 * 60 * 1000);
  assert.equal(completed.attempts, 0);
  assert.equal(completed.next_retry_at, null);
});

test('native task history separates verified outcomes from writes with unknown outcomes', () => {
  const history = __test.nativeTaskExecutionHistory('task-history', {
    executions: [
      {
        id: 'verified-write', surface: 'railway_hourly', interaction_ref: 'task-history',
        access_mode: 'write', status: 'succeeded', tool_name: 'draft_gmail_message',
        completed: '2026-07-23T04:00:00.000Z',
        audit: { complete_chain_verified: true },
      },
      {
        id: 'uncertain-write', surface: 'railway_hourly', interaction_ref: 'task-history',
        access_mode: 'write', status: 'selected', tool_name: 'nora_reply_to_task_origin',
        selected: '2026-07-23T04:01:00.000Z',
        audit: { complete_chain_verified: false },
      },
      {
        id: 'other-task', surface: 'railway_hourly', interaction_ref: 'task-other',
        access_mode: 'write', status: 'selected', tool_name: 'irrelevant',
      },
    ],
  });
  assert.deepEqual(history.succeeded_writes, [{
    execution_id: 'verified-write', tool_name: 'draft_gmail_message',
    completed: '2026-07-23T04:00:00.000Z',
  }]);
  assert.deepEqual(history.uncertain_writes, [{
    execution_id: 'uncertain-write', tool_name: 'nora_reply_to_task_origin',
    status: 'selected', selected: '2026-07-23T04:01:00.000Z',
  }]);
});
