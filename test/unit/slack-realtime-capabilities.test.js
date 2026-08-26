'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readServerSource } = require('../helpers/server-source');

const source = readServerSource();

function region(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Slack webhook acknowledges immediately and dispatches the same event without hourly polling', () => {
  const webhook = region("app.post('/webhook/slack'", 'async function processSlackWebhookEvent');
  assert.match(webhook, /res\.sendStatus\(200\)/);
  assert.match(webhook, /trackSlackWebhookEvent\([\s\S]*processSlackWebhookEvent/);

  const eventHandler = region('async function processSlackWebhookEvent', 'async function handleSlack');
  assert.match(eventHandler, /await handleSlack\(channel, user, query/);
});

test('direct Slack tool turns attach native project planning and calendar scheduling tools', () => {
  const handler = region('async function handleSlackImpl', 'async function getNoraBotUserId');
  assert.match(handler, /const TW_WRITE = TW_WRITE_NAMES/);
  assert.match(handler, /createGoogleCalendarTools\(\{/);
  assert.match(handler, /const LIVE_WRITE = new Set\(\[\.\.\.TW_WRITE, \.\.\.CALENDAR_WRITE\]\)/);
  assert.match(handler, /writeToolNames: \[\.\.\.LIVE_WRITE/);
  assert.match(handler, /firedTools\.some\(n => LIVE_WRITE\.has\(n\)\)/);
});

test('scheduled task runs receive the same native Teamwork and calendar tools', () => {
  const scheduled = region('function nativeHourlyTaskToolset', 'async function runNativeHourlyTask');
  assert.match(scheduled, /for \(const tool of TEAMWORK_TOOLS\)/);
  assert.match(scheduled, /createGoogleCalendarTools\(\{/);
  assert.match(scheduled, /CALENDAR_WRITE_TOOL_NAMES\.includes/);
});

test('Google OAuth requests event write and free-busy scopes and reports scheduling readiness', () => {
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/calendar\.events'/);
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/calendar\.events\.freebusy'/);
  assert.doesNotMatch(region('const GOOGLE_OAUTH_SCOPES', 'const oauthStates'), /calendar\.events\.readonly/);
  assert.match(region("app.get('/calendar/status'", "app.delete('/calendar'"), /scheduling_enabled/);
});
