'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const domain = fs.readFileSync(path.join(root, 'src/intelligence/project-autopilot.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/registerProjectControlRoutes.js'), 'utf8');
const routine = fs.readFileSync(path.join(root, 'nora-routine.md'), 'utf8');
const prompt = fs.readFileSync(path.join(root, 'cowork-prompt.md'), 'utf8');

test('Project Autopilot keeps its non-negotiable human gates in code', () => {
  for (const gate of ['external_email', 'client_commitment', 'scope_change', 'budget_change',
    'major_deadline_change', 'financial_disclosure']) {
    assert.match(domain, new RegExp(`${gate}:`));
  }
  assert.match(domain, /human-facing autopilot action requires an authorized PM intervention/);
  assert.match(domain, /shadow mode cannot authorize actions/);
  assert.match(domain, /copilot mode requires operator approval/);
  assert.match(domain, /calendar_cancellation_required = true/);
});

test('charter mutations and one-time approvals remain operator-only routes', () => {
  for (const fragment of [
    "app.put('/pm-control/autopilot/charters/:key', requireOperatorAuth",
    "app.post('/pm-control/autopilot/charters/:key/activate', requireOperatorAuth",
    "app.post('/pm-control/autopilot/charters/:key/pause', requireOperatorAuth",
    "app.post('/pm-control/autopilot/actions/:id/approve', requireOperatorAuth",
    "app.post('/pm-control/autopilot/meetings/:id/approve', requireOperatorAuth",
  ]) assert.ok(routes.includes(fragment), `${fragment} must remain operator-only`);
});

test('operating instructions preserve event-driven quietness and standing-authority boundaries', () => {
  assert.match(routine, /Project Autopilot is standing authority for one named project/);
  assert.match(routine, /never emits a quiet status message/);
  assert.match(routine, /record `\/schedule` with the event reference/);
  assert.match(routine, /Record `\/join` when the Recall bot joins/);
  assert.match(routine, /call the action `\/observe` endpoint/);
  assert.match(prompt, /Project Autopilot is project-scoped standing authority/);
  assert.match(prompt, /Human-facing reminders and escalations must also pass the existing PM intervention rail/);
  assert.match(prompt, /A charter never authorizes financial forecast or estimate writes/);
});
