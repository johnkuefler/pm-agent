'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskRoutes } = require('../../src/routes/registerTaskRoutes');

function harness(seed = [], overrides = {}) {
  const routes = new Map();
  let tasks = seed.map(item => ({ ...item }));
  const calls = { created: [], completed: [], deleted: [], deliveries: [], slackReads: [] };
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
    readSlackSource: async (channel, options) => {
      calls.slackReads.push({ channel, options });
      return { channel_id: channel, channel_name: 'int-sales', count: 1,
        messages: [{ ts: '1', text: 'Acme moved to Closed Won' }] };
    },
    ...overrides,
  });
  return { routes, calls, getTasks: () => tasks };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
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

test('task creation records a fixed Slack destination and source thread', () => {
  const ctx = harness();
  const res = response();

  ctx.routes.get('post:/tasks')({ body: {
    action: 'Post the weekly report', destination_channel: 'C031HHSBM1Q',
    source_channel: 'slack:D123', source_thread_ts: '1787768000.001',
  } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.getTasks()[0].metadata.destination_channel, 'C031HHSBM1Q');
  assert.equal(ctx.getTasks()[0].source_thread_ts, '1787768000.001');
});

test('task update can safely repair or clear its fixed Slack destination', () => {
  const task = { id: 'task-repair', action: 'Post report', status: 'pending',
    metadata: { retained: true } };
  const ctx = harness([task]);
  const repaired = response();

  ctx.routes.get('put:/tasks/:id')({
    params: { id: task.id }, body: { destination_channel: 'C031HHSBM1Q' },
  }, repaired);
  assert.equal(repaired.statusCode, 200);
  assert.deepEqual(ctx.getTasks()[0].metadata,
    { retained: true, destination_channel: 'C031HHSBM1Q' });

  const cleared = response();
  ctx.routes.get('put:/tasks/:id')({
    params: { id: task.id }, body: { destination_channel: '' },
  }, cleared);
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(ctx.getTasks()[0].metadata, { retained: true });
});

test('task destination updates reject channel names and malformed ids', () => {
  const task = { id: 'task-bad-destination', action: 'Post report', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  ctx.routes.get('put:/tasks/:id')({
    params: { id: task.id }, body: { destination_channel: '#pm-team' },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Slack channel or DM ID/);
  assert.equal(ctx.getTasks()[0].metadata, undefined);
});

test('task update accepts the metadata destination shape used by scheduled runners', () => {
  const task = { id: 'task-metadata-repair', action: 'Post report', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  ctx.routes.get('put:/tasks/:id')({
    params: { id: task.id },
    body: { metadata: { destination_channel: 'C031HHSBM1Q' } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.getTasks()[0].metadata.destination_channel, 'C031HHSBM1Q');
});

test('task-scoped Slack source reads only the channel fixed on the task', async () => {
  const task = { id: 'task-agenda', action: 'Prepare agenda', status: 'pending',
    metadata: { slack_read_channel: 'C07NMUBDP1R' } };
  const ctx = harness([task]);
  const res = response();

  await ctx.routes.get('get:/tasks/:id/slack-source')({
    params: { id: task.id }, query: { since: '2026-08-19', limit: '100' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.channel_name, 'int-sales');
  assert.deepEqual(ctx.calls.slackReads, [{
    channel: 'C07NMUBDP1R',
    options: { since: '2026-08-19', until: null, limit: '100' },
  }]);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('task-scoped Slack source refuses tasks without an approved channel', async () => {
  const task = { id: 'task-no-source', action: 'Prepare agenda', status: 'pending' };
  const ctx = harness([task]);
  const res = response();

  await ctx.routes.get('get:/tasks/:id/slack-source')({
    params: { id: task.id }, query: { since: '2026-08-19' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /no fixed Slack read source/);
  assert.equal(ctx.calls.slackReads.length, 0);
});

test('task update records a validated Slack read source without changing its destination', () => {
  const task = { id: 'task-source-repair', action: 'Prepare agenda', status: 'pending',
    metadata: { destination_channel: 'C07PV5G7T2N' } };
  const ctx = harness([task]);
  const res = response();

  ctx.routes.get('put:/tasks/:id')({
    params: { id: task.id },
    body: { metadata: { slack_read_channel: 'C07NMUBDP1R' } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(ctx.getTasks()[0].metadata, {
    destination_channel: 'C07PV5G7T2N', slack_read_channel: 'C07NMUBDP1R',
  });
});
