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
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('fallback forecast retries spend one shared runtime deadline', async () => {
  const requestTimeouts = [];
  const waits = [];
  const retryable = Object.assign(new Error('projection is still preparing'), {
    code: 'SELF_FORECAST_PREPARATION_PENDING',
  });
  await assert.rejects(__test.commitFallbackForecast('cycle-bounded', {}, {
    attempts: 3,
    deadlineAt: Date.now() + 13500,
    request: async (_method, _route, _payload, timeoutMs) => {
      requestTimeouts.push(timeoutMs);
      throw retryable;
    },
    wait: async milliseconds => { waits.push(milliseconds); },
  }), error => error === retryable);
  assert.equal(requestTimeouts.length, 3);
  assert.ok(requestTimeouts.every(timeout => timeout > 0 && timeout <= 1500),
    'each retry must receive only the wall-clock budget left before the cleanup reserve');
  assert.deepEqual(waits, [1000, 1000]);
});

test('fallback forecast never starts after its runtime deadline is exhausted', async () => {
  let requests = 0;
  await assert.rejects(__test.commitFallbackForecast('cycle-expired', {}, {
    deadlineAt: Date.now() - 1,
    request: async () => { requests += 1; },
  }), error => error.code === 'hourly_fallback_deadline_exceeded');
  assert.equal(requests, 0);
});

test('hourly coverage connector reads propagate cancellation and remaining budgets', () => {
  const source = __test.fallbackOperationalSweep.toString();
  assert.match(source, /signal => peopleTool\.execute/);
  assert.match(source, /\{ signal, timeoutMs: identityBudgetMs \}/);
  assert.match(source, /signal => tasksTool\.execute/);
  assert.match(source, /\{ signal, timeoutMs: taskBudgetMs \}/);
  assert.match(source, /Promise\.all\(\[teamworkLane\(\), slackLane\(\), gmailLane\(\)\]\)/,
    'independent connector scans must run concurrently');
  assert.match(source, /Fallback Slack missed-mention sweep/);
  assert.match(source, /Fallback Gmail unread sweep/);
  assert.match(source, /signal => binding\.execute\(args, \{ signal, timeoutMs: gmailBudgetMs \}\)/);
});

test('operational recovery is scheduled before optional background intelligence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const scheduler = source.slice(
    source.indexOf('// Operational recovery always gets the first bounded window.'),
    source.indexOf('}, 5 * 60 * 1000));',
      source.indexOf('// Operational recovery always gets the first bounded window.')));
  assert.ok(scheduler.indexOf("runHourlyFallbackRuntime({ trigger: 'five-minute-scheduler' })")
    < scheduler.indexOf("runBackgroundIntelligenceRuntime({ trigger: 'five-minute-scheduler' })"));
  const startup = source.slice(
    source.indexOf("scheduleStartupBackgroundTask('startup operational recovery then intelligence'"),
    source.indexOf('_runtimeIntervals.push(setInterval', source.indexOf(
      "scheduleStartupBackgroundTask('startup operational recovery then intelligence'")));
  assert.ok(startup.indexOf("runHourlyFallbackRuntime({ trigger: 'startup' })")
    < startup.indexOf("runBackgroundIntelligenceRuntime({ trigger: 'startup' })"));
});

test('coverage result counting handles MCP envelopes without retaining message content', () => {
  assert.equal(__test.coverageCollectionCount([{ id: 1 }, { id: 2 }]), 2);
  assert.equal(__test.coverageCollectionCount({ messages: [{ id: 1 }] }), 1);
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }) }],
  }), 2);
  assert.equal(__test.coverageCollectionCount({ total: 4 }), 4);
  assert.equal(__test.coverageCollectionCount('opaque connector response'), null);
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
  assert.equal(captured[5], 'normal');
  assert.equal(captured[9].recoveryGuard, true);
  assert.ok(captured[9].terminalAt <= Date.now() + 30000);
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

test('Gmail coverage adapts to the connected tool schema and fails closed on unknown requirements', () => {
  assert.deepEqual(__test.gmailCoverageSearchArgs({
    properties: {
      user_google_email: { type: 'string' },
      query: { type: 'string' },
      page_size: { type: 'integer' },
    },
    required: ['user_google_email', 'query'],
  }, 'is:unread', 'nora@example.com'), {
    query: 'is:unread', page_size: 25, user_google_email: 'nora@example.com',
  });
  assert.throws(() => __test.gmailCoverageSearchArgs({
    properties: { account_id: { type: 'string' } },
    required: ['account_id'],
  }, 'is:unread', 'nora@example.com'), error =>
    error.code === 'gmail_coverage_schema_unresolved');
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
    experimental_access_sealed: false,
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
  assert.equal(__test.nativeTaskExecutionHistory('task-history', {
    experimental_access_sealed: true,
  }).available, false);
});
