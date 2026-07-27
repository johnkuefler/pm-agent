'use strict';

const goodyGifting = require('../gifting/goody');

function publicIntent(intent) {
  if (!intent) return null;
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
    product_id: intent.product_id || null,
    product_name: intent.product_name || null,
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
    gift_link_delivery_status: intent.gift_link_delivery_status || null,
    gift_link_delivery_channel: intent.gift_link_delivery_channel || null,
    gift_link_delivery_ts: intent.gift_link_delivery_ts || null,
    gift_link_delivery_error: intent.gift_link_delivery_error || null,
    gift_link_delivery_commitment: intent.gift_link_delivery_commitment || null,
    sent_at: intent.sent_at || null,
    sent_by: intent.sent_by || null,
  };
}

function publicDeliberation(record) {
  if (!record) return null;
  return {
    id: record.id,
    candidate_key: record.candidate_key,
    decision: record.decision,
    recipient_name: record.recipient_name || null,
    reason_category: record.reason_category || null,
    occasion: record.occasion,
    rationale: record.rationale,
    counterconsiderations: record.counterconsiderations || [],
    evidence: record.evidence || [],
    evidence_commitment: record.evidence_commitment,
    intent_id: record.intent_id || null,
    deliberation_commitment: record.deliberation_commitment,
    created_by: record.created_by,
    created_at: record.created_at,
  };
}

function registerGiftRoutes(app, deps) {
  const { requireAuth, requireOperatorAuth, loadGiftLedger, saveGiftLedger, deliverGiftLink = null } = deps;

  app.get('/gifts/policy', requireAuth, (_req, res) => {
    const ledger = loadGiftLedger();
    res.json(goodyGifting.policyReport(ledger));
  });

  app.post('/gifts/defaults', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const result = goodyGifting.updateGiftDefaults(loadGiftLedger(), {
        product_id: req.body?.product_id,
        card_id: req.body?.card_id,
        environment: req.body?.environment || req.body?.goody_environment,
        per_gift_limit_cents: req.body?.per_gift_limit_cents,
        requires_approval_over_cents: req.body?.requires_approval_over_cents,
        monthly_budget_cents: req.body?.monthly_budget_cents,
        updated_by: req.principal?.id || 'dashboard_operator',
      });
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/gifts/goody/products', requireAuth, async (req, res) => {
    try {
      const result = await goodyGifting.listGoodyProducts(loadGiftLedger(), {
        query: req.query.q || req.query.query || '',
        page: req.query.page || 1,
        perPage: req.query.per_page || req.query.limit || 25,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/gifts/goody/cards', requireAuth, async (req, res) => {
    try {
      const result = await goodyGifting.listGoodyCards(loadGiftLedger(), {
        occasion: req.query.occasion || req.query.q || '',
        page: req.query.page || 1,
        perPage: req.query.per_page || req.query.limit || 25,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
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

  app.get('/gifts/deliberations', requireAuth, (req, res) => {
    const ledger = loadGiftLedger();
    const decision = req.query.decision ? String(req.query.decision) : '';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const records = decision ? ledger.deliberations.filter(item => item.decision === decision) : ledger.deliberations;
    res.json({
      report: goodyGifting.deliberationReport(ledger),
      policy_report: goodyGifting.policyReport(ledger),
      count: records.length,
      deliberations: records.slice(-limit).reverse().map(publicDeliberation),
    });
  });

  app.post('/gifts/deliberations', requireAuth, async (req, res) => {
    try {
      const result = goodyGifting.createDeliberation(req.body || {}, loadGiftLedger());
      if (!result.already_recorded) await saveGiftLedger(result.ledger);
      res.json({ ok: true, already_recorded: result.already_recorded,
        deliberation: publicDeliberation(result.deliberation),
        intent: publicIntent(result.intent), report: result.report, policy_report: result.policy_report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/gifts/intents/:id', requireAuth, (req, res) => {
    const ledger = loadGiftLedger();
    const intent = ledger.intents.find(item => item.id === req.params.id);
    if (!intent) return res.status(404).json({ error: 'gift intent not found' });
    res.json({ intent: publicIntent(intent), report: goodyGifting.policyReport(ledger) });
  });

  // Direct intent creation is retained for operator repair/import only. Nora's proposal lane is
  // /gifts/deliberations so every proposal has an explicit alternatives-and-evidence receipt.
  app.post('/gifts/intents', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const result = goodyGifting.createIntent({
        ...(req.body || {}),
        created_by: req.principal?.id || 'dashboard_operator',
      }, loadGiftLedger());
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/approve', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const result = goodyGifting.approveIntent(loadGiftLedger(), req.params.id, {
        approvedBy: req.principal?.id || 'dashboard_operator',
      });
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/reject', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const result = goodyGifting.rejectIntent(loadGiftLedger(), req.params.id, {
        rejectedBy: req.principal?.id || 'dashboard_operator',
        note: req.body?.note || '',
      });
      await saveGiftLedger(result.ledger);
      res.json({ ok: true, intent: publicIntent(result.intent), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/gifts/intents/:id/send', requireAuth, requireOperatorAuth, async (req, res) => {
    try {
      const result = await goodyGifting.sendIntent(loadGiftLedger(), req.params.id, {
        sentBy: req.principal?.id || 'dashboard_operator',
      });
      await saveGiftLedger(result.ledger);
      let delivery = null;
      let currentIntent = result.intent;
      const shouldDeliver = req.body?.deliver !== false;
      if (shouldDeliver && typeof deliverGiftLink === 'function' && currentIntent.goody_gift_link
        && currentIntent.recipient_slack_user_id
        && currentIntent.gift_link_delivery_status !== 'delivered') {
        delivery = await deliverGiftLink(currentIntent);
        const recorded = goodyGifting.recordGiftLinkDelivery(loadGiftLedger(), currentIntent.id, {
          status: delivery.ok ? 'delivered' : 'failed',
          channel: delivery.channel || '',
          ts: delivery.ts || '',
          error: delivery.ok ? '' : delivery.error || 'gift link delivery failed',
          deliveredBy: 'nora-server',
        });
        await saveGiftLedger(recorded.ledger);
        currentIntent = recorded.intent;
      }
      return res.json({
        ok: true,
        already_sent: result.already_sent === true,
        delivery,
        intent: publicIntent(currentIntent),
        report: goodyGifting.policyReport(loadGiftLedger()),
      });
    } catch (error) {
      const status = error.code === 'goody_not_ready' ? 409 : 400;
      res.status(status).json({ error: error.message });
    }
  });
}

module.exports = { publicIntent, publicDeliberation, registerGiftRoutes };
