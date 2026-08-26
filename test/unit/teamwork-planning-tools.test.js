'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITE_TOOL_NAMES, createTeamworkPlanningTools } = require('../../src/integrations/teamwork-planning-tools');

function byName(tools, name) {
  return tools.find(tool => tool.definition.name === name);
}

test('Teamwork planning tools expose only the three narrow verified write capabilities', () => {
  assert.deepEqual([...WRITE_TOOL_NAMES], [
    'teamwork_create_project',
    'teamwork_create_tasklist',
    'teamwork_create_milestone',
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
