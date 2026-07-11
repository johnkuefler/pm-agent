'use strict';

function requireAuth(req, res, next) {
  const apiKey = process.env.NORA_API_KEY;
  if (!apiKey) return next(); // no key configured = open access (dev)
  const provided = req.query.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided === apiKey) return next();
  return res.status(401).json({ error: 'unauthorized — provide ?key= or Authorization: Bearer header' });
}

// Basic auth middleware for the dashboard UI pages. Username is ignored (any value works);
// the password check is against DASHBOARD_PASSWORD env var. If unset, auth is skipped (dev).
//
// This protects /, /instructions, /architecture from unauthenticated browsing. Once a user
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

module.exports = { requireAuth, requireDashboardAuth };
