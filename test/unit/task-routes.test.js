'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskRoutes } = require('../../src/routes/registerTaskRoutes');

function harness(seed = []) {
  const routes = new Map();
  let tasks = seed.map(item => ({ ...item }));
  const calls = { created: [], completed: [], deleted: [] };
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
