'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskRoutes } = require('../../src/routes/registerTaskRoutes');

function harness(seed = [], overrides = {}) {
  const routes = new Map();
  let tasks = seed.map(item => ({ ...item }));
  const calls = { created: [], completed: [], deleted: [], deliveries: [] };
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    app[method] = (path, ...handlers) => routes.set(`${method}:${path}`, handlers.at(-1));
  }
  registerTaskRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    loadTasks: () => tasks,
    saveTasks: next => { tasks = next; },
    addTask: task => {
      tasks.push({ id: 'task-new', ...task, status: 'pending' });
      return 'task-new';
    },
    isTaskEligibleNow: () => true,
    isValidRecurrence: () => true,
    computeNextRun: () => null,
    onTaskCreated: task => calls.created.push(task),
    onTaskCompleted: (task, meta) => calls.completed.push({ task, meta }),
    onTaskDeleted: (task, meta) => calls.deleted.push({ task, meta }),
    deliverSlack: async (channel, text, threadTs) => {
      calls.deliveries.push({ channel, text, threadTs });
      return { ok: true, channel, ts: '1787769000.001' };
    },
    ...overrides,
  });
  return { routes, calls, getTasks: () => tasks };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('deleting a task invokes the lifecycle callback so its commitment can be dropped', () => {
  const task = { id: 'task-1', action: 'Build artifact', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  ctx.routes.get('delete:/tasks/:id')({ params: { id: task.id } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.getTasks(), []);
  assert.equal(ctx.calls.deleted.length, 1);
  assert.equal(ctx.calls.deleted[0].task.id, task.id);
  assert.match(ctx.calls.deleted[0].meta.deleted_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('completing a task invokes the lifecycle callback exactly once', () => {
  const task = { id: 'task-2', action: 'Build artifact', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  ctx.routes.get('patch:/tasks/:id/complete')(
    { params: { id: task.id }, body: { result: { status: 'review_ready' } } },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.getTasks()[0].status, 'done');
  assert.equal(ctx.calls.completed.length, 1);
  assert.equal(ctx.calls.completed[0].task.id, task.id);
  assert.equal(ctx.calls.completed[0].meta.recurring, false);
});

test('scheduled Slack delivery posts once through the bot and completes the task', async () => {
  const task = {
    id: 'task-deliver', action: 'Send status', assignee: 'Nora', status: 'pending',
    source_channel: 'slack:D123', source_thread_ts: '1787768000.001', metadata: null,
  };
  const ctx = harness([task]);
  const first = response();

  await ctx.routes.get('post:/tasks/:id/deliver')(
    { params: { id: task.id }, body: { text: 'Eight tasks are open.' } }, first,
  );

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.delivery.provider, 'slack_bot');
  assert.deepEqual(ctx.calls.deliveries, [{
    channel: 'D123', text: 'Eight tasks are open.', threadTs: '1787768000.001',
  }]);
  assert.equal(ctx.getTasks()[0].status, 'done');
  assert.equal(ctx.getTasks()[0].delivery.ts, '1787769000.001');
  assert.equal(ctx.calls.completed.length, 1);

  const retry = response();
  await ctx.routes.get('post:/tasks/:id/deliver')(
    { params: { id: task.id }, body: { text: 'Eight tasks are open.' } }, retry,
  );
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.already, true);
  assert.equal(ctx.calls.deliveries.length, 1, 'a retry must not post a second Slack message');
  assert.equal(ctx.calls.completed.length, 1, 'a retry must not complete the task twice');
});

test('fixed delivery destination overrides the Slack origin and cannot be redirected by the caller', async () => {
  const task = {
    id: 'task-fixed', action: 'Post summary', assignee: 'Nora', status: 'pending',
    source_channel: 'slack:DORIGIN', source_thread_ts: '1787768000.002',
    metadata: { destination_channel: 'CDESTINATION' },
  };
  const ctx = harness([task]);
  const res = response();

  await ctx.routes.get('post:/tasks/:id/deliver')(
    { params: { id: task.id }, body: {
      text: 'Verified summary.', channel: 'CATTACKER', thread_ts: 'redirect',
    } }, res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.calls.deliveries, [{
    channel: 'CDESTINATION', text: 'Verified summary.', threadTs: null,
  }]);
});

test('scheduled Slack delivery refuses a task without a recorded destination', async () => {
  const task = { id: 'task-no-slack', action: 'Prepare summary', assignee: 'Nora', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  await ctx.routes.get('post:/tasks/:id/deliver')(
    { params: { id: task.id }, body: { text: 'Summary.' } }, res,
  );

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no fixed Slack destination/i);
  assert.equal(ctx.calls.deliveries.length, 0);
  assert.equal(ctx.getTasks()[0].status, 'pending');
});
