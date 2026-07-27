'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const coworkSource = fs.readFileSync(path.join(__dirname, '..', '..', 'cowork-prompt.md'), 'utf8');
const { __test } = require('../../server');

test('transcript bot IDs are opaque and fallback paths remain inside their data directory', () => {
  assert.equal(__test.normalizeTranscriptBotId('bot_ABC-123'), 'bot_ABC-123');
  for (const value of [
    '', '.', '..', '../nora-calendar', 'bot/../../nora-tokens', 'bot\\tokens',
    'bot%2Ftokens', 'bot.json', '__proto__', 'b'.repeat(129), '☃',
  ]) {
    assert.throws(() => __test.normalizeTranscriptBotId(value), /invalid transcript bot id/);
  }
  const root = path.join(os.tmpdir(), 'nora-transcript-path-test');
  const target = __test.transcriptJsonPath(root, 'bot_ABC-123');
  assert.equal(path.dirname(target), path.resolve(root));
  assert.equal(path.basename(target), 'transcript-bot_ABC-123.json');
});

test('Slack file ingress rejects external URLs, non-global DNS, and mapped address forms', async () => {
  assert.equal(__test.slackFileIsExternal({
    mode: 'external',
    external_url: 'https://attacker.example/file',
  }), true);
  assert.equal(__test.slackFileIsExternal({
    mode: 'hosted',
    url_private_download: 'https://files.slack.com/file',
  }), false);
  assert.equal(__test.networkAddressIsGlobal('::ffff:8.8.8.8'), false);
  assert.equal(__test.networkAddressIsGlobal('::8.8.8.8'), false);
  assert.equal(__test.networkAddressIsGlobal('64:ff9b::808:808'), false);

  const publicDns = async () => [{ address: '151.101.1.6', family: 4 }];
  const validated = await __test.validateSlackDownloadUrl(
    'https://files.slack.com/files-pri/T123/file.txt',
    { dnsLookup: publicDns },
  );
  assert.equal(validated.url.hostname, 'files.slack.com');
  assert.equal(typeof validated.lookup, 'function');
  await assert.rejects(__test.validateSlackDownloadUrl(
    'https://attacker.example/file',
    { dnsLookup: publicDns },
  ), /Slack-owned HTTPS origin/);
  await assert.rejects(__test.validateSlackDownloadUrl(
    'https://files.slack.com/file',
    { dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] },
  ), /non-public network/);
});

test('Slack redirects are revalidated and bearer credentials never cross origins', async () => {
  const requests = [];
  const dnsLookup = async () => [{ address: '151.101.1.6', family: 4 }];
  const get = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return {
        status: 302,
        headers: { location: 'https://downloads.slack-edge.com/file.txt' },
        data: Buffer.alloc(0),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      data: Buffer.from('safe file'),
    };
  };
  const result = await __test.downloadSlackFile(
    'https://files.slack.com/files-pri/T123/file.txt',
    'slack-secret',
    1024,
    { get, dnsLookup },
  );
  assert.equal(result.body.toString(), 'safe file');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer slack-secret');
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(typeof requests[0].options.lookup, 'function');
  assert.equal(typeof requests[1].options.lookup, 'function');
  assert.equal(requests.every(request => request.options.maxRedirects === 0), true);
});

test('OAuth state is one-time, expiry-checked, and bound to its start-time redirect', () => {
  const redirectUri = 'https://nora.example.com/calendar/oauth/callback';
  const valid = __test.newOAuthState({ redirectUri, now: 1000 });
  assert.deepEqual(__test.consumeOAuthState(valid, { now: 2000 }), {
    created: 1000,
    redirect_uri: redirectUri,
  });
  assert.equal(__test.consumeOAuthState(valid, { now: 2001 }), null);

  const expired = __test.newOAuthState({ redirectUri, now: 1000 });
  assert.equal(__test.consumeOAuthState(expired, { now: 11 * 60 * 1000 }), null);
});

test('OAuth callback errors are bounded plain text instead of reflected HTML', () => {
  const longAttack = `<script>alert(1)</script>\r\n${'x'.repeat(1000)}`;
  const rendered = __test.oauthCallbackErrorText(longAttack);
  assert.equal(rendered.includes('\n'), false);
  assert.doesNotMatch(rendered, /<script>/i);
  assert.equal(rendered.length <= 500, true);

  const observed = {};
  const response = {
    status(value) { observed.status = value; return this; },
    type(value) { observed.type = value; return this; },
    send(value) { observed.body = value; return this; },
  };
  __test.sendOAuthCallbackError(response, 400, longAttack);
  assert.deepEqual({ status: observed.status, type: observed.type }, {
    status: 400,
    type: 'text/plain',
  });
  assert.equal(observed.body.length <= 500, true);
  assert.match(serverSource,
    /if \(error\) return sendOAuthCallbackError\(res, 400, `Google OAuth error:/);
});

test('hosted callback origins fail closed instead of trusting the request Host header', () => {
  const keys = [
    'NODE_ENV', 'NORA_ENV', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
    'RAILWAY_PROJECT_ID', 'RAILWAY_PUBLIC_DOMAIN', 'PUBLIC_URL',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = 'production';
    assert.equal(__test.publicHost('attacker.example'), '');
    assert.throws(() => __test.requiredPublicOrigin('attacker.example'), /required for public callbacks/);
    process.env.PUBLIC_URL = 'https://trusted.example/app';
    assert.equal(__test.requiredPublicOrigin('attacker.example'), 'https://trusted.example');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('cowork harness returns only a caller environment reference and disables caching', () => {
  const routeStart = serverSource.indexOf("app.get('/cowork-prompt'");
  const routeEnd = serverSource.indexOf("// ── Nora's editable hourly routine", routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /\.replaceAll\('\{\{NORA_API_KEY\}\}', '\$NORA_API_KEY'\)/);
  assert.match(route, /private, no-store, max-age=0/);
  assert.doesNotMatch(route, /NORA_AUTONOMY_KEY|process\.env\.NORA_API_KEY/);
  assert.match(coworkSource, /scheduler\/bootstrap supplies its own `NORA_API_KEY`/);
  assert.match(coworkSource, /\{\{NORA_API_KEY\}\}/);
});

test('governance and bot-control mutations require operator authority', () => {
  for (const declaration of [
    "app.post('/dummy/join', requireAuth, requireOperatorAuth,",
    "app.get('/calendar/connect', requireAuth, requireOperatorAuth,",
    "app.delete('/calendar', requireAuth, requireOperatorAuth,",
    "app.post('/slack/proactive-channels/:channel', requireAuth, requireOperatorAuth,",
    "app.delete('/slack/proactive-channels/:channel', requireAuth, requireOperatorAuth,",
    "app.post('/slack/financial-approved/:userId', requireAuth, requireOperatorAuth,",
    "app.delete('/slack/financial-approved/:userId', requireAuth, requireOperatorAuth,",
    "app.post('/admin/scheduled-bots/dedupe', requireAuth, requireOperatorAuth,",
    "app.post('/admin/bots/:id/leave', requireAuth, requireOperatorAuth,",
  ]) {
    assert.equal(serverSource.includes(declaration), true, declaration);
  }
});
