'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerifiedTaskTool, validateTaskSchedule, resolveTaskRequester } = require('../../src/integrations/teamwork-task-request');
const { buildTaskIntake, taskDetailContinuation, pendingTaskDetails, taskRequestBindings } = require('../../src/surfaces/slack/task-intake');
const { createTeamworkPlanningTools } = require('../../src/integrations/teamwork-planning-tools');
const { readServerSource } = require('../helpers/server-source');

const args = { project_id: '10', tasklist_id: '20', name: 'Fix mobile nav', assignee_ids: ['30'],
  start_date: '2026-10-12', due_date: '2026-10-13', estimate_minutes: 120 };
const identity = { id: 'U1', name: 'Sam Smith', email: 'sam@example.test', fullMember: true };
function fixture() {
  const markers = {};
  const state = { writes: [], task: null, project: { id: 10, name: 'KCBR', status: 'active' },
    list: { id: 20, name: 'Build', projectId: 10, status: 'new', complete: false },
    people: [{ id: 30, firstName: 'Sam', lastName: 'Smith', email: 'sam@example.test' }] };
  const get = async path => {
    if (path.includes('/people.json')) return { people: state.people };
    if (path.includes('/projects/10.json')) return { project: state.project };
    if (path === '/tasklists/20.json') return { 'todo-list': state.list };
    if (path.includes('/tasks/40.json')) return { task: state.task };
    throw new Error('Unexpected read: ' + path);
  };
  const send = async (method, path, body) => {
    state.writes.push({ method, path, body });
    if (state.writeError) throw new Error(state.writeError);
    const t = body.task;
    state.task = { id: 40, name: t.name, tasklist: { id: t.tasklistId },
      assignees: t.assignees.userIds.map(id => ({ id, type: 'users' })),
      startDate: t.startAt, dueDate: t.dueAt, estimateMinutes: t.estimatedMinutes,
      ...state.readbackOverride };
    return { task: { id: 40 } };
  };
  const deps = { channel: 'C1', thread: 'T1', user: 'U1', identity, get, send,
    loadMarkers: () => markers, mutateMarkers: async fn => ({ result: fn(markers) }) };
  const intake = () => buildTaskIntake(deps);
  const tool = name => intake().tools.find(t => t.definition.name === name);
  return { state, markers, deps, get, send, intake, tool };
}

test('required schedule fields are enforced before any provider access', async () => {
  for (const field of ['start_date', 'due_date', 'estimate_minutes']) {
    const f = fixture();
    const incomplete = { ...args }; delete incomplete[field];
    await assert.rejects(f.tool('teamwork_create_task').execute(incomplete), /required/);
    assert.equal(f.state.writes.length, 0);
  }
  for (const invalid of [{ start_date: '2026-02-30' }, { due_date: 'tomorrow' },
    { due_date: '2026-10-11' }, { estimate_minutes: 0 }, { estimate_minutes: -1 },
    { estimate_minutes: 1.5 }, { estimate_minutes: '120' }]) {
    assert.throws(() => validateTaskSchedule({ ...args, ...invalid }));
  }
  assert.deepEqual(validateTaskSchedule({ ...args, due_date: args.start_date }),
    { start_date: args.start_date, due_date: args.start_date, estimate_minutes: 120 });
});

test('creation writes Teamwork v3 field names and verifies every required value', async () => {
  const f = fixture();
  const result = await f.tool('teamwork_create_task').execute(args);
  assert.equal(result.verified, true);
  assert.equal(result.task_id, '40');
  assert.equal(result.project, 'KCBR');
  assert.equal(result.tasklist, 'Build');
  assert.equal(result.estimate_minutes, 120);
  assert.deepEqual(f.state.writes[0].body.task, { tasklistId: 20, name: args.name,
    description: '', startAt: args.start_date, dueAt: args.due_date, estimatedMinutes: 120,
    assignees: { userIds: [30] } });
});

test('wrong project/list, archived project and completed list refuse creation', async () => {
  for (const change of [f => { f.state.list.projectId = 99; },
    f => { f.state.project.status = 'archived'; }, f => { f.state.list.complete = true; }]) {
    const f = fixture(); change(f);
    assert.match((await f.tool('teamwork_create_task').execute(args)).error, /destination/);
    assert.equal(f.state.writes.length, 0);
  }
});

test('readback drift returns the created ID without a success claim or duplicate on retry', async () => {
  for (const override of [{ startDate: null }, { dueDate: '2026-11-12' },
    { estimateMinutes: 0 }, { assignees: [] }, { tasklist: { id: 99 } }, { name: 'Different' }]) {
    const f = fixture(); f.state.readbackOverride = override;
    const result = await f.tool('teamwork_create_task').execute(args);
    assert.match(result.error, /readback differs/);
    assert.equal(result.task_id, '40');
    await f.tool('teamwork_create_task').execute(args);
    assert.equal(f.state.writes.length, 1);
  }
});

test('creation receipts survive a new intake instance and reject changed retry fields', async () => {
  const f = fixture();
  await f.tool('teamwork_create_task').execute(args);
  const retry = await f.tool('teamwork_create_task').execute(args);
  assert.equal(retry.already_created, true);
  assert.equal(retry.verified, true);
  assert.match((await f.tool('teamwork_create_task').execute({ ...args, estimate_minutes: 60 })).error, /different fields/);
  assert.equal(f.state.writes.length, 1);
});

test('ambiguous network outcome cannot issue a second create', async () => {
  const f = fixture(); f.state.writeError = 'Network timeout';
  await assert.rejects(f.tool('teamwork_create_task').execute(args), /timeout/);
  assert.match((await f.tool('teamwork_create_task').execute(args)).error, /uncertain/);
  assert.equal(f.state.writes.length, 1);
});

test('failed durable claim prevents the external write', async () => {
  const f = fixture();
  f.deps.mutateMarkers = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.tool('teamwork_create_task').execute(args), /storage unavailable/);
  assert.equal(f.state.writes.length, 0);
});

test('for me resolves exact email, falls back to unique full name, never a fuzzy first name', async () => {
  const f = fixture();
  f.state.people.push({ id: 31, firstName: 'Sam', lastName: 'Smith', email: 'other@example.test' });
  assert.equal((await resolveTaskRequester(f.get, identity)).person_id, '30');
  assert.match((await resolveTaskRequester(f.get, { ...identity, email: null })).error, /ambiguous/);
  f.state.people.pop();
  assert.equal((await resolveTaskRequester(f.get, { ...identity, email: null })).person_id, '30');
  assert.ok((await resolveTaskRequester(f.get, { ...identity, email: null, name: 'Sam' })).error);
  assert.ok((await resolveTaskRequester(f.get, { ...identity, isBot: true })).error);
  const { assignee_ids, ...self } = args;
  assert.equal((await f.tool('teamwork_create_task').execute(self)).verified, true);
});

test('saved clarification survives restart and accepts short owner replies only', async () => {
  const f = fixture();
  await f.tool('nora_task_details').execute({ action: 'ask', draft: 'Fix mobile nav, KCBR build, estimate missing', question: 'Estimate, start and due date?' });
  assert.match(f.intake().prompt, /estimate missing/);
  const event = { type: 'message', channel: 'C1', thread_ts: 'T1', user: 'U1' };
  for (const text of ['yes', '2h', 'Friday', 'the second one', 'cancel']) {
    assert.equal(taskDetailContinuation({ ...event, text }, f.markers, 'UBOT'), true);
  }
  for (const override of [{ user: 'U2' }, { channel: 'C2' }, { thread_ts: 'T2' },
    { subtype: 'message_changed' }, { bot_id: 'B1' }, { text: '<@UBOT> yes' }]) {
    assert.equal(taskDetailContinuation({ ...event, text: 'yes', ...override }, f.markers, 'UBOT'), false);
  }
  assert.equal(pendingTaskDetails(f.markers, 'C1', 'T1', 'U1', Date.now() + 8 * 86400000), null);
  await f.tool('nora_task_details').execute({ action: 'cancel' });
  assert.equal(taskDetailContinuation(event, f.markers, 'UBOT'), false);
});

test('verified completion closes only the requesting persons pending draft', async () => {
  const f = fixture();
  await f.tool('nora_task_details').execute({ action: 'ask', draft: 'Fix nav', question: 'When?' });
  f.markers['task-intake:C1:T1:U2'] = { status: 'pending', expires_at: new Date(Date.now() + 86400000).toISOString() };
  await f.tool('teamwork_create_task').execute(args);
  assert.equal(pendingTaskDetails(f.markers, 'C1', 'T1', 'U1'), null);
  assert.ok(pendingTaskDetails(f.markers, 'C1', 'T1', 'U2'));
});

test('intake wiring bypasses both follow-up gates and keeps receipt-aware creation', () => {
  const source = readServerSource();
  assert.match(source, /if \(taskDetailContinuation\(event, loadMarkers\(\), noraBotUserId\)\) return true/);
  assert.match(source, /!isDM && !isMention && !taskDetailContinuation/);
  assert.match(source, /toolExecutors\[t.definition.name\] = t.execute/);
  assert.match(source, /thread: isDM \? null : threadTs/);
});

test('batch plan cannot bypass required task schedule fields', async () => {
  let touchedProvider = false;
  const tool = createTeamworkPlanningTools({ get: async () => { touchedProvider = true; },
    send: async () => { touchedProvider = true; }, ymd: s => s?.replace(/-/g, '') })
    .find(t => t.definition.name === 'teamwork_apply_project_plan');
  for (const field of ['estimate_minutes', 'start_date', 'due_date']) {
    const task = { ...args }; delete task[field];
    await assert.rejects(tool.execute({ project_id: '10', tasklists: [{ name: 'Build', tasks: [task] }] }), /required/);
  }
  assert.equal(touchedProvider, false);
});

test('alternate Teamwork creates are removed without changing other connector tools', () => {
  const inventory = [
    { name: 'mcp1', connection: 'Teamwork', tool: 'twprojects-create_task' },
    { name: 'mcp2', connection: 'Teamwork', tool: 'twprojects-create_tasks' },
    { name: 'mcp3', connection: 'Teamwork', tool: 'twprojects-list_tasks' },
    { name: 'mcp4', connection: 'Other', tool: 'create_task' },
  ];
  const bindings = { inventory, claudeTools: inventory.map(t => ({ name: t.name })),
    executors: Object.fromEntries(inventory.map(t => [t.name, () => {}])),
    meta: Object.fromEntries(inventory.map(t => [t.name, { toolName: t.tool }])) };
  const result = taskRequestBindings(bindings);
  assert.deepEqual(result.claudeTools.map(t => t.name), ['mcp3', 'mcp4']);
  assert.deepEqual(Object.keys(result.executors), ['mcp3', 'mcp4']);
  assert.deepEqual(Object.keys(result.meta), ['mcp3', 'mcp4']);
  assert.equal(bindings.inventory.length, 4);
});
