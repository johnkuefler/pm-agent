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
    source.indexOf("scheduleRecurringRuntimeJob('operational-and-intelligence-cycle'"),
    source.indexOf("scheduleRecurringRuntimeJob('stale-research-projection-refresh'"));
  assert.match(scheduler, /const trigger = runNumber === 1 \? 'startup' : 'five-minute-scheduler'/);
  assert.ok(scheduler.indexOf('await runHourlyFallbackRuntime({ trigger })')
    < scheduler.indexOf('await runBackgroundIntelligenceRuntime({'));
  assert.match(scheduler, /trigger, signal, budget: backgroundBudget/,
    'the optional lane must inherit the recurring owner cancellation and remaining deadline');
  assert.match(scheduler,
    /scheduleRecurringRuntimeJob\('operational-and-intelligence-cycle'[\s\S]*initialDelayMs: 20000/,
    'startup and periodic recovery must share one non-overlapping scheduler owner');
});

test('self-forecast commit briefly joins its existing replay preparation instead of forcing a retry', () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'intelligence.js'), 'utf8');
  const forecastRoute = routeSource.slice(
    routeSource.indexOf("app.post('/intelligence/cycles/:id/self-forecast'"),
    routeSource.indexOf("app.post('/intelligence/cycles/:id/self-forecast/revision'"));
  assert.match(forecastRoute,
    /await store\.waitForCycleSelfForecastRuntimePreparation\(\{ timeoutMs: 2500 \}\)/);
  assert.ok(forecastRoute.indexOf('waitForCycleSelfForecastRuntimePreparation')
    < forecastRoute.indexOf('store.preregisterCycleSelfForecast'),
  'the worker join must happen before the mutation attempts to consume the prepared replay');
});

test('coverage result counting handles MCP envelopes without retaining message content', () => {
  assert.equal(__test.coverageCollectionCount([{ id: 1 }, { id: 2 }]), 2);
  assert.equal(__test.coverageCollectionCount({ messages: [{ id: 1 }] }), 1);
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }) }],
  }), 2);
  assert.equal(__test.coverageCollectionCount({
    structuredContent: { messages: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    content: [{ type: 'text', text: 'Three matching messages.' }],
  }), 3, 'modern MCP structured content must outrank presentational text');
  assert.equal(__test.coverageCollectionCount({
    structuredContent: { response: { result: { messages: [{ id: 1 }] } } },
  }), 1, 'managed connector wrapper objects must remain countable');
  assert.equal(__test.coverageCollectionCount({
    structuredContent: {
      content: [{ type: 'text', text: 'Found 7 Gmail messages matching the search.' }],
    },
  }), 7, 'structured content blocks may carry an explicit prose cardinality');
  assert.equal(__test.coverageCollectionCount(
    '**Gmail search**\n\nTotal messages: 12\n\nResults omitted from this fixture.'), 12);
  assert.equal(__test.coverageCollectionCount(
    'Message dated 2026-07-23 with thread id 184992 was returned.'), null,
  'arbitrary numbers in message metadata must never become a result count');
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: 'No messages found.' }],
  }), 0, 'an explicit zero-result connector response is verified coverage, not an unknown count');
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: [
      'Message ID: `18ff-private-a`',
      'Thread ID: `18ff-thread-a`',
      'Subject: Private subject with the number 2026',
      '',
      '**Message_ID**: 18ff-private-b',
      'Thread_ID: 18ff-thread-b',
      '',
      'Message ID: `18ff-private-a`',
    ].join('\n') }],
  }), 2, 'formatted Gmail results count unique labeled message ids, never arbitrary metadata');
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: 'No Gmail emails were found for that query.' }],
  }), 0);
  assert.equal(__test.coverageCollectionCount({ total: 4 }), 4);
  assert.equal(__test.coverageCollectionCount('opaque connector response'), null);
  const safeShape = __test.coverageResultShape({
    structuredContent: { content: [{ type: 'text', text: 'private-subject-value' }] },
  });
  assert.deepEqual(safeShape.keys, ['structuredContent']);
  assert.equal(safeShape.wrappers.structuredContent.wrappers.content.length, 1);
  assert.doesNotMatch(JSON.stringify(safeShape), /private-subject-value/,
    'coverage diagnostics must expose structure only, never connector content');
});

test('Gmail coverage never labels an unrecognized connector result as fully checked', () => {
  const source = __test.fallbackOperationalSweep.toString();
  assert.match(source, /const unreadCount = coverageCollectionCount\(unread\)/);
  assert.match(source, /status: Number\.isFinite\(unreadCount\) \? 'checked' : 'partial'/);
  assert.match(source, /connector_result_shape_unrecognized/);
  assert.match(source, /response_shape: coverageResultShape\(unread\)/);
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

test('hourly recovery durably enqueues and processes one missed Slack mention', async () => {
  let enqueued;
  let processedEventId;
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
    enqueue: async (body, attestation, eventId) => {
      enqueued = { body, attestation, eventId };
      return { inserted: true, status: 'queued' };
    },
    process: async eventId => {
      processedEventId = eventId;
      return { state: 'processed', event_id: eventId };
    },
  });
  assert.equal(result.status, 'processed');
  assert.equal(enqueued.body.event.type, 'app_mention');
  assert.equal(enqueued.body.event.channel, 'C-MISSED');
  assert.equal(enqueued.body.event.text, '<@UNORA> can you check the launch date?');
  assert.equal(enqueued.body.event.ts, '1784781000.000100');
  assert.equal(enqueued.attestation.internal_durable_recovery, true);
  assert.equal(enqueued.attestation.kind, 'slack_web_api_missed_mention_recovery');
  assert.ok(enqueued.attestation.processing_budget_ms <= 30000);
  assert.equal(processedEventId, enqueued.eventId);
  assert.match(result.durable_event_id, /^slack-recovery-[a-f0-9]{64}$/);

  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'server.js'), 'utf8');
  const claimed = source.slice(
    source.indexOf('async function processClaimedSlackWebhook'),
    source.indexOf('async function processNextSlackWebhookInbox'),
  );
  assert.match(claimed, /internal_durable_recovery/);
  assert.match(claimed, /stage_result: async result/);
});

test('hourly missed-mention recovery yields to a current live interaction', async () => {
  let enqueued = false;
  const result = await __test.recoverUnhandledSlackMention({
    channel: 'C-BUSY', ts: '1784781002.000100', user: 'U-REQUESTER',
    text: '<@UNORA> check this',
  }, {
    deadlineAt: Date.now() + 60000,
    prioritySnapshot: () => ({ active_interactions: 1, quiet_remaining_ms: 0 }),
    enqueue: async () => { enqueued = true; },
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'interactive_priority');
  assert.equal(enqueued, false);
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

test('native hourly MCP wrappers do not count resolved failure envelopes as successful actions', async () => {
  const successful = new Set();
  const task = { id: 'task-false-mcp-success', status: 'pending',
    action: 'Perform the requested connector write' };
  const toolset = __test.nativeHourlyTaskToolset(task, successful, {
    mcpBindings: {
      claudeTools: [{ name: 'mcp_write' }],
      executors: {
        mcp_write: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'remote provider rejected the write' }],
        }),
      },
      meta: { mcp_write: { accessMode: 'write' } },
    },
  });

  const failed = await toolset.executors.mcp_write({});
  assert.equal(failed.isError, true);
  assert.equal(successful.size, 0);
  const completion = await toolset.executors.nora_complete_local_task({ summary: 'done' });
  assert.match(completion.error, /no successful external or delivery action/i);
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
