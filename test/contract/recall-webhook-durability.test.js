'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

test('every signed Recall route delegates acceptance to the generic durable inbox', () => {
  for (const [pathName, route] of [
    ['/webhook/recall-calendar', 'calendar'],
    ['/webhook/transcript', 'transcript'],
    ['/webhook/chat', 'chat'],
    ['/webhook/participant', 'participant'],
    ['/webhook/status', 'status'],
  ]) {
    assert.match(server, new RegExp(
      `app\\.post\\('${pathName.replaceAll('/', '\\/')}', requireVerifiedRecallWebhook,\\s*`
      + `\\(req, res\\) => acceptRecallWebhook\\('${route}', req, res\\)\\)`));
  }
  const acceptor = server.slice(server.indexOf('async function acceptRecallWebhook'),
    server.indexOf('function reconstructRecallWebhookRequest'));
  assert.ok(acceptor.indexOf('await enqueueRecallWebhook(route, req)')
    < acceptor.indexOf('res.sendStatus(200)'));
  assert.match(acceptor, /Retry-After[\s\S]*status\(503\)/);
});

test('Recall processing is claim-token fenced, retry bounded, and lifecycle owned', () => {
  const claimed = server.slice(server.indexOf('async function processClaimedRecallWebhook'),
    server.indexOf('async function processNextRecallWebhookInboxUnsafe'));
  assert.match(claimed,
    /complete\(\s*RECALL_WEBHOOK_PROVIDER, record\.event_id, record\.claim_token\)/);
  assert.match(claimed,
    /fail\(\s*RECALL_WEBHOOK_PROVIDER, record\.event_id, record\.claim_token, error\)/);
  assert.match(server, /kickRecallWebhookInbox\(\);[\s\S]*if \(background\)/);
  assert.match(server,
    /scheduleRecurringRuntimeJob\('recall-webhook-inbox'[\s\S]*drainRecallWebhookInbox/);
  assert.match(server, /drainRecallWebhookInbox\(\{ timeoutMs: 20000 \}\)/);
  assert.match(server, /recall_webhook_events: recallWebhookInboxSnapshot\(\)/);
});

test('transcript completion is source-event deduplicated behind strict incremental persistence', () => {
  const transcript = server.slice(server.indexOf('async function processRecallTranscriptWebhook'),
    server.indexOf("app.post('/webhook/transcript'"));
  assert.match(transcript, /source_event_id: sourceEventId/);
  assert.match(transcript, /existingSourceIndex >= \(_transcriptPersistedCounts\.get\(bot_id\) \|\| 0\)/);
  assert.match(transcript,
    /await saveTranscriptDoc\(bot_id, session\.transcript, null, \{[\s\S]*incremental: true,[\s\S]*strict: true/);
});

test('meeting chat and participant processors propagate undelivered or unexpected work', () => {
  const chat = server.slice(server.indexOf('async function processRecallChatWebhook'),
    server.indexOf("app.post('/webhook/chat'"));
  assert.match(chat, /meeting-chat response and fallback delivery failed/);
  assert.match(chat, /throw retryable/);
  const participant = server.slice(
    server.indexOf('async function processRecallParticipantWebhook'),
    server.indexOf("app.post('/webhook/participant'"));
  assert.match(participant, /catch \(error\)[\s\S]*ownershipError = error;[\s\S]*throw error/);
  assert.doesNotMatch(participant, /console\.warn\('participant webhook/);
});

test('calendar cursor, pagination, and scheduling credentials remain retry-safe until inbox completion', () => {
  const calendar = server.slice(server.indexOf('async function processRecallCalendarWebhook'),
    server.indexOf("app.post('/webhook/recall-calendar'"));
  assert.match(calendar, /pageUrl = validatedRecallV2PaginationUrl\(listRes\.data\?\.next\)/);
  assert.match(calendar, /deduplication_key: credential\.deduplication_key/);
  assert.match(calendar, /await persistSessionTokens\(\{ strict: true \}\)/);
  assert.match(calendar,
    /state\.last_sync = syncWindow\.cursor;[\s\S]*state\.last_sync_completed_at[\s\S]*await saveCalendarStateStrict\(state\)/);
  assert.match(server,
    /const recallCalendarId = String\(recallRes\.data\?\.id[\s\S]*await saveCalendarStateStrict\(\{[\s\S]*recall_calendar_id: recallCalendarId[\s\S]*res\.redirect\('\/\?calendar_connected=1'\)/);
});
