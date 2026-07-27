'use strict';

const crypto = require('crypto');
let warnedLegacyQueryAuth = false;

function isProductionEnvironment(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return true;
  if (String(env.NORA_ENV || '').toLowerCase() === 'production') return true;
  return Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
}

function timingSafeStringEqual(provided, expected) {
  const providedBytes = Buffer.from(String(provided || ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected || ''), 'utf8');
  return providedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

function configuredEvaluatorKeys(env = process.env) {
  const configured = [];
  if (env.NORA_EVALUATOR_KEYS) {
    try {
      const parsed = JSON.parse(env.NORA_EVALUATOR_KEYS);
      for (const [id, key] of Object.entries(parsed || {})) {
        if (id && key) configured.push([String(id), String(key)]);
      }
    } catch {
      for (const entry of String(env.NORA_EVALUATOR_KEYS).split(',')) {
        const separator = entry.indexOf(':');
        if (separator > 0) {
          const id = entry.slice(0, separator).trim();
          const key = entry.slice(separator + 1).trim();
          if (id && key) configured.push([id, key]);
        }
      }
    }
  }
  if (env.NORA_EVALUATOR_KEY) {
    configured.push(['evaluator-1', String(env.NORA_EVALUATOR_KEY)]);
  }
  return configured;
}

function configuredCredentialEntries(env = process.env) {
  const entries = [
    ['shared_api', 'NORA_API_KEY', env.NORA_API_KEY],
    ['server_internal', 'NORA_INTERNAL_KEY', env.NORA_INTERNAL_KEY],
    ['nora_autonomy', 'NORA_AUTONOMY_KEY', env.NORA_AUTONOMY_KEY],
    ['research', 'NORA_RESEARCH_KEY', env.NORA_RESEARCH_KEY],
    ['operator', 'DASHBOARD_PASSWORD', env.DASHBOARD_PASSWORD],
  ].filter(([, , value]) => typeof value === 'string' && value.length > 0)
    .map(([scope, source, value]) => ({ scope, source, value }));
  for (const [id, value] of configuredEvaluatorKeys(env)) {
    entries.push({
      scope: 'evaluator',
      source: `NORA_EVALUATOR_KEYS:${String(id).slice(0, 80)}`,
      value,
    });
  }
  return entries;
}

function credentialConfigurationAudit(env = process.env) {
  const byValue = new Map();
  for (const entry of configuredCredentialEntries(env)) {
    const group = byValue.get(entry.value) || [];
    group.push(entry);
    byValue.set(entry.value, group);
  }
  const collisions = [];
  for (const entries of byValue.values()) {
    const scopes = [...new Set(entries.map(entry => entry.scope))].sort();
    if (scopes.length < 2) continue;
    collisions.push({
      scopes,
      sources: [...new Set(entries.map(entry => entry.source))].sort(),
    });
  }
  collisions.sort((left, right) => left.scopes.join(':').localeCompare(right.scopes.join(':')));
  return {
    valid: collisions.length === 0,
    collision_count: collisions.length,
    collisions,
  };
}

function rejectCredentialCollision(res) {
  const audit = credentialConfigurationAudit();
  if (audit.valid) return false;
  res.status(503).json({
    error: 'authentication is unavailable because configured credentials overlap authority scopes',
    code: 'credential_scope_collision',
    conflicting_scopes: audit.collisions.map(item => item.scopes),
  });
  return true;
}

function requireAuth(req, res, next) {
  if (rejectCredentialCollision(res)) return;
  const apiKey = process.env.NORA_API_KEY;
  const production = isProductionEnvironment();
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const bearerPrincipals = [
    { key: process.env.NORA_INTERNAL_KEY, kind: 'server_internal', id: 'nora-server' },
    { key: process.env.NORA_AUTONOMY_KEY, kind: 'nora_autonomy', id: 'nora-cowork' },
    { key: apiKey, kind: 'shared_api', id: 'shared-api-client' },
  ].filter(item => item.key);
  const dashboardSessionConfigured = Boolean(operatorSecret());
  if (!bearerPrincipals.length && !dashboardSessionConfigured) {
    if (!production) {
      req.principal = { kind: 'local_development', id: 'local-development',
        authentication: 'development_open' };
      return next(); // explicitly local development remains frictionless
    }
    return res.status(503).json({
      error: 'API authentication is unavailable until a Nora API, autonomy, internal, or dashboard key is configured',
    });
  }
  // Query-string credentials can leak through browser history, reverse-proxy logs, and referrers.
  // Hosted deployments reject them by default. A short migration window is available only
  // through an explicit opt-in; local tests retain compatibility unless explicitly disabled.
  const queryAuthAllowed = process.env.NORA_ALLOW_LEGACY_QUERY_AUTH === '1'
    || (!production && process.env.NORA_ALLOW_LEGACY_QUERY_AUTH !== '0');
  const legacyQueryKey = queryAuthAllowed ? String(req.query?.key || '') : '';
  if (production && legacyQueryKey && !warnedLegacyQueryAuth) {
    warnedLegacyQueryAuth = true;
    console.warn('Legacy query-string API authentication was used; migrate this caller to Bearer auth and remove NORA_ALLOW_LEGACY_QUERY_AUTH=1');
  }
  if (bearer) {
    if (dashboardSessionConfigured && verifyOperatorToken(bearer)) {
      req.principal = { kind: 'dashboard_operator', id: 'dashboard_operator',
        authentication: 'signed_dashboard_bearer' };
      return next();
    }
    const principal = bearerPrincipals.find(candidate =>
      timingSafeStringEqual(bearer, candidate.key));
    if (principal) {
      req.principal = { kind: principal.kind, id: principal.id, authentication: 'bearer' };
      return next();
    }
  } else if (legacyQueryKey && apiKey && timingSafeStringEqual(legacyQueryKey, apiKey)) {
    req.principal = { kind: 'legacy_query', id: 'shared-api-client',
      authentication: 'query_string' };
    return next();
  }
  return res.status(401).json({ error: production && !queryAuthAllowed
    ? 'unauthorized — provide an Authorization: Bearer header'
    : 'unauthorized — provide ?key= or an Authorization: Bearer header' });
}

function requireResearchAuth(req, res, next) {
  if (rejectCredentialCollision(res)) return;
  const expected = process.env.NORA_RESEARCH_KEY;
  if (!expected) return res.status(503).json({ error: 'research operations are disabled until NORA_RESEARCH_KEY is configured' });
  const provided = String(req.headers['x-nora-research-key'] || '');
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes)) {
    req.principal = { kind: 'research', id: 'research-harness',
      authentication: 'research_key' };
    return next();
  }
  return res.status(401).json({ error: 'unauthorized research harness' });
}

function requireEvaluatorAuth(req, res, next) {
  if (rejectCredentialCollision(res)) return;
  const configured = configuredEvaluatorKeys();
  if (!configured.length) return res.status(503).json({ error: 'independent evaluation is disabled until NORA_EVALUATOR_KEY or NORA_EVALUATOR_KEYS is configured' });
  const provided = String(req.headers['x-nora-evaluator-key'] || '');
  const providedBytes = Buffer.from(provided);
  for (const [id, expected] of configured) {
    const expectedBytes = Buffer.from(expected);
    if (expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes)) {
      req.evaluatorId = id;
      req.principal = { kind: 'evaluator', id, authentication: 'evaluator_key' };
      return next();
    }
  }
  return res.status(401).json({ error: 'unauthorized blinded evaluator' });
}

// Basic auth middleware for the dashboard UI pages. Username is ignored (any value works);
// the password check is against DASHBOARD_PASSWORD env var. If unset, auth is skipped (dev).
//
// This protects /, /instructions, /architecture from unauthenticated browsing. Once a user
// passes Basic auth, the dashboard HTML is rendered with NORA_API_KEY embedded so the
// dashboard JS can call API endpoints with the key.
function requireDashboardAuth(req, res, next) {
  if (rejectCredentialCollision(res)) return;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    if (!isProductionEnvironment()) {
      req.principal = { kind: 'local_dashboard', id: 'local-dashboard',
        authentication: 'development_open' };
      return next(); // no password configured = open access (dev)
    }
    return res.status(503).send('Dashboard authentication is unavailable until DASHBOARD_PASSWORD is configured');
  }
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const provided = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
    if (timingSafeStringEqual(provided, password)) {
      req.principal = { kind: 'dashboard_operator', id: 'dashboard_operator',
        authentication: 'basic_password' };
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Nora Dashboard", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

function operatorSecret() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function createOperatorToken({ now = Date.now(), ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  if (!credentialConfigurationAudit().valid) return '';
  const secret = operatorSecret();
  if (!secret) return '';
  const payload = Buffer.from(JSON.stringify({ version: 1, audience: 'nora-dashboard-operator',
    issued_at: now, expires_at: now + ttlMs }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyOperatorToken(token, { now = Date.now() } = {}) {
  if (!credentialConfigurationAudit().valid) return false;
  const secret = operatorSecret();
  if (!secret) return !isProductionEnvironment();
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.audience === 'nora-dashboard-operator' && Number(parsed.issued_at) <= now
      && Number(parsed.expires_at) >= now && Number(parsed.expires_at) - Number(parsed.issued_at) <= 24 * 60 * 60 * 1000;
  } catch { return false; }
}

function requireOperatorAuth(req, res, next) {
  if (rejectCredentialCollision(res)) return;
  if (!operatorSecret()) {
    if (!isProductionEnvironment()) return next();
    return res.status(503).json({ error: 'operator approval is unavailable until DASHBOARD_PASSWORD is configured' });
  }
  const alreadyVerifiedOperator = req.principal?.kind === 'dashboard_operator'
    && ['signed_dashboard_bearer', 'signed_operator_session', 'basic_password']
      .includes(req.principal.authentication);
  if (alreadyVerifiedOperator) {
    req.operatorAuthority = 'dashboard';
    return next();
  }
  if (verifyOperatorToken(req.headers['x-nora-operator-token'])) {
    req.operatorAuthority = 'dashboard';
    req.principal = { kind: 'dashboard_operator', id: 'dashboard_operator',
      authentication: 'signed_operator_session' };
    return next();
  }
  return res.status(401).json({ error: 'operator approval requires a signed dashboard session' });
}

module.exports = { requireAuth, requireDashboardAuth, requireResearchAuth, requireEvaluatorAuth,
  createOperatorToken, verifyOperatorToken, requireOperatorAuth, isProductionEnvironment,
  timingSafeStringEqual, configuredEvaluatorKeys, credentialConfigurationAudit };
