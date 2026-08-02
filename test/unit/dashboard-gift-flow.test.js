const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardAdminSource = fs.readFileSync(
  path.resolve(__dirname, '../../public/js/dashboard-admin.js'), 'utf8');

function giftDashboardContext(responses) {
  const toast = { className: '', textContent: '' };
  const requests = [];
  const context = vm.createContext({
    console,
    URLSearchParams,
    window: { location: { search: '', pathname: '/' } },
    history: { replaceState: () => {} },
    setTimeout,
    document: { getElementById: id => id === 'gift-toast' ? toast : null },
    confirm: () => true,
    prompt: () => '',
    operatorApi: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      return {
        ok: response.ok,
        status: response.status || (response.ok ? 200 : 400),
        text: async () => JSON.stringify(response.body || {}),
      };
    },
    api: async () => { throw new Error('unexpected dashboard refresh request'); },
    refreshCount: 0,
  });
  vm.runInContext(dashboardAdminSource, context);
  vm.runInContext('loadGiftDeliberations = async () => { refreshCount += 1; }', context);
  return { context, requests, toast };
}

test('one confirmed gift approval approves then sends through Goody', async () => {
  const { context, requests, toast } = giftDashboardContext([
    { ok: true, body: { intent: { status: 'approved' } } },
    { ok: true, body: { delivery: { ok: true } } },
  ]);

  await context.decideGiftIntent('gift-mallory', 'approve_and_send');

  assert.deepEqual(requests.map(request => request.url), [
    '/gifts/intents/gift-mallory/approve',
    '/gifts/intents/gift-mallory/send',
  ]);
  assert.equal(requests.every(request => request.options.method === 'POST'), true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { approved_by: 'John' });
  assert.deepEqual(JSON.parse(requests[1].options.body), { sent_by: 'John', delivered_by: 'Nora' });
  assert.equal(toast.className, 'toast ok');
  assert.match(toast.textContent, /delivered by Nora in Slack with you included/);
  assert.equal(context.refreshCount, 1);
});

test('a failed send remains visibly approved and recoverable', async () => {
  const { context, requests, toast } = giftDashboardContext([
    { ok: true, body: { intent: { status: 'approved' } } },
    { ok: false, status: 409, body: { error: 'Goody is temporarily unavailable' } },
  ]);

  await context.decideGiftIntent('gift-mallory', 'approve_and_send');

  assert.equal(requests.length, 2);
  assert.equal(toast.className, 'toast err');
  assert.equal(toast.textContent, 'Gift approved, but not sent: Goody is temporarily unavailable');
  assert.equal(context.refreshCount, 1);
});

test('a quoted overage requires exact reapproval before the gift is sent', async () => {
  const { context, requests, toast } = giftDashboardContext([
    { ok: true, body: { intent: { status: 'approved', amount_cents: 5660 } } },
    { ok: true, body: { delivery: { ok: true } } },
  ]);

  await context.decideGiftIntent('gift-mallory', 'approve_quote_and_send', 5660, 'quote-commitment');

  assert.deepEqual(requests.map(request => request.url), [
    '/gifts/intents/gift-mallory/approve',
    '/gifts/intents/gift-mallory/send',
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    approved_by: 'John',
    amount_cents: 5660,
    allow_per_gift_overage: true,
    quote_commitment: 'quote-commitment',
    note: 'John approved the current itemized Goody estimate in the operator dashboard.',
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), { sent_by: 'John', delivered_by: 'Nora' });
  assert.equal(toast.className, 'toast ok');
  assert.match(toast.textContent, /delivered by Nora in Slack with you included/);
  assert.equal(context.refreshCount, 1);
});
