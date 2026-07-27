'use strict';

function registerCognitiveParameterRoutes(app, {
  requireAuth, requireOperatorAuth, isDbReady, snapshot, update, rollback, repairSchema,
}) {
  app.get('/cognitive-parameters', (_req, res) => res.json(snapshot({ includeHistory: false })));

  app.get('/cognitive-parameters/history', requireAuth, (req, res) => {
    const full = req.query.full === 'true';
    res.json(snapshot({ includeHistory: true, fullHistory: full }));
  });

  app.put('/cognitive-parameters', requireAuth, requireOperatorAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const result = await update({
        patch: req.body?.params || req.body?.patch,
        updatedBy: req.principal?.id || 'dashboard_operator',
        note: req.body?.note,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = /autonomous cognitive parameter tuning is disabled/i.test(error.message) ? 403 : 400;
      return res.status(status).json({ error: error.message });
    }
  });

  app.post('/cognitive-parameters/rollback', requireAuth, requireOperatorAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const result = await rollback({
        targetCommitment: req.body?.target_commitment,
        updatedBy: req.principal?.id || 'dashboard_operator',
        note: req.body?.note,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = /autonomous cognitive parameter tuning is disabled/i.test(error.message) ? 403 : 400;
      return res.status(status).json({ error: error.message });
    }
  });

  app.post('/cognitive-parameters/repair-schema', requireAuth, requireOperatorAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const result = await repairSchema({
        updatedBy: req.principal?.id || 'dashboard_operator',
        note: req.body?.note,
      });
      return res.status(result.repaired ? 200 : 409).json({ ok: result.repaired, ...result });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { registerCognitiveParameterRoutes };
