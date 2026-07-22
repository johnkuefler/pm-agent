'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeRuntimePerformance } = require('../../scripts/probe-runtime-performance');

test('runtime probe measures core live reads in parallel', async () => {
  const calls = [];
  const result = await probeRuntimePerformance({
    baseUrl: 'https://nora.test/',
    apiKey: 'secret',
    paths: ['/fast', '/slow'],
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(1024).buffer };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.url).sort(), ['https://nora.test/fast', 'https://nora.test/slow']);
  assert.ok(calls.every(call => call.authorization === 'Bearer secret'));
  assert.ok(result.results.every(item => item.response_kb === 1));
});

test('runtime probe reports transport failures without hiding healthy paths', async () => {
  const result = await probeRuntimePerformance({
    baseUrl: 'https://nora.test', paths: ['/ok', '/broken'],
    fetchImpl: async url => {
      if (url.endsWith('/broken')) throw new Error('socket closed');
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 200);
  assert.equal(result.results[1].error, 'socket closed');
});

test('runtime probe fails a configured response budget', async () => {
  const result = await probeRuntimePerformance({
    baseUrl: 'https://nora.test', paths: ['/slow'], budgetMs: 1,
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].within_interactive_budget, false);
});
