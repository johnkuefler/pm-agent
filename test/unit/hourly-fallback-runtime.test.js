'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NORA_TEST_MODE = '1';
const { __test } = require('../../server');

test('fallback forecast retries spend one shared runtime deadline', async () => {
  const requestTimeouts = [];
  const waits = [];
  const retryable = Object.assign(new Error('projection is still preparing'), {
    code: 'SELF_FORECAST_PREPARATION_PENDING',
  });
  await assert.rejects(__test.commitFallbackForecast('cycle-bounded', {}, {
    attempts: 3,
    deadlineAt: Date.now() + 13500,
    request: async (_method, _route, _payload, timeoutMs) => {
      requestTimeouts.push(timeoutMs);
      throw retryable;
    },
    wait: async milliseconds => { waits.push(milliseconds); },
  }), error => error === retryable);
  assert.equal(requestTimeouts.length, 3);
  assert.ok(requestTimeouts.every(timeout => timeout > 0 && timeout <= 1500),
    'each retry must receive only the wall-clock budget left before the cleanup reserve');
  assert.deepEqual(waits, [1000, 1000]);
});

test('fallback forecast never starts after its runtime deadline is exhausted', async () => {
  let requests = 0;
  await assert.rejects(__test.commitFallbackForecast('cycle-expired', {}, {
    deadlineAt: Date.now() - 1,
    request: async () => { requests += 1; },
  }), error => error.code === 'hourly_fallback_deadline_exceeded');
  assert.equal(requests, 0);
});

test('hourly coverage connector reads propagate cancellation and remaining budgets', () => {
  const source = __test.fallbackOperationalSweep.toString();
  assert.match(source, /signal => peopleTool\.execute/);
  assert.match(source, /\{ signal, timeoutMs: identityBudgetMs \}/);
  assert.match(source, /signal => tasksTool\.execute/);
  assert.match(source, /\{ signal, timeoutMs: taskBudgetMs \}/);
  assert.match(source, /Promise\.all\(\[teamworkLane\(\), slackLane\(\), gmailLane\(\)\]\)/,
    'independent connector scans must run concurrently');
  assert.match(source, /Fallback Slack missed-mention sweep/);
  assert.match(source, /Fallback Gmail unread sweep/);
  assert.match(source, /signal => binding\.execute\(args, \{ signal, timeoutMs: gmailBudgetMs \}\)/);
});

test('coverage result counting handles MCP envelopes without retaining message content', () => {
  assert.equal(__test.coverageCollectionCount([{ id: 1 }, { id: 2 }]), 2);
  assert.equal(__test.coverageCollectionCount({ messages: [{ id: 1 }] }), 1);
  assert.equal(__test.coverageCollectionCount({
    content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }) }],
  }), 2);
  assert.equal(__test.coverageCollectionCount({ total: 4 }), 4);
  assert.equal(__test.coverageCollectionCount('opaque connector response'), null);
});

test('Gmail coverage adapts to the connected tool schema and fails closed on unknown requirements', () => {
  assert.deepEqual(__test.gmailCoverageSearchArgs({
    properties: {
      user_google_email: { type: 'string' },
      query: { type: 'string' },
      page_size: { type: 'integer' },
    },
    required: ['user_google_email', 'query'],
  }, 'is:unread', 'nora@example.com'), {
    query: 'is:unread', page_size: 25, user_google_email: 'nora@example.com',
  });
  assert.throws(() => __test.gmailCoverageSearchArgs({
    properties: { account_id: { type: 'string' } },
    required: ['account_id'],
  }, 'is:unread', 'nora@example.com'), error =>
    error.code === 'gmail_coverage_schema_unresolved');
});
