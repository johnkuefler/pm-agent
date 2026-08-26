'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITE_TOOL_NAMES, createTeamworkPlanningTools } = require('../../src/integrations/teamwork-planning-tools');

function byName(tools, name) {
  return tools.find(tool => tool.definition.name === name);
}

test('Teamwork planning tools expose only the narrow verified write capabilities', () => {
  assert.deepEqual([...WRITE_TOOL_NAMES], [
    'teamwork_create_project',
    'teamwork_create_tasklist',
    'teamwork_create_milestone',
    'teamwork_apply_project_plan',
  ]);
});

test('project creation posts to Teamwork and verifies the returned project by readback', async () => {
  const calls = [];
  const tools = createTeamworkPlanningTools({
    send: async (...args) => { calls.push(['send', ...args]); return { id: 41 }; },
    get: async path => { calls.push(['get', path]); return { project: { id: 41, name: 'Launch' } }; },
    ymd: value => String(value).replace(/-/g, ''),
  });
  const result = await byName(tools, 'teamwork_create_project').execute({
    name: 'Launch', description: 'Ship the launch plan', company_id: '9',
  });

  assert.equal(result.verified, true);
  assert.equal(result.project_id, '41');
  assert.deepEqual(calls[0], ['send', 'post', '/projects.json', {
    project: { name: 'Launch', description: 'Ship the launch plan', 'company-id': '9' },
  }]);
  assert.match(calls[1][1], /projects\/41\.json/);
});

test('task-list creation stays inside the resolved project and verifies its id', async () => {
  const calls = [];
  const tools = createTeamworkPlanningTools({
    send: async (...args) => { calls.push(['send', ...args]); return { TASKLISTID: '88' }; },
    get: async path => { calls.push(['get', path]); return { 'todo-list': { id: 88, name: 'Build' } }; },
    ymd: value => String(value).replace(/-/g, ''),
  });
  const result = await byName(tools, 'teamwork_create_tasklist').execute({
    project_id: '12', name: 'Build', milestone_id: '7',
  });

  assert.equal(result.verified, true);
  assert.deepEqual(calls[0], ['send', 'post', '/projects/12/tasklists.json', {
    'todo-list': { name: 'Build', 'milestone-id': '7' },
  }]);
  assert.equal(calls[1][1], '/tasklists/88.json');
});

test('milestone creation requires a real date and verifies the provider record', async () => {
  const calls = [];
  const tools = createTeamworkPlanningTools({
    send: async (...args) => { calls.push(['send', ...args]); return { milestoneid: 73 }; },
    get: async path => { calls.push(['get', path]); return { milestones: [{ id: 73, title: 'Go live' }] }; },
    ymd: value => String(value).replace(/-/g, ''),
  });
  const milestone = byName(tools, 'teamwork_create_milestone');
  const result = await milestone.execute({
    project_id: '12', title: 'Go live', deadline: '2026-09-30', responsible_person_id: '5',
  });

  assert.equal(result.verified, true);
  assert.equal(calls[0][3].milestone.deadline, '20260930');
  assert.equal(calls[0][3].milestone['responsible-party-ids'], '5');
  await assert.rejects(() => milestone.execute({
    project_id: '12', title: 'Go live', deadline: 'someday', responsible_person_id: '5',
  }), /deadline must be YYYY-MM-DD/);
});

test('one batch call applies and verifies a scheduled Teamwork project plan', async () => {
  const state = { milestones: [], tasklists: [], tasks: [] };
  const writes = [];
  let nextId = 100;
  const tools = createTeamworkPlanningTools({
    ymd: value => value ? String(value).replace(/[^0-9]/g, '').slice(0, 8) : undefined,
    get: async path => {
      if (/projects\/77\.json/.test(path)) return { project: { id: 77, name: 'Launch' } };
      if (/milestones\.json/.test(path)) return { milestones: state.milestones };
      if (/tasklists\.json/.test(path)) return { tasklists: state.tasklists };
      if (/tasks\.json/.test(path)) return { tasks: state.tasks };
      throw new Error(`unexpected GET ${path}`);
    },
    send: async (method, path, body) => {
      writes.push({ method, path, body });
      if (/milestones\.json/.test(path)) {
        state.milestones.push({ id: nextId++, name: body.milestone.title,
          deadline: `${body.milestone.deadline.slice(0, 4)}-${body.milestone.deadline.slice(4, 6)}-${body.milestone.deadline.slice(6)}` });
      } else if (/tasklists\.json/.test(path)) {
        state.tasklists.push({ id: nextId++, name: body['todo-list'].name,
          milestoneId: body['todo-list']['milestone-id'] });
      } else if (/\/tasks\.json/.test(path)) {
        const task = body.task;
        state.tasks.push({ id: nextId++, name: task.name, tasklistId: task.tasklistId,
          startDate: task.startAt, dueDate: task.dueAt, priority: task.priority,
          estimateMinutes: task.estimatedMinutes,
          assignees: (task.assignees?.userIds || []).map(id => ({ id })) });
      }
      return { id: nextId - 1, STATUS: 'OK' };
    },
  });
  const apply = byName(tools, 'teamwork_apply_project_plan');
  const plan = {
    project_id: '77',
    milestones: [{ title: 'Go live', deadline: '2026-10-01', responsible_person_id: '5' }],
    tasklists: [{ name: 'Build', milestone_title: 'Go live', tasks: [{
      name: 'Implement', assignee_ids: ['9'], start_date: '2026-09-01',
      due_date: '2026-09-15', priority: 'high', estimate_minutes: 960,
    }] }],
  };
  const first = await apply.execute(plan);

  assert.equal(first.status, 'complete');
  assert.equal(first.verified, true);
  assert.deepEqual(first.created, {
    milestones: ['Go live'], tasklists: ['Build'], tasks: ['Build: Implement'],
  });
  assert.equal(writes.length, 3);
  assert.match(writes[2].path, /projects\/api\/v3\/tasklists\/101\/tasks\.json/);
  assert.equal(writes[2].body.task.estimatedMinutes, 960);

  const second = await apply.execute(plan);
  assert.equal(second.status, 'complete');
  assert.equal(second.verified, true);
  assert.equal(writes.length, 3, 'an identical retry must not duplicate provider writes');
  assert.deepEqual(second.skipped, {
    milestones: ['Go live'], tasklists: ['Build'], tasks: ['Build: Implement'],
  });
});

test('batch plan refuses same-name task drift instead of overwriting or duplicating it', async () => {
  const writes = [];
  const tools = createTeamworkPlanningTools({
    ymd: value => value ? String(value).replace(/[^0-9]/g, '').slice(0, 8) : undefined,
    get: async path => {
      if (/projects\/77\.json/.test(path)) return { project: { id: 77 } };
      if (/milestones\.json/.test(path)) return { milestones: [] };
      if (/tasklists\.json/.test(path)) return { tasklists: [{ id: 8, name: 'Build' }] };
      if (/tasks\.json/.test(path)) return { tasks: [{ id: 9, tasklistId: 8,
        name: 'Implement', dueDate: '2026-09-20' }] };
      throw new Error(`unexpected GET ${path}`);
    },
    send: async (...args) => { writes.push(args); return { id: 10 }; },
  });
  const result = await byName(tools, 'teamwork_apply_project_plan').execute({
    project_id: '77', tasklists: [{ name: 'Build', tasks: [{
      name: 'Implement', due_date: '2026-09-15',
    }] }],
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.error, /No part/);
  assert.equal(result.failures[0].type, 'task_drift');
  assert.equal(writes.length, 0);
});
