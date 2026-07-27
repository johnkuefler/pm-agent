'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTeamworkClient } = require('../../src/integrations/teamwork-client');
const { createTeamworkTools } = require('../../src/integrations/teamwork-tools');

const EXPECTED_TOOL_ORDER = [
  'teamwork_find_projects',
  'teamwork_get_project',
  'teamwork_list_tasks',
  'teamwork_get_task',
  'teamwork_list_milestones',
  'teamwork_list_tasklists',
  'teamwork_list_people',
  'teamwork_get_task_comments',
  'teamwork_user_workload',
  'teamwork_team_capacity',
  'teamwork_create_task',
  'teamwork_update_task',
  'teamwork_complete_task',
  'teamwork_reopen_task',
  'teamwork_add_comment',
];

function toolByName(adapter, name) {
  const tool = adapter.TEAMWORK_TOOLS.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

test('Teamwork client reads live configuration and maps bounded authenticated requests', async () => {
  const calls = [];
  const httpClient = {
    async get(url, options) {
      calls.push({ kind: 'get', url, options });
      return { data: { ok: 'read' } };
    },
    async request(options) {
      calls.push({ kind: 'request', options });
      return { data: { ok: 'write' } };
    },
  };
  let config = {};
  const client = createTeamworkClient({ httpClient, getConfig: () => config });
  assert.equal(client.enabled(), false);

  config = { apiKey: 'test-key', baseUrl: 'https://teamwork.example' };
  assert.equal(client.enabled(), true);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await client.get('/projects/api/v3/projects.json', { signal, timeoutMs: 90000 }),
    { ok: 'read' },
  );
  assert.deepEqual(await client.send('post', '/tasks.json', { task: true }), { ok: 'write' });

  assert.deepEqual(calls[0], {
    kind: 'get',
    url: 'https://teamwork.example/projects/api/v3/projects.json',
    options: {
      headers: {
        Authorization: `Basic ${Buffer.from('test-key:').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
      signal,
    },
  });
  assert.equal(calls[1].kind, 'request');
  assert.equal(calls[1].options.method, 'post');
  assert.equal(calls[1].options.url, 'https://teamwork.example/tasks.json');
  assert.equal(calls[1].options.timeout, 15000);
  assert.deepEqual(calls[1].options.data, { task: true });
});

test('Teamwork client preserves provider failures for truthful connector handling', async () => {
  const providerFailure = new Error('provider unavailable');
  const client = createTeamworkClient({
    httpClient: {
      async get() { throw providerFailure; },
      async request() { throw providerFailure; },
    },
    getConfig: () => ({ apiKey: 'key', baseUrl: 'https://teamwork.example' }),
  });

  await assert.rejects(client.get('/failure'), (error) => error === providerFailure);
  await assert.rejects(
    client.send('put', '/failure', {}),
    (error) => error === providerFailure,
  );
});

test('Teamwork tools preserve schema order and keep write tools off realtime voice', () => {
  let enabled = false;
  const adapter = createTeamworkTools({
    client: {
      enabled: () => enabled,
      async get() { return {}; },
      async send() { return {}; },
    },
  });

  assert.deepEqual(
    adapter.TEAMWORK_TOOLS.map((tool) => tool.definition.name),
    EXPECTED_TOOL_ORDER,
  );
  assert.deepEqual([...adapter.TW_WRITE_NAMES], EXPECTED_TOOL_ORDER.slice(-5));
  assert.deepEqual(adapter.realtimeTeamworkTools(), []);

  enabled = true;
  const voiceTools = adapter.realtimeTeamworkTools();
  assert.deepEqual(voiceTools.map((tool) => tool.name), EXPECTED_TOOL_ORDER.slice(0, 10));
  for (const voiceTool of voiceTools) {
    const anthropicTool = toolByName(adapter, voiceTool.name).definition;
    assert.deepEqual(voiceTool, {
      type: 'function',
      name: anthropicTool.name,
      description: anthropicTool.description,
      parameters: anthropicTool.input_schema,
    });
  }
});

test('task listing retries without optional query parameters and filters provider noise locally', async () => {
  const calls = [];
  const request = { signal: new AbortController().signal, timeoutMs: 4321 };
  const included = {
    users: { 7: { firstName: 'Ada', lastName: 'Lovelace' } },
    tasklists: { 12: { name: 'Delivery', project: { id: 9 } } },
    projects: { 9: { name: 'Apollo' } },
  };
  const client = {
    enabled: () => true,
    async get(path, receivedRequest) {
      calls.push({ path, request: receivedRequest });
      if (calls.length === 1) throw new Error('optional filter unsupported');
      return {
        tasks: [
          {
            id: 1,
            name: 'Ship it',
            status: 'new',
            dueDate: '2026-08-01',
            assignees: [{ id: 7 }],
            tasklist: { id: 12 },
          },
          {
            id: 2,
            name: 'Wrong person',
            dueDate: '2026-08-01',
            assignees: [{ id: 8 }],
          },
          {
            id: 3,
            name: 'Wrong date',
            dueDate: '2026-08-02',
            assignees: [{ id: 7 }],
          },
          { id: 4, name: 'No date', assignees: [{ id: 7 }] },
        ],
        included,
      };
    },
    async send() { return {}; },
  };
  const adapter = createTeamworkTools({ client });
  const output = await toolByName(adapter, 'teamwork_list_tasks').execute({
    project_id: 'project/1',
    assigned_to_user_ids: ' 7 ',
    due_on: '2026-08-01',
  }, request);

  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /projectIds=project%2F1/);
  assert.match(calls[0].path, /responsiblePartyIds=7/);
  assert.match(calls[0].path, /dueAfter=2026-08-01/);
  assert.match(calls[0].path, /dueBefore=2026-08-01/);
  assert.doesNotMatch(calls[1].path, /responsiblePartyIds|dueAfter|dueBefore|orderBy/);
  assert.equal(calls[0].request, request);
  assert.equal(calls[1].request, request);
  assert.deepEqual(output, [{
    id: 1,
    name: 'Ship it',
    status: 'new',
    assignees: ['Ada Lovelace'],
    due: '2026-08-01',
    start: undefined,
    priority: undefined,
    progress: undefined,
    tasklist: 'Delivery',
    project: 'Apollo',
  }]);
});

test('Teamwork writes retain endpoint, payload, and provider receipt mapping', async () => {
  const sends = [];
  const adapter = createTeamworkTools({
    client: {
      enabled: () => true,
      async get() { return {}; },
      async send(method, path, body) {
        sends.push({ method, path, body });
        return { task: { id: 42 }, STATUS: 'CREATED' };
      },
    },
  });

  const output = await toolByName(adapter, 'teamwork_create_task').execute({
    tasklist_id: 'list/5',
    name: 'Prepare launch',
    assignee_ids: ['7', '8'],
    due_date: '2026-08-03',
    priority: 'high',
    description: 'Confirm the final checklist.',
  });

  assert.deepEqual(sends, [{
    method: 'post',
    path: '/tasklists/list%2F5/tasks.json',
    body: {
      'todo-item': {
        content: 'Prepare launch',
        'responsible-party-id': '7,8',
        'due-date': '20260803',
        priority: 'high',
        description: 'Confirm the final checklist.',
      },
    },
  }]);
  assert.deepEqual(output, { ok: true, task_id: 42, status: 'CREATED' });
});

test('capacity mapping excludes non-staff rows and ranks tracked availability', async () => {
  const adapter = createTeamworkTools({
    client: {
      enabled: () => true,
      async get() {
        return {
          included: {
            users: {
              1: { firstName: 'Most', lastName: 'Open', lengthOfDay: 8 },
              2: { firstName: 'Over', lastName: 'Booked', lengthOfDay: 8 },
              3: { firstName: 'No', lastName: 'Allocation', lengthOfDay: 8 },
              4: { firstName: 'Client', lastName: 'Contact', isClientUser: true },
              5: { firstName: 'Resource', lastName: 'Pool' },
            },
          },
          workload: {
            users: [
              { userId: 1, dates: { '2026-08-03': { capacityMinutes: 120 } } },
              { userId: 2, dates: { '2026-08-03': { capacityMinutes: 600 } } },
              { userId: 3, dates: { '2026-08-03': { capacityMinutes: 0 } } },
              { userId: 4, dates: { '2026-08-03': { capacityMinutes: 60 } } },
              { userId: 5, dates: { '2026-08-03': { capacityMinutes: 60 } } },
            ],
          },
        };
      },
      async send() { return {}; },
    },
  });

  const output = await adapter.teamworkTeamCapacity({
    start_date: '2026-08-03',
    end_date: '2026-08-03',
    min_free_hours: 2,
  });
  assert.equal(output.team_size, 3);
  assert.deepEqual(output.has_room.map((row) => row.user), ['Most Open']);
  assert.deepEqual(output.over_allocated, [{ user: 'Over Booked', bookedPct: 125 }]);
  assert.deepEqual(output.unallocated, ['No Allocation']);
});
