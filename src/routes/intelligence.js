'use strict';

function registerIntelligenceRoutes(app, { requireAuth, store }) {
  app.get('/intelligence', requireAuth, (req, res) => {
    const state = store.snapshot();
    res.json({
      commitments: { total: state.commitments.length, open: state.commitments.filter(item => item.status === 'open').length },
      episodes: state.episodes.length,
      relationships: state.relationships.length,
      traces: state.traces.length,
      experiments: { total: state.experiments.length, active: state.experiments.filter(item => item.status === 'active').length },
      initiative: state.initiative,
    });
  });

  app.get('/commitments', requireAuth, (req, res) => {
    const status = req.query.status;
    res.json(store.list('commitments', item => !status || item.status === status).sort((a, b) => b.updated.localeCompare(a.updated)));
  });
  app.post('/commitments', requireAuth, (req, res) => {
    try { res.json({ ok: true, commitment: store.addCommitment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.put('/commitments/:id', requireAuth, (req, res) => {
    const commitment = store.updateCommitment(req.params.id, req.body || {});
    if (!commitment) return res.status(404).json({ error: 'commitment not found' });
    res.json({ ok: true, commitment });
  });
  app.patch('/commitments/:id/:status', requireAuth, (req, res) => {
    if (!['fulfilled', 'renegotiated', 'dropped', 'open'].includes(req.params.status)) return res.status(400).json({ error: 'invalid status' });
    const commitment = store.updateCommitment(req.params.id, { status: req.params.status, notes: req.body?.notes });
    if (!commitment) return res.status(404).json({ error: 'commitment not found' });
    res.json({ ok: true, commitment });
  });

  app.get('/episodes', requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(store.list('episodes').sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit));
  });
  app.get('/episodes/:id', requireAuth, (req, res) => {
    const episode = store.get('episodes', req.params.id);
    if (!episode) return res.status(404).json({ error: 'episode not found' });
    res.json(episode);
  });
  app.post('/episodes/events', requireAuth, (req, res) => {
    res.json({ ok: true, episode: store.recordEpisodeEvent(req.body || {}) });
  });

  app.get('/relationships', requireAuth, (req, res) => res.json(store.list('relationships').sort((a, b) => a.name.localeCompare(b.name))));
  app.post('/relationships/observe', requireAuth, (req, res) => {
    try { res.json({ ok: true, relationship: store.observeRelationship(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/decision-traces', requireAuth, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json(store.list('traces').sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
  });

  app.get('/learning-experiments', requireAuth, (req, res) => res.json(store.list('experiments').sort((a, b) => b.started.localeCompare(a.started))));
  app.post('/learning-experiments', requireAuth, (req, res) => {
    try { res.json({ ok: true, experiment: store.createExperiment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/learning-experiments/:id/sample', requireAuth, (req, res) => {
    const experiments = store.recordExperimentSample({ ...(req.body || {}), experiment_id: req.params.id });
    if (!experiments.length) return res.status(404).json({ error: 'experiment not found' });
    res.json({ ok: true, experiment: experiments[0] });
  });
  app.post('/learning-experiments/:id/evaluate', requireAuth, (req, res) => {
    const experiment = store.evaluateExperiment(req.params.id, req.body || {});
    if (!experiment) return res.status(404).json({ error: 'experiment not found' });
    res.json({ ok: true, experiment });
  });

  app.get('/initiative-budgets/:scope', requireAuth, (req, res) => res.json(store.initiativeStatus(req.params.scope)));
  app.put('/initiative-budgets/:scope', requireAuth, (req, res) => {
    res.json({ ok: true, budget: store.setInitiativeBudget(req.params.scope, req.body?.daily_limit) });
  });
}

module.exports = { registerIntelligenceRoutes };
