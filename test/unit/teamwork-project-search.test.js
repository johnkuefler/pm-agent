'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectSearchTool } = require('../../src/integrations/teamwork-project-search');
const { buildTaskIntake } = require('../../src/surfaces/slack/task-intake');
const { createContextCollector } = require('../../src/surfaces/meeting/assistance-context');

const project = (id, name, company = 'LimeLight Marketing (LL)') => ({ id, name, status: 'active', company: { name } });
const page = (projects, hasMore = false) => ({ projects, meta: { page: { hasMore } } });
function fixture(responses, extra = {}) {
  const calls = [];
  const tool = createProjectSearchTool({ baseUrl: () => 'https://example.teamwork.com/',
    get: async (url, request) => {
      calls.push({ url, request });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }, ...extra });
  return { calls, tool };
}

test('full client name finds abbreviated project across pages and returns actual ranked choices', async () => {
  const f = fixture([page([]), page([project(2, 'BML - Agentic Website', 'Ball Morse Law'),
    project(3, 'LLM - Agentic Fleet Dev'), project(4, 'Other', 'Unrelated')], true),
  { ...page([project(1, 'LLM - Agentic Website - 1612756')]),
    included: { companies: { 42: { name: 'LimeLight Marketing (LL)' } } },
    projects: [{ ...project(1, 'LLM - Agentic Website - 1612756'), company: { id: 42 } }] }]);
  const r = await f.tool.execute({ query: 'LimeLight Agentic Website' });
  assert.equal(r.projects[0].id, 1);
  assert.equal(r.projects[0].company, 'LimeLight Marketing (LL)');
  assert.equal(r.projects[0].url, 'https://example.teamwork.com/app/projects/1');
  assert.equal(r.projects.length, 3);
  assert.equal(r.match_type, 'suggestions');
  assert.equal(r.requires_confirmation, true);
  assert.equal(r.search_complete, true);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].url, /searchTerm=LimeLight%20Agentic%20Website/);
  assert.match(f.calls[2].url, /page=2$/);
});

test('unique exact match is fast; duplicate exact names require a choice', async () => {
  for (const count of [1, 2]) {
    const f = fixture([page(Array.from({ length: count }, (_, i) => project(i + 1, 'Website Build')))]);
    const r = await f.tool.execute({ query: 'website-build' });
    assert.equal(r.match_type, 'exact');
    assert.equal(r.requires_confirmation, count > 1);
    assert.equal(f.calls.length, 1);
  }
});

test('fallback deduplicates and excludes non-active or unrelated projects', async () => {
  const p = project(1, 'LLM Website');
  const f = fixture([page([p]), page([p, { ...project(2, 'Website'), status: 'completed' },
    { ...project(3, 'Website'), status: 'archived' }, project(4, 'Random', 'Elsewhere')])]);
  const r = await f.tool.execute({ query: 'LimeLight Website' });
  assert.deepEqual(r.projects.map(p => p.id), [1]);
});

test('no plausible match does not invent candidates', async () => {
  const f = fixture([page([]), page([project(1, 'Random', 'Elsewhere')])]);
  const r = await f.tool.execute({ query: 'Acme Launch' });
  assert.deepEqual(r.projects, []);
  assert.equal(r.search_complete, true);
  assert.equal(r.requires_confirmation, true);
});

test('directory scan has a five-page cap and reports partial results', async () => {
  const f = fixture(Array.from({ length: 5 }, (_, i) => page([project(i, `Website ${i}`)], true)));
  const r = await f.tool.execute({});
  assert.equal(r.projects.length, 5);
  assert.equal(r.search_complete, false);
  assert.match(r.warning, /incomplete/);
  assert.equal(f.calls.length, 5);
});

test('provider failure retains suggestions but never reports an exhaustive no-match', async () => {
  const f = fixture([page([project(1, 'LLM Website')]), new Error('provider unavailable')]);
  const r = await f.tool.execute({ query: 'LimeLight Website' });
  assert.equal(r.projects.length, 1);
  assert.equal(r.search_complete, false);
  assert.match(r.warning, /unavailable/);
  const empty = await fixture([{}]).tool.execute({ query: 'website' });
  assert.equal(empty.search_complete, false);
});

test('one shared time budget bounds pagination and forwards caller cancellation', async () => {
  let time = 0;
  const calls = [];
  const signal = new AbortController().signal;
  const tool = createProjectSearchTool({ now: () => time, get: async (_url, request) => {
    calls.push(request); time += 3000; return page([project(1, 'Website')], true);
  } });
  const r = await tool.execute({}, { signal, timeoutMs: 5000 });
  assert.deepEqual(calls.map(c => c.timeoutMs), [5000, 2000]);
  assert.ok(calls.every(c => c.signal === signal));
  assert.equal(r.search_complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute({}, { signal: controller.signal }), /abort/i);
});

test('task intake saves numbered choices and groups remaining required fields', () => {
  const { prompt } = buildTaskIntake({ channel: 'C', user: 'U', loadMarkers: () => ({}) });
  assert.match(prompt, /numbered list/);
  assert.match(prompt, /Save the numbered choices and their IDs/);
  assert.match(prompt, /estimate, start date and due date in that SAME reply/);
  assert.match(prompt, /A suggestion is not permission/);
});

test('meeting context consumes structured search results and notes incomplete coverage', async () => {
  const collector = createContextCollector({ ownEmail: () => 'nora@example.com', slackToken: () => '',
    financialContent: () => false, teamworkTools: () => [
      { definition: { name: 'teamwork_find_projects' }, execute: async () => ({ projects: [
        { id: 1, name: 'Acme Launch', company: 'Acme' }], search_complete: false }) },
      ...['teamwork_list_tasks', 'teamwork_list_milestones'].map(name => ({ definition: { name }, execute: async () => [] })),
    ] });
  const r = await collector.collect({ title: 'Acme Launch', attendees: [{ email: 'sam@example.com' }] }, {});
  assert.equal(r.projects[0]?.id, 1);
  assert.ok(r.gaps.includes('Teamwork project search incomplete.'));
});
