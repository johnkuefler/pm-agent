'use strict';

const goodyGifting = require('../gifting/goody');

function publicIntent(intent) {
  return {
    id: intent.id,
    status: intent.status,
    recipient_name: intent.recipient_name,
    recipient_email: intent.recipient_email || null,
    recipient_slack_user_id: intent.recipient_slack_user_id || null,
    delivery_contact_required: intent.delivery_contact_required === true,
    reason_category: intent.reason_category,
    reason: intent.reason,
    amount_cents: intent.amount_cents,
    currency: intent.currency,
    suggested_gift: intent.suggested_gift,
    card_message: intent.card_message || '',
    evidence: intent.evidence || [],
    requires_approval: intent.requires_approval === true,
    request_commitment: intent.request_commitment,
    created_by: intent.created_by,
    created_at: intent.created_at,
    approved_by: intent.approved_by || null,
    approved_at: intent.approved_at || null,
    rejected_by: intent.rejected_by || null,
    rejected_at: intent.rejected_at || null,
    rejection_note: intent.rejection_note || null,
    goody_order_id: intent.goody_order_id || null,
    sent_at: intent.sent_at || null,
  };
}

function registerGiftRoutes(app, deps) {
  const { requireAuth, loadGiftLedger, saveGiftLedger } = deps;

  app.get('/gifts/policy', requireAuth, (_req, res) => {
    const ledger = loadGiftLedger();
    res.json(goodyGifting.policyReport(ledger));
  });

  app.get('/gifts/intents', requireAuth, (req, res) => {
    const ledger = loadGiftLedger();
    const status = req.query.status ? String(req.query.status) : null;
    const intents = status ? ledger.intents.filter(item => item.status === status) : ledger.intents;
    res.json({
      report: goodyGifting.policyReport(ledger),
      count: intents.length,
      intents: intents.slice(-100).map(publicIntent),
    });
  });

  app.get('/gifts/intents/:id', requireAuth, (req, res) => {
    const ledger = loadGiftLedger();
    const intent = ledger.intents.find(item => item.id === req.params.id);
    if (!intent) return res.status(404).json({ error: 'gift intent not found' });
    res.json({ intent: publicIntent(intent), report: goodyGifting.policyReport(ledger) });
  });

  app.post('/gifts/intents', requireAuth, async (req, res) => {
    try {
      const result = goodyGifting.createIntent(req.body || {}, loadGiftLedger());
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/approve', requireAuth, async (req, res) => {
    try {
      const result = goodyGifting.approveIntent(loadGiftLedger(), req.params.id, {
        approvedBy: req.body?.approved_by || 'John',
      });
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/reject', requireAuth, async (req, res) => {
    try {
      const result = goodyGifting.rejectIntent(loadGiftLedger(), req.params.id, {
        rejectedBy: req.body?.rejected_by || 'John',
        note: req.body?.note || '',
      });
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/send', requireAuth, async (req, res) => {
    try {
      const ledger = loadGiftLedger();
      const readiness = goodyGifting.sendReadiness(ledger, req.params.id);
      if (!readiness.ready) return res.status(409).json({
        error: 'goody sending is not enabled',
        reason: readiness.reason,
        proposal_only: true,
      });
      return res.status(501).json({
        error: 'goody send execution is not implemented in this deployment',
        base_url: readiness.base_url,
        reason: 'proposal ledger is live; direct spend remains intentionally gated',
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicIntent, registerGiftRoutes };
