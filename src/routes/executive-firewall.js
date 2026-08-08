'use strict';

function errorResponse(res, error) {
  res.status(400).json({ error: String(error?.message || error) });
}

function registerExecutiveFirewallRoutes(app, { requireAuth, requireOperatorAuth, runtime }) {
  app.get('/executive-firewall', requireAuth, (_req, res) => res.json(runtime.snapshot()));

  app.get('/executive-firewall/brief', requireAuth, (_req, res) => {
    res.json(runtime.snapshot().brief);
  });

  app.post('/executive-firewall/intake', requireAuth, async (req, res) => {
    try {
      const result = await runtime.intake(req.body || {});
      res.json({ ok: true, case: result.case, created: result.created,
        material_change: result.material_change, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/attempts', requireAuth, async (req, res) => {
    try {
      const result = await runtime.attempt(req.params.id, req.body || {});
      res.json({ ok: true, case: result.case, attempt: result.attempt, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/decision-packet', requireAuth, async (req, res) => {
    try {
      const result = await runtime.prepareDecision(req.params.id, req.body || {});
      res.json({ ok: true, case: result.case, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/decision', requireOperatorAuth, async (req, res) => {
    try {
      const result = await runtime.decide(req.params.id,
        { ...(req.body || {}), decided_by: req.body?.decided_by || 'John' });
      res.json({ ok: true, case: result.case, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/close', requireAuth, async (req, res) => {
    try {
      const result = await runtime.close(req.params.id, req.body || {});
      res.json({ ok: true, case: result.case, idempotent: result.idempotent,
        metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/dismiss', requireOperatorAuth, async (req, res) => {
    try {
      const result = await runtime.dismiss(req.params.id, req.body || {}, { operator: true });
      res.json({ ok: true, case: result.case, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/cases/:id/feedback', requireOperatorAuth, async (req, res) => {
    try {
      const result = await runtime.feedback(req.params.id, req.body || {});
      res.json({ ok: true, case: result.case, feedback: result.feedback,
        metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/executive-firewall/reconcile', requireOperatorAuth, async (req, res) => {
    try {
      const result = await runtime.cycle({ notify: req.body?.notify === true });
      res.json({ ok: true, ...result });
    } catch (error) { errorResponse(res, error); }
  });

  app.put('/executive-firewall/policy', requireOperatorAuth, async (req, res) => {
    try {
      const result = await runtime.policy(req.body || {});
      res.json({ ok: true, policy: result.policy, metrics: result.metrics });
    } catch (error) { errorResponse(res, error); }
  });
}

module.exports = { registerExecutiveFirewallRoutes };
