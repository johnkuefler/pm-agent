'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

test('database webhook claims rotate opaque tokens and fence terminal mutations', async () => {
  const pools = [];
  class FakePool extends EventEmitter {
    constructor() {
      super();
      this.queries = [];
      this.activeClaimToken = null;
      pools.push(this);
    }

    async query(text, params = []) {
      this.queries.push({ text, params });
      if (/SET status='processing'/.test(text)) {
        const token = text.includes('candidate.event_id') ? params[2] : params[3];
        this.activeClaimToken = token;
        return {
          rows: [{
            provider: String(params[0]),
            event_id: text.includes('candidate.event_id') ? 'Ev-next' : String(params[1]),
            status: 'processing',
            claim_token: token,
          }],
        };
      }
      if (/SET status='completed'/.test(text)) {
        const matches = params[2] === this.activeClaimToken;
        if (matches) this.activeClaimToken = null;
        return { rowCount: matches ? 1 : 0, rows: [] };
      }
      if (/SET processing_result=\$4::jsonb/.test(text)) {
        return { rowCount: params[2] === this.activeClaimToken ? 1 : 0, rows: [] };
      }
      if (/SET lease_until=GREATEST/.test(text)) {
        return { rowCount: params[2] === this.activeClaimToken ? 1 : 0, rows: [] };
      }
      if (/SET status=CASE WHEN attempts/.test(text)) {
        const matches = params[4] === this.activeClaimToken;
        if (matches) this.activeClaimToken = null;
        return {
          rowCount: matches ? 1 : 0,
          rows: matches ? [{ status: 'queued', attempts: 1, available_at: new Date() }] : [],
        };
      }
      return { rowCount: 0, rows: [] };
    }

    async end() {}
  }

  const originalLoad = Module._load;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://test.invalid/nora';
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'pg') return { Pool: FakePool };
    return originalLoad.call(this, request, parent, isMain);
  };

  let db;
  try {
    const dbPath = require.resolve('../../db');
    delete require.cache[dbPath];
    db = require('../../db');

    const first = await db.claimWebhookEvent('slack', 'Ev1', { leaseSeconds: 60 });
    assert.match(first.claim_token, /^[0-9a-f-]{36}$/);
    const firstQuery = pools[0].queries.at(-1);
    assert.match(firstQuery.text, /claim_token=\$4/);
    assert.match(firstQuery.text, /attempts < \$5/);
    assert.match(firstQuery.text, /earlier\.ordering_key=inbox\.ordering_key/);
    assert.equal(firstQuery.params[3], first.claim_token);
    assert.equal(firstQuery.params[4], 5);

    const second = await db.claimNextWebhookEvent('slack', { leaseSeconds: 60 });
    assert.match(second.claim_token, /^[0-9a-f-]{36}$/);
    assert.notEqual(second.claim_token, first.claim_token);
    const secondQuery = pools[0].queries.at(-1);
    assert.match(secondQuery.text, /claim_token=\$3/);
    assert.match(secondQuery.text, /candidate\.attempts < \$4/);
    assert.match(secondQuery.text, /earlier\.ordering_key=candidate\.ordering_key/);
    assert.equal(secondQuery.params[2], second.claim_token);
    assert.equal(secondQuery.params[3], 5);
    assert.ok(pools[0].queries.some(query =>
      /processing lease expired at the maximum attempt count/.test(query.text)),
    'expired crash-only claims must be terminalized before another owner can claim');

    const beforeMissingToken = pools[0].queries.length;
    assert.equal(await db.completeWebhookEvent('slack', 'Ev-next'), false);
    assert.equal(await db.failWebhookEvent('slack', 'Ev-next', null, 'missing'), null);
    assert.equal(await db.failWebhookEvent('slack', 'Ev-next', new Error('legacy call')), null);
    assert.equal(pools[0].queries.length, beforeMissingToken);

    assert.equal(await db.completeWebhookEvent('slack', 'Ev-next', first.claim_token), false);
    assert.equal(await db.stageWebhookEventResult('slack', 'Ev-next', first.claim_token,
      { segments: ['stale'] }), false);
    assert.equal(await db.stageWebhookEventResult('slack', 'Ev-next', second.claim_token,
      { segments: ['stable'] }), true);
    const stagedQuery = pools[0].queries.at(-1);
    assert.match(stagedQuery.text, /status='processing'/);
    assert.match(stagedQuery.text, /AND claim_token=\$3/);
    assert.match(stagedQuery.text, /content_commitment/);
    assert.match(stagedQuery.text, /NOT IN \('delivered','suppressed'\)/);
    assert.equal(stagedQuery.params[3], JSON.stringify({ segments: ['stable'] }));
    assert.equal(await db.renewWebhookEventLease(
      'slack', 'Ev-next', first.claim_token, { leaseSeconds: 30 }), false);
    assert.equal(await db.renewWebhookEventLease(
      'slack', 'Ev-next', second.claim_token, { leaseSeconds: 30 }), true);
    const renewalQuery = pools[0].queries.at(-1);
    assert.match(renewalQuery.text, /GREATEST\(\s*lease_until/);
    assert.match(renewalQuery.text, /lease_until > now\(\)/);
    assert.equal(renewalQuery.params[3], 30);
    assert.equal(await db.failWebhookEvent('slack', 'Ev-next', first.claim_token, 'stale'), null);
    assert.equal(await db.completeWebhookEvent('slack', 'Ev-next', second.claim_token), true);
    const completedQuery = pools[0].queries.at(-1);
    assert.match(completedQuery.text, /claim_token=NULL/);
    assert.match(completedQuery.text, /AND claim_token=\$3/);

    const third = await db.claimWebhookEvent('slack', 'Ev2');
    const failed = await db.failWebhookEvent('slack', 'Ev2', third.claim_token,
      new Error('temporary'));
    assert.equal(failed.status, 'queued');
    const failedQuery = pools[0].queries.at(-1);
    assert.match(failedQuery.text, /claim_token=NULL/);
    assert.match(failedQuery.text, /AND claim_token=\$5/);
    assert.equal(failedQuery.params[4], third.claim_token);
  } finally {
    if (db) await db.close();
    Module._load = originalLoad;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
});
