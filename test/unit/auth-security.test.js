'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  requireAuth,
  requireDashboardAuth,
  requireOperatorAuth,
  createOperatorToken,
  verifyOperatorToken,
  isProductionEnvironment,
  credentialConfigurationAudit,
  requireEvaluatorAuth,
  requireResearchAuth,
} = require('../../src/middleware/auth');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

async function withEnvironment(values, work) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const hostedKeys = {
  NODE_ENV: undefined,
  NORA_ENV: undefined,
  RAILWAY_ENVIRONMENT_ID: undefined,
  RAILWAY_ENVIRONMENT_NAME: undefined,
  RAILWAY_PROJECT_ID: undefined,
  NORA_AUTONOMY_KEY: undefined,
  NORA_INTERNAL_KEY: undefined,
  NORA_RESEARCH_KEY: undefined,
  NORA_EVALUATOR_KEY: undefined,
  NORA_EVALUATOR_KEYS: undefined,
  DASHBOARD_PASSWORD: undefined,
};

test('hosted environments are detected even when NODE_ENV is absent', () => {
  assert.equal(isProductionEnvironment({ RAILWAY_ENVIRONMENT_ID: 'environment-id' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'test' }), false);
});

test('API authentication fails closed when a hosted deployment has no key', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production', NORA_API_KEY: undefined }, () => {
    let continued = false;
    const res = responseRecorder();
    requireAuth({ headers: {}, query: {} }, res, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(res.statusCode, 503);
  });
});

test('production accepts Bearer authentication and can explicitly disable legacy query credentials', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production', NORA_API_KEY: 'secure-key',
    NORA_ALLOW_LEGACY_QUERY_AUTH: '0' }, () => {
    let continued = false;
    const queryRes = responseRecorder();
    requireAuth({ headers: {}, query: { key: 'secure-key' } }, queryRes, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(queryRes.statusCode, 401);

    const bearerRes = responseRecorder();
    requireAuth({ headers: { authorization: 'Bearer secure-key' }, query: {} }, bearerRes,
      () => { continued = true; });
    assert.equal(continued, true);
  });
});

test('hosted query authentication is disabled by default and requires an explicit migration opt-in', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production', NORA_API_KEY: 'secure-key',
    NORA_ALLOW_LEGACY_QUERY_AUTH: undefined }, () => {
    let continued = false;
    const denied = responseRecorder();
    requireAuth({ headers: {}, query: { key: 'secure-key' } }, denied,
      () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(denied.statusCode, 401);

    process.env.NORA_ALLOW_LEGACY_QUERY_AUTH = '1';
    const request = { headers: {}, query: { key: 'secure-key' } };
    requireAuth(request, responseRecorder(), () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(request.principal.kind, 'legacy_query');
  });
});

test('bearer authentication stamps scoped principals without trusting request-body actor fields', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production',
    NORA_API_KEY: 'shared-key', NORA_AUTONOMY_KEY: 'autonomy-key',
    NORA_INTERNAL_KEY: 'internal-key' }, () => {
    for (const [key, kind] of [
      ['shared-key', 'shared_api'],
      ['autonomy-key', 'nora_autonomy'],
      ['internal-key', 'server_internal'],
    ]) {
      const request = { headers: { authorization: `Bearer ${key}` }, query: {},
        body: { actor: 'John' } };
      let continued = false;
      requireAuth(request, responseRecorder(), () => { continued = true; });
      assert.equal(continued, true);
      assert.equal(request.principal.kind, kind);
      assert.notEqual(request.principal.id, request.body.actor);
    }
  });
});

test('credentials shared across authority scopes fail closed instead of escalating', async () => {
  const fixtures = [
    {
      name: 'shared and internal',
      env: { NORA_API_KEY: 'collision-one', NORA_INTERNAL_KEY: 'collision-one' },
      scopes: ['server_internal', 'shared_api'],
    },
    {
      name: 'autonomy and research',
      env: { NORA_AUTONOMY_KEY: 'collision-two', NORA_RESEARCH_KEY: 'collision-two' },
      scopes: ['nora_autonomy', 'research'],
    },
    {
      name: 'evaluator and operator',
      env: {
        NORA_EVALUATOR_KEYS: JSON.stringify({ independent: 'collision-three' }),
        DASHBOARD_PASSWORD: 'collision-three',
      },
      scopes: ['evaluator', 'operator'],
    },
  ];

  for (const fixture of fixtures) {
    await withEnvironment({
      ...hostedKeys,
      NODE_ENV: 'production',
      ...fixture.env,
    }, () => {
      const audit = credentialConfigurationAudit();
      assert.equal(audit.valid, false, fixture.name);
      assert.deepEqual(audit.collisions[0].scopes, fixture.scopes, fixture.name);
      assert.doesNotMatch(JSON.stringify(audit), /collision-(?:one|two|three)/,
        'audit output must never expose a credential');

      let continued = false;
      const request = {
        headers: { authorization: `Bearer ${Object.values(fixture.env)[0]}` },
        query: {},
      };
      const res = responseRecorder();
      requireAuth(request, res, () => { continued = true; });
      assert.equal(continued, false, fixture.name);
      assert.equal(request.principal, undefined, fixture.name);
      assert.equal(res.statusCode, 503, fixture.name);
      assert.equal(res.body.code, 'credential_scope_collision', fixture.name);
    });
  }
});

test('research, evaluator, dashboard, and operator entrypoints also reject credential collisions', async () => {
  await withEnvironment({
    ...hostedKeys,
    NODE_ENV: 'production',
    NORA_RESEARCH_KEY: 'cross-scope-secret',
    NORA_EVALUATOR_KEY: 'cross-scope-secret',
    DASHBOARD_PASSWORD: 'different-operator-secret',
  }, () => {
    for (const [middleware, headers] of [
      [requireResearchAuth, { 'x-nora-research-key': 'cross-scope-secret' }],
      [requireEvaluatorAuth, { 'x-nora-evaluator-key': 'cross-scope-secret' }],
      [requireDashboardAuth, {
        authorization: `Basic ${Buffer.from('operator:different-operator-secret').toString('base64')}`,
      }],
      [requireOperatorAuth, {}],
    ]) {
      let continued = false;
      const res = responseRecorder();
      middleware({ headers, query: {} }, res, () => { continued = true; });
      assert.equal(continued, false);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'credential_scope_collision');
    }
    assert.equal(createOperatorToken(), '');
    assert.equal(verifyOperatorToken('anything'), false);
  });
});

test('a signed dashboard session authenticates API calls without exposing the shared API key', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production',
    NORA_API_KEY: 'long-lived-shared-key', DASHBOARD_PASSWORD: 'operator-password' }, () => {
    const token = createOperatorToken({ now: Date.now() });
    const request = { headers: { authorization: `Bearer ${token}` }, query: {} };
    let continued = false;
    requireAuth(request, responseRecorder(), () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(request.principal.kind, 'dashboard_operator');
    assert.equal(request.principal.authentication, 'signed_dashboard_bearer');
    assert.notEqual(token, process.env.NORA_API_KEY);
  });
});

test('local development remains open when keys are intentionally absent', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'test', NORA_API_KEY: undefined,
    DASHBOARD_PASSWORD: undefined }, () => {
    let apiContinued = false;
    let dashboardContinued = false;
    requireAuth({ headers: {}, query: {} }, responseRecorder(), () => { apiContinued = true; });
    requireDashboardAuth({ headers: {} }, responseRecorder(), () => { dashboardContinued = true; });
    assert.equal(apiContinued, true);
    assert.equal(dashboardContinued, true);
  });
});

test('dashboard and operator authority fail closed in production without a password', async () => {
  await withEnvironment({ ...hostedKeys, NODE_ENV: 'production', DASHBOARD_PASSWORD: undefined }, () => {
    let dashboardContinued = false;
    let operatorContinued = false;
    const dashboardRes = responseRecorder();
    const operatorRes = responseRecorder();
    requireDashboardAuth({ headers: {} }, dashboardRes, () => { dashboardContinued = true; });
    requireOperatorAuth({ headers: {} }, operatorRes, () => { operatorContinued = true; });
    assert.equal(dashboardContinued, false);
    assert.equal(operatorContinued, false);
    assert.equal(dashboardRes.statusCode, 503);
    assert.equal(operatorRes.statusCode, 503);
    assert.equal(verifyOperatorToken(''), false);
  });
});

test('production identity and operating-state reads stay behind API authentication', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  for (const route of ['/prompt', '/charter', '/self', '/predictions', '/people', '/routine']) {
    const escaped = route.replaceAll('/', '\\/');
    assert.match(server, new RegExp(`app\\.get\\('${escaped}',\\s*requireAuth`),
      `${route} must not be public`);
  }
  assert.match(server, /registerCoworkInstructionsRoute\(app,\s*\{\s*requireAuth\s*\}\)/);
});
