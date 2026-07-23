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
});
