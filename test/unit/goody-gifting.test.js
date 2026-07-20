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
