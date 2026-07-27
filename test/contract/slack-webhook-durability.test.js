'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const database = fs.readFileSync(path.join(root, 'db.js'), 'utf8');

test('Slack acknowledges only after an atomic durable inbox insert', () => {
  const route = server.slice(
    server.indexOf("app.post('/webhook/slack'"),
    server.indexOf('async function processSlackWebhookEvent'),
  );
  assert.match(route, /await enqueueSlackWebhook\(body, slackVerification\.attestation, eventId\)/);
  assert.ok(route.indexOf('await enqueueSlackWebhook') < route.indexOf('res.sendStatus(200)'));
  assert.match(route, /status\(503\)[\s\S]*retry required/);
  assert.match(database,
    /CREATE TABLE IF NOT EXISTS \$\{DB_SCHEMA\}\.webhook_inbox[\s\S]*PRIMARY KEY \(provider, event_id\)/);
  assert.match(database,
    /ON CONFLICT \(provider, event_id\) DO UPDATE[\s\S]*webhook_inbox\.payload=EXCLUDED\.payload[\s\S]*RETURNING status/);
});

test('Slack processing uses expiring cross-instance leases and bounded poison retries', () => {
  assert.match(database,
    /async function claimNextWebhookEvent[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*lease_until/);
  assert.match(database,
    /async function failWebhookEvent[\s\S]*attempts >= \$4 THEN 'dead' ELSE 'queued'/);
  assert.match(server,
    /processClaimedSlackWebhook[\s\S]*processSlackWebhookEvent[\s\S]*complete\('slack', eventId, record\.claim_token, \{ allowEmptyResult \}\)[\s\S]*fail\('slack', eventId, record\.claim_token, error\)/);
  assert.match(server,
    /scheduleRecurringRuntimeJob\('slack-webhook-inbox'[\s\S]*processNextSlackWebhookInbox/);
});
