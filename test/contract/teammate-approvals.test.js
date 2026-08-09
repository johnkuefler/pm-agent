'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceRegion, ROOT } = require('../helpers/server-source');

test('teammate approval has no generic execution or reminder HTTP surface', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/routes/teammate-approvals.js'), 'utf8');
  assert.match(source, /get\('\/teammate-approvals'/);
  assert.match(source, /post\('\/teammate-approvals\/proposals'/);
  assert.match(source, /post\('\/teammate-approvals\/proposals\/:id\/cancel'/);
  assert.doesNotMatch(source, /execute|remind/);
});

test('only the signed Slack webhook can turn a teammate reply into execution', () => {
  const handler = sourceRegion('async function processSlackWebhookEvent',
    'async function getNoraBotUserId');
  const signedDecision = handler.indexOf('teammateApprovals.handleSlackDecision');
  const ordinaryConversation = handler.indexOf('await handleSlack(');
  assert.ok(signedDecision >= 0, 'signed Slack processing must inspect teammate decisions');
  assert.ok(ordinaryConversation > signedDecision,
    'an exact teammate decision must be consumed before ordinary model conversation');
  assert.match(handler, /rawText: text/);
  assert.match(handler, /attestation: sourceAttestation/);
});
