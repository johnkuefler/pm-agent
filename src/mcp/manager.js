'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { auth, UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { isFleetConnection } = require('./fleet-policy');

const AUTH_TYPES = new Set(['none', 'bearer', 'url_token', 'oauth', 'client_credentials', 'custom_headers']);
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'cookie', 'set-cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'proxy-authorization']);
const WRITE_NAME = /(^|[_-])(create|update|delete|remove|write|send|post|put|patch|edit|modify|upload|publish|invite|approve|reject|cancel|complete|reopen|assign)([_-]|$)/i;
// Tools whose runtime is measured in minutes, not seconds — they get deferred to the background
// job queue when called in a live turn so the turn doesn't time out. Image/video generation is
// the canonical case. A per-connection `deferred` flag overrides this heuristic either way.
const SLOW_NAME = /(generate_image|generate_ad_set|generate_video|edit_image|txt2img|img2img|render_|_render|upscale|animate|diffusion|synthesi[sz]e)/i;
function toolIsDeferred(connection, tool) {
  if (connection && connection.deferred === true) return true;   // explicit opt-in: ALL of this connection's tools
  if (connection && connection.deferred === false) return false; // explicit opt-out
  return SLOW_NAME.test((tool && tool.name) || '');              // else: per-tool name heuristic (precise)
}

function clampText(value, max = 500) { return value == null ? '' : String(value).slice(0, max); }

function deriveKey(secret) {
  if (!secret) throw new Error('MCP credential encryption requires MCP_CREDENTIALS_ENCRYPTION_KEY or NORA_API_KEY');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptObject(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptObject(value, key) {
  if (!value) return {};
  if (typeof value === 'object') return { ...value };
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('Unsupported encrypted MCP credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8'));
}

function privateIp(address) {
  if (!address) return true;
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

async function validateMcpUrl(value, { resolveDns = true } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('MCP URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:') throw new Error('MCP URL must use HTTPS');
  if (url.username || url.password) throw new Error('Credentials in URL userinfo are not supported');
  if (url.hostname === 'localhost' || privateIp(url.hostname)) throw new Error('MCP URL cannot target localhost or a private network');
  if (resolveDns && !net.isIP(url.hostname)) {
    const results = await dns.lookup(url.hostname, { all: true });
    if (!results.length || results.some(item => privateIp(item.address))) throw new Error('MCP URL resolved to a private network');
  }
  return url;
}

function urlHint(value, authType) {
  try {
    const url = new URL(value);
    if (authType === 'url_token') return `${url.origin}/…/••••`;
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|auth|signature/i.test(key)) url.searchParams.set(key, '••••');
    return url.toString();
  } catch { return '(invalid URL)'; }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName).trim();
    const lower = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name) || BLOCKED_HEADERS.has(lower)) throw new Error(`Header ${name || '(blank)'} is not allowed`);
    if (typeof rawValue !== 'string' || rawValue.length > 4000) throw new Error(`Header ${name} must be a string under 4000 characters`);
    out[name] = rawValue;
  }
  return out;
}

function safeToolName(connection, toolName) {
  const prefix = `mcp_${String(connection.name || connection.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20)}_`;
  const suffix = String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(`${connection.id}:${toolName}`).digest('hex').slice(0, 6);
  return `${(prefix + suffix).slice(0, 57)}_${hash}`;
}

function withAbortableTimeout(operation, ms, label, parentSignal) {
  const controller = new AbortController();
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const relayAbort = () => {
    const reason = parentSignal?.reason || new Error(`${label} aborted`);
    controller.abort(reason);
    rejectAbort(reason);
  };
  if (parentSignal?.aborted) relayAbort();
  else parentSignal?.addEventListener('abort', relayAbort, { once: true });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
    timer.unref?.();
  });
  const work = controller.signal.aborted
    ? Promise.reject(controller.signal.reason)
    : Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([work, timeout, aborted]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', relayAbort);
  });
}

function toolIsWriteCapable(tool) {
  return tool.annotations?.readOnlyHint === false
    || tool.annotations?.destructiveHint === true
    || WRITE_NAME.test(tool.name || '');
}

function toolIsAllowed(connection, tool) {
  const writeCapable = toolIsWriteCapable(tool);
  // Nora observes and routes work across Fleet, but never administers Fleet from
  // a conversational surface. A direct Slack or meeting request can enable
  // writes for other MCPs, so the Fleet connection needs its own hard ceiling
  // even when its saved access mode is accidentally set to full.
  if (isFleetConnection(connection) && writeCapable) return false;
  if (connection.access_mode === 'full') return true;
  return !writeCapable;
}

function createMcpManager({ loadConnections, saveConnections, encryptionSecret, clock = () => new Date(), connectFactory, resolveDns = true, authFn = auth, onToolSuccess = null }) {
  const key = deriveKey(encryptionSecret);
  const clients = new Map();
  const oauthStates = new Map();

  function listRaw() { return (loadConnections() || []).map(item => ({ ...item })); }
  async function persistList(list) { await Promise.resolve(saveConnections(list)); }
  function findRaw(id) { return listRaw().find(item => item.id === id) || null; }
  function secretsFor(connection) {
    const secrets = decryptObject(connection.secrets_encrypted, key);
    if (connection.token && !secrets.token) secrets.token = connection.token;
    if (connection.url && !secrets.url) secrets.url = connection.url;
    return secrets;
  }
  async function saveSecrets(connection, secrets) {
    const list = listRaw();
    const index = list.findIndex(item => item.id === connection.id);
    if (index < 0) throw new Error('MCP connection not found');
    list[index] = { ...list[index], secrets_encrypted: encryptObject(secrets, key) };
    delete list[index].token; delete list[index].url;
    await persistList(list);
    Object.assign(connection, list[index]);
  }
  async function patchConnection(id, changes) {
    const list = listRaw(); const index = list.findIndex(item => item.id === id);
    if (index < 0) throw new Error('MCP connection not found');
    list[index] = { ...list[index], ...changes, updated: clock().toISOString() };
    await persistList(list); return list[index];
  }
  async function invalidateClient(id) {
    const cached = clients.get(id); clients.delete(id);
    if (cached) { try { await cached.client.close(); } catch {} }
  }

  function publicConnection(connection) {
    const secrets = secretsFor(connection);
    const authType = AUTH_TYPES.has(connection.auth_type) ? connection.auth_type : (secrets.token ? 'bearer' : 'none');
    const tokens = secrets.oauth_tokens || {};
    const credentialSet = !!(authType === 'url_token' || secrets.token || secrets.client_secret
      || Object.keys(secrets.headers || {}).length || tokens.access_token);
    const missingRequiredCredential = authType !== 'none' && !credentialSet;
    return {
      id: connection.id, name: connection.name, url_hint: urlHint(secrets.url || '', authType), auth_type: authType,
      financial: !!connection.financial, enabled: connection.enabled !== false,
      access_mode: isFleetConnection(connection) ? 'read_only' : (connection.access_mode || 'read_only'),
      deferred: connection.deferred === undefined ? null : connection.deferred, // null = name-heuristic default
      credential_set: credentialSet,
      oauth_connected: !!tokens.access_token, oauth_expires_at: connection.oauth_expires_at || null,
      status: missingRequiredCredential ? 'needs_authorization' : connection.status || 'untested',
      status_message: missingRequiredCredential ? 'A saved credential is required before this connection can run.' : connection.status_message || '',
      tools: (connection.tools || []).map(tool => ({ name: tool.name, description: tool.description || '', allowed: toolIsAllowed(connection, tool), annotations: tool.annotations || {} })),
      last_tested: connection.last_tested || null, created: connection.created || null,
    };
  }

  function safeErrorMessage(error, connection) {
    let message = clampText(error?.message || 'Connection failed', 1000);
    const secrets = secretsFor(connection);
    for (const value of [secrets.url, secrets.token, secrets.client_secret, secrets.oauth_tokens?.access_token, secrets.oauth_tokens?.refresh_token, ...Object.values(secrets.headers || {})]) {
      if (value && String(value).length >= 4) message = message.split(String(value)).join('[redacted]');
    }
    return clampText(message, 500);
  }

  async function create(input = {}) {
    const name = clampText(input.name, 60).trim();
    if (!name || !input.url) throw new Error('name and url are required');
    if (listRaw().some(item => String(item.name).toLowerCase() === name.toLowerCase())) throw new Error('connection name must be unique');
    const authType = AUTH_TYPES.has(input.auth_type) ? input.auth_type : 'none';
    const url = await validateMcpUrl(input.url, { resolveDns });
    const secrets = { url: url.toString() };
    if (authType === 'bearer') {
      secrets.token = clampText(input.token, 8000);
      if (!secrets.token) throw new Error('bearer token is required');
    }
    if (authType === 'custom_headers') {
      secrets.headers = sanitizeHeaders(input.headers);
      if (!Object.keys(secrets.headers).length) throw new Error('at least one custom header is required');
    }
    if (authType === 'oauth' || authType === 'client_credentials') {
      secrets.client_secret = clampText(input.client_secret, 4000);
      secrets.client_information = input.client_id ? { client_id: clampText(input.client_id, 1000), ...(secrets.client_secret ? { client_secret: secrets.client_secret } : {}) } : undefined;
    }
    if (authType === 'client_credentials' && !input.client_id) throw new Error('client_id is required for client credentials');
    if (authType === 'client_credentials' && !secrets.client_secret) throw new Error('client_secret is required for client credentials');
    const entry = {
      id: `mcp-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, name, auth_type: authType,
      secrets_encrypted: encryptObject(secrets, key), scopes: clampText(input.scopes, 1000),
      financial: !!input.financial, enabled: input.enabled !== false, access_mode: input.access_mode === 'full' ? 'full' : 'read_only',
      deferred: input.deferred === undefined ? undefined : !!input.deferred,
      status: authType === 'oauth' ? 'needs_authorization' : 'untested', status_message: '', tools: [],
      created: clock().toISOString(), updated: clock().toISOString(),
    };
    const list = listRaw(); list.push(entry); await persistList(list); return publicConnection(entry);
  }

  async function update(id, input = {}) {
    const connection = findRaw(id); if (!connection) return null;
    const secrets = secretsFor(connection);
    const changes = {};
    if (input.name !== undefined) {
      changes.name = clampText(input.name, 60).trim();
      if (!changes.name) throw new Error('name cannot be blank');
      if (listRaw().some(item => item.id !== id && String(item.name).toLowerCase() === changes.name.toLowerCase())) throw new Error('connection name must be unique');
    }
    if (input.url) { secrets.url = (await validateMcpUrl(input.url, { resolveDns })).toString(); changes.tools = []; changes.status = 'untested'; }
    if (input.auth_type && AUTH_TYPES.has(input.auth_type)) { changes.auth_type = input.auth_type; changes.status = input.auth_type === 'oauth' ? 'needs_authorization' : 'untested'; }
    const authType = changes.auth_type || connection.auth_type || 'none';
    if (input.token) secrets.token = clampText(input.token, 8000);
    if (input.headers) secrets.headers = sanitizeHeaders(input.headers);
    if (input.client_id) secrets.client_information = { ...(secrets.client_information || {}), client_id: clampText(input.client_id, 1000) };
    if (input.client_secret) { secrets.client_secret = clampText(input.client_secret, 4000); secrets.client_information = { ...(secrets.client_information || {}), client_secret: secrets.client_secret }; }
    if (input.scopes !== undefined) changes.scopes = clampText(input.scopes, 1000);
    if (input.financial !== undefined) changes.financial = !!input.financial;
    if (input.enabled !== undefined) changes.enabled = !!input.enabled;
    if (input.access_mode !== undefined) changes.access_mode = input.access_mode === 'full' ? 'full' : 'read_only';
    if (input.deferred !== undefined) changes.deferred = input.deferred === null ? null : !!input.deferred; // null = fall back to name heuristic
    if (authType !== 'oauth' && input.clear_oauth) { delete secrets.oauth_tokens; delete secrets.code_verifier; delete secrets.discovery_state; }
    if (authType === 'bearer' && !secrets.token) throw new Error('bearer token is required');
    if (authType === 'custom_headers' && !Object.keys(secrets.headers || {}).length) throw new Error('at least one custom header is required');
    if (authType === 'client_credentials' && !secrets.client_information?.client_id) throw new Error('client_id is required for client credentials');
    if (authType === 'client_credentials' && !secrets.client_secret) throw new Error('client_secret is required for client credentials');
    changes.secrets_encrypted = encryptObject(secrets, key);
    const updated = await patchConnection(id, changes); await invalidateClient(id); return publicConnection(updated);
  }

  async function remove(id) {
    const list = listRaw(); const index = list.findIndex(item => item.id === id); if (index < 0) return null;
    const [removed] = list.splice(index, 1); await persistList(list); await invalidateClient(id); return publicConnection(removed);
  }

  async function migrate() {
    const list = listRaw(); let changed = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item.url && !item.token) continue;
      const secrets = decryptObject(item.secrets_encrypted, key);
      if (item.url) secrets.url = item.url;
      if (item.token) secrets.token = item.token;
      list[i] = { ...item, auth_type: item.auth_type || (item.token ? 'bearer' : 'none'), secrets_encrypted: encryptObject(secrets, key), updated: clock().toISOString() };
      delete list[i].url; delete list[i].token; changed = true;
    }
    if (changed) await persistList(list);
    return changed;
  }

  function makeOAuthProvider(connection, callbackUrl, state) {
    const provider = {
      authorizationUrl: null,
      get redirectUrl() { return connection.auth_type === 'client_credentials' ? undefined : callbackUrl; },
      get clientMetadata() {
        const grant = connection.auth_type === 'client_credentials' ? ['client_credentials'] : ['authorization_code', 'refresh_token'];
        const hasSecret = !!secretsFor(connection).client_secret;
        return { client_name: 'Nora PM Agent', redirect_uris: connection.auth_type === 'client_credentials' ? [] : [callbackUrl], grant_types: grant, response_types: connection.auth_type === 'client_credentials' ? [] : ['code'], token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none', scope: connection.scopes || undefined };
      },
      state: async () => state || crypto.randomBytes(24).toString('base64url'),
      clientInformation: async () => secretsFor(connection).client_information,
      saveClientInformation: async info => { const s = secretsFor(connection); s.client_information = info; await saveSecrets(connection, s); },
      tokens: async () => secretsFor(connection).oauth_tokens,
      saveTokens: async tokens => {
        const s = secretsFor(connection); s.oauth_tokens = tokens; await saveSecrets(connection, s);
        const expires = tokens.expires_in ? new Date(clock().getTime() + Number(tokens.expires_in) * 1000).toISOString() : null;
        await patchConnection(connection.id, { oauth_expires_at: expires, status: 'connected', status_message: '' });
      },
      redirectToAuthorization: async url => { provider.authorizationUrl = url.toString(); },
      saveCodeVerifier: async verifier => { const s = secretsFor(connection); s.code_verifier = verifier; await saveSecrets(connection, s); },
      codeVerifier: async () => { const value = secretsFor(connection).code_verifier; if (!value) throw new Error('OAuth verifier is missing or expired'); return value; },
      saveDiscoveryState: async discovery => { const s = secretsFor(connection); s.discovery_state = discovery; await saveSecrets(connection, s); },
      discoveryState: async () => secretsFor(connection).discovery_state,
      invalidateCredentials: async scope => {
        const s = secretsFor(connection);
        if (scope === 'all' || scope === 'tokens') delete s.oauth_tokens;
        if (scope === 'all' || scope === 'verifier') delete s.code_verifier;
        if (scope === 'all' || scope === 'client') delete s.client_information;
        if (scope === 'all' || scope === 'discovery') delete s.discovery_state;
        await saveSecrets(connection, s);
      },
    };
    if (connection.auth_type === 'client_credentials') provider.prepareTokenRequest = async scope => new URLSearchParams({ grant_type: 'client_credentials', ...(scope || connection.scopes ? { scope: scope || connection.scopes } : {}) });
    return provider;
  }

  async function startOAuth(id, callbackUrl) {
    const connection = findRaw(id); if (!connection) throw new Error('MCP connection not found');
    if (connection.auth_type !== 'oauth') throw new Error('Connection is not configured for OAuth authorization code flow');
    await validateMcpUrl(secretsFor(connection).url, { resolveDns });
    const state = crypto.randomBytes(24).toString('base64url'); oauthStates.set(state, { id, created: Date.now(), callbackUrl });
    const pendingSecrets = secretsFor(connection);
    pendingSecrets.oauth_pending = { state, created: Date.now(), callbackUrl };
    await saveSecrets(connection, pendingSecrets);
    const provider = makeOAuthProvider(connection, callbackUrl, state);
    try {
      const result = await authFn(provider, { serverUrl: secretsFor(connection).url, scope: connection.scopes || undefined });
      if (result !== 'REDIRECT' || !provider.authorizationUrl) throw new Error('MCP server did not provide an interactive OAuth authorization flow');
      await patchConnection(id, { status: 'authorizing', status_message: 'Waiting for OAuth consent' });
      return provider.authorizationUrl;
    } catch (error) {
      oauthStates.delete(state);
      const cleanup = secretsFor(connection); delete cleanup.oauth_pending; await saveSecrets(connection, cleanup);
      const message = safeErrorMessage(error, connection);
      await patchConnection(id, { status: 'error', status_message: message });
      throw new Error(message);
    }
  }

  async function finishOAuth({ state, code }) {
    let pending = oauthStates.get(state); oauthStates.delete(state);
    if (!pending) {
      for (const candidate of listRaw()) {
        const stored = secretsFor(candidate).oauth_pending;
        if (stored?.state === state) { pending = { id: candidate.id, created: stored.created, callbackUrl: stored.callbackUrl }; break; }
      }
    }
    if (!pending || Date.now() - pending.created > 10 * 60 * 1000) throw new Error('OAuth state is invalid or expired');
    const connection = findRaw(pending.id); if (!connection) throw new Error('MCP connection not found');
    const consumed = secretsFor(connection); delete consumed.oauth_pending; await saveSecrets(connection, consumed);
    const provider = makeOAuthProvider(connection, pending.callbackUrl, state);
    try {
      const result = await authFn(provider, { serverUrl: secretsFor(connection).url, authorizationCode: code, scope: connection.scopes || undefined });
      if (result !== 'AUTHORIZED') throw new Error('OAuth token exchange did not complete');
      await patchConnection(connection.id, { status: 'connected', status_message: '' });
      return connection.id;
    } catch (error) {
      const message = safeErrorMessage(error, connection);
      await patchConnection(connection.id, { status: 'error', status_message: message });
      throw new Error(message);
    }
  }

  function requestOptions(connection, callbackUrl) {
    const secrets = secretsFor(connection); const headers = {};
    let authProvider;
    if (connection.auth_type === 'bearer' && secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
    if (connection.auth_type === 'custom_headers') Object.assign(headers, sanitizeHeaders(secrets.headers));
    if (connection.auth_type === 'oauth' || connection.auth_type === 'client_credentials') authProvider = makeOAuthProvider(connection, callbackUrl || 'https://invalid.local/admin/mcp/oauth/callback');
    return { headers, authProvider };
  }

  async function defaultConnect(connection, callbackUrl, { signal, timeout = 12000 } = {}) {
    const url = new URL(secretsFor(connection).url);
    const { headers, authProvider } = requestOptions(connection, callbackUrl);
    const attempts = [
      () => new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider }),
      () => new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init = {}) => fetch(input, { ...init, headers: { ...headers, ...(init.headers || {}) } }) }, authProvider }),
    ];
    let lastError;
    const startedAt = Date.now();
    for (let index = 0; index < attempts.length; index++) {
      const makeTransport = attempts[index];
      const remaining = timeout - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const attemptBudget = Math.max(1, Math.floor(remaining / (attempts.length - index)));
      const client = new Client({ name: 'nora-pm-agent', version: '1.0.0' }, { capabilities: {} });
      const transport = makeTransport();
      try {
        await withAbortableTimeout(connectSignal => client.connect(transport, {
          signal: connectSignal, timeout: attemptBudget, maxTotalTimeout: attemptBudget,
        }), attemptBudget, 'MCP connection', signal);
        return { client, transport };
      }
      catch (error) { lastError = error; try { await client.close(); } catch {} if (error instanceof UnauthorizedError) throw error; }
    }
    throw lastError || new Error('Unable to connect to MCP server');
  }

  async function getClient(connection, { signal, timeout = 12000 } = {}) {
    const cached = clients.get(connection.id);
    if (cached && cached.expires > Date.now()) return cached;
    if (cached) await invalidateClient(connection.id);
    if (!connectFactory) await validateMcpUrl(secretsFor(connection).url, { resolveDns });
    const connected = await (connectFactory
      ? connectFactory(connection, secretsFor(connection), { signal, timeout })
      : defaultConnect(connection, undefined, { signal, timeout }));
    const entry = { ...connected, expires: Date.now() + 5 * 60 * 1000 }; clients.set(connection.id, entry); return entry;
  }

  async function listAllTools(client) {
    const tools = []; let cursor;
    do { const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 12000 }); tools.push(...(page.tools || [])); cursor = page.nextCursor; } while (cursor && tools.length < 500);
    return tools.slice(0, 500);
  }

  async function testConnection(id) {
    const connection = findRaw(id); if (!connection) throw new Error('MCP connection not found');
    try {
      await invalidateClient(id); const { client } = await getClient(connection); const tools = await listAllTools(client);
      const catalog = tools.map(tool => ({ name: clampText(tool.name, 200), description: clampText(tool.description, 1200), inputSchema: tool.inputSchema || { type: 'object', properties: {} }, annotations: tool.annotations || {} }));
      const updated = await patchConnection(id, { tools: catalog, status: 'connected', status_message: `${catalog.length} tool${catalog.length === 1 ? '' : 's'} available`, last_tested: clock().toISOString() });
      return publicConnection(updated);
    } catch (error) {
      const message = error instanceof UnauthorizedError ? 'Authorization required or expired' : safeErrorMessage(error, connection);
      await patchConnection(id, { status: error instanceof UnauthorizedError ? 'needs_authorization' : 'error', status_message: message, last_tested: clock().toISOString() });
      throw new Error(message);
    }
  }

  // timeout is the OUTER cap. Live turns use the default (~16s, so a live reply never stalls);
  // the background job worker passes a generous timeout for deferred tools like ImageGen.
  async function callTool(connectionId, toolName, args, { timeout = 16000, signal } = {}) {
    const connection = findRaw(connectionId); if (!connection || connection.enabled === false) throw new Error('MCP connection is unavailable');
    const catalogTool = (connection.tools || []).find(tool => tool.name === toolName);
    if (!catalogTool || !toolIsAllowed(connection, catalogTool)) throw new Error('MCP tool is not allowed for this connection');
    let entry;
    const startedAt = Date.now();
    try {
      const result = await withAbortableTimeout(async toolSignal => {
        entry = await getClient(connection, { signal: toolSignal, timeout });
        const remaining = Math.max(1, timeout - (Date.now() - startedAt));
        return entry.client.callTool({ name: toolName, arguments: args || {} }, undefined,
          { timeout: remaining, maxTotalTimeout: remaining, signal: toolSignal });
      }, timeout, 'MCP tool call', signal);
      if (result?.isError !== true && typeof onToolSuccess === 'function') {
        Promise.resolve(onToolSuccess({ connectionName: connection.name, toolName, args: args || {}, result,
          writeCapable: toolIsWriteCapable(catalogTool) }))
          .catch(() => {});
      }
      return result;
    }
    catch (error) { await invalidateClient(connectionId); throw error; }
  }

  function bindings({ financialApproved = false, voice = false, allowWrites = false } = {}) {
    const claudeTools = [], openaiTools = [], executors = {}, inventory = [], meta = {};
    for (const connection of listRaw()) {
      if (connection.enabled === false || connection.status !== 'connected' || (connection.financial && !financialApproved)) continue;
      for (const tool of connection.tools || []) {
        if (!toolIsAllowed(connection, tool)) continue;
        const writeCapable = toolIsWriteCapable(tool);
        if ((voice || !allowWrites) && writeCapable) continue;
        const name = safeToolName(connection, tool.name);
        const description = `[${connection.name}] ${tool.description || tool.name}`.slice(0, 1000);
        const schema = tool.inputSchema || { type: 'object', properties: {} };
        claudeTools.push({ name, description, input_schema: schema });
        openaiTools.push({ type: 'function', name, description, parameters: schema });
        executors[name] = (args, options = {}) => callTool(connection.id, tool.name, args,
          { timeout: options.timeoutMs || 16000, signal: options.signal });
        // meta lets a live turn recognize a deferred tool and enqueue it (by connection + real
        // tool name) instead of running it inline; the background worker runs it via callTool.
        meta[name] = { connectionId: connection.id, toolName: tool.name, connectionName: connection.name, deferred: toolIsDeferred(connection, tool), accessMode: writeCapable ? 'write' : 'read' };
        inventory.push({ connection: connection.name, tool: tool.name, name, access_mode: connection.access_mode || 'read_only', deferred: meta[name].deferred });
      }
    }
    return { claudeTools, openaiTools, executors, inventory, meta };
  }

  return {
    list: () => listRaw().map(publicConnection), create, update, remove, migrate, startOAuth, finishOAuth,
    testConnection, callTool, bindings, publicConnection,
    __test: { encryptObject: value => encryptObject(value, key), decryptObject: value => decryptObject(value, key), validateMcpUrl: value => validateMcpUrl(value, { resolveDns }), urlHint, sanitizeHeaders, toolIsAllowed, safeToolName,
      requestOptions: (id, callbackUrl) => { const connection = findRaw(id); return connection ? requestOptions(connection, callbackUrl) : null; } },
  };
}

module.exports = { AUTH_TYPES, SLOW_NAME, createMcpManager, validateMcpUrl, urlHint, sanitizeHeaders, toolIsAllowed, toolIsDeferred };
