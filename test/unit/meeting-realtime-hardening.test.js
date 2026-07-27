'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-meeting-hardening-'));
process.env.NORA_DATA_DIR = dataDir;
process.env.NORA_TEST_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;
delete process.env.RECALL_ALLOW_UNSIGNED_WEBHOOKS_IN_TEST;

const verificationSecret = `whsec_${Buffer.from('meeting-webhook-test-secret').toString('base64')}`;
process.env.RECALL_WORKSPACE_VERIFICATION_SECRET = verificationSecret;

const { server, __test: helpers } = require('../../server');
const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
let port;

function signatureHeaders(rawBody, {
  secret = verificationSecret,
  webhookId = `msg_${crypto.randomBytes(4).toString('hex')}`,
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = crypto.createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

function request(pathname, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(rawBody);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await helpers.drainRecallWebhookInbox({ timeoutMs: 2000 });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('all Recall webhook routes fail closed and accept an exact officially signed body', async () => {
  const routes = [
    '/webhook/recall-calendar',
    '/webhook/transcript',
    '/webhook/chat',
    '/webhook/participant',
    '/webhook/status',
  ];
  const rawBody = '{ "event": "ignored.test.event", "data": {} }';
  for (const route of routes) {
    assert.equal((await request(route, rawBody)).status, 401, `${route} accepted an unsigned request`);
    assert.equal((await request(route, rawBody, signatureHeaders(rawBody))).status, 200,
      `${route} rejected an exact signed request`);
  }
  const headers = signatureHeaders(rawBody);
  assert.equal((await request('/webhook/transcript', rawBody.replace('{ ', '{  '), headers)).status, 401,
    're-serialized body bytes must not pass the original signature');
});

test('unsigned webhook override requires both explicit flags and never wins over production mode', () => {
  const requestShape = { headers: {}, rawBody: Buffer.from('{}') };
  assert.equal(helpers.recallWebhookVerification(requestShape, {}).valid, false);
  assert.equal(helpers.recallWebhookVerification(requestShape, {
    RECALL_ALLOW_UNSIGNED_WEBHOOKS_IN_TEST: '1',
  }).valid, false);
  assert.equal(helpers.recallWebhookVerification(requestShape, {
    NORA_TEST_MODE: '1',
  }).valid, false);
  assert.equal(helpers.recallWebhookVerification(requestShape, {
    NORA_TEST_MODE: '1',
    RECALL_ALLOW_UNSIGNED_WEBHOOKS_IN_TEST: '1',
  }).valid, true);
  assert.equal(helpers.recallWebhookVerification(requestShape, {
    NORA_TEST_MODE: '1',
    RECALL_ALLOW_UNSIGNED_WEBHOOKS_IN_TEST: '1',
    RECALL_WORKSPACE_VERIFICATION_SECRET: verificationSecret,
  }).valid, false, 'an explicit test override must not bypass a configured signing secret');
});

test('Recall bot routing is payload-bound and transcript ingress has no active-meeting fallback', () => {
  assert.equal(helpers.recallWebhookBotId({ data: { bot: { id: 'nested' } } }), 'nested');
  assert.equal(helpers.recallWebhookBotId({ data: { bot_id: 'data-id' } }), 'data-id');
  assert.equal(helpers.recallWebhookBotId({ bot_id: 'top-id' }), 'top-id');
  assert.equal(helpers.recallWebhookBotId({}), null);

  const transcriptStart = serverSource.indexOf('async function processRecallTranscriptWebhook');
  const transcriptEnd = serverSource.indexOf('const chatSessions', transcriptStart);
  assert.ok(transcriptStart >= 0 && transcriptEnd > transcriptStart);
  assert.doesNotMatch(serverSource.slice(transcriptStart, transcriptEnd), /activeBotId/);
  assert.ok((serverSource.match(/origin:\s*\{\s*kind:\s*'voice',\s*bot_id:\s*botId\s*\}/g) || []).length >= 2,
    'both realtime tool event paths must preserve their meeting bot id');
});

test('actual participant presence overrides speaker inference conservatively', () => {
  const unknown = {
    participantPresenceKnown: false,
    participants: new Map(),
    speakersHeard: new Set(['John']),
  };
  assert.equal(helpers.meetingHumanPresence(unknown).solo, true);

  const noHumans = {
    participantPresenceKnown: true,
    participants: new Map(),
    speakersHeard: new Set(['John']),
  };
  assert.deepEqual(helpers.meetingHumanPresence(noHumans), {
    source: 'participant_presence',
    known: true,
    humans: 0,
    solo: false,
    group: false,
  });

  const group = {
    participantPresenceKnown: true,
    participants: new Map([['1', {}], ['2', {}]]),
    speakersHeard: new Set(['John']),
  };
  assert.equal(helpers.meetingHumanPresence(group).solo, false);
  assert.equal(helpers.meetingHumanPresence(group).group, true);
});

test('response epochs bind provider ids and reject stale response events', () => {
  const sent = [];
  const socket = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  const session = {};
  const first = helpers.sendOwnedVoiceResponse(socket, session, {}, { kind: 'turn' });
  const metadata = sent[0].response.metadata;
  assert.equal(sent[0].event_id, first.responseCreateEventId);
  assert.equal(metadata.nora_voice_epoch, String(first.epoch));
  assert.equal(metadata.nora_voice_kind, 'turn');
  assert.equal(helpers.voiceResponseOwnerForEvent(session, {
    responseId: 'resp-current',
    metadata,
    requireEpochWhenUnbound: true,
  }), first);

  const second = helpers.createVoiceResponseOwner(session, 'turn');
  assert.equal(first.cancelled, true);
  assert.equal(helpers.voiceResponseOwnerForEvent(session, {
    responseId: 'resp-current',
    metadata,
    requireEpochWhenUnbound: true,
  }), null);
  helpers.cancelVoiceResponseOwnership(session, 'test_cleanup', second);
  assert.equal(helpers.releaseVoiceResponse(socket, session, 'cancelled', second), true);
});

test('realtime errors release only the response.create event that owns the current epoch', () => {
  const sent = [];
  const socket = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  const session = {};
  const owner = helpers.sendOwnedVoiceResponse(socket, session, {}, { kind: 'turn' });
  const currentEventId = sent[0].event_id;

  assert.equal(helpers.voiceResponseOwnerForError(session, {
    type: 'error',
    event_id: 'server-error-event-is-not-correlation',
    error: { message: 'generic transport warning' },
  }), null);
  assert.equal(helpers.voiceResponseOwnerForError(session, {
    type: 'error',
    error: { event_id: 'stale-response-create', message: 'late error' },
  }), null);
  assert.equal(helpers.voiceResponseOwnerForError(session, {
    type: 'error',
    error: { event_id: currentEventId, message: 'owned response failed' },
  }), owner);

  owner.responseDone = true;
  owner.awaitingToolContinuation = true;
  assert.equal(helpers.maybeContinueRealtimeVoiceResponse(socket, session, owner), true);
  assert.notEqual(sent[1].event_id, currentEventId);
  assert.equal(helpers.voiceResponseOwnerForError(session, {
    type: 'error',
    error: { event_id: currentEventId, message: 'late prior response error' },
  }), null);
  assert.equal(helpers.voiceResponseOwnerForError(session, {
    type: 'error',
    error: { event_id: sent[1].event_id, message: 'continuation failed' },
  }), owner);

  helpers.cancelVoiceResponseOwnership(session, 'test_cleanup', owner);
  helpers.releaseVoiceResponse(socket, session, 'cancelled', owner);
});

test('response terminal status is not reported as success unless the provider completed it', () => {
  assert.deepEqual(helpers.realtimeResponseDisposition({ status: 'completed' }), {
    status: 'completed',
    runtimeStatus: 'completed',
    watchdogOutcome: 'completed',
  });
  assert.equal(helpers.realtimeResponseDisposition({ status: 'cancelled' }).runtimeStatus, 'cancelled');
  assert.equal(helpers.realtimeResponseDisposition({ status: 'failed' }).runtimeStatus, 'failed');
  assert.equal(helpers.realtimeResponseDisposition({ status: 'incomplete' }).runtimeStatus, 'failed');
  assert.equal(helpers.realtimeResponseDisposition({}).runtimeStatus, 'failed');
});

test('runtime activity is finished by its response owner and superseded epochs are cancelled', () => {
  const session = {};
  const first = helpers.createVoiceResponseOwner(session, 'turn');
  const activity = helpers.runtimeActivityStream.begin({
    id: `meeting-owner-test-${crypto.randomBytes(4).toString('hex')}`,
    lane: 'conversation',
    kind: 'meeting_voice_response',
    label: 'Testing owned meeting response',
  });
  assert.equal(helpers.attachOwnedVoiceRuntimeActivity(session, first, activity.id), true);
  const second = helpers.createVoiceResponseOwner(session, 'turn');
  const record = helpers.runtimeActivityStream.snapshot().recent
    .find(item => item.id === activity.id);
  assert.equal(record.status, 'cancelled');
  assert.equal(first.activityFinished, true);
  helpers.cancelVoiceResponseOwnership(session, 'test_cleanup', second);
});

test('the voice gate stays owned through all tool outputs and only then creates one continuation', () => {
  const sent = [];
  const socket = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  const session = { voiceResponseActive: true };
  const owner = helpers.createVoiceResponseOwner(session, 'turn');
  owner.responseDone = true;
  const first = helpers.claimRealtimeVoiceToolOwnership(session, owner, 'call-1');
  const second = helpers.claimRealtimeVoiceToolOwnership(session, owner, 'call-2');

  assert.equal(helpers.releaseVoiceResponse(socket, session, 'completed', owner), false);
  helpers.completeRealtimeVoiceToolOwnership(first);
  assert.equal(helpers.maybeContinueRealtimeVoiceResponse(socket, session, owner), false);
  assert.equal(sent.length, 0);
  helpers.completeRealtimeVoiceToolOwnership(second);
  assert.equal(helpers.maybeContinueRealtimeVoiceResponse(socket, session, owner), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'response.create');
  assert.equal(sent[0].response.metadata.nora_voice_epoch, String(owner.epoch));

  helpers.cancelVoiceResponseOwnership(session, 'test_cleanup', owner);
  assert.equal(helpers.releaseVoiceResponse(socket, session, 'cancelled', owner), true);
});

test('cancelled async voice tools cannot emit output or restart a response', async () => {
  let resolveLookup;
  let lookupStarted = false;
  const lookup = new Promise(resolve => { resolveLookup = resolve; });
  const sent = [];
  const socket = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  const session = { voiceResponseActive: true };
  const owner = helpers.createVoiceResponseOwner(session, 'turn');

  const pending = helpers.handleRealtimeVoiceTool(
    socket,
    'call-stale',
    'lookup_status',
    '{}',
    new Set(),
    {
      lookup_status: async () => {
        lookupStarted = true;
        return lookup;
      },
    },
    {
      session,
      owner,
      origin: { kind: 'voice', bot_id: 'bot-1' },
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookupStarted, true);
  helpers.cancelVoiceResponseOwnership(session, 'human_barge_in', owner);
  helpers.releaseVoiceResponse(socket, session, 'cancelled', owner);
  resolveLookup({ ok: true, status: 'on_track' });

  const result = await pending;
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, 'stale_response_epoch');
  assert.deepEqual(sent, []);
});

test('silent volunteer probes prohibit tools and unexpected calls are explicitly discarded', () => {
  const session = {};
  const owner = helpers.createVoiceResponseOwner(session, 'volunteer_probe');
  assert.equal(helpers.claimRealtimeVoiceToolOwnership(session, owner, 'probe-call'), null);
  assert.match(serverSource, /tool_choice:\s*'none',[\s\S]{0,160}nora_probe:\s*'volunteer'/);
  assert.match(serverSource, /owner\?\.kind === 'volunteer_probe'[\s\S]{0,700}prohibited tool call; discarded/);
});
