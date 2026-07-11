const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-api-'));
Object.assign(process.env, {
  NORA_DATA_DIR: dataDir,
  NORA_TEST_MODE: '1',
  NORA_API_KEY: 'integration-key',
  DASHBOARD_PASSWORD: 'integration-password',
  DATABASE_URL: '',
});

const seed = {
  'nora-memory.json': '[]',
  'nora-tasks.json': '[]',
  'nora-projects.json': '[]',
  'nora-markers.json': '{}',
  'nora-dreams.json': '[]',
  'nora-interactions.json': '[]',
  'nora-routine.md': '# Routine\nInitial routine',
  'nora-charter.md': '# Charter\nInitial charter',
  'transcript-test-bot.json': JSON.stringify({
    bot_id: 'test-bot',
    ended: '2026-07-10T18:00:00.000Z',
    transcript: [{ speaker: 'Alex', text: 'Original line' }, { speaker: 'Nora', text: 'Second line' }],
  }),
};
for (const [name, contents] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name), contents);

const runtime = require('../../server');
let base;

test.before(async () => {
  const server = await runtime.start({ port: 0, background: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(url, options = {}) {
  const headers = { Authorization: 'Bearer integration-key', ...options.headers };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(base + url, { ...options, headers });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { response, body };
}

test('authentication protects APIs and dashboard independently', async () => {
  const api = await fetch(base + '/memory');
  assert.equal(api.status, 401);
  assert.equal((await fetch(base + '/memory?key=integration-key')).status, 200);

  const dashboard = await fetch(base + '/');
  assert.equal(dashboard.status, 401);
  assert.match(dashboard.headers.get('www-authenticate'), /Basic/);

  const auth = Buffer.from('nora:integration-password').toString('base64');
  const permitted = await fetch(base + '/', { headers: { Authorization: `Basic ${auth}` } });
  assert.equal(permitted.status, 200);
  assert.match(await permitted.text(), /integration-key/);

  const css = await fetch(base + '/assets/dashboard.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(base + '/assets/js/dashboard-core.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('memory supports create, update, list, bulk delete, and JSON persistence', async () => {
  const created = await request('/memory', { method: 'POST', body: { fact: 'Integration fact', source: 'test' } });
  assert.equal(created.response.status, 200);
  assert.match(created.body.id, /^m-/);

  const updated = await request(`/memory/${created.body.id}`, { method: 'PUT', body: { fact: 'Updated fact' } });
  assert.equal(updated.body.memory.fact, 'Updated fact');

  const listed = await request('/memory');
  assert.equal(listed.body.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'nora-memory.json')))[0].fact, 'Updated fact');

  const stats = await request('/memory/embedding-stats');
  assert.deepEqual(stats.body, { db: false, total: 1, embedded: 0, model: null });

  const removed = await request('/memory/bulk-delete', { method: 'POST', body: { ids: [created.body.id] } });
  assert.equal(removed.body.removed_count, 1);
});

test('tasks preserve validation, scheduling, filtering, completion, and deletion behavior', async () => {
  const invalid = await request('/tasks', { method: 'POST', body: { action: 'Bad', recurrence: 'sometimes' } });
  assert.equal(invalid.response.status, 400);

  const future = await request('/tasks', { method: 'POST', body: { action: 'Future', scheduled_for: '2099-01-01T00:00:00.000Z' } });
  const now = await request('/tasks?status=pending');
  assert.equal(now.body.some(task => task.id === future.body.id), false);
  const all = await request('/tasks?status=pending&include=all');
  assert.equal(all.body.some(task => task.id === future.body.id), true);

  const edit = await request(`/tasks/${future.body.id}`, { method: 'PUT', body: { action: 'Edited future task' } });
  assert.equal(edit.body.task.action, 'Edited future task');
  const complete = await request(`/tasks/${future.body.id}/complete`, { method: 'PATCH' });
  assert.equal(complete.body.task.status, 'done');
  assert.equal((await request(`/tasks/${future.body.id}`, { method: 'DELETE' })).body.ok, true);

  const recurring = await request('/tasks', { method: 'POST', body: { action: 'Daily check', recurrence: 'daily:09:00' } });
  const rolled = await request(`/tasks/${recurring.body.id}/complete`, { method: 'PATCH' });
  assert.equal(rolled.body.task.status, 'pending');
  assert.ok(rolled.body.rolled_to);
  await request(`/tasks/${recurring.body.id}`, { method: 'DELETE' });
});

test('projects support create, duplicate protection, coverage, update, detail, and deletion', async () => {
  const created = await request('/projects', {
    method: 'POST',
    body: { name: 'Launch Site', client: 'Acme', status: 'active', pm: 'Taylor', tags: ['web'] },
  });
  assert.equal(created.body.project.client, 'Acme');
  assert.equal((await request('/projects', { method: 'POST', body: { name: 'launch site' } })).response.status, 409);

  const coverage = await request('/projects/coverage?include_internal=true');
  assert.equal(coverage.body.projects[0].name, 'Launch Site');
  assert.equal(coverage.body.projects[0].has_pm, true);

  const updated = await request('/projects/Launch%20Site', { method: 'PUT', body: { phase: 'build', details: 'In progress' } });
  assert.equal(updated.body.project.phase, 'build');
  const detail = await request('/projects/launch%20site');
  assert.equal(detail.body.details, 'In progress');
  assert.equal((await request('/projects/Launch%20Site', { method: 'DELETE' })).body.ok, true);
});

test('markers support exact checks, bulk updates, prefix filters, and deletion', async () => {
  assert.equal((await request('/markers', { method: 'POST', body: { key: 'filed:a', data: { source: 'test' } } })).body.ok, true);
  assert.equal((await request('/markers/bulk', { method: 'POST', body: { markers: { 'filed:b': {}, 'other:c': {} } } })).body.count, 2);
  const filtered = await request('/markers?prefix=filed:');
  assert.equal(filtered.body.count, 2);
  assert.equal((await request('/markers/filed%3Aa')).body.exists, true);
  assert.equal((await request('/markers/filed%3Aa', { method: 'DELETE' })).body.existed, true);
});

test('run lock enforces holder ownership', async () => {
  assert.equal((await request('/run-lock', { method: 'POST', body: { holder: 'one', ttl_seconds: 60 } })).body.acquired, true);
  assert.equal((await request('/run-lock', { method: 'POST', body: { holder: 'two', ttl_seconds: 60 } })).body.acquired, false);
  assert.equal((await request('/run-lock?holder=two', { method: 'DELETE' })).body.released, false);
  assert.equal((await request('/run-lock?holder=one', { method: 'DELETE' })).body.released, true);
});

test('routine and charter reads and writes remain file-backed without Postgres', async () => {
  assert.match((await request('/routine')).body.content, /Initial routine/);
  assert.equal((await request('/routine', { method: 'PUT', body: { content: '# New routine', updated_by: 'test' } })).body.ok, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'nora-routine.md'), 'utf8'), '# New routine');

  assert.match((await request('/charter')).body.content, /Initial charter/);
  assert.equal((await request('/charter', { method: 'PUT', body: { content: '# New charter', updated_by: 'test' } })).body.ok, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'nora-charter.md'), 'utf8'), '# New charter');
});

test('public identity and prompt endpoints retain their response contracts', async () => {
  const prompt = await request('/prompt');
  assert.equal(typeof prompt.body, 'string');
  assert.ok(prompt.body.length > 100);
  const self = await request('/self');
  assert.equal(typeof self.body.autobiography.content, 'string');
  assert.ok('wants' in self.body);
  assert.ok('inner_thread' in self.body);
  assert.ok('soma' in self.body);
});

test('dream and transcript CRUD preserves response shapes and local files', async () => {
  const dream = await request('/dreams', { method: 'POST', body: { narrative: 'A useful dream', reflection: { ideas: ['Ship it'] } } });
  assert.equal(dream.body.dream.narrative, 'A useful dream');
  assert.equal((await request(`/dreams/${dream.body.dream.id}`)).body.reflection.ideas[0], 'Ship it');
  assert.equal((await request(`/dreams/${dream.body.dream.id}`, { method: 'DELETE' })).body.ok, true);

  const list = await request('/transcripts');
  assert.equal(list.body[0].bot_id, 'test-bot');
  const edited = await request('/transcripts/test-bot/utterances/0', { method: 'PUT', body: { speaker: 'Jordan', text: 'Edited line' } });
  assert.deepEqual(edited.body.utterance, { speaker: 'Jordan', text: 'Edited line' });
  assert.equal((await request('/transcripts/test-bot/utterances/1', { method: 'DELETE' })).body.ok, true);
  assert.equal((await request('/transcripts/test-bot')).body.transcript.length, 1);
  assert.equal((await request('/transcripts/test-bot', { method: 'DELETE' })).body.ok, true);
});
