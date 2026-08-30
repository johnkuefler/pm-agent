const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
const cowork = fs.readFileSync(path.join(root, 'src/routes/cowork-instructions.js'), 'utf8');
const harness = fs.readFileSync(path.join(root, 'cowork-prompt.md'), 'utf8');

test('scheduled work executes only explicit due tasks', () => {
  for (const capability of [
    'Teamwork', 'calendar', 'Slack', 'meeting transcripts', 'project planning', 'task triage',
  ]) assert.match(`${routine}\n${cowork}`, new RegExp(capability, 'i'));

  assert.match(routine, /Acquire the run lock/);
  assert.match(routine, /Verify every external write/);
  assert.match(routine, /Do not scan Teamwork, Slack, Gmail, calendars/);
  assert.match(routine, /Deliver only when requested/);
  assert.match(routine, /Do not send project alerts, blocker notices, status nudges/);
  assert.doesNotMatch(routine, /Maintain project plans|Reconcile active Teamwork projects/);
  for (const source of [routine, cowork, harness]) {
    assert.match(source, /GET \/tasks\/:id\/slack-source\?since=/);
    assert.match(source, /task-scoped|fixed on that task/i);
  }
});

test('scheduled Slack delivery is bot-only and task-scoped', () => {
  for (const source of [routine, cowork, harness]) {
    assert.match(source, /POST \/tasks\/:id\/deliver/);
    assert.match(source, /Never (?:send Slack through|use) a connected Slack tool/i);
  }
  assert.match(routine, /posts as the Nora bot/i);
  assert.match(routine, /Do not send a second message/i);
});

test('research and novelty work are outside Nora role', () => {
  assert.match(routine, /Research programs[\s\S]*out of[\s\S]*scope/);
  assert.match(cowork, /research experiments[\s\S]*outside Nora's role/);
  assert.doesNotMatch(cowork, /\/routine\/research/);
  assert.equal(fs.existsSync(path.join(root, 'nora-research-routine.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'consciousness-research.md')), false);
});
