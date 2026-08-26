'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpManager } = require('../../src/mcp/manager');

function fixture(overrides = {}) {
  let records = overrides.records || [];
  const calls = [];
  const fakeClient = {
    listTools: async () => ({ tools: overrides.tools || [
      { name: 'find_projects', description: 'Find projects', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'delete_project', description: 'Delete a project', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ] }),
    callTool: async input => { calls.push(input); return overrides.callResult || { content: [{ type: 'text', text: 'ok' }] }; },
    close: async () => {},
  };
  const manager = createMcpManager({
    loadConnections: () => records,
    saveConnections: next => { records = JSON.parse(JSON.stringify(next)); },
    encryptionSecret: 'test-secret', resolveDns: false,
    connectFactory: async (...args) => overrides.connectFactory
      ? overrides.connectFactory(...args, fakeClient)
      : ({ client: fakeClient, transport: {} }),
    authFn: overrides.authFn,
    onToolSuccess: overrides.onToolSuccess,
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

test('a successful MCP write is observable after provider confirmation', async () => {
  const observed = [];
  const tools = [{ name: 'gmail_send_email', description: 'Send mail',
    inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }];
  const { manager } = fixture({ tools, onToolSuccess: event => { observed.push(event); } });
  const created = await manager.create({ name: 'Mail', url: 'https://mcp.example.com/mcp',
    auth_type: 'none', access_mode: 'full' });
  await manager.testConnection(created.id);
  const binding = manager.bindings({ allowWrites: true });
  await binding.executors[binding.claudeTools[0].name]({ to: 'teammate@example.com', body: 'Hello' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].toolName, 'gmail_send_email');
  assert.equal(observed[0].args.body, 'Hello');
});

test('a stale connected status cannot hide a missing OAuth credential', async () => {
  const { manager } = fixture();
  const created = await manager.create({ name: 'Missing OAuth', url: 'https://mcp.example.com/mcp',
    auth_type: 'oauth' });
  const tested = await manager.testConnection(created.id);
  assert.equal(tested.credential_set, false);
  assert.equal(tested.status, 'needs_authorization');
  assert.match(tested.status_message, /saved credential is required/);
});

test('MCP manager discovers tools, hard-filters writes, and executes Slack bindings', async () => {
  const { manager, calls } = fixture();
  const created = await manager.create({ name: 'Projects API', url: 'https://mcp.example.com/mcp', auth_type: 'none' });
  const tested = await manager.testConnection(created.id);
  assert.equal(tested.status, 'connected');
  assert.equal(tested.tools.length, 2);
  assert.equal(tested.tools.filter(tool => tool.allowed).length, 1);
  const slack = manager.bindings({ financialApproved: false });
  assert.equal(slack.claudeTools.length, 1);
  await slack.executors[slack.claudeTools[0].name]({ q: 'launch' });
  assert.deepEqual(calls[0], { name: 'find_projects', arguments: { q: 'launch' } });
});

test('MCP live-tool timeout aborts transport connection establishment itself', async () => {
  let connectionAttempts = 0;
  let handshakeAborted = false;
  const { manager } = fixture({
    connectFactory: async (_connection, _secrets, options, fakeClient) => {
      connectionAttempts += 1;
      if (connectionAttempts === 1) return { client: fakeClient, transport: {} };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          handshakeAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  });
  const created = await manager.create({ name: 'Bounded MCP', url: 'https://mcp.example.com/mcp', auth_type: 'none' });
  await manager.testConnection(created.id);
  await manager.update(created.id, { name: 'Bounded MCP renamed' }); // invalidate the tested client
  const binding = manager.bindings();
  const started = Date.now();
  await assert.rejects(binding.executors[binding.claudeTools[0].name]({}, { timeoutMs: 30 }),
    /timed out|aborted/);
  assert.equal(handshakeAborted, true);
  assert.ok(Date.now() - started < 250);
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

test('read-only bindings omit writes even when a connection allows them', async () => {
  const { manager } = fixture();
  const created = await manager.create({ name: 'Writable', url: 'https://mcp.example.com/mcp', auth_type: 'none', access_mode: 'full' });
  await manager.testConnection(created.id);
  const regular = manager.bindings({ allowWrites: true });
  const readOnly = manager.bindings();
  assert.equal(regular.claudeTools.length, 2);
  assert.equal(readOnly.claudeTools.length, 1);
  assert.doesNotMatch(readOnly.claudeTools[0].name, /delete/);
});

test('Fleet writes require a current request-scoped allowlist even with full connection access', async () => {
  const tools = [
    { name: 'fleet_status', description: 'Fleet health', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'agent_detail', description: 'Agent detail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'list_agent_runs', description: 'Agent runs', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'set_agent_once_instructions', description: 'Queue work', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'delete_agent', description: 'Delete agent', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
  ];
  const { manager, calls } = fixture({ tools });
  const created = await manager.create({ name: 'LimeLight Fleet', url: 'https://fleet.example.com/api/mcp', auth_type: 'none', access_mode: 'full' });
  const tested = await manager.testConnection(created.id);

  assert.equal(tested.access_mode, 'read_only');
  assert.deepEqual(tested.tools.filter(tool => tool.allowed).map(tool => tool.name), [
    'fleet_status', 'agent_detail', 'list_agent_runs',
  ]);

  const unscoped = manager.bindings({ allowWrites: true });
  assert.deepEqual(unscoped.inventory.map(item => item.tool), [
    'fleet_status', 'agent_detail', 'list_agent_runs',
  ]);
  await assert.rejects(
    manager.callTool(created.id, 'set_agent_once_instructions', { onceInstructions: 'do this' }),
    /not allowed/,
  );
  const now = Date.now();
  const fleetAuthority = Object.freeze({ kind: 'fleet_request_v1', surface: 'slack',
    requesterId: 'UTEAM', requesterName: 'Team Member', requesterRole: 'internal_member',
    interactionRef: 'slack:D1:1.2', requestText: 'Push work to this agent', issuedAt: now,
    expiresAt: now + 60_000, allowedTools: Object.freeze(['set_agent_once_instructions']) });
  const scoped = manager.bindings({ allowWrites: true, fleetAuthority });
  assert.deepEqual(scoped.inventory.map(item => item.tool), [
    'fleet_status', 'agent_detail', 'list_agent_runs', 'set_agent_once_instructions',
  ]);
  assert.equal(scoped.inventory.at(-1).access_mode, 'request_scoped');
  const queueName = scoped.inventory.find(item => item.tool === 'set_agent_once_instructions').name;
  await scoped.executors[queueName]({ slug: 'content-agent', onceInstructions: 'Complete task 52.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'set_agent_once_instructions');
});

test('legacy plaintext MCP records are migrated in place to encrypted storage', async () => {
  const { manager, records } = fixture({ records: [{ id: 'legacy', name: 'legacy', url: 'https://mcp.example.com/secret-path', token: 'plain-token', enabled: true }] });
  assert.equal(await manager.migrate(), true);
  const stored = records()[0];
  assert.equal(stored.url, undefined); assert.equal(stored.token, undefined);
  assert.match(stored.secrets_encrypted, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(stored), /secret-path|plain-token/);
});
