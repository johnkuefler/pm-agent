'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpManager } = require('../../src/mcp/manager');

function fixture(overrides = {}) {
  let records = overrides.records || [];
  const calls = [];
  const fakeClient = {
    listTools: async () => ({ tools: [
      { name: 'find_projects', description: 'Find projects', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'delete_project', description: 'Delete a project', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ] }),
    callTool: async input => { calls.push(input); return { content: [{ type: 'text', text: 'ok' }] }; },
    close: async () => {},
  };
  const manager = createMcpManager({
    loadConnections: () => records,
    saveConnections: next => { records = JSON.parse(JSON.stringify(next)); },
    encryptionSecret: 'test-secret', resolveDns: false,
    connectFactory: async () => ({ client: fakeClient, transport: {} }),
    authFn: overrides.authFn,
  });
  return { manager, records: () => records, calls };
}

test('all MCP credential modes store secrets encrypted and never expose raw URLs', async () => {
  for (const [auth_type, extra] of [
    ['none', {}], ['bearer', { token: 'bearer-secret' }], ['url_token', {}],
    ['oauth', { client_id: 'client', client_secret: 'oauth-secret', scopes: 'read' }],
    ['client_credentials', { client_id: 'service', client_secret: 'service-secret' }],
    ['custom_headers', { headers: { 'X-API-Token': 'token', 'X-API-Secret': 'secret' } }],
  ]) {
    const { manager, records } = fixture();
    const connection = await manager.create({ name: auth_type, url: `https://mcp.example.com/mcp/${auth_type === 'url_token' ? 'embedded-secret-value' : 'endpoint'}`, auth_type, ...extra });
    const serialized = JSON.stringify(records());
    assert.doesNotMatch(serialized, /bearer-secret|oauth-secret|service-secret|embedded-secret-value|X-API-Secret":"secret/);
    assert.equal(connection.auth_type, auth_type);
    assert.equal('url' in connection, false);
    if (auth_type === 'url_token') assert.match(connection.url_hint, /••••/);
  }
});

test('MCP manager discovers tools, hard-filters writes, and executes the same binding for every surface', async () => {
  const { manager, calls } = fixture();
  const created = await manager.create({ name: 'Projects API', url: 'https://mcp.example.com/mcp', auth_type: 'none' });
  const tested = await manager.testConnection(created.id);
  assert.equal(tested.status, 'connected');
  assert.equal(tested.tools.length, 2);
  assert.equal(tested.tools.filter(tool => tool.allowed).length, 1);
  const slack = manager.bindings({ financialApproved: false });
  const zoom = manager.bindings({ financialApproved: false });
  const voice = manager.bindings({ financialApproved: false, voice: true });
  assert.equal(slack.claudeTools.length, 1);
  assert.equal(zoom.claudeTools[0].name, slack.claudeTools[0].name);
  assert.equal(voice.openaiTools[0].name, slack.claudeTools[0].name);
  await slack.executors[slack.claudeTools[0].name]({ q: 'launch' });
  assert.deepEqual(calls[0], { name: 'find_projects', arguments: { q: 'launch' } });
});

test('OAuth PKCE state, discovery, verifier, tokens, and refreshable provider survive separate requests', async () => {
  let redirectState;
  const authFn = async (provider, options) => {
    if (!options.authorizationCode) {
      redirectState = await provider.state();
      await provider.saveCodeVerifier('verifier-123');
      await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com', resource: new URL('https://mcp.example.com/mcp') });
      await provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${redirectState}`));
      return 'REDIRECT';
    }
    assert.equal(await provider.codeVerifier(), 'verifier-123');
    await provider.saveTokens({ access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer', expires_in: 3600 });
    return 'AUTHORIZED';
  };
  const { manager, records } = fixture({ authFn });
  const created = await manager.create({ name: 'OAuth MCP', url: 'https://mcp.example.com/mcp', auth_type: 'oauth' });
  const authorizeUrl = await manager.startOAuth(created.id, 'https://nora.example.com/admin/mcp/oauth/callback');
  assert.match(authorizeUrl, /authorize/);
  await manager.finishOAuth({ state: redirectState, code: 'code-123' });
  const connection = manager.list()[0];
  assert.equal(connection.oauth_connected, true);
  assert.equal(connection.status, 'connected');
  assert.doesNotMatch(JSON.stringify(records()), /access-secret|refresh-secret|verifier-123/);
  const provider = manager.__test.requestOptions(created.id, 'https://nora.example.com/admin/mcp/oauth/callback').authProvider;
  assert.equal((await provider.tokens()).refresh_token, 'refresh-secret');
});

test('client credentials exposes a noninteractive refreshable OAuth provider', async () => {
  const { manager } = fixture();
  const created = await manager.create({ name: 'Service MCP', url: 'https://mcp.example.com/mcp', auth_type: 'client_credentials', client_id: 'service-id', client_secret: 'service-secret', scopes: 'records:read' });
  const provider = manager.__test.requestOptions(created.id).authProvider;
  assert.equal(provider.redirectUrl, undefined);
  assert.equal((await provider.clientInformation()).client_id, 'service-id');
  assert.equal((await provider.prepareTokenRequest()).get('grant_type'), 'client_credentials');
  assert.equal((await provider.prepareTokenRequest()).get('scope'), 'records:read');
  await provider.saveTokens({ access_token: 'machine-token', refresh_token: 'machine-refresh', token_type: 'bearer', expires_in: 300 });
  assert.equal((await provider.tokens()).access_token, 'machine-token');
});

test('custom header and URL validation rejects credential leaks and private targets', async () => {
  const { manager } = fixture();
  await assert.rejects(manager.create({ name: 'bad', url: 'http://mcp.example.com', auth_type: 'none' }), /HTTPS/);
  await assert.rejects(manager.create({ name: 'bad', url: 'https://127.0.0.1/mcp', auth_type: 'none' }), /private network/);
  await assert.rejects(manager.create({ name: 'bad', url: 'https://mcp.example.com', auth_type: 'custom_headers', headers: { Host: 'evil.example' } }), /not allowed/);
});

test('bearer and custom-header credentials are attached only inside the transport layer', async () => {
  const { manager } = fixture();
  const bearer = await manager.create({ name: 'Bearer', url: 'https://mcp.example.com/mcp', auth_type: 'bearer', token: 'bearer-value' });
  const custom = await manager.create({ name: 'Headers', url: 'https://mcp.example.com/mcp', auth_type: 'custom_headers', headers: { 'X-API-Token': 'token-value', 'X-API-Secret': 'secret-value' } });
  assert.equal(manager.__test.requestOptions(bearer.id).headers.Authorization, 'Bearer bearer-value');
  assert.deepEqual(manager.__test.requestOptions(custom.id).headers, { 'X-API-Token': 'token-value', 'X-API-Secret': 'secret-value' });
  assert.doesNotMatch(JSON.stringify(manager.list()), /bearer-value|token-value|secret-value/);
});

test('voice remains read-only even when a connection explicitly allows writes elsewhere', async () => {
  const { manager } = fixture();
  const created = await manager.create({ name: 'Writable', url: 'https://mcp.example.com/mcp', auth_type: 'none', access_mode: 'full' });
  await manager.testConnection(created.id);
  const regular = manager.bindings({ allowWrites: true });
  const voice = manager.bindings({ voice: true });
  assert.equal(regular.claudeTools.length, 2);
  assert.equal(voice.openaiTools.length, 1);
  assert.doesNotMatch(voice.openaiTools[0].name, /delete/);
});

test('legacy plaintext MCP records are migrated in place to encrypted storage', async () => {
  const { manager, records } = fixture({ records: [{ id: 'legacy', name: 'legacy', url: 'https://mcp.example.com/secret-path', token: 'plain-token', enabled: true }] });
  assert.equal(await manager.migrate(), true);
  const stored = records()[0];
  assert.equal(stored.url, undefined); assert.equal(stored.token, undefined);
  assert.match(stored.secrets_encrypted, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(stored), /secret-path|plain-token/);
});
