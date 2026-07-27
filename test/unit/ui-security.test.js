'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { escapeHtmlAttribute, registerUiRoutes } = require('../../src/routes/ui');

test('dashboard capability values are escaped for HTML attribute context', () => {
  assert.equal(
    escapeHtmlAttribute(`key"><img src=x onerror='steal()'>&`),
    'key&quot;&gt;&lt;img src=x onerror=&#39;steal()&#39;&gt;&amp;',
  );
});

test('operator documents cannot be cached, framed, or leak referrers', () => {
  const priorPassword = process.env.DASHBOARD_PASSWORD;
  const priorApiKey = process.env.NORA_API_KEY;
  process.env.DASHBOARD_PASSWORD = 'ui-test-operator-password';
  process.env.NORA_API_KEY = 'do-not-embed-this-long-lived-key';
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(route, handlers.at(-1)); },
  };
  registerUiRoutes(app, {
    requireDashboardAuth: (_req, _res, next) => next(),
    rootDir: path.join(__dirname, '..', '..'),
  });

  const headers = {};
  let body = '';
  const response = {
    setHeader(name, value) { headers[name] = value; },
    type() { return this; },
    send(value) { body = value; return this; },
    status() { return this; },
  };
  try {
    routes.get('/')({}, response);
    assert.match(headers['Cache-Control'], /no-store/);
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.match(body, /<title>Nora - PM Agent<\/title>/);
    assert.doesNotMatch(body, /do-not-embed-this-long-lived-key/);
    const apiSession = body.match(/<meta name="nora-api-key" content="([^"]+)">/)?.[1];
    const operatorSession = body.match(/<meta name="nora-operator-token" content="([^"]+)">/)?.[1];
    assert.ok(apiSession);
    assert.equal(apiSession, operatorSession);
  } finally {
    if (priorPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = priorPassword;
    if (priorApiKey === undefined) delete process.env.NORA_API_KEY;
    else process.env.NORA_API_KEY = priorApiKey;
  }
});
