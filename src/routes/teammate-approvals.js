'use strict';

function errorResponse(res, error) {
  res.status(400).json({ error: String(error?.message || error) });
}

function registerTeammateApprovalRoutes(app, { requireAuth, runtime }) {
  app.get('/teammate-approvals', requireAuth, (_req, res) => res.json(runtime.snapshot()));

  app.post('/teammate-approvals/proposals', requireAuth, async (req, res) => {
    try {
      const result = await runtime.propose(req.body || {});
      res.json({ ok: true, proposal: result.proposal, created: result.created,
        duplicate: result.duplicate, sent: result.sent, reason: result.reason });
    } catch (error) { errorResponse(res, error); }
  });

  app.post('/teammate-approvals/proposals/:id/cancel', requireAuth, async (req, res) => {
    try {
      const result = await runtime.cancel(req.params.id, req.body?.reason);
      res.json({ ok: true, proposal: result.proposal });
    } catch (error) { errorResponse(res, error); }
  });
}

module.exports = { registerTeammateApprovalRoutes };
