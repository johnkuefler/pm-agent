const test = require('node:test');
const assert = require('node:assert/strict');

const { registerProjectRoutes, isLimeLightInternalClient } = require('../../src/routes/registerProjectRoutes');

// The exact string every internal project carries in production. The previous exclusion compared
// for equality against 'limelight marketing', which this never matches because of the code suffix,
// so all fifteen internal buckets stayed in the coverage list.
const PRODUCTION_INTERNAL_CLIENT = 'LimeLight Marketing (LL)';

test('the production internal client value is recognized', () => {
  assert.equal(isLimeLightInternalClient(PRODUCTION_INTERNAL_CLIENT), true);
});

test('internal client detection survives suffix and spacing drift', () => {
  for (const value of [
    'LimeLight Marketing (LL)',
    'LimeLight Marketing',
    '  limelight marketing  ',
    'LimeLight Marketing, LLC',
    'LimeLight Marketing (LLM)',
    'LimeLight',
    'limelight',
  ]) {
    assert.equal(isLimeLightInternalClient(value), true, `${value} should read as internal`);
  }
});

// The agency's own name is distinctive, but the check must not swallow an unrelated client whose
// name merely begins with the same word.
test('real clients are never mistaken for internal work', () => {
  for (const value of ['Limelight Networks', 'Lime Light Studios', 'Greenbush', '', null, undefined]) {
    assert.equal(isLimeLightInternalClient(value), false, `${JSON.stringify(value)} should read as a client`);
  }
});

function harness(projects) {
  const routes = {};
  const app = { get: (path, _auth, handler) => { routes['get:' + path] = handler; },
    post: () => {}, put: () => {}, delete: () => {} };
  registerProjectRoutes(app, {
    requireAuth: (req, res, next) => next && next(),
    loadProjects: () => projects,
    saveProjects: () => {},
    loadMemory: () => [],
  });
  return routes;
}

function coverage(projects, query = {}) {
  const routes = harness(projects);
  let body = null;
  routes['get:/projects/coverage']({ query }, { json: value => { body = value; } });
  return body;
}

// The end-to-end shape of the bug: internal buckets have no client research written about them, so
// they score thinnest, and the "most in need first" sort puts them at the very top. Every idle
// round got handed the same dead ends.
test('internal buckets are excluded from the coverage worklist', () => {
  const projects = [
    { name: 'LLM - T&M Billing', client: PRODUCTION_INTERNAL_CLIENT },
    { name: 'LL - Contractor Invoicing', client: PRODUCTION_INTERNAL_CLIENT },
    { name: 'LLM - Non-Billable Company Time', client: PRODUCTION_INTERNAL_CLIENT },
    { name: 'Greenbush Registration', client: 'Greenbush (GB)', status: 'active', pm: 'Mallory' },
  ];
  const body = coverage(projects);
  assert.deepEqual(body.projects.map(row => row.name), ['Greenbush Registration']);
  assert.equal(body.count, 1);
});

test('internal buckets are still reachable when explicitly requested', () => {
  const projects = [
    { name: 'LLM - T&M Billing', client: PRODUCTION_INTERNAL_CLIENT },
    { name: 'Greenbush Registration', client: 'Greenbush (GB)' },
  ];
  const body = coverage(projects, { include_internal: 'true' });
  assert.equal(body.count, 2);
});

// The name-prefix half of the heuristic predates the client check and still has to work for
// internal projects that never got a client assigned.
test('name-prefixed internal projects are excluded even without a client field', () => {
  const projects = [
    { name: 'LimeLight Website Redesign' },
    { name: 'LimeLight' },
    { name: 'Greenbush Registration', client: 'Greenbush (GB)' },
  ];
  assert.deepEqual(coverage(projects).projects.map(row => row.name), ['Greenbush Registration']);
});
