'use strict';

const crypto = require('crypto');

function requireAuth(req, res, next) {
  const apiKey = process.env.NORA_API_KEY;
  if (!apiKey) return next(); // no key configured = open access (dev)
  const provided = req.query.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided === apiKey) return next();
  return res.status(401).json({ error: 'unauthorized — provide ?key= or Authorization: Bearer header' });
}

function requireResearchAuth(req, res, next) {
  const expected = process.env.NORA_RESEARCH_KEY;
  if (!expected) return res.status(503).json({ error: 'research operations are disabled until NORA_RESEARCH_KEY is configured' });
  const provided = String(req.headers['x-nora-research-key'] || '');
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes)) return next();
  return res.status(401).json({ error: 'unauthorized research harness' });
}

function requireEvaluatorAuth(req, res, next) {
  const configured = [];
  if (process.env.NORA_EVALUATOR_KEYS) {
    try {
      const parsed = JSON.parse(process.env.NORA_EVALUATOR_KEYS);
      for (const [id, key] of Object.entries(parsed || {})) if (id && key) configured.push([String(id), String(key)]);
    } catch {
      for (const entry of process.env.NORA_EVALUATOR_KEYS.split(',')) {
        const separator = entry.indexOf(':');
        if (separator > 0) configured.push([entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]);
      }
    }
  }
  if (process.env.NORA_EVALUATOR_KEY) configured.push(['evaluator-1', process.env.NORA_EVALUATOR_KEY]);
  if (!configured.length) return res.status(503).json({ error: 'independent evaluation is disabled until NORA_EVALUATOR_KEY or NORA_EVALUATOR_KEYS is configured' });
  const provided = String(req.headers['x-nora-evaluator-key'] || '');
  const providedBytes = Buffer.from(provided);
  for (const [id, expected] of configured) {
    const expectedBytes = Buffer.from(expected);
    if (expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes)) {
      req.evaluatorId = id;
      return next();
    }
  }
  return res.status(401).json({ error: 'unauthorized blinded evaluator' });
}

// Basic auth middleware for the dashboard UI pages. Username is ignored (any value works);
// the password check is against DASHBOARD_PASSWORD env var. If unset, auth is skipped (dev).
//
// This protects the operator dashboard from unauthenticated browsing. Once a user
// passes Basic auth, the dashboard HTML is rendered with NORA_API_KEY embedded so the
// dashboard JS can call API endpoints with the key.
function requireDashboardAuth(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next(); // no password configured = open access (dev)
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const provided = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
    if (provided === password) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Nora Dashboard", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

function operatorSecret() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function createOperatorToken({ now = Date.now(), ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const secret = operatorSecret();
  if (!secret) return '';
  const payload = Buffer.from(JSON.stringify({ version: 1, audience: 'nora-dashboard-operator',
    issued_at: now, expires_at: now + ttlMs }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyOperatorToken(token, { now = Date.now() } = {}) {
  const secret = operatorSecret();
  if (!secret) return true;
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
  if (!operatorSecret()) return next();
  if (verifyOperatorToken(req.headers['x-nora-operator-token'])) {
    req.operatorAuthority = 'dashboard';
    return next();
  }
  return res.status(401).json({ error: 'operator approval requires a signed dashboard session' });
}

module.exports = { requireAuth, requireDashboardAuth, requireResearchAuth, requireEvaluatorAuth,
  createOperatorToken, verifyOperatorToken, requireOperatorAuth };
