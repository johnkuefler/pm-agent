'use strict';

function registerIntelligenceRoutes(app, { requireAuth, store }) {
  app.get('/intelligence', requireAuth, (req, res) => {
    const state = store.snapshot();
    res.json({
      commitments: { total: state.commitments.length, open: state.commitments.filter(item => item.status === 'open').length },
      episodes: state.episodes.length,
      relationships: state.relationships.length,
      traces: state.traces.length,
      cycles: { total: state.cycles.length, running: state.cycles.filter(item => item.status === 'running').length },
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
    const changes = { ...(req.body || {}), status: req.params.status };
    const commitment = store.updateCommitment(req.params.id, changes);
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
    const reviewed = req.query.reviewed;
    const since = req.query.since ? new Date(req.query.since).getTime() : null;
    res.json(store.list('traces', item => {
      if (reviewed === 'true' && !item.reviewed_at) return false;
      if (reviewed === 'false' && item.reviewed_at) return false;
      if (since && new Date(item.at).getTime() < since) return false;
      return true;
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
  });
  app.post('/decision-traces/:id/outcome', requireAuth, (req, res) => {
    const trace = store.updateTraceOutcome(req.params.id, req.body || {});
    if (!trace) return res.status(404).json({ error: 'decision trace not found' });
    res.json({ ok: true, trace });
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
  app.post('/initiative-budgets/:scope/spend', requireAuth, (req, res) => {
    const budget = store.spendInitiative(req.params.scope, req.body || {});
    if (!budget.allowed) return res.status(409).json({ error: 'initiative budget exhausted', budget });
    res.json({ ok: true, budget });
  });

  app.get('/intelligence/orient', requireAuth, (req, res) => {
    res.json(store.orient({ now: req.query.now }));
  });
  app.get('/intelligence/cycles', requireAuth, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json(store.list('cycles').sort((a, b) => b.started.localeCompare(a.started)).slice(0, limit));
  });
  app.post('/intelligence/cycles', requireAuth, (req, res) => {
    res.json({ ok: true, ...store.startCycle(req.body || {}) });
  });
  app.patch('/intelligence/cycles/:id/complete', requireAuth, (req, res) => {
    const cycle = store.completeCycle(req.params.id, req.body || {});
    if (!cycle) return res.status(404).json({ error: 'intelligence cycle not found' });
    res.json({ ok: true, cycle });
  });
}

module.exports = { registerIntelligenceRoutes };
