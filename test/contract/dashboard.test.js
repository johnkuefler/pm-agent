const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

test('dashboard exposes only operational PM views', () => {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(tabs, ['projects', 'tasks', 'meeting', 'admin']);
  for (const tab of tabs) assert.match(html, new RegExp(`id="page-${tab}"`));

  const removed = ['executive', 'fleet', 'transcripts', 'memory', 'live', 'intelligence',
    'dreams', 'markers', 'routine', 'charter', 'self'];
  for (const tab of removed) assert.doesNotMatch(html, new RegExp(`id="page-${tab}"`));

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'element ids must remain unique');
});

test('dashboard assets are focused, deploy-versioned, and valid JavaScript', () => {
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /^\s*<script>\s*$/m);
  assert.match(html, /href="\/assets\/dashboard\.css\?v=\{\{ASSET_VERSION\}\}"/);

  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts.map(source => source.replace(/\?v=.*$/, '')), [
    '/assets/js/dashboard-core.js',
    '/assets/js/dashboard-meeting.js',
    '/assets/js/dashboard-tasks.js',
    '/assets/js/dashboard-knowledge.js',
    '/assets/js/dashboard-portfolio.js',
    '/assets/js/dashboard-admin.js',
    '/assets/js/dashboard-init.js',
  ]);

  for (const source of scripts) {
    const file = path.join(root, 'public', source.replace('/assets/', '').replace(/\?v=.*$/, ''));
    const code = fs.readFileSync(file, 'utf8');
    assert.ok(code.length > 100, `${source} should not be empty`);
    assert.doesNotThrow(() => new vm.Script(code, { filename: file }));
  }
});

test('core project, task, meeting, transcript, and settings controls remain visible', () => {
  for (const id of [
    'portfolio-overview', 'pm-control-stats', 'project-detail-info',
    'task-list', 'url', 'transcript-list', 'calendar-status', 'mcp-list',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.doesNotMatch(html, /Send a Test Bot|Voice Agent|Nora's Memory|Executive Firewall|Fleet Supervisor|Project Autopilot|Legacy project context/);

  const core = fs.readFileSync(path.join(root, 'public/js/dashboard-core.js'), 'utf8');
  const meeting = fs.readFileSync(path.join(root, 'public/js/dashboard-meeting.js'), 'utf8');
  assert.match(core, /Dashboard request timed out/);
  assert.match(meeting, /if \(meetingStatusRefreshInFlight\) return;/);
  assert.doesNotMatch(meeting, /setInterval\(/);
});

test('dashboard retains responsive mobile and portfolio layouts', () => {
  const css = fs.readFileSync(path.join(root, 'public/dashboard.css'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.portfolio-project-card\{[^}]*display:grid/);
  assert.match(css, /@media\(max-width:760px\)/);
});
