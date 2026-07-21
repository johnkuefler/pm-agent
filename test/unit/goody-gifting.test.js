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
    amount_cents: 1500,
    suggested_gift: 'Coffee or lunch gift of choice',
    card_message: 'Thank you for closing the loop and flagging the risk early.',
    evidence: [{ type: 'intelligence_cycle_action', id: 'cycle-1:warmth' }],
  }, ledger, { now: new Date('2026-07-20T22:00:00Z') });
  assert.equal(created.intent.status, 'proposed');
  assert.equal(created.intent.requires_approval, true);
  assert.equal(created.report.remaining_cents, 10000);
  assert.match(created.intent.request_commitment, /^[a-f0-9]{64}$/);

  const approved = goody.approveIntent(created.ledger, 'gift-chelsea', {
    approvedBy: 'John',
    now: new Date('2026-07-20T22:05:00Z'),
  });
  assert.equal(approved.intent.status, 'approved');
  assert.equal(approved.report.approved_or_sent_cents, 1500);
  assert.equal(approved.report.remaining_cents, 8500);
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
  assert.throws(() => goody.createIntent({ ...base, amount_cents: 5000 }, ledger), /per-gift limit/);
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
    await assert.rejects(() => goody.sendIntent(approved.ledger, 'gift-too-much', { fetchImpl }), /exceeds approved amount/);
    assert.equal(calls, 1);
  } finally {
    if (prior.key === undefined) delete process.env.GOODY_API_KEY; else process.env.GOODY_API_KEY = prior.key;
    if (prior.enabled === undefined) delete process.env.GOODY_SEND_ENABLED; else process.env.GOODY_SEND_ENABLED = prior.enabled;
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

test('Goody defaults can be stored in the gift policy without Railway env edits', () => {
  const updated = goody.updateGiftDefaults(goody.emptyLedger(), {
    environment: 'production',
    product_id: 'product-from-catalog',
    card_id: 'card-from-catalog',
    updated_by: 'John',
  });
  assert.equal(updated.ledger.policy.goody_environment, 'production');
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
