const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
const cowork = fs.readFileSync(path.join(root, 'src/routes/cowork-instructions.js'), 'utf8');

test('scheduled work is a bounded PM operating loop', () => {
  for (const capability of [
    'Teamwork', 'calendar', 'Slack', 'meeting transcripts', 'project plans', 'task triage',
  ]) assert.match(`${routine}\n${cowork}`, new RegExp(capability, 'i'));

  assert.match(routine, /Acquire the run lock/);
  assert.match(routine, /Verify every external write/);
  assert.match(routine, /Do not create duplicate tasks or reminders/);
  assert.match(routine, /Do not send a message merely because the scheduled run occurred/);
});

test('research and novelty work are outside Nora role', () => {
  assert.match(routine, /Research programs[\s\S]*out of[\s\S]*scope/);
  assert.match(cowork, /research experiments[\s\S]*outside Nora's role/);
  assert.doesNotMatch(cowork, /\/routine\/research/);
  assert.equal(fs.existsSync(path.join(root, 'nora-research-routine.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'consciousness-research.md')), false);
});
