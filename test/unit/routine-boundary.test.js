'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerCoworkInstructionsRoute } = require('../../src/routes/cowork-instructions');

const root = path.join(__dirname, '..', '..');

test('ordinary PM routine keeps full research manuals off the hourly hot path', () => {
  const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
  const annex = fs.readFileSync(path.join(root, 'nora-research-routine.md'), 'utf8');
  assert.ok(routine.length < 170000, `ordinary routine is still too large: ${routine.length}`);
  assert.ok(annex.length > 120000, 'research protocols should remain preserved in the annex');
  assert.match(routine, /GET \/routine\/research/);
  assert.match(annex, /## Step 0\.75: Consume the Subject Research Inbox/);
  assert.match(annex, /## Step 7\.45: Off-hours developmental reading/);
  assert.match(annex, /## Step 7\.6: Weekly Self-Improvement Round/);
  assert.doesNotMatch(routine, /\/self-model\/prediction-studies\/subject-queue/);
  assert.doesNotMatch(routine, /## Step 7\.45: Off-hours developmental reading/);
});

test('research annex route serves the preserved manual only when fetched', () => {
  const handlers = new Map();
  registerCoworkInstructionsRoute({
    get(route, ...handlersForRoute) { handlers.set(route, handlersForRoute.at(-1)); },
  });
  assert.equal(typeof handlers.get('/routine/research'), 'function');
  const response = {
    contentType: '',
    body: '',
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    status() { throw new Error('research annex should be readable in the repository'); },
  };
  handlers.get('/routine/research')({}, response);
  assert.equal(response.contentType, 'text/markdown');
  assert.equal(response.body, fs.readFileSync(path.join(root, 'nora-research-routine.md'), 'utf8'));
});

test('end-of-run routine requires the structured anti-noise gate', () => {
  const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
  assert.match(routine, /POST \/pm-control\/run-summary\/evaluate/);
  assert.match(routine, /Never open a message with "quiet run,"/);
  assert.match(routine, /The fact that a dream ran is never itself a human\s+notification/);
  assert.match(routine, /If the evaluator returns `allowed:false`, do not call `\/notify`/);
  assert.match(routine, /requested_summary` or `requested_delivery`[\s\S]*create a `requested_action` intervention/);
});
