'use strict';

const fs = require('fs');
const path = require('path');
const { createOperatorToken } = require('../middleware/auth');

function escapeHtmlAttribute(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function registerUiRoutes(app, { requireDashboardAuth, rootDir }) {
  function secureOperatorDocument(res, { sensitive = false } = {}) {
    res.setHeader('Cache-Control', sensitive
      ? 'private, no-store, max-age=0'
      : 'private, no-cache, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  }

  function serveDashboardWithKey(filePath, req, res) {
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      const operatorToken = createOperatorToken();
      // Hosted dashboards use a short-lived signed session for ordinary API reads/writes,
      // never the deployment's long-lived shared API key. Local development retains its
      // existing key fallback when dashboard authentication is intentionally absent.
      const apiKey = operatorToken || process.env.NORA_API_KEY || '';
      const assetVersion = process.env.RAILWAY_GIT_COMMIT_SHA
        || process.env.GIT_COMMIT
        || Math.floor(fs.statSync(filePath).mtimeMs).toString(36);
      // The rendered document contains bearer and signed operator capabilities.
      // It must never be retained in browser/proxy caches or framed by another site.
      secureOperatorDocument(res, { sensitive: true });
      res.type('html').send(html
        .replace('{{NORA_API_KEY}}', escapeHtmlAttribute(apiKey))
        .replace('{{NORA_OPERATOR_TOKEN}}', escapeHtmlAttribute(operatorToken))
        .replaceAll('{{ASSET_VERSION}}', encodeURIComponent(assetVersion)));
    } catch (err) {
      console.error('Failed to serve dashboard:', err.message);
      res.status(500).send('dashboard unavailable');
    }
  }

  // Dashboard UI pages — all gated by Basic auth (DASHBOARD_PASSWORD)
  app.get('/', requireDashboardAuth, (req, res) => {
    serveDashboardWithKey(path.join(rootDir, 'dashboard.html'), req, res);
  });

  // Claude instructions page — serves prompt + API docs for scheduled Claude Code sessions
  app.get('/instructions', requireDashboardAuth, (req, res) => {
    secureOperatorDocument(res);
    res.sendFile(path.join(rootDir, 'instructions.html'));
  });

  app.get('/architecture', requireDashboardAuth, (req, res) => {
    secureOperatorDocument(res);
    res.sendFile(path.join(rootDir, 'architecture.html'));
  });
}

module.exports = { escapeHtmlAttribute, registerUiRoutes };
