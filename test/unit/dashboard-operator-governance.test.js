'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const identitySource = fs.readFileSync(
  path.join(root, 'public', 'js', 'dashboard-identity.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

test('dashboard identity mutations use the signed operator API client', () => {
  for (const endpoint of ['/prompt', '/charter', '/routine']) {
    const escaped = endpoint.replace('/', '\\/');
    assert.match(identitySource, new RegExp(`operatorApi\\('${escaped}'\\s*,\\s*\\{\\s*method:\\s*'PUT'`),
      `${endpoint} dashboard writes must carry the signed operator token`);
    assert.doesNotMatch(identitySource, new RegExp(`api\\('${escaped}'\\s*,\\s*\\{\\s*method:\\s*'PUT'`),
      `${endpoint} dashboard writes must not rely on API-key auth and updated_by metadata alone`);
  }

  for (const endpoint of ['/prompt/rollback', '/charter/rollback', '/routine/rollback']) {
    const escaped = endpoint.replaceAll('/', '\\/');
    const unsignedRollback = new RegExp(`(?<!operator)api\\('${escaped}'\\s*,`);
    assert.doesNotMatch(identitySource, unsignedRollback,
      `${endpoint} must use operatorApi if a dashboard rollback control is added`);
  }
});

test('dashboard describes charter and persona self-improvement as proposals requiring operator approval', () => {
  assert.match(dashboardSource,
    /Nora may propose evidence-backed revisions[\s\S]{0,220}signed operator session approves/i);
  assert.match(dashboardSource,
    /Nora may propose evidence-backed revisions[\s\S]{0,180}signed operator approval/i);
  assert.doesNotMatch(dashboardSource, /living document Nora co-owns/i);
  assert.doesNotMatch(dashboardSource, /Nora evolves it as she earns trust/i);
  assert.doesNotMatch(dashboardSource, /She can refine it herself/i);
  assert.match(dashboardSource,
    /autonomous improvement lane is narrower[\s\S]{0,260}evidence-bound allowlisted section proposal/i);
  assert.match(dashboardSource,
    /Full replacement and rollback require this signed operator session/i);
});
