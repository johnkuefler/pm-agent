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

for (const [name, contents] of Object.entries({
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
    transcript: [{ speaker: 'Alex', text: 'Original line' }],
  }),
})) fs.writeFileSync(path.join(dataDir, name), contents);

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

test('health, API auth, and the reduced dashboard are available', async () => {
  const healthResponse = await fetch(base + '/health');
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ready, true);
  assert.equal((await fetch(base + '/tasks')).status, 401);

  const auth = Buffer.from('nora:integration-password').toString('base64');
  const dashboard = await fetch(base + '/', { headers: { Authorization: `Basic ${auth}` } });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /data-tab="tasks"/);
  assert.doesNotMatch(html, /data-tab="projects"/);
  assert.doesNotMatch(html, /data-tab="intelligence"/);
});

test('tasks preserve scheduling, recurrence, completion, and deletion', async () => {
  const future = await request('/tasks', { method: 'POST', body: {
    action: 'Prepare the client status agenda', scheduled_for: '2099-01-01T15:00:00.000Z',
  } });
  assert.equal(future.response.status, 200);
  assert.equal((await request('/tasks?status=pending')).body.some(item => item.id === future.body.id), false);
  assert.equal((await request('/tasks?status=pending&include=all')).body.some(item => item.id === future.body.id), true);

  const recurring = await request('/tasks', { method: 'POST', body: {
    action: 'Run weekly project triage', recurrence: 'every:1:weeks:09:00',
  } });
  const rolled = await request(`/tasks/${recurring.body.id}/complete`, { method: 'PATCH' });
  assert.equal(rolled.body.task.status, 'pending');
  assert.ok(rolled.body.rolled_to);

  assert.equal((await request(`/tasks/${future.body.id}`, { method: 'DELETE' })).body.ok, true);
  assert.equal((await request(`/tasks/${recurring.body.id}`, { method: 'DELETE' })).body.ok, true);
});

test('projects preserve Teamwork linkage and planning context', async () => {
  const created = await request('/projects', { method: 'POST', body: {
    name: 'Launch Site', client: 'Acme', status: 'active', pm: 'Taylor', teamwork_id: '900',
  } });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.project.teamwork_id, '900');
  assert.equal((await request('/projects', { method: 'POST', body: { name: 'launch site' } })).response.status, 409);

  const updated = await request('/projects/Launch%20Site', { method: 'PUT', body: {
    phase: 'build', details: 'QA starts after content approval.',
  } });
  assert.equal(updated.body.project.phase, 'build');
  assert.equal((await request('/projects/launch%20site')).body.details, 'QA starts after content approval.');
  assert.equal((await request('/projects/Launch%20Site', { method: 'DELETE' })).body.ok, true);
});

test('memory and transcript context remain available', async () => {
  const memory = await request('/memory', { method: 'POST', body: {
    fact: 'Acme approvals come from Taylor.', source: 'integration', kind: 'fact',
  } });
  assert.equal(memory.response.status, 200);
  assert.equal((await request('/memory')).body[0].fact, 'Acme approvals come from Taylor.');

  const transcripts = await request('/transcripts?status=ended');
  assert.equal(transcripts.body[0].bot_id, 'test-bot');
  const transcript = await request('/transcripts/test-bot');
  assert.equal(transcript.body.transcript[0].text, 'Original line');
});
