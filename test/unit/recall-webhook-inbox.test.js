'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');

process.env.NORA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-recall-inbox-'));
process.env.NORA_TEST_MODE = '1';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test: helpers } = require('../../server');

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    sendStatus(value) {
      this.statusCode = value;
      return this;
    },
  };
}

test('Recall queue IDs are route-scoped and raw-body hashes are confined to test mode', () => {
  const explicit = helpers.recallWebhookQueueEventId('chat', {
    recallVerification: { webhook_id: 'msg_same' },
    rawBody: Buffer.from('one'),
  });
  assert.equal(explicit, 'chat:msg_same');
  assert.equal(helpers.recallWebhookQueueEventId('status', {
    recallVerification: { webhook_id: 'msg_same' },
    rawBody: Buffer.from('one'),
  }), 'status:msg_same');

  const hashed = helpers.recallWebhookQueueEventId('transcript', {
    recallVerification: {},
    rawBody: Buffer.from('exact bytes'),
  });
  assert.match(hashed, /^transcript:test-sha256-[a-f0-9]{64}$/);
  assert.throws(() => helpers.recallWebhookQueueEventId('transcript', {
    recallVerification: {},
    rawBody: Buffer.from('exact bytes'),
  }, { NODE_ENV: 'production', NORA_TEST_MODE: '1' }), /verified Recall webhook id is required/);
});

test('the common acceptor acknowledges only a generic inbox insert and deduplicates replay', async () => {
  const before = helpers.recallWebhookInboxSnapshot();
  const req = {
    body: { event: 'ignored.test.event', data: {} },
    rawBody: Buffer.from('{"event":"ignored.test.event","data":{}}'),
    recallVerification: {
      cryptographically_verified: true,
      webhook_id: 'msg_accept_once',
      timestamp: new Date().toISOString(),
    },
    get(name) {
      return String(name).toLowerCase() === 'host' ? 'nora.test' : undefined;
    },
  };
  const first = responseRecorder();
  const accepted = await helpers.acceptRecallWebhook('status', req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(accepted.inserted, true);
  await helpers.drainRecallWebhookInbox({ timeoutMs: 2000 });

  const second = responseRecorder();
  const duplicate = await helpers.acceptRecallWebhook('status', req, second);
  assert.equal(second.statusCode, 200);
  assert.equal(duplicate.inserted, false);
  await helpers.drainRecallWebhookInbox({ timeoutMs: 2000 });

  const after = helpers.recallWebhookInboxSnapshot();
  assert.equal(after.completed, before.completed + 1);
  assert.equal(after.duplicate_deliveries, before.duplicate_deliveries + 1);
  assert.equal(after.active_count, 0);
  assert.equal(after.inbox.dead_letters, 0);
});

test('a non-test process without Postgres refuses Recall acknowledgement with retry guidance', async () => {
  const priorTestMode = process.env.NORA_TEST_MODE;
  delete process.env.NORA_TEST_MODE;
  const response = responseRecorder();
  try {
    await helpers.acceptRecallWebhook('status', {
      body: { event: 'ignored.test.event', data: {} },
      rawBody: Buffer.from('{}'),
      recallVerification: {
        cryptographically_verified: true,
        webhook_id: 'msg_requires_durable_db',
      },
      get: () => 'nora.test',
    }, response);
  } finally {
    process.env.NORA_TEST_MODE = priorTestMode;
  }
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '1');
  assert.match(response.body.error, /not durably accepted/);
});

test('claimed payload reconstruction keeps host and verification metadata but no request secrets', () => {
  const reconstructed = helpers.reconstructRecallWebhookRequest({
    event_id: 'participant:msg_1',
    payload: {
      route: 'participant',
      body: { event: 'participant_events.join', data: {} },
      request_host: 'nora.example.com',
      verification: {
        cryptographically_verified: true,
        webhook_id: 'msg_1',
        timestamp: '2026-07-26T12:00:00.000Z',
      },
    },
    attestation: { ignored: 'not-needed' },
  });
  assert.equal(reconstructed.recallEventId, 'participant:msg_1');
  assert.equal(reconstructed.get('host'), 'nora.example.com');
  assert.deepEqual(JSON.parse(reconstructed.rawBody.toString('utf8')), reconstructed.body);
  assert.equal(JSON.stringify(reconstructed).includes('authorization'), false);
});

test('transcript source events persist strictly once and replay without duplicate utterances', async () => {
  const botId = 'bot_recall_dedupe';
  const request = {
    recallEventId: 'transcript:msg_transcript_once',
    body: {
      event: 'transcript.data',
      data: {
        bot: { id: botId },
        data: {
          text: 'The approved launch date is August 4.',
          participant: { name: 'Alex' },
        },
      },
    },
  };
  await helpers.processRecallTranscriptWebhook(request);
  await helpers.processRecallTranscriptWebhook(request);
  const transcriptPath = path.join(
    process.env.NORA_DATA_DIR, `transcript-${botId}.json`);
  const persisted = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  assert.equal(persisted.transcript.length, 1);
  assert.equal(persisted.transcript[0].source_event_id,
    'transcript:msg_transcript_once');
  assert.equal(persisted.transcript[0].text,
    'The approved launch date is August 4.');
  const episode = helpers.intelligenceStore.list('episodes')
    .find(item => item.correlation === `meeting:${botId}`);
  assert.equal(episode.events.filter(
    item => item.id === 'transcript:msg_transcript_once').length, 1);
});

test('calendar cursors are monotonic and credentials reuse both relay and dedupe identity', () => {
  const state = { last_sync: '2026-07-26T12:00:00.000Z' };
  const lateOldDelivery = helpers.calendarSyncWindow(state, {
    last_updated_ts: '2026-07-26T11:00:00.000Z',
  });
  assert.equal(lateOldDelivery.cursor, '2026-07-26T12:00:00.000Z');
  assert.equal(lateOldDelivery.updated_since, '2026-07-26T10:55:00.000Z');

  const later = helpers.calendarSyncWindow(state, {
    last_updated_ts: '2026-07-26T13:00:00.000Z',
  });
  assert.equal(later.cursor, '2026-07-26T13:00:00.000Z');
  assert.throws(() => helpers.calendarSyncWindow(state, {}), /last_updated_ts cursor/);

  const calendar = {};
  const credential = helpers.calendarBotCredential(calendar, 'event-1', {
    randomBytes: size => Buffer.alloc(size, 7),
    now: new Date('2026-07-26T12:00:00.000Z'),
  });
  const replay = helpers.calendarBotCredential(calendar, 'event-1', {
    randomBytes: () => { throw new Error('must not rotate'); },
  });
  assert.equal(replay.session_token, credential.session_token);
  assert.equal(replay.deduplication_key, 'nora-auto-event-1');
});

test('Calendar V2 pagination preserves a trusted next URL byte-for-byte', () => {
  const exact = 'https://us-east-1.recall.ai/api/v2/calendar-events/?cursor=a%2Bb&calendar_id=1';
  assert.equal(helpers.validatedRecallV2PaginationUrl(exact), exact);
  assert.equal(helpers.validatedRecallV2PaginationUrl(null), null);
  assert.throws(() => helpers.validatedRecallV2PaginationUrl(
    'http://us-east-1.recall.ai/api/v2/calendar-events/?cursor=x'), /trusted-origin policy/);
  assert.throws(() => helpers.validatedRecallV2PaginationUrl(
    'https://attacker.example/api/v2/calendar-events/?cursor=x'), /trusted-origin policy/);
});

test('calendar processing follows every trusted page, removes stale schedules, then advances the provider cursor', async () => {
  const calendarPath = path.join(process.env.NORA_DATA_DIR, 'nora-calendar.json');
  fs.writeFileSync(calendarPath, JSON.stringify({
    recall_calendar_id: 'calendar-1',
    google_email: 'nora@example.com',
    last_sync: '2026-07-26T12:00:00.000Z',
    bot_credentials: {
      'event-removed': {
        event_id: 'event-removed',
        session_token: 'stable-token',
        deduplication_key: 'nora-auto-event-removed',
        status: 'scheduled',
        bot_id: 'bot-1',
      },
    },
  }));
  const nextUrl =
    'https://us-east-1.recall.ai/api/v2/calendar-events/?cursor=provider%2Bopaque';
  const gets = [];
  const deletes = [];
  const originalGet = axios.get;
  const originalDelete = axios.delete;
  axios.get = async url => {
    gets.push(url);
    if (gets.length === 1) {
      return {
        data: {
          results: [{ id: 'event-removed', is_deleted: true }],
          next: nextUrl,
        },
      };
    }
    assert.equal(url, nextUrl);
    return { data: { results: [], next: null } };
  };
  axios.delete = async url => {
    deletes.push(url);
    return { data: {} };
  };
  try {
    await helpers.processRecallCalendarWebhook({
      body: {
        event: 'calendar.sync_events',
        data: {
          calendar_id: 'calendar-1',
          last_updated_ts: '2026-07-26T13:00:00.000Z',
        },
      },
      get: name => String(name).toLowerCase() === 'host' ? 'nora.test' : undefined,
    });
  } finally {
    axios.get = originalGet;
    axios.delete = originalDelete;
  }
  assert.equal(gets.length, 2);
  assert.equal(gets[1], nextUrl);
  assert.deepEqual(deletes, [
    'https://us-east-1.recall.ai/api/v2/calendar-events/event-removed/bot/',
  ]);
  const persisted = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
  assert.equal(persisted.bot_credentials['event-removed'].status, 'removed');
  assert.equal(persisted.last_sync, '2026-07-26T13:00:00.000Z');
  assert.equal(persisted.provider_status, 'connected');
  assert.match(persisted.last_sync_completed_at, /^\d{4}-\d\d-\d\dT/);
});

test('calendar.update re-fetches provider state and records automatic disconnect cleanup', async () => {
  const calendarPath = path.join(process.env.NORA_DATA_DIR, 'nora-calendar.json');
  fs.writeFileSync(calendarPath, JSON.stringify({
    recall_calendar_id: 'calendar-2',
    google_email: 'nora@example.com',
    bot_credentials: {
      'event-future': {
        event_id: 'event-future',
        session_token: 'stable-token-2',
        deduplication_key: 'nora-auto-event-future',
        status: 'scheduled',
        bot_id: 'bot-2',
      },
    },
  }));
  const originalGet = axios.get;
  axios.get = async url => {
    assert.equal(url, 'https://us-east-1.recall.ai/api/v2/calendars/calendar-2/');
    return { data: { status: 'disconnected' } };
  };
  try {
    await helpers.processRecallCalendarWebhook({
      body: { event: 'calendar.update', data: { calendar_id: 'calendar-2' } },
      get: () => 'nora.test',
    });
  } finally {
    axios.get = originalGet;
  }
  const persisted = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
  assert.equal(persisted.provider_status, 'disconnected');
  assert.equal(persisted.bot_credentials['event-future'].status, 'removed');
  assert.equal(persisted.bot_credentials['event-future'].removal_source,
    'recall_calendar_update');
});

test('calendar page failures remain retryable and never advance the durable cursor', async () => {
  const calendarPath = path.join(process.env.NORA_DATA_DIR, 'nora-calendar.json');
  fs.writeFileSync(calendarPath, JSON.stringify({
    recall_calendar_id: 'calendar-3',
    google_email: 'nora@example.com',
    last_sync: '2026-07-26T12:00:00.000Z',
  }));
  const nextUrl = 'https://us-east-1.recall.ai/api/v2/calendar-events/?cursor=retry-me';
  const originalGet = axios.get;
  let calls = 0;
  axios.get = async () => {
    calls += 1;
    if (calls === 1) return { data: { results: [], next: nextUrl } };
    throw new Error('temporary Recall page failure');
  };
  try {
    await assert.rejects(helpers.processRecallCalendarWebhook({
      body: {
        event: 'calendar.sync_events',
        data: {
          calendar_id: 'calendar-3',
          last_updated_ts: '2026-07-26T14:00:00.000Z',
        },
      },
      get: () => 'nora.test',
    }), /temporary Recall page failure/);
  } finally {
    axios.get = originalGet;
  }
  const persisted = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
  assert.equal(persisted.last_sync, '2026-07-26T12:00:00.000Z');
  assert.equal(persisted.last_sync_completed_at, undefined);
});

test('processor failures return to the Recall inbox with visible retry health', async () => {
  const before = helpers.recallWebhookInboxSnapshot();
  const response = responseRecorder();
  await helpers.acceptRecallWebhook('status', {
    body: {
      event: 'bot.status_change',
      data: { bot: { id: '../invalid-bot-id' }, status: { code: 'joining_call' } },
    },
    rawBody: Buffer.from('invalid-bot-test'),
    recallVerification: {
      cryptographically_verified: true,
      webhook_id: 'msg_retry_invalid_bot',
    },
    get: () => 'nora.test',
  }, response);
  assert.equal(response.statusCode, 200);
  await helpers.drainRecallWebhookInbox({ timeoutMs: 2000 });
  const after = helpers.recallWebhookInboxSnapshot();
  assert.equal(after.processing_failures, before.processing_failures + 1);
  assert.equal(after.retries_scheduled, before.retries_scheduled + 1);
  assert.equal(after.inbox.queued, before.inbox.queued + 1);
  assert.match(after.last_processing_failure.error, /invalid transcript bot id/);
});
