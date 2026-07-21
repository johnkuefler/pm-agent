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
    goody_order_batch_id: intent.goody_order_batch_id || null,
    goody_send_status: intent.goody_send_status || null,
    goody_gift_link: intent.goody_gift_link || null,
    goody_reference_id: intent.goody_reference_id || null,
    goody_customer_reference_id: intent.goody_customer_reference_id || null,
    goody_price_estimate_cents: intent.goody_price_estimate_cents || null,
    goody_send_commitment: intent.goody_send_commitment || null,
    sent_at: intent.sent_at || null,
    sent_by: intent.sent_by || null,
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
      const result = await goodyGifting.sendIntent(loadGiftLedger(), req.params.id, {
        sentBy: req.body?.sent_by || 'John',
      });
      await saveGiftLedger(result.ledger);
      return res.json({
        ok: true,
        already_sent: result.already_sent === true,
        intent: publicIntent(result.intent),
        report: result.report,
      });
    } catch (error) {
      const status = error.code === 'goody_not_ready' ? 409 : 400;
      res.status(status).json({ error: error.message });
    }
  });
}

module.exports = { publicIntent, registerGiftRoutes };
