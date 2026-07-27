'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const { Readable } = require('stream');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { auth, UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

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
  if (!secret) throw new Error('MCP credential encryption requires a stable configured encryption secret');
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

function ipv4Number(address) {
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((value, octet) =>
    ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4InCidr(address, network, prefix) {
  const value = ipv4Number(address);
  const base = ipv4Number(network);
  if (value == null || base == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

const NON_GLOBAL_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv6Words(address) {
  let value = String(address || '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '').split('%')[0];
  if (!value || !value.includes(':')) return null;
  const dotted = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted) {
    if (!net.isIPv4(dotted)) return null;
    const bytes = dotted.split('.').map(Number);
    value = value.slice(0, value.length - dotted.length)
      + `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right]
    .map(part => /^[a-f0-9]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN);
  return words.length === 8 && words.every(Number.isInteger) ? words : null;
}

function privateIp(address) {
  const value = String(address || '').trim().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (net.isIPv4(value)) {
    return NON_GLOBAL_IPV4.some(([network, prefix]) =>
      ipv4InCidr(value, network, prefix));
  }
  if (!net.isIPv6(value)) return false;
  const words = ipv6Words(value);
  if (!words) return true;
  // Reject IPv4-mapped and legacy IPv4-compatible forms even when the embedded
  // address looks public; they are a common parser-disagreement bypass.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return true;
  if (words.slice(0, 6).every(word => word === 0)) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true; // unique-local
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
  if ((words[0] & 0xff00) === 0xff00) return true; // multicast
  if (words[0] === 0x0064 && words[1] === 0xff9b) return true;
  if (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002) return true; // deprecated 6to4 transition space
  if (words[0] === 0x3fff) return true; // documentation space
  // Today globally routed unicast space is 2000::/3. Fail closed for all other
  // special-purpose address families.
  return (words[0] & 0xe000) !== 0x2000;
}

function parseMcpUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('MCP URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:') throw new Error('MCP URL must use HTTPS');
  if (url.username || url.password) throw new Error('Credentials in URL userinfo are not supported');
  if (url.hostname === 'localhost' || privateIp(url.hostname)) throw new Error('MCP URL cannot target localhost or a private network');
  return url;
}

function pinnedDnsLookup(expectedHostname, addresses) {
  const expected = String(expectedHostname || '').toLowerCase();
  return (hostname, options, callback) => {
    if (String(hostname || '').toLowerCase() !== expected) {
      const error = new Error('MCP request hostname changed after validation');
      error.code = 'EACCES';
      return callback(error);
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    const family = Number(opts.family) || 0;
    const candidates = addresses.filter(item => !family || item.family === family);
    if (!candidates.length) {
      const error = new Error('validated MCP address family is unavailable');
      error.code = 'EAI_AGAIN';
      return callback(error);
    }
    if (opts.all) {
      return callback(null, candidates.map(item => ({
        address: item.address, family: item.family,
      })));
    }
    return callback(null, candidates[0].address, candidates[0].family);
  };
}

async function resolveMcpTarget(value, {
  resolveDns = true,
  dnsLookup = dns.lookup,
} = {}) {
  const url = parseMcpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses = null;
  if (resolveDns && !net.isIP(hostname)) {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    addresses = (Array.isArray(results) ? results : [results]).filter(Boolean)
      .map(item => ({
        address: String(item.address || ''),
        family: Number(item.family) || net.isIP(String(item.address || '')),
      }));
    if (!addresses.length || addresses.some(item =>
      ![4, 6].includes(item.family) || privateIp(item.address))) {
      throw new Error('MCP URL resolved to a private network');
    }
  } else if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  }
  return {
    url,
    lookup: addresses ? pinnedDnsLookup(hostname, addresses) : undefined,
    addresses,
  };
}

async function validateMcpUrl(value, options = {}) {
  return (await resolveMcpTarget(value, options)).url;
}

async function pinnedHttpsFetch(input, init = {}) {
  const { lookup, ...requestInit } = init || {};
  const request = input instanceof Request
    ? new Request(input, { ...requestInit, redirect: 'manual' })
    : new Request(input, { ...requestInit, redirect: 'manual', duplex: 'half' });
  const url = new URL(request.url);
  return new Promise((resolve, reject) => {
    const headers = {};
    for (const [name, value] of request.headers) headers[name] = value;
    const outbound = https.request(url, {
      method: request.method,
      headers,
      lookup,
      signal: request.signal,
      agent: false,
    }, response => {
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        const bodyAllowed = request.method !== 'HEAD'
          && ![101, 204, 205, 304].includes(Number(response.statusCode));
        const body = bodyAllowed ? Readable.toWeb(response) : null;
        resolve(new Response(body, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    outbound.once('error', reject);
    if (!request.body) {
      outbound.end();
      return;
    }
    const body = Readable.fromWeb(request.body);
    body.once('error', error => outbound.destroy(error));
    body.pipe(outbound);
  });
}

function createGuardedFetch({
  fetchImpl = pinnedHttpsFetch,
  resolveDns = true,
  dnsLookup = dns.lookup,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('MCP transport requires a fetch implementation');
  return async function guardedFetch(input, init = {}) {
    const requestUrl = input instanceof URL ? input.toString()
      : typeof input === 'string' ? input : input?.url;
    const target = await resolveMcpTarget(requestUrl, { resolveDns, dnsLookup });
    const dispatchInput = input instanceof Request ? input : target.url.toString();
    const response = await fetchImpl(dispatchInput, {
      ...init,
      redirect: 'manual',
      ...(target.lookup ? { lookup: target.lookup } : {}),
    });
    if (response?.status >= 300 && response.status < 400) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error('MCP redirects are disabled; configure the final public HTTPS endpoint');
    }
    return response;
  };
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

function toolIsAllowed(connection, tool) {
  if (connection.access_mode === 'full') return true;
  if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) return false;
  return !WRITE_NAME.test(tool.name || '');
}

function createMcpManager({
  loadConnections,
  saveConnections,
  encryptionSecret,
  clock = () => new Date(),
  connectFactory,
  resolveDns = true,
  authFn = auth,
  fetchImpl = pinnedHttpsFetch,
  dnsLookup = dns.lookup,
}) {
  const key = deriveKey(encryptionSecret);
  const clients = new Map();
  const oauthStates = new Map();
  const guardedFetch = createGuardedFetch({ fetchImpl, resolveDns, dnsLookup });

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
    return {
      id: connection.id, name: connection.name, url_hint: urlHint(secrets.url || '', authType), auth_type: authType,
      financial: !!connection.financial, enabled: connection.enabled !== false, access_mode: connection.access_mode || 'read_only',
      deferred: connection.deferred === undefined ? null : connection.deferred, // null = name-heuristic default
      credential_set: !!(authType === 'url_token' || secrets.token || secrets.client_secret || Object.keys(secrets.headers || {}).length || tokens.access_token),
      oauth_connected: !!tokens.access_token, oauth_expires_at: connection.oauth_expires_at || null,
      status: connection.status || 'untested', status_message: connection.status_message || '',
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
    const url = await validateMcpUrl(input.url, { resolveDns, dnsLookup });
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
    if (input.url) { secrets.url = (await validateMcpUrl(input.url, { resolveDns, dnsLookup })).toString(); changes.tools = []; changes.status = 'untested'; }
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
    await validateMcpUrl(secretsFor(connection).url, { resolveDns, dnsLookup });
    const state = crypto.randomBytes(24).toString('base64url'); oauthStates.set(state, { id, created: Date.now(), callbackUrl });
    const pendingSecrets = secretsFor(connection);
    pendingSecrets.oauth_pending = { state, created: Date.now(), callbackUrl };
    await saveSecrets(connection, pendingSecrets);
    const provider = makeOAuthProvider(connection, callbackUrl, state);
    try {
      const result = await authFn(provider, {
        serverUrl: secretsFor(connection).url,
        scope: connection.scopes || undefined,
        fetchFn: guardedFetch,
      });
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
      const result = await authFn(provider, {
        serverUrl: secretsFor(connection).url,
        authorizationCode: code,
        scope: connection.scopes || undefined,
        fetchFn: guardedFetch,
      });
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
      () => new StreamableHTTPClientTransport(url, {
        requestInit: { headers }, authProvider, fetch: guardedFetch,
      }),
      () => new SSEClientTransport(url, {
        requestInit: { headers }, eventSourceInit: { fetch: guardedFetch },
        authProvider, fetch: guardedFetch,
      }),
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
    if (!connectFactory) {
      await validateMcpUrl(secretsFor(connection).url, { resolveDns, dnsLookup });
    }
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
      return await withAbortableTimeout(async toolSignal => {
        entry = await getClient(connection, { signal: toolSignal, timeout });
        const remaining = Math.max(1, timeout - (Date.now() - startedAt));
        return entry.client.callTool({ name: toolName, arguments: args || {} }, undefined,
          { timeout: remaining, maxTotalTimeout: remaining, signal: toolSignal });
      }, timeout, 'MCP tool call', signal);
    }
    catch (error) { await invalidateClient(connectionId); throw error; }
  }

  function bindings({ financialApproved = false, voice = false, allowWrites = false } = {}) {
    const claudeTools = [], openaiTools = [], executors = {}, inventory = [], meta = {};
    for (const connection of listRaw()) {
      if (connection.enabled === false || connection.status !== 'connected' || (connection.financial && !financialApproved)) continue;
      for (const tool of connection.tools || []) {
        if (!toolIsAllowed(connection, tool)) continue;
        const writeCapable = tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true || WRITE_NAME.test(tool.name || '');
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
    __test: { encryptObject: value => encryptObject(value, key), decryptObject: value => decryptObject(value, key), validateMcpUrl: value => validateMcpUrl(value, { resolveDns, dnsLookup }), guardedFetch, urlHint, sanitizeHeaders, toolIsAllowed, safeToolName,
      requestOptions: (id, callbackUrl) => { const connection = findRaw(id); return connection ? requestOptions(connection, callbackUrl) : null; } },
  };
}

module.exports = {
  AUTH_TYPES,
  SLOW_NAME,
  createMcpManager,
  validateMcpUrl,
  resolveMcpTarget,
  createGuardedFetch,
  pinnedHttpsFetch,
  privateIp,
  urlHint,
  sanitizeHeaders,
  toolIsAllowed,
  toolIsDeferred,
};
