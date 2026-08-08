'use strict';

function registerFleetSupervisorRoutes(app, {
  requireAuth,
  requireOperatorAuth,
  supervisor,
} = {}) {
  if (!app || !supervisor) throw new Error('app and supervisor are required');

  app.get('/fleet-supervisor', requireAuth, async (req, res) => {
    try { res.json(await supervisor.snapshot()); }
    catch (error) { res.status(503).json({ error: error.message || 'Fleet supervisor unavailable' }); }
  });

  app.post('/fleet-supervisor/scan', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      res.json(await supervisor.scan({ reason: 'dashboard', notify: false }));
    } catch (error) {
      res.status(503).json({ error: error.message || 'Fleet scan failed' });
    }
  });

  app.post('/fleet-supervisor/incidents/:id/acknowledge', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const incident = await supervisor.acknowledge(req.params.id, 'dashboard operator');
      if (!incident) return res.status(404).json({ error: 'Fleet incident not found' });
      res.json({ ok: true, incident });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Fleet incident could not be acknowledged' });
    }
  });
}

module.exports = { registerFleetSupervisorRoutes };
