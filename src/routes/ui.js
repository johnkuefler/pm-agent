'use strict';

const fs = require('fs');
const path = require('path');

function registerUiRoutes(app, { requireDashboardAuth, rootDir }) {
  function serveDashboardWithKey(filePath, req, res) {
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      const apiKey = process.env.NORA_API_KEY || '';
      res.type('html').send(html.replace('{{NORA_API_KEY}}', apiKey));
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
    res.sendFile(path.join(rootDir, 'instructions.html'));
  });
  
  app.get('/architecture', requireDashboardAuth, (req, res) => {
    res.sendFile(path.join(rootDir, 'architecture.html'));
  });
}

module.exports = { registerUiRoutes };
