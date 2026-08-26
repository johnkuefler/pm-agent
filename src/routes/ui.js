'use strict';

const fs = require('fs');
const path = require('path');
const { createOperatorToken } = require('../middleware/auth');

function registerUiRoutes(app, { requireDashboardAuth, rootDir }) {
  function serveDashboardWithKey(filePath, req, res) {
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      const apiKey = process.env.NORA_API_KEY || '';
      const operatorToken = createOperatorToken();
      const assetVersion = process.env.RAILWAY_GIT_COMMIT_SHA
        || process.env.GIT_COMMIT
        || Math.floor(fs.statSync(filePath).mtimeMs).toString(36);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html
        .replace('{{NORA_API_KEY}}', apiKey)
        .replace('{{NORA_OPERATOR_TOKEN}}', operatorToken)
        .replaceAll('{{ASSET_VERSION}}', assetVersion));
    } catch (err) {
      console.error('Failed to serve dashboard:', err.message);
      res.status(500).send('dashboard unavailable');
    }
  }

  // The operator dashboard is gated by Basic auth (DASHBOARD_PASSWORD).
  app.get('/', requireDashboardAuth, (req, res) => {
    serveDashboardWithKey(path.join(rootDir, 'dashboard.html'), req, res);
  });
}

module.exports = { registerUiRoutes };
