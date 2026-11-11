'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubtaskMoveTools, MOVE_TOOL } = require('../../src/integrations/teamwork-subtask-move');
const { readServerSource } = require('../helpers/server-source');

function task(id, list = 10, parent = 0, status = 'new') {
  return { id, name: `Task ${id}`, description: 'Keep history', status, parentTaskId: parent,
    tasklist: { id: list, meta: { projectId: list * 10 } }, startDate: null, dueDate: null,
    estimateMinutes: 0, assignees: [{ id: 7, type: 'users' }], attachments: [{ id: 8 }],
    userPermissions: { canEdit: true, canAddSubtasks: true } };
}
function harness(seed = [task(1), task(2, 10, 1), task(3, 10, 0, 'completed'), task(90, 20)]) {
  const tasks = new Map(seed.map(t => [t.id, structuredClone(t)]));
  let markers = {}; const calls = [];
  const deps = {
    baseUrl: () => 'https://test.teamwork.com',
    mutateMarkers: async (fn, options) => {
      assert.equal(options.strict, true);
      const next = structuredClone(markers); const result = fn(next); markers = next; return { result };
    },
    get: async path => {
      if (path.includes('/tasklists/')) return { tasks: structuredClone([...tasks.values()].filter(t => t.tasklist.id === 10)), meta: { page: { hasMore: false } } };
      const id = Number(path.match(/tasks\/(\d+)/)?.[1]);
      return { task: structuredClone(tasks.get(id)) };
    },
    send: async (method, path, body) => {
      calls.push({ method, path, body }); const t = tasks.get(Number(path.match(/tasks\/(\d+)/)[1]));
      if (method === 'PUT') {
        t.tasklist = { id: body.tasklistId, meta: { projectId: body.projectId } };
        for (const child of tasks.values()) if (child.parentTaskId === t.id) child.tasklist = t.tasklist;
        t.parentTaskId = 0;
      } else t.parentTaskId = body.task.parentTaskId;
      return { ok: true };
    },
  };
  const build = overrides => createSubtaskMoveTools({ ...deps, ...overrides });
  const [preview, move] = build();
  const plan = (scope = 'open') => preview.execute({ source_tasklist_id: 10, parent_task_id: 90, scope });
  return { tasks, calls, deps, build, preview, move, plan, markers: () => markers };
}

test('preview clarifies completed scope without moving or requiring new estimates/dates', async () => {
  const h = harness(); const p = await h.plan('inspect');
  assert.equal(p.open, 2); assert.equal(p.completed, 1); assert.equal(p.plan_id, undefined);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.markers(), {});
});

test('moves existing root across projects then reparents, preserving children and fields', async () => {
  const h = harness(); const p = await h.plan();
  assert.equal(p.selected_roots, 1);
  const r = await h.move.execute({ plan_id: p.plan_id });
  assert.equal(r.verified, true); assert.deepEqual(r.moved, [1]);
  assert.deepEqual(h.calls.map(c => c.method), ['PUT', 'PATCH']);
  assert.deepEqual(h.calls[0].body, { taskId: 1, projectId: 200, tasklistId: 20 });
  assert.deepEqual(h.calls[1].body, { task: { parentTaskId: 90 }, taskOptions: { notify: false } });
  assert.equal(h.tasks.get(1).parentTaskId, 90);
  assert.equal(h.tasks.get(2).parentTaskId, 1); assert.equal(h.tasks.get(2).tasklist.id, 20);
  assert.equal(h.tasks.get(3).tasklist.id, 10, 'completed work was not selected');
  assert.deepEqual(await h.move.execute({ plan_id: p.plan_id }), r);
  assert.equal(h.calls.length, 2, 'replayed plan has no more writes');
});

test('explicit all scope includes completed tasks', async () => {
  const h = harness(); const p = await h.plan('all');
  const result = await h.move.execute({ plan_id: p.plan_id });
  assert.deepEqual(result.moved, [1, 3]); assert.equal(h.tasks.get(3).status, 'completed');
});

test('same-list moves patch only the parent; ancestor-selected descendants stay nested', async () => {
  const h = harness([task(1), task(2, 10, 1), task(3, 10, 2), task(90, 10)]);
  const p = await h.preview.execute({ task_ids: [1, 3], parent_task_id: 90, scope: 'all' });
  assert.equal(p.selected_roots, 1);
  assert.equal((await h.move.execute({ plan_id: p.plan_id })).verified, true);
  assert.deepEqual(h.calls.map(c => c.method), ['PATCH']); assert.equal(h.tasks.get(3).parentTaskId, 2);
});

test('self/descendant parents, repeating tasks and incomplete pagination fail before writes', async () => {
  const h = harness();
  await assert.rejects(h.preview.execute({ task_ids: [1], parent_task_id: 2, scope: 'all' }), /ancestor/);
  h.tasks.get(1).sequenceId = 50;
  await assert.rejects(h.plan(), /repeat/);
  const [preview] = h.build({ get: async path => path.includes('/tasklists/') ? {} : h.deps.get(path) });
  await assert.rejects(preview.execute({ source_tasklist_id: 10, parent_task_id: 90, scope: 'all' }), /Incomplete/);
  assert.equal(h.calls.length, 0);
});

test('paginates based on hasMore and never moves a partial lookup', async () => {
  const h = harness(); let pages = 0;
  const [preview] = h.build({ get: async path => path.includes('/tasklists/')
    ? { tasks: [task(++pages)], meta: { page: { hasMore: pages < 2 } } } : h.deps.get(path) });
  const p = await preview.execute({ source_tasklist_id: 10, parent_task_id: 90, scope: 'all' });
  assert.equal(p.selected_roots, 2); assert.equal(pages, 2);
  const [bad] = h.build({ get: async path => path.includes('/tasklists/')
    ? { tasks: [task(1)], meta: { page: { hasMore: true } } } : h.deps.get(path) });
  await assert.rejects(bad.execute({ source_tasklist_id: 10, parent_task_id: 90, scope: 'all' }), /page limit/);
});

test('revalidates a stale destination or task before writing', async () => {
  for (const mutate of [h => { h.tasks.get(90).tasklist.id = 30; }, h => { h.tasks.get(1).dueDate = '2026-12-01'; }]) {
    const h = harness(); const p = await h.plan(); mutate(h);
    const r = await h.move.execute({ plan_id: p.plan_id });
    assert.equal(r.verified, false); assert.equal(h.calls.length, 0); assert.equal(r.uncertain_task_id, null);
  }
});

test('stops on ambiguous write or readback, reports partial result, and blocks retry after restart', async () => {
  const h = harness(); const p = await h.plan('all');
  const [, failing] = h.build({ send: async (...args) => {
    await h.deps.send(...args);
    if (args[1].includes('/3/')) throw new Error('socket timeout');
  } });
  const r = await failing.execute({ plan_id: p.plan_id });
  assert.equal(r.verified, false); assert.deepEqual(r.moved, [1]); assert.equal(r.uncertain_task_id, 3);
  const [, restarted] = h.build();
  await assert.rejects(restarted.execute({ plan_id: p.plan_id }), /already started/);
  assert.equal(h.calls.length, 3);
});

test('storage failure refuses the operation before Teamwork is contacted', async () => {
  const h = harness(); const p = await h.plan();
  const [, move] = h.build({ mutateMarkers: async () => { throw new Error('database unavailable'); } });
  await assert.rejects(move.execute({ plan_id: p.plan_id }), /database/);
  assert.equal(h.calls.length, 0);
});

test('readback mismatch stops rather than claiming preservation or continuing the batch', async () => {
  const h = harness(); const p = await h.plan('all');
  const [, move] = h.build({ send: async (...args) => {
    await h.deps.send(...args); h.tasks.get(1).estimateMinutes = 999;
  } });
  const r = await move.execute({ plan_id: p.plan_id });
  assert.equal(r.verified, false); assert.equal(r.uncertain_task_id, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.tasks.get(3).tasklist.id, 10);
});

test('time limit returns explicit remaining IDs without starting more writes', async () => {
  const h = harness(); const p = await h.plan();
  const r = await h.move.execute({ plan_id: p.plan_id }, { timeoutMs: 100 });
  assert.equal(r.verified, false); assert.deepEqual(r.remaining, [1]);
  assert.equal(h.calls.length, 0); assert.match(r.message, /remain/);
});

test('Slack registers moves as writes and defers them through the existing worker', () => {
  const source = readServerSource();
  assert.match(source, /TW_WRITE_NAMES = new Set\([\s\S]*?SUBTASK_MOVE_TOOL/);
  assert.match(source, /if \(t.definition.name === SUBTASK_MOVE_TOOL\) mcpBindings.meta[\s\S]*?deferred: true, accessMode: 'write'/);
  assert.match(source, /job.connection_id === NATIVE_TEAMWORK_CONNECTION && job.tool_name === SUBTASK_MOVE_TOOL[\s\S]*?\.execute\(job.args/);
  assert.match(source, /\[SUBTASK_MOVE_TOOL\]: 1/);
  assert.equal(MOVE_TOOL, 'teamwork_move_tasks_under_parent');
});
