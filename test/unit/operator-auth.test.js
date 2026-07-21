'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperatorToken, verifyOperatorToken, requireOperatorAuth } = require('../../src/middleware/auth');

test('operator authority is signed, expiring, and separate from Nora bearer authority', () => {
  const previous = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'operator-test-secret';
  try {
    const now = Date.now();
    const token = createOperatorToken({ now, ttlMs: 60000 });
    assert.equal(verifyOperatorToken(token, { now: now + 30000 }), true);
    assert.equal(verifyOperatorToken(token, { now: now + 60001 }), false);
    const tampered = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    assert.equal(verifyOperatorToken(tampered, { now: now + 1 }), false);
    let advanced = false; let status = null; let body = null;
    requireOperatorAuth({ headers: { authorization: 'Bearer nora-key' } },
      { status(value) { status = value; return this; }, json(value) { body = value; } },
      () => { advanced = true; });
    assert.equal(advanced, false); assert.equal(status, 401);
    assert.match(body.error, /signed dashboard session/);
    requireOperatorAuth({ headers: { 'x-nora-operator-token': token } },
      { status() { return this; }, json() {} }, () => { advanced = true; });
    assert.equal(advanced, true);
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = previous;
  }
});
