'use strict';

function registerCognitiveParameterStudyRoutes(app, {
  requireResearchAuth, isDbReady, snapshot, create, finalize, abort,
}) {
  app.get('/cognitive-parameter-studies', (_req, res) => res.json(snapshot()));

  app.get('/cognitive-parameter-studies/:id/research', requireResearchAuth, (req, res) => {
    const result = snapshot({ research: true, studyId: req.params.id });
    if (!result.studies.length) return res.status(404).json({ error: 'cognitive parameter study not found' });
    return res.json(result);
  });

  app.post('/cognitive-parameter-studies', requireResearchAuth, (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      return res.status(201).json({ ok: true, study: create(req.body || {}) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/cognitive-parameter-studies/:id/finalize', requireResearchAuth, (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const study = finalize(req.params.id);
      if (!study) return res.status(404).json({ error: 'cognitive parameter study not found' });
      return res.json({ ok: true, study });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/cognitive-parameter-studies/:id/abort', requireResearchAuth, (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active' });
    try {
      const study = abort(req.params.id, { reason: req.body?.reason });
      if (!study) return res.status(404).json({ error: 'cognitive parameter study not found' });
      return res.json({ ok: true, study });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { registerCognitiveParameterStudyRoutes };
