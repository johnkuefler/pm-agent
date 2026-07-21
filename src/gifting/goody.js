'use strict';

const crypto = require('crypto');

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'proposal_only',
  currency: 'USD',
  monthly_budget_cents: 10000,
  per_gift_limit_cents: 2500,
  requires_approval_over_cents: 1500,
  auto_send_enabled: false,
  recipient_scope: 'internal_team_first',
  allowed_reasons: ['thanks', 'congratulations', 'support', 'milestone', 'repair'],
  blocked_reasons: ['persuasion', 'pressure', 'romance_or_intimacy', 'hr_sensitive'],
  goody_environment: 'sandbox',
  default_product_id: '',
  default_card_id: '',
});

const GOODY_BASE_URLS = Object.freeze({
  production: 'https://api.ongoody.com',
  sandbox: 'https://api.sandbox.ongoody.com',
});

const ALLOWED_SEND_METHODS = Object.freeze(['link_multiple_custom_list', 'email_and_link']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function emptyLedger(policy = DEFAULT_POLICY) {
  return { version: 1, policy: { ...DEFAULT_POLICY, ...(policy || {}) }, intents: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    policy: { ...DEFAULT_POLICY, ...(ledger.policy || {}) },
    intents: Array.isArray(ledger.intents) ? ledger.intents.map(normalizeIntentRecord).filter(Boolean).slice(-500) : [],
  };
}

function normalizeText(value, max = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) {
    throw new Error('gift intents require one to eight evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    if (!type || (!id && !url)) throw new Error('each gift evidence reference requires type and id or url');
    return {
      type,
      ...(id ? { id } : {}),
      ...(url ? { url } : {}),
      ...(item?.note ? { note: normalizeText(item.note, 300) } : {}),
    };
  });
}

function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeReasonCategory(value) {
  return normalizeText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function splitName(fullName) {
  const parts = normalizeText(fullName, 120).split(' ').filter(Boolean);
  if (parts.length <= 1) return { first_name: parts[0] || 'Friend' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function policyReport(ledger = emptyLedger(), { now = new Date() } = {}) {
  const normalized = normalizeLedger(ledger);
  const productId = configuredProductId(normalized.policy);
  const cardId = configuredCardId(normalized.policy);
  const key = monthKey(now);
  const spent = normalized.intents
    .filter(item => monthKey(item.created_at) === key && ['approved', 'sent'].includes(item.status))
    .reduce((sum, item) => sum + (Number(item.amount_cents) || 0), 0);
  return {
    policy: normalized.policy,
    month: key,
    approved_or_sent_cents: spent,
    remaining_cents: Math.max(0, Number(normalized.policy.monthly_budget_cents) - spent),
    proposal_only: normalized.policy.mode === 'proposal_only' || normalized.policy.auto_send_enabled !== true,
    goody_configured: Boolean(process.env.GOODY_API_KEY),
    goody_send_enabled: process.env.GOODY_SEND_ENABLED === 'true',
    goody_product_configured: Boolean(productId),
    goody_card_configured: Boolean(cardId),
    default_product_id: productId || null,
    default_card_id: cardId || null,
  };
}

function configuredProductId(policy = DEFAULT_POLICY) {
  return normalizeText(process.env.GOODY_PRODUCT_ID || policy.default_product_id, 120);
}

function configuredCardId(policy = DEFAULT_POLICY) {
  return normalizeText(process.env.GOODY_CARD_ID || policy.default_card_id, 120);
}

function updateGiftDefaults(ledger = emptyLedger(), input = {}) {
  const current = normalizeLedger(ledger);
  const productId = normalizeText(input.product_id ?? input.default_product_id ?? current.policy.default_product_id, 120);
  const cardId = normalizeText(input.card_id ?? input.default_card_id ?? current.policy.default_card_id, 120);
  current.policy = {
    ...current.policy,
    default_product_id: productId,
    default_card_id: cardId,
    defaults_updated_by: normalizeText(input.updated_by || 'John', 120),
    defaults_updated_at: new Date().toISOString(),
  };
  return { ledger: current, report: policyReport(current) };
}

function validateIntentInput(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const policy = current.policy;
  const recipientName = normalizeText(input.recipient_name, 120);
  if (!recipientName) throw new Error('recipient_name is required');
  const amountCents = Math.round(Number(input.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents < 100) throw new Error('amount_cents must be at least 100');
  if (amountCents > Number(policy.per_gift_limit_cents)) throw new Error('gift exceeds per-gift limit');
  const reasonCategory = normalizeReasonCategory(input.reason_category || input.reason);
  if (!policy.allowed_reasons.includes(reasonCategory)) throw new Error('gift reason_category is not allowed by policy');
  if (policy.blocked_reasons.includes(reasonCategory)) throw new Error('gift reason_category is blocked by policy');
  const reason = normalizeText(input.reason, 700);
  if (reason.length < 20) throw new Error('gift reason must be specific and evidence-grounded');
  const report = policyReport(current, { now });
  if (amountCents > report.remaining_cents) throw new Error('gift would exceed monthly budget');
  const evidence = normalizeEvidence(input.evidence);
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const body = {
    recipient_name: recipientName,
    ...(input.recipient_email ? { recipient_email: normalizeText(input.recipient_email, 240) } : {}),
    ...(input.recipient_slack_user_id ? { recipient_slack_user_id: normalizeText(input.recipient_slack_user_id, 80) } : {}),
    reason_category: reasonCategory,
    reason,
    amount_cents: amountCents,
    currency: policy.currency,
    suggested_gift: normalizeText(input.suggested_gift || 'Goody gift of choice', 200),
    card_message: normalizeText(input.card_message, 600),
    evidence,
    created_by: normalizeText(input.created_by || 'Nora', 80),
    created_at: createdAt,
  };
  if (!body.recipient_email && !body.recipient_slack_user_id) {
    body.delivery_contact_required = true;
  }
  return body;
}

function intentPayload(record) {
  return {
    id: record.id,
    recipient_name: record.recipient_name,
    recipient_email: record.recipient_email || null,
    recipient_slack_user_id: record.recipient_slack_user_id || null,
    reason_category: record.reason_category,
    reason: record.reason,
    amount_cents: record.amount_cents,
    currency: record.currency,
    suggested_gift: record.suggested_gift,
    card_message: record.card_message || '',
    evidence: record.evidence,
    created_by: record.created_by,
    created_at: record.created_at,
    status: record.status,
  };
}

function normalizeIntentRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    status: normalizeText(record.status, 40) || 'proposed',
    amount_cents: Math.round(Number(record.amount_cents) || 0),
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function createIntent(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const body = validateIntentInput(input, current, { now });
  const id = input.id ? normalizeText(input.id, 120) : `gift-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.intents.some(item => item.id === id)) throw new Error('gift intent id already exists');
  const requiresApproval = current.policy.mode === 'proposal_only'
    || current.policy.auto_send_enabled !== true
    || body.amount_cents > Number(current.policy.requires_approval_over_cents);
  const record = {
    id,
    ...body,
    status: 'proposed',
    requires_approval: requiresApproval,
    goody_send_enabled_at_creation: process.env.GOODY_SEND_ENABLED === 'true',
    request_commitment: null,
  };
  record.request_commitment = commitment(intentPayload(record));
  current.intents.push(record);
  current.intents = current.intents.slice(-500);
  return { ledger: current, intent: record, report: policyReport(current, { now }) };
}

function approveIntent(ledger = emptyLedger(), id, { approvedBy = 'John', now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (!['proposed', 'approved'].includes(intent.status)) throw new Error('only proposed gift intents can be approved');
  const alreadyApproved = intent.status === 'approved';
  const report = policyReport(current, { now });
  if (!alreadyApproved && intent.amount_cents > report.remaining_cents) throw new Error('approving this gift would exceed monthly budget');
  if (alreadyApproved) return { ledger: current, intent, report };
  intent.status = 'approved';
  intent.approved_by = normalizeText(approvedBy, 120) || 'John';
  intent.approved_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.approval_commitment = commitment({
    id: intent.id, request_commitment: intent.request_commitment,
    approved_by: intent.approved_by, approved_at: intent.approved_at,
  });
  return { ledger: current, intent, report: policyReport(current, { now }) };
}

function rejectIntent(ledger = emptyLedger(), id, { rejectedBy = 'John', note = '', now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (intent.status === 'sent') throw new Error('sent gift intents cannot be rejected');
  intent.status = 'rejected';
  intent.rejected_by = normalizeText(rejectedBy, 120) || 'John';
  intent.rejected_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.rejection_note = normalizeText(note, 500);
  return { ledger: current, intent, report: policyReport(current, { now }) };
}

function recordGiftLinkDelivery(ledger = emptyLedger(), id, {
  status,
  channel = '',
  ts = '',
  error = '',
  deliveredBy = 'Nora',
  now = new Date(),
} = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  intent.gift_link_delivery_status = normalizeText(status, 40) || 'unknown';
  intent.gift_link_delivered_by = normalizeText(deliveredBy, 120) || 'Nora';
  intent.gift_link_delivery_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.gift_link_delivery_channel = normalizeText(channel, 120);
  intent.gift_link_delivery_ts = normalizeText(ts, 80);
  intent.gift_link_delivery_error = normalizeText(error, 300);
  intent.gift_link_delivery_commitment = commitment({
    id: intent.id,
    goody_order_batch_id: intent.goody_order_batch_id,
    goody_order_id: intent.goody_order_id,
    goody_gift_link: intent.goody_gift_link,
    status: intent.gift_link_delivery_status,
    channel: intent.gift_link_delivery_channel,
    ts: intent.gift_link_delivery_ts,
    error: intent.gift_link_delivery_error,
  });
  return { ledger: current, intent, report: policyReport(current, { now }) };
}

function sendReadiness(ledger = emptyLedger(), id) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (intent.status !== 'approved') return { ready: false, reason: 'gift intent must be approved before send' };
  if (process.env.GOODY_SEND_ENABLED !== 'true') return { ready: false, reason: 'GOODY_SEND_ENABLED is not true' };
  if (!process.env.GOODY_API_KEY) return { ready: false, reason: 'GOODY_API_KEY is not configured' };
  return { ready: true, base_url: GOODY_BASE_URLS[current.policy.goody_environment] || GOODY_BASE_URLS.sandbox };
}

function goodyConfig(policy = DEFAULT_POLICY) {
  const baseUrl = GOODY_BASE_URLS[policy.goody_environment] || GOODY_BASE_URLS.sandbox;
  const sendMethod = normalizeText(process.env.GOODY_SEND_METHOD || 'link_multiple_custom_list', 80);
  return {
    api_key: process.env.GOODY_API_KEY || '',
    base_url: baseUrl,
    product_id: configuredProductId(policy),
    card_id: configuredCardId(policy),
    from_name: normalizeText(process.env.GOODY_FROM_NAME || 'Nora at LimeLight Marketing', 120),
    payment_method_id: normalizeText(process.env.GOODY_PAYMENT_METHOD_ID, 120),
    workspace_id: normalizeText(process.env.GOODY_WORKSPACE_ID, 120),
    send_method: ALLOWED_SEND_METHODS.includes(sendMethod) ? sendMethod : 'link_multiple_custom_list',
  };
}

async function getGoodyJson(path, {
  policy = DEFAULT_POLICY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Goody catalog requires fetch');
  if (!process.env.GOODY_API_KEY) throw new Error('GOODY_API_KEY is not configured');
  const baseUrl = GOODY_BASE_URLS[policy.goody_environment] || GOODY_BASE_URLS.sandbox;
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${process.env.GOODY_API_KEY}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = body?.error || body?.message || body?.raw || `HTTP ${response.status}`;
    throw new Error(`Goody API request failed: ${String(message).slice(0, 240)}`);
  }
  return body;
}

function publicProduct(product = {}) {
  return {
    id: product.id || null,
    name: product.name || null,
    brand_name: product.brand?.name || null,
    price: product.price ?? null,
    price_is_variable: product.price_is_variable ?? null,
    shipping_price: product.brand?.shipping_price ?? null,
    subtitle: product.subtitle || product.subtitle_short || null,
    image_url: product.images?.[0]?.image_large?.url || product.image_large?.url || null,
    restricted_states: Array.isArray(product.restricted_states) ? product.restricted_states : [],
  };
}

function publicCard(card = {}) {
  return {
    id: card.id || null,
    occasions: Array.isArray(card.occasions) ? card.occasions : [],
    image_thumb_url: card.image_thumb?.url || null,
    image_url: card.image?.url || null,
  };
}

async function listGoodyProducts(ledger = emptyLedger(), {
  query = '',
  page = 1,
  perPage = 25,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = normalizeLedger(ledger);
  const safePage = Math.max(1, Math.round(Number(page) || 1));
  const safePerPage = Math.min(100, Math.max(1, Math.round(Number(perPage) || 25)));
  const params = new URLSearchParams({ page: String(safePage), per_page: String(safePerPage) });
  const body = await getGoodyJson(`/v1/products?${params}`, { policy: current.policy, fetchImpl });
  const q = normalizeText(query, 120).toLowerCase();
  let products = Array.isArray(body.data) ? body.data.map(publicProduct) : [];
  if (q) {
    products = products.filter(product => [product.name, product.brand_name, product.subtitle]
      .filter(Boolean).some(value => String(value).toLowerCase().includes(q)));
  }
  return { products, list_meta: body.list_meta || {}, report: policyReport(current) };
}

async function listGoodyCards(ledger = emptyLedger(), {
  occasion = '',
  page = 1,
  perPage = 25,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = normalizeLedger(ledger);
  const safePage = Math.max(1, Math.round(Number(page) || 1));
  const safePerPage = Math.min(100, Math.max(1, Math.round(Number(perPage) || 25)));
  const params = new URLSearchParams({ page: String(safePage), per_page: String(safePerPage) });
  const body = await getGoodyJson(`/v1/cards?${params}`, { policy: current.policy, fetchImpl });
  const q = normalizeText(occasion, 120).toLowerCase();
  let cards = Array.isArray(body.data) ? body.data.map(publicCard) : [];
  if (q) cards = cards.filter(card => card.occasions.some(item => String(item).toLowerCase().includes(q)));
  return { cards, list_meta: body.list_meta || {}, report: policyReport(current) };
}

function buildGoodyOrderPayload(intent, policy = DEFAULT_POLICY) {
  const config = goodyConfig(policy);
  if (!config.product_id) throw new Error('GOODY_PRODUCT_ID is required before sending gifts');
  if (intent.card_message && !config.card_id) throw new Error('GOODY_CARD_ID is required when sending a card message');
  if (config.send_method === 'email_and_link' && !intent.recipient_email) {
    throw new Error('recipient_email is required for Goody email delivery');
  }
  const recipient = {
    ...splitName(intent.recipient_name),
    ...(intent.recipient_email ? { email: intent.recipient_email } : {}),
  };
  const payload = {
    from_name: config.from_name,
    send_method: config.send_method,
    recipients: [recipient],
    cart: { items: [{ product_id: config.product_id, quantity: 1 }] },
    customer_reference_id: `nora-${intent.id}-${String(intent.approval_commitment || intent.request_commitment || '').slice(0, 12)}`,
    ...(intent.card_message ? { message: intent.card_message, card_id: config.card_id } : {}),
    ...(config.payment_method_id ? { payment_method_id: config.payment_method_id } : {}),
    ...(config.workspace_id ? { workspace_id: config.workspace_id } : {}),
  };
  return { payload, config };
}

async function postGoodyJson(path, payload, { config, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Goody send requires fetch');
  const response = await fetchImpl(`${config.base_url}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = body?.error || body?.message || body?.raw || `HTTP ${response.status}`;
    throw new Error(`Goody API request failed: ${String(message).slice(0, 240)}`);
  }
  return body;
}

function extractHighPriceCents(priceBody = {}) {
  const candidates = [
    priceBody.total_price_estimate?.est_group_total_high,
    priceBody.total_price?.est_group_total_high,
    priceBody.cart_price_estimate?.price_est_total_high,
    priceBody.cart_price?.price_est_total_high,
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

async function sendIntent(ledger = emptyLedger(), id, {
  sentBy = 'John',
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = normalizeLedger(ledger);
  const intent = current.intents.find(item => item.id === id);
  if (!intent) throw new Error('gift intent not found');
  if (intent.status === 'sent') return { ledger: current, intent, report: policyReport(current, { now }), already_sent: true };
  const readiness = sendReadiness(current, id);
  if (!readiness.ready) {
    const error = new Error(readiness.reason);
    error.code = 'goody_not_ready';
    throw error;
  }
  const { payload, config } = buildGoodyOrderPayload(intent, current.policy);
  const pricePayload = { send_method: payload.send_method, recipients: payload.recipients, cart: payload.cart };
  const price = await postGoodyJson('/v1/order_batches/price', pricePayload, { config, fetchImpl });
  const highEstimate = extractHighPriceCents(price);
  if (!Number.isFinite(highEstimate)) throw new Error('Goody price response did not include a high estimate');
  if (highEstimate > Number(intent.amount_cents)) {
    throw new Error(`Goody estimated total ${highEstimate} exceeds approved amount ${intent.amount_cents}`);
  }
  const orderBatch = await postGoodyJson('/v1/order_batches', payload, { config, fetchImpl });
  const firstOrder = Array.isArray(orderBatch.orders_preview) ? orderBatch.orders_preview[0] : null;
  intent.status = 'sent';
  intent.sent_by = normalizeText(sentBy, 120) || 'John';
  intent.sent_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  intent.goody_environment = current.policy.goody_environment;
  intent.goody_order_batch_id = orderBatch.id || null;
  intent.goody_order_id = firstOrder?.id || null;
  intent.goody_send_status = orderBatch.send_status || null;
  intent.goody_gift_link = firstOrder?.individual_gift_link || firstOrder?.individual_order_link || null;
  intent.goody_reference_id = orderBatch.reference_id || null;
  intent.goody_customer_reference_id = orderBatch.customer_reference_id || payload.customer_reference_id;
  intent.goody_price_estimate_cents = highEstimate;
  intent.goody_send_commitment = commitment({
    id: intent.id,
    request_commitment: intent.request_commitment,
    approval_commitment: intent.approval_commitment,
    goody_order_batch_id: intent.goody_order_batch_id,
    goody_order_id: intent.goody_order_id,
    goody_customer_reference_id: intent.goody_customer_reference_id,
    goody_price_estimate_cents: intent.goody_price_estimate_cents,
  });
  return { ledger: current, intent, report: policyReport(current, { now }), price, order_batch: orderBatch };
}

module.exports = {
  ALLOWED_SEND_METHODS,
  DEFAULT_POLICY,
  GOODY_BASE_URLS,
  approveIntent,
  buildGoodyOrderPayload,
  commitment,
  createIntent,
  emptyLedger,
  extractHighPriceCents,
  listGoodyCards,
  listGoodyProducts,
  normalizeLedger,
  policyReport,
  recordGiftLinkDelivery,
  rejectIntent,
  sendIntent,
  sendReadiness,
  updateGiftDefaults,
  validateIntentInput,
};
