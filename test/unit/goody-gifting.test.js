const test = require('node:test');
const assert = require('node:assert/strict');
const goody = require('../../src/gifting/goody');

test('Goody gift intents enforce Nora generosity policy and budget math', () => {
  const ledger = goody.emptyLedger();
  const created = goody.createIntent({
    id: 'gift-chelsea',
    recipient_name: 'Chelsea Galindo',
    recipient_slack_user_id: 'U03CJSL85AL',
    reason_category: 'thanks',
    reason: 'Chelsea delivered all eight copy docs and proactively flagged the SEO length risk.',
    amount_cents: 4900,
    product_id: '013bc7e4-61aa-438d-a619-a1aaa9dc91e8',
    product_name: 'Botanicals Petite Sunny Bouquet Flower Set',
    suggested_gift: 'Coffee or lunch gift of choice',
    card_message: 'Thank you for closing the loop and flagging the risk early.',
    evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
  }, ledger, { now: new Date('2026-07-20T22:00:00Z') });
  assert.equal(created.intent.status, 'proposed');
  assert.equal(created.intent.product_id, '013bc7e4-61aa-438d-a619-a1aaa9dc91e8');
  assert.equal(created.intent.requires_approval, true);
  assert.equal(created.report.remaining_cents, 10000);
  assert.match(created.intent.request_commitment, /^[a-f0-9]{64}$/);

  const approved = goody.approveIntent(created.ledger, 'gift-chelsea', {
    approvedBy: 'John',
    now: new Date('2026-07-20T22:05:00Z'),
  });
  assert.equal(approved.intent.status, 'approved');
  assert.equal(approved.report.approved_or_sent_cents, 4900);
  assert.equal(approved.report.remaining_cents, 5100);
});

test('Goody gift intents reject pressure, thin reasons, and oversized gifts', () => {
  const ledger = goody.emptyLedger();
  const base = {
    recipient_name: 'A Teammate',
    reason_category: 'thanks',
    reason: 'A specific observed contribution with evidence.',
    amount_cents: 1500,
    evidence: [{ type: 'slack_message', id: '123.45' }],
  };
  assert.throws(() => goody.createIntent({ ...base, reason_category: 'pressure' }, ledger), /not allowed|blocked/);
  assert.throws(() => goody.createIntent({ ...base, reason: 'nice', amount_cents: 1500 }, ledger), /specific/);
  assert.throws(() => goody.createIntent({ ...base, amount_cents: 5001 }, ledger), /per-gift limit/);
});

test('gift deliberation makes proposal or abstention explicit and atomically creates an intent', () => {
  const base = {
    candidate_key: 'milestone:chelsea-eight-docs',
    recipient_name: 'Chelsea Galindo',
    reason_category: 'milestone',
    occasion: 'Chelsea shipped all eight copy documents and surfaced an SEO risk before handoff.',
    rationale: 'The completed body of work and proactive risk catch make a modest gift proportionate, not merely routine thanks.',
    counterconsiderations: ['A specific Slack note may already be enough recognition.'],
    evidence: [{ type: 'teamwork_task', id: 'tw-39585335' }],
    created_by: 'Nora',
  };
  const proposed = goody.createDeliberation({ ...base, id: 'delib-chelsea', decision: 'propose',
    intent: {
      id: 'gift-from-deliberation', amount_cents: 2400,
      reason: 'Chelsea shipped eight copy documents and proactively caught the SEO length risk before handoff.',
      suggested_gift: 'LEGO Botanicals Petite Sunny Bouquet',
      card_message: 'Eight docs and a risk catch before handoff. That was a strong finish—thank you.',
      recipient_slack_user_id: 'U03CJSL85AL',
    },
  }, goody.emptyLedger(), { now: new Date('2026-07-21T14:00:00Z') });
  assert.equal(proposed.deliberation.decision, 'propose');
  assert.equal(proposed.deliberation.intent_id, 'gift-from-deliberation');
  assert.equal(proposed.intent.status, 'proposed');
  assert.equal(proposed.ledger.intents.length, 1);
  assert.equal(proposed.ledger.deliberations.length, 1);
  assert.match(proposed.deliberation.deliberation_commitment, /^[a-f0-9]{64}$/);

  const duplicate = goody.createDeliberation({ ...base, decision: 'warmth_only' }, proposed.ledger,
    { now: new Date('2026-07-21T15:00:00Z') });
  assert.equal(duplicate.already_recorded, true);
  assert.equal(duplicate.deliberation.decision, 'propose');
  assert.equal(duplicate.ledger.deliberations.length, 1);

  const abstained = goody.createDeliberation({
    id: 'delib-none', candidate_key: 'daily-scan:2026-07-22', decision: 'no_candidate',
    occasion: 'The daily relationship scan found routine task movement but no substantial milestone or repair moment.',
    rationale: 'Nothing observed today crossed the evidence threshold for spending, so no gift proposal is proportionate.',
    counterconsiderations: ['Ordinary warmth remains available if a specific contribution deserves acknowledgment.'],
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-2026-07-22' }], created_by: 'Nora',
  }, proposed.ledger, { now: new Date('2026-07-22T14:00:00Z') });
  assert.equal(abstained.deliberation.decision, 'no_candidate');
  assert.equal(abstained.intent, null);
  assert.equal(abstained.report.counts.no_candidate, 1);
});

test('gift deliberation enforces proportionality budgets and recipient cooldown', () => {
  const candidate = (key, recipient, day) => ({
    candidate_key: key, decision: 'propose', recipient_name: recipient, reason_category: 'thanks',
    occasion: `${recipient} completed a substantial deliverable and caught a material handoff risk on ${day}.`,
    rationale: 'The completed milestone and attributable risk prevention justify considering a modest bounded gift.',
    counterconsiderations: ['A personal note could be sufficient.'],
    evidence: [{ type: 'teamwork_task', id: `tw-${key}` }],
    intent: { amount_cents: 1500, reason: `${recipient} completed a substantial deliverable and caught a material handoff risk.`,
      suggested_gift: 'A modest Goody gift', card_message: 'Thank you for the strong finish.' },
  });
  const first = goody.createDeliberation(candidate('one', 'Person One', 'Monday'), goody.emptyLedger(),
    { now: new Date('2026-07-21T10:00:00Z') });
  assert.throws(() => goody.createDeliberation(candidate('one-again', 'Person One', 'Tuesday'), first.ledger,
    { now: new Date('2026-07-22T10:00:00Z') }), /recipient.*cooldown/);
  const second = goody.createDeliberation(candidate('two', 'Person Two', 'Tuesday'), first.ledger,
    { now: new Date('2026-07-22T10:00:00Z') });
  assert.throws(() => goody.createDeliberation(candidate('three', 'Person Three', 'Wednesday'), second.ledger,
    { now: new Date('2026-07-23T10:00:00Z') }), /weekly gift proposal budget/);
});

test('Goody send readiness fails closed until explicit credentials and send flag exist', () => {
  const priorKey = process.env.GOODY_API_KEY;
  const priorEnabled = process.env.GOODY_SEND_ENABLED;
  delete process.env.GOODY_API_KEY;
  delete process.env.GOODY_SEND_ENABLED;
  try {
    const created = goody.createIntent({
      id: 'gift-ready',
      recipient_name: 'Chelsea Galindo',
      reason_category: 'thanks',
      reason: 'Chelsea delivered all eight copy docs and proactively flagged the SEO length risk.',
      amount_cents: 1500,
      evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
    }, goody.emptyLedger());
    const approved = goody.approveIntent(created.ledger, 'gift-ready');
    assert.deepEqual(goody.sendReadiness(approved.ledger, 'gift-ready'), {
      ready: false,
      reason: 'GOODY_SEND_ENABLED is not true',
    });
  } finally {
    if (priorKey !== undefined) process.env.GOODY_API_KEY = priorKey;
    if (priorEnabled !== undefined) process.env.GOODY_SEND_ENABLED = priorEnabled;
  }
});

test('Goody send creates an order batch only after price stays within approval', async () => {
  const prior = {
    key: process.env.GOODY_API_KEY,
    enabled: process.env.GOODY_SEND_ENABLED,
    product: process.env.GOODY_PRODUCT_ID,
    card: process.env.GOODY_CARD_ID,
  };
  Object.assign(process.env, {
    GOODY_API_KEY: 'test-goody-key',
    GOODY_SEND_ENABLED: 'true',
    GOODY_PRODUCT_ID: 'product-123',
    GOODY_CARD_ID: 'card-123',
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
    if (url.endsWith('/v1/order_batches/price')) {
      return new Response(JSON.stringify({
        total_price_estimate: { est_group_total_low: 1400, est_group_total_high: 1500 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'batch-123',
      send_status: 'complete',
      reference_id: 'REF123',
      customer_reference_id: calls.at(-1).body.customer_reference_id,
      orders_preview: [{ id: 'order-123', individual_gift_link: 'https://gifts.ongoody.com/gift/test' }],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const created = goody.createIntent({
      id: 'gift-send',
      recipient_name: 'Chelsea Galindo',
      recipient_slack_user_id: 'U03CJSL85AL',
      reason_category: 'thanks',
      reason: 'Chelsea delivered all eight copy docs and proactively flagged the SEO length risk.',
      amount_cents: 1500,
      product_id: 'product-override-456',
      card_message: 'Thank you for closing the loop and flagging the risk early.',
      evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
    }, goody.emptyLedger());
    const approved = goody.approveIntent(created.ledger, 'gift-send');
    const sent = await goody.sendIntent(approved.ledger, 'gift-send', { fetchImpl });
    assert.equal(sent.intent.status, 'sent');
    assert.equal(sent.intent.goody_order_batch_id, 'batch-123');
    assert.equal(sent.intent.goody_order_id, 'order-123');
    assert.equal(sent.intent.goody_gift_link, 'https://gifts.ongoody.com/gift/test');
    assert.equal(sent.intent.goody_price_estimate_cents, 1500);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].auth, 'Bearer test-goody-key');
    assert.equal(calls[1].body.cart.items[0].product_id, 'product-override-456');
    assert.equal(calls[1].body.customer_reference_id.startsWith('nora-gift-send-'), true);
  } finally {
    if (prior.key === undefined) delete process.env.GOODY_API_KEY; else process.env.GOODY_API_KEY = prior.key;
    if (prior.enabled === undefined) delete process.env.GOODY_SEND_ENABLED; else process.env.GOODY_SEND_ENABLED = prior.enabled;
    if (prior.product === undefined) delete process.env.GOODY_PRODUCT_ID; else process.env.GOODY_PRODUCT_ID = prior.product;
    if (prior.card === undefined) delete process.env.GOODY_CARD_ID; else process.env.GOODY_CARD_ID = prior.card;
  }
});

test('Goody send refuses estimates above the approved amount', async () => {
  const prior = {
    key: process.env.GOODY_API_KEY,
    enabled: process.env.GOODY_SEND_ENABLED,
    product: process.env.GOODY_PRODUCT_ID,
  };
  Object.assign(process.env, {
    GOODY_API_KEY: 'test-goody-key',
    GOODY_SEND_ENABLED: 'true',
    GOODY_PRODUCT_ID: 'product-123',
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      total_price_estimate: { est_group_total_low: 2000, est_group_total_high: 2600 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const created = goody.createIntent({
      id: 'gift-too-much',
      recipient_name: 'Chelsea Galindo',
      reason_category: 'thanks',
      reason: 'Chelsea delivered all eight copy docs and proactively flagged the SEO length risk.',
      amount_cents: 1500,
      evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
    }, goody.emptyLedger());
    const approved = goody.approveIntent(created.ledger, 'gift-too-much');
    await assert.rejects(() => goody.sendIntent(approved.ledger, 'gift-too-much', { fetchImpl }), error => {
      assert.match(error.message, /exceeds approved amount/);
      assert.equal(error.code, 'goody_approval_too_low');
      assert.equal(error.required_amount_cents, 2600);
      assert.equal(error.approved_amount_cents, 1500);
      assert.equal(error.quote_result.intent.goody_price_estimate_cents, 2600);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    if (prior.key === undefined) delete process.env.GOODY_API_KEY; else process.env.GOODY_API_KEY = prior.key;
    if (prior.enabled === undefined) delete process.env.GOODY_SEND_ENABLED; else process.env.GOODY_SEND_ENABLED = prior.enabled;
    if (prior.product === undefined) delete process.env.GOODY_PRODUCT_ID; else process.env.GOODY_PRODUCT_ID = prior.product;
  }
});

test('Goody quote surfaces product costs and binds an exact operator overage approval', async () => {
  const prior = {
    key: process.env.GOODY_API_KEY,
    product: process.env.GOODY_PRODUCT_ID,
  };
  Object.assign(process.env, {
    GOODY_API_KEY: 'test-goody-key',
    GOODY_PRODUCT_ID: 'product-lego',
  });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/v1/order_batches/price')) {
      return new Response(JSON.stringify({
        cart_price: {
          price_product: 4000,
          price_shipping: 900,
          price_processing_fee: 0,
          price_pre_tax: 4900,
          price_est_tax_low: 700,
          price_est_tax_high: 760,
          price_est_total_low: 5600,
          price_est_total_high: 5660,
        },
        total_price: { est_group_total_low: 5600, est_group_total_high: 5660 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/v1/products/product-lego')) {
      return new Response(JSON.stringify({ data: {
        id: 'product-lego',
        name: 'Botanicals Petite Sunny Bouquet Flower Set',
        brand: { name: 'LEGO', shipping_price: 900 },
        price: 4000,
        images: [{ image_large: { url: 'https://cdn.example.com/lego.jpg' } }],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected Goody URL ${url}`);
  };
  try {
    const created = goody.createIntent({
      id: 'gift-quote-overage',
      recipient_name: 'Mallory Maryman',
      recipient_slack_user_id: 'U03MALLORY',
      reason_category: 'thanks',
      reason: 'Mallory stepped onto the website project mid-crunch and unblocked six migration pages.',
      amount_cents: 2500,
      suggested_gift: 'Configured Goody default if it prices within the approved amount',
      evidence: [{ type: 'teamwork_task', id: 'tw-mallory' }],
    }, goody.emptyLedger());
    const approved = goody.approveIntent(created.ledger, 'gift-quote-overage');
    const quoted = await goody.quoteIntent(approved.ledger, 'gift-quote-overage', {
      fetchImpl,
      now: new Date('2026-08-02T20:00:00Z'),
    });

    assert.equal(quoted.quote.product.name, 'Botanicals Petite Sunny Bouquet Flower Set');
    assert.equal(quoted.quote.product.brand_name, 'LEGO');
    assert.equal(quoted.quote.breakdown.product_cents, 4000);
    assert.equal(quoted.quote.breakdown.shipping_cents, 900);
    assert.equal(quoted.quote.breakdown.estimated_tax_high_cents, 760);
    assert.equal(quoted.quote.total_high_cents, 5660);
    assert.match(quoted.quote.commitment, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);

    assert.throws(() => goody.approveIntent(quoted.ledger, 'gift-quote-overage', {
      amountCents: 5660,
      quoteCommitment: quoted.quote.commitment,
      note: 'John approved the itemized quote.',
    }), /explicit per-gift overage approval/);
    assert.throws(() => goody.approveIntent(quoted.ledger, 'gift-quote-overage', {
      amountCents: 5660,
      allowPerGiftOverage: true,
      quoteCommitment: 'stale-quote',
      note: 'John approved the itemized quote.',
    }), /quote changed/);

    const revised = goody.approveIntent(quoted.ledger, 'gift-quote-overage', {
      approvedBy: 'John',
      amountCents: 5660,
      allowPerGiftOverage: true,
      quoteCommitment: quoted.quote.commitment,
      note: 'John approved the itemized quote.',
      now: new Date('2026-08-02T20:01:00Z'),
    });
    assert.equal(revised.intent.original_amount_cents, 2500);
    assert.equal(revised.intent.amount_cents, 5660);
    assert.equal(revised.intent.amount_authorization.approved_amount_cents, 5660);
    assert.equal(revised.intent.amount_authorization.quote_commitment, quoted.quote.commitment);
    assert.equal(revised.report.approved_or_sent_cents, 5660);
    assert.equal(revised.report.remaining_cents, 4340);
  } finally {
    if (prior.key === undefined) delete process.env.GOODY_API_KEY; else process.env.GOODY_API_KEY = prior.key;
    if (prior.product === undefined) delete process.env.GOODY_PRODUCT_ID; else process.env.GOODY_PRODUCT_ID = prior.product;
  }
});

test('Goody gift link delivery is recorded separately from order send', () => {
  const created = goody.createIntent({
    id: 'gift-delivery',
    recipient_name: 'Chelsea Galindo',
    reason_category: 'thanks',
    reason: 'Chelsea delivered all eight copy docs and proactively flagged the SEO length risk.',
    amount_cents: 1500,
    evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
  }, goody.emptyLedger());
  created.intent.status = 'sent';
  created.intent.goody_order_batch_id = 'batch-123';
  created.intent.goody_order_id = 'order-123';
  created.intent.goody_gift_link = 'https://gifts.ongoody.com/gift/test';
  const recorded = goody.recordGiftLinkDelivery(created.ledger, 'gift-delivery', {
    status: 'delivered',
    channel: 'D123',
    ts: '123.456',
    deliveredBy: 'Nora',
    now: new Date('2026-07-21T01:00:00Z'),
  });
  assert.equal(recorded.intent.status, 'sent');
  assert.equal(recorded.intent.gift_link_delivery_status, 'delivered');
  assert.equal(recorded.intent.gift_link_delivery_channel, 'D123');
  assert.match(recorded.intent.gift_link_delivery_commitment, /^[a-f0-9]{64}$/);
});

test('gift Slack delivery includes the recipient and John', () => {
  assert.equal(goody.giftSlackConversationUsers('U03RECIPIENT', 'U03JOHNK'), 'U03RECIPIENT,U03JOHNK');
  assert.equal(goody.giftSlackConversationUsers('U03JOHNK', 'U03JOHNK'), 'U03JOHNK');
  assert.throws(() => goody.giftSlackConversationUsers('U03RECIPIENT', ''), /John Slack user ID/);
});

test('Goody defaults can be stored in the gift policy without Railway env edits', () => {
  const updated = goody.updateGiftDefaults(goody.emptyLedger(), {
    environment: 'production',
    product_id: 'product-from-catalog',
    card_id: 'card-from-catalog',
    per_gift_limit_cents: 5000,
    updated_by: 'John',
  });
  assert.equal(updated.ledger.policy.goody_environment, 'production');
  assert.equal(updated.ledger.policy.per_gift_limit_cents, 5000);
  assert.equal(updated.report.goody_environment, 'production');
  assert.equal(updated.ledger.policy.default_product_id, 'product-from-catalog');
  assert.equal(updated.ledger.policy.default_card_id, 'card-from-catalog');
  assert.equal(updated.report.goody_product_configured, true);
  assert.equal(updated.report.goody_card_configured, true);
});

test('Goody catalog helpers return safe product and card summaries', async () => {
  const priorKey = process.env.GOODY_API_KEY;
  process.env.GOODY_API_KEY = 'test-goody-key';
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/v1/products')) {
      return new Response(JSON.stringify({
        data: [{
          id: 'product-1',
          name: 'Coffee Treat',
          price: 1200,
          price_is_variable: false,
          brand: { name: 'Cafe Co', shipping_price: 0 },
          images: [{ image_large: { url: 'https://example.com/coffee.png' } }],
        }],
        list_meta: { total_count: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [{ id: 'card-1', occasions: ['Thanks'], image_thumb: { url: 'https://example.com/card.png' } }],
      list_meta: { total_count: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const products = await goody.listGoodyProducts(goody.emptyLedger(), { query: 'coffee', fetchImpl });
    assert.equal(products.products[0].id, 'product-1');
    assert.equal(products.products[0].brand_name, 'Cafe Co');
    const cards = await goody.listGoodyCards(goody.emptyLedger(), { occasion: 'thanks', fetchImpl });
    assert.equal(cards.cards[0].id, 'card-1');
    assert.equal(calls.length, 2);
  } finally {
    if (priorKey === undefined) delete process.env.GOODY_API_KEY; else process.env.GOODY_API_KEY = priorKey;
  }
});
