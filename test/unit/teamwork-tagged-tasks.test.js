'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaggedTasksTool, taskTags } = require('../../src/integrations/teamwork-tagged-tasks');
const args = { tag_name: 'tentative', window_start: '2026-11-09', window_end: '2026-11-15' };
const row = (id, extra = {}) => ({ id, name: `Task ${id}`, status: 'new', tags: [{ id: 4 }],
  tasklist: { id: 20, meta: { projectId: 30 } }, assignees: [{ id: 7, type: 'users' }],
  startDate: '2026-11-11', dueDate: '2026-11-16', ...extra });
const included = { users: { 7: { firstName: 'Example', lastName: 'Person' } },
  tasklists: { 20: { name: 'Design', projectId: 30 } }, projects: { 30: { name: 'Website', status: 'active' } } };
function build(tasks, overrides = {}) {
  const calls = [];
  const tool = createTaggedTasksTool({ get: async path => {
    calls.push(path);
    if (overrides.get) return overrides.get(path);
    return path.includes('/tags.json')
      ? { tags: [{ id: 4, name: 'Tentative' }, { id: 5, name: 'Not tentative' }], meta: { page: { hasMore: false } } }
      : { tasks, included, meta: { page: { hasMore: false } } };
  } });
  return { run: input => tool.execute({ ...args, ...input }), calls };
}

test('matches real tag IDs and start OR due date inclusively, not name or due date alone', async () => {
  const h = build([row(1), row(2, { startDate: '2026-11-01', dueDate: '2026-11-09' }),
    row(3, { startDate: '2026-11-15', dueDate: null }),
    row(4, { startDate: '2026-11-16', dueDate: '2026-11-20' }),
    row(5, { name: 'Tentative fake match', tags: [{ id: 5 }] }),
    row(6, { status: 'completed' }), row(7, { deletedAt: '2026-11-10' }), row(8, { isArchived: true })]);
  const result = await h.run();
  assert.equal(result.complete, true); assert.deepEqual(result.tasks.map(t => t.id), [1, 2, 3]);
  assert.equal(result.tasks[0].project, 'Website'); assert.deepEqual(result.tasks[0].assignees, ['Example Person']);
  assert.match(h.calls[1], /tagIds=4&/); assert.doesNotMatch(h.calls[1], /dueAfter|startAfter/);
});

test('reads every tag and task page and resolves missing project status', async () => {
  const calls = [];
  const h = build([], { get: async path => {
    calls.push(path);
    if (path.includes('/tags.json')) return path.includes('page=1')
      ? { tags: [{ id: 1, name: 'other' }], meta: { page: { hasMore: true } } }
      : { tags: [{ id: 4, name: 'tentative' }], meta: { page: { hasMore: false } } };
    if (path.includes('/projects/30.json')) return { project: { name: 'Website', status: 'active' } };
    return { tasks: [row(path.includes('page=1') ? 1 : 2)],
      included: { users: included.users }, meta: { page: { hasMore: path.includes('page=1') } } };
  } });
  assert.equal((await h.run()).count, 2);
  assert.equal(calls.filter(p => p.includes('/projects/30.json')).length, 1);
});

test('inactive projects are excluded and completed tasks require explicit inclusion', async () => {
  assert.equal((await build([row(1, { status: 'completed' })]).run({ include_completed: true })).count, 1);
  const h = build([], { get: async path => path.includes('/tags.json') ? { tags: [{ id: 4, name: 'tentative' }] }
    : { tasks: [row(1)], included: { ...included, projects: { 30: { name: 'Archived', status: 'archived' } } } } });
  assert.equal((await h.run()).count, 0);
  assert.equal((await h.run({ active_projects_only: false })).count, 1);
});

test('missing tags, malformed pages and access errors do not become zero-task reports', async () => {
  for (const get of [async () => ({ tags: [] }), async () => ({}), async () => { throw new Error('403 Forbidden'); }]) {
    await assert.rejects(build([], { get }).run());
  }
  await assert.rejects(build([row(1, { tags: undefined })]).run(), /membership missing/);
  await assert.rejects(build([], { get: async path => path.includes('/tags.json')
    ? { tags: [{ id: 4, name: 'tentative' }], meta: { page: { hasMore: true } } } : {} }).run(), /page limit/);
});

test('valid empty result is complete; invalid dates and oversized results fail clearly', async () => {
  assert.deepEqual((await build([]).run()).tasks, []);
  await assert.rejects(build([]).run({ window_start: '2026-02-30' }), /valid/);
  await assert.rejects(build([]).run({ window_end: '2026-11-01' }), /end/);
  await assert.rejects(build([row(1, { name: 'x'.repeat(12000) })]).run(), /response budget/);
});

test('tag detail retains IDs and resolves both direct names and included names', () => {
  assert.deepEqual(taskTags({ tags: [{ id: 4 }], tagIds: [4, 5] }, { tags: { 4: { name: 'tentative' } } }),
    [{ id: 4, name: 'tentative' }, { id: 5, name: null }]);
  assert.deepEqual(taskTags({ tags: [{ id: 4, name: 'tentative' }] }), [{ id: 4, name: 'tentative' }]);
});
