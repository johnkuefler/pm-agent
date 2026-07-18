'use strict';

function registerCognitiveParameterRoutes(app, {
  requireAuth, isDbReady, snapshot, update, rollback,
}) {
  app.get('/cognitive-parameters', (_req, res) => res.json(snapshot({ includeHistory: false })));

  app.get('/cognitive-parameters/history', requireAuth, (req, res) => {
    const full = req.query.full === 'true';
    res.json(snapshot({ includeHistory: true, fullHistory: full }));
  });

  app.put('/cognitive-parameters', requireAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const result = await update({
        patch: req.body?.params || req.body?.patch,
        updatedBy: req.body?.updated_by,
        note: req.body?.note,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = /autonomous cognitive parameter tuning is disabled/i.test(error.message) ? 403 : 400;
      return res.status(status).json({ error: error.message });
    }
  });

  app.post('/cognitive-parameters/rollback', requireAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const result = await rollback({
        targetCommitment: req.body?.target_commitment,
        updatedBy: req.body?.updated_by || 'human_rollback',
        note: req.body?.note,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = /autonomous cognitive parameter tuning is disabled/i.test(error.message) ? 403 : 400;
      return res.status(status).json({ error: error.message });
    }
  });
}

module.exports = { registerCognitiveParameterRoutes };
