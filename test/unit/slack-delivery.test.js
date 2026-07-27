'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildSlackExtractionOrigin,
  deterministicSlackClientMsgId,
  deliverSlackNotification,
  fetchSlackThreadPages,
  networkAddressIsGlobal,
  parseNotificationFileUrl,
  postSlackSegments,
  resolvePinnedNotificationFileUrl,
} = require('../../src/integrations/slack-delivery');

function ok(data = {}) {
  return { status: 200, data: { ok: true, ...data } };
}

const resolvePublicTestHost = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

test('deterministic client message IDs are stable UUIDs and reach chat.postMessage', async () => {
  const clientMsgId = deterministicSlackClientMsgId('job-123:origin:C123');
  assert.match(clientMsgId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(deterministicSlackClientMsgId('job-123:origin:C123'), clientMsgId);
  let payload;
  await deliverSlackNotification({
    channel: 'C123',
    text: 'finished',
    client_msg_id: clientMsgId,
  }, {
    token: 'xoxb-test',
    post: async (_url, input) => {
      payload = input;
      return ok({ channel: 'C123', ts: '1.1' });
    },
  });
  assert.equal(payload.client_msg_id, clientMsgId);
});

test('segmented delivery assigns stable distinct client message IDs across whole-operation retries', async () => {
  const operationId = deterministicSlackClientMsgId('slack-event:E123:C123');
  const attempts = [];
  for (let retry = 0; retry < 2; retry += 1) {
    const ids = [];
    const result = await postSlackSegments({
      channel: 'C123',
      segments: ['first beat', 'second beat', 'third beat'],
      delivery: { mode: 'channel' },
      token: 'xoxb-test',
      clientMsgId: operationId,
      deadlineAt: Date.now() + 5000,
      pauseMs: () => 0,
      post: async (_url, payload) => {
        ids.push(payload.client_msg_id);
        return ok({ channel: 'C123', ts: `1.${ids.length}` });
      },
    });
    assert.equal(result.ok, true);
    attempts.push(ids);
  }

  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(new Set(attempts[0]).size, 3);
  assert.equal(attempts[0][0], operationId,
    'the first segment retains the caller-persisted ID for backward compatibility');
  for (const id of attempts[0]) {
    assert.match(id,
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
});

test('a stale durable owner is fenced before any Slack segment leaves the process', async () => {
  let posts = 0;
  await assert.rejects(postSlackSegments({
    channel: 'C123',
    segments: ['must not escape'],
    delivery: { mode: 'channel' },
    token: 'xoxb-test',
    deadlineAt: Date.now() + 5000,
    pauseMs: () => 0,
    beforePost: async () => {
      const error = new Error('claim token rotated');
      error.code = 'claim_token_rotated';
      throw error;
    },
    post: async () => {
      posts += 1;
      return ok();
    },
  }), error => error.code === 'slack_delivery_lease_lost'
    && error.attempted_segments === 0);
  assert.equal(posts, 0);
});

test('receipt callback failures cannot reclassify acknowledged Slack segments', async () => {
  let posts = 0;
  let callbackAttempts = 0;
  const result = await postSlackSegments({
    channel: 'C_CALLBACK',
    segments: ['first', 'second'],
    delivery: { mode: 'channel' },
    token: 'xoxb-test',
    clientMsgId: deterministicSlackClientMsgId('callback-operation'),
    deadlineAt: Date.now() + 5000,
    pauseMs: () => 0,
    post: async () => {
      posts += 1;
      return ok({ channel: 'C_CALLBACK', ts: `2.${posts}` });
    },
    onReceipt: async () => {
      callbackAttempts += 1;
      throw new Error('metrics sink unavailable');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(posts, 2);
  assert.equal(callbackAttempts, 2);
  assert.equal(result.segment_receipts.every(receipt => receipt.ok), true);
  assert.deepEqual(result.receipt_callback_errors, [
    { segment_index: 0, error: 'metrics sink unavailable' },
    { segment_index: 1, error: 'metrics sink unavailable' },
  ]);
});

test('Slack notification routing produces thread, broadcast, channel, and inline DM payloads', async () => {
  const threadTs = String((Date.now() - 3 * 60 * 60 * 1000) / 1000);
  const cases = [
    {
      name: 'routine thread',
      input: {
        channel: 'C_ROUTINE',
        text: 'routine update',
        thread_ts: threadTs,
        materiality: 'routine',
        channel_type: 'channel',
      },
      expected: { thread_ts: threadTs, reply_broadcast: undefined },
    },
    {
      name: 'stale material broadcast',
      input: {
        channel: 'C_MATERIAL',
        text: 'the deliverable is ready',
        thread_ts: threadTs,
        source_ts: threadTs,
        materiality: 'shared_deliverable',
        channel_type: 'channel',
      },
      expected: { thread_ts: threadTs, reply_broadcast: true },
    },
    {
      name: 'urgent correction broadcast',
      input: {
        channel: 'C_CORRECTION',
        text: 'correction: the deadline is today',
        thread_ts: String(Date.now() / 1000),
        materiality: 'correction',
        channel_type: 'channel',
      },
      expected: { reply_broadcast: true },
    },
    {
      name: 'explicit channel',
      input: {
        channel: 'C_CHANNEL',
        text: 'channel announcement',
        thread_ts: threadTs,
        delivery_mode: 'channel',
        channel_type: 'channel',
      },
      expected: { thread_ts: undefined, reply_broadcast: undefined },
    },
  ];

  for (const fixture of cases) {
    const payloads = [];
    const result = await deliverSlackNotification(fixture.input, {
      token: 'xoxb-test',
      get: async () => { throw new Error('not expected'); },
      post: async (url, payload) => {
        assert.match(url, /chat\.postMessage$/);
        payloads.push(payload);
        return ok({ ts: '1900000000.000001', channel: fixture.input.channel });
      },
    });
    assert.equal(result.ok, true, fixture.name);
    assert.equal(payloads.length, 1, fixture.name);
    if (Object.hasOwn(fixture.expected, 'thread_ts')) {
      assert.equal(payloads[0].thread_ts, fixture.expected.thread_ts, fixture.name);
    }
    assert.equal(payloads[0].reply_broadcast, fixture.expected.reply_broadcast, fixture.name);
  }

  const dmCalls = [];
  const dm = await deliverSlackNotification({
    user: 'UDIRECT1',
    text: 'inline response',
    thread_ts: threadTs,
    delivery_mode: 'dm',
    materiality: 'urgent_risk',
    channel_type: 'im',
  }, {
    token: 'xoxb-test',
    post: async (url, payload) => {
      dmCalls.push({ url, payload });
      if (url.endsWith('/conversations.open')) {
        return ok({ channel: { id: 'D_DIRECT' } });
      }
      return ok({ channel: 'D_DIRECT', ts: '1900000000.000002' });
    },
  });
  assert.equal(dm.ok, true);
  assert.equal(dm.delivery.mode, 'dm');
  assert.equal(dmCalls[1].payload.thread_ts, undefined);
  assert.equal(dmCalls[1].payload.reply_broadcast, undefined);
});

test('notification target selection cannot leak an explicit DM into a supplied public channel', async () => {
  const dmCalls = [];
  const dm = await deliverSlackNotification({
    channel: 'CPUBLIC',
    user: 'UPRIVATE',
    text: 'private update',
    delivery_mode: 'dm',
  }, {
    token: 'xoxb-test',
    post: async (url, payload) => {
      dmCalls.push({ url, payload });
      if (url.endsWith('/conversations.open')) {
        assert.deepEqual(payload, { users: 'UPRIVATE' });
        return ok({ channel: { id: 'DPRIVATE' } });
      }
      assert.equal(payload.channel, 'DPRIVATE');
      return ok({ channel: 'DPRIVATE', ts: '3.1' });
    },
  });
  assert.equal(dm.channel, 'DPRIVATE');
  assert.equal(dmCalls.length, 2);

  const channelCalls = [];
  const channelResult = await deliverSlackNotification({
    channel: 'CPUBLIC',
    user: 'UPRIVATE',
    text: 'shared update',
    delivery_mode: 'channel',
  }, {
    token: 'xoxb-test',
    post: async (url, payload) => {
      channelCalls.push({ url, payload });
      return ok({ channel: 'CPUBLIC', ts: '3.2' });
    },
  });
  assert.equal(channelResult.channel, 'CPUBLIC');
  assert.equal(channelCalls.length, 1);
  assert.equal(channelCalls[0].payload.channel, 'CPUBLIC');

  let ambiguousPosts = 0;
  await assert.rejects(deliverSlackNotification({
    channel: 'CPUBLIC',
    user: 'UPRIVATE',
    text: 'unclear target',
  }, {
    token: 'xoxb-test',
    post: async () => {
      ambiguousPosts += 1;
      return ok();
    },
  }), error => error.code === 'ambiguous_slack_notification_target');
  assert.equal(ambiguousPosts, 0);
});

test('explicit channel and thread delivery modes never fall back to a user target', async () => {
  for (const deliveryMode of ['channel', 'thread', 'thread_broadcast']) {
    let posts = 0;
    await assert.rejects(deliverSlackNotification({
      user: 'UPRIVATE',
      text: 'must stay in a channel',
      delivery_mode: deliveryMode,
    }, {
      token: 'xoxb-test',
      post: async () => {
        posts += 1;
        return ok();
      },
    }), error => {
      assert.equal(error.code, 'invalid_slack_notification_target');
      assert.match(error.message, new RegExp(`delivery_mode=${deliveryMode} requires`));
      return true;
    });
    assert.equal(posts, 0, `${deliveryMode} must fail before any Slack side effect`);
  }
});

test('notification file URL validation rejects non-public destinations and pins public DNS', async () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1',
    'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '3fff::1',
  ]) {
    assert.equal(networkAddressIsGlobal(address), false, address);
  }
  assert.equal(networkAddressIsGlobal('93.184.216.34'), true);
  assert.equal(networkAddressIsGlobal('2606:2800:220:1:248:1893:25c8:1946'), true);

  for (const value of [
    'http://artifacts.example/file',
    'https://user:secret@artifacts.example/file',
    'https://localhost/file',
    'https://artifacts.example:8443/file',
  ]) {
    assert.throws(() => parseNotificationFileUrl(value),
      error => error.code === 'slack_file_url_rejected');
  }

  await assert.rejects(resolvePinnedNotificationFileUrl(
    'https://metadata.example/latest',
    { resolveHost: async () => [{ address: '169.254.169.254', family: 4 }] },
  ), error => error.code === 'slack_file_url_rejected');
  await assert.rejects(resolvePinnedNotificationFileUrl(
    'https://mixed.example/file',
    { resolveHost: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] },
  ), error => error.code === 'slack_file_url_rejected');
  await assert.rejects(resolvePinnedNotificationFileUrl(
    'https://slow.example/file',
    {
      resolveHost: () => new Promise(() => {}),
      resolutionTimeoutMs: 10,
    },
  ), error => error.code === 'slack_file_url_rejected'
    && error.cause?.message.includes('timed out'));

  let literalDnsCalls = 0;
  const pinnedIpv6 = await resolvePinnedNotificationFileUrl(
    'https://[2606:4700:4700::1111]/report.txt',
    {
      resolveHost: async () => {
        literalDnsCalls += 1;
        throw new Error('IPv6 literals must not be looked up again');
      },
    },
  );
  assert.equal(literalDnsCalls, 0);
  assert.deepEqual(pinnedIpv6.addresses, [
    { address: '2606:4700:4700::1111', family: 6 },
  ]);

  const pinned = await resolvePinnedNotificationFileUrl(
    'https://artifacts.example/report.txt#ignored',
    { resolveHost: resolvePublicTestHost },
  );
  assert.equal(pinned.url, 'https://artifacts.example/report.txt');
  assert.deepEqual(pinned.addresses, await resolvePublicTestHost());
  const selected = await new Promise((resolve, reject) => {
    pinned.httpsAgent.options.lookup('artifacts.example', { family: 4 },
      (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(selected, { address: '93.184.216.34', family: 4 });
  await assert.rejects(new Promise((resolve, reject) => {
    pinned.httpsAgent.options.lookup('redirect.example', {},
      error => error ? reject(error) : resolve());
  }), /hostname mismatch/);
});

test('notification file transport rejects redirects and enforces the byte cap', async t => {
  await t.test('redirect', async () => {
    await assert.rejects(deliverSlackNotification({
      channel: 'C_FILES',
      text: 'attaching',
      file_url: 'https://artifacts.example/redirect',
      file_name: 'report.bin',
    }, {
      token: 'xoxb-test',
      resolveHost: resolvePublicTestHost,
      get: async (_url, options) => {
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['Proxy-Authorization'], undefined);
        assert.equal(options.headers.Cookie, undefined);
        return { status: 302, headers: { location: 'https://elsewhere.example/report.bin' } };
      },
      post: async () => ok({ channel: 'C_FILES', ts: '4.1' }),
    }), error => error.code === 'slack_file_redirect_rejected');
  });

  await t.test('oversize body', async () => {
    await assert.rejects(deliverSlackNotification({
      channel: 'C_FILES',
      text: 'attaching',
      file_url: 'https://artifacts.example/large',
      file_name: 'large.bin',
    }, {
      token: 'xoxb-test',
      fileMaxBytes: 3,
      resolveHost: resolvePublicTestHost,
      get: async (_url, options) => {
        assert.equal(options.maxContentLength, 3);
        assert.ok(options.timeout <= 30000);
        return { status: 200, data: Buffer.from([1, 2, 3, 4]) };
      },
      post: async () => ok({ channel: 'C_FILES', ts: '4.2' }),
    }), error => error.code === 'slack_file_too_large');
  });
});

test('Slack ok:false and HTTP failures cannot become successful notification delivery', async () => {
  let joined = 0;
  await assert.rejects(deliverSlackNotification({
    channel: 'C_FAILURE',
    text: 'not delivered',
    thread_ts: '1900000000.100000',
    channel_type: 'channel',
  }, {
    token: 'xoxb-test',
    post: async () => ({ status: 200, data: { ok: false, error: 'not_in_channel' } }),
    onThreadJoined: () => { joined += 1; },
  }), error => {
    assert.equal(error.code, 'slack_segment_delivery_failed');
    assert.equal(error.partial_delivery, false);
    assert.equal(error.delivery_receipts[0].http_ok, true);
    assert.equal(error.delivery_receipts[0].slack_ok, false);
    assert.equal(error.delivery_receipts[0].error, 'not_in_channel');
    return true;
  });
  assert.equal(joined, 0, 'failed delivery must not join the thread');

  await assert.rejects(deliverSlackNotification({
    channel: 'C_HTTP_FAILURE',
    text: 'also not delivered',
  }, {
    token: 'xoxb-test',
    post: async () => ({ status: 503, data: { ok: true, ts: 'false-success' } }),
  }), error => {
    assert.equal(error.delivery_receipts[0].http_ok, false);
    assert.equal(error.delivery_receipts[0].slack_ok, true);
    return true;
  });
});

test('Slack attachments use the external upload ticket, binary transfer, and completion flow', async () => {
  const calls = [];
  const bytes = Buffer.from('file bytes', 'utf8');
  const result = await deliverSlackNotification({
    channel: 'C_FILES',
    text: 'attaching the report',
    thread_ts: '1900000000.400000',
    delivery_mode: 'thread',
    file_url: 'https://artifacts.example/report.txt',
    file_name: 'report.txt',
  }, {
    token: 'xoxb-test',
    resolveHost: resolvePublicTestHost,
    get: async (url, options) => {
      assert.equal(url, 'https://artifacts.example/report.txt');
      assert.equal(options.responseType, 'arraybuffer');
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.proxy, false);
      assert.equal(typeof options.httpsAgent?.options?.lookup, 'function');
      assert.equal(options.headers.Authorization, undefined);
      return { status: 200, data: bytes };
    },
    post: async (url, payload, options) => {
      calls.push({ url, payload, options });
      if (url.endsWith('/chat.postMessage')) {
        return ok({ channel: 'C_FILES', ts: '1900000000.400001' });
      }
      if (url.endsWith('/files.getUploadURLExternal')) {
        assert.deepEqual(payload, { filename: 'report.txt', length: bytes.byteLength });
        return ok({
          upload_url: 'https://files.slack.com/upload/v1/ticket-123',
          file_id: 'F_REPORT',
        });
      }
      if (url === 'https://files.slack.com/upload/v1/ticket-123') {
        assert.equal(Buffer.isBuffer(payload), true);
        assert.equal(payload.equals(bytes), true);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['Content-Type'], 'application/octet-stream');
        assert.equal(options.headers['Content-Length'], bytes.byteLength);
        return { status: 200, data: `OK - ${bytes.byteLength}` };
      }
      if (url.endsWith('/files.completeUploadExternal')) {
        assert.deepEqual(payload, {
          files: [{ id: 'F_REPORT', title: 'report.txt' }],
          channel_id: 'C_FILES',
          thread_ts: '1900000000.400000',
        });
        return ok({ files: [{ id: 'F_REPORT', title: 'report.txt' }] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/chat.postMessage',
    '/api/files.getUploadURLExternal',
    '/upload/v1/ticket-123',
    '/api/files.completeUploadExternal',
  ]);
  assert.doesNotMatch(calls.map(call => call.url).join('\n'), /files\.upload(?:$|\?)/);
  assert.deepEqual(result.delivery_receipts.map(receipt => receipt.method), [
    'chat.postMessage',
    'files.getUploadURLExternal',
    'files.externalUpload',
    'files.completeUploadExternal',
  ]);
  assert.equal(result.delivery_receipts.every(receipt => receipt.ok), true);
});

test('external Slack attachment flow fails closed on ticket, transfer, and completion errors', async t => {
  const fixtures = [
    {
      name: 'ticket ok false',
      failAt: 'ticket',
      expectedCode: 'slack_api_failed',
      expectedMethod: 'files.getUploadURLExternal',
      expectedError: 'invalid_auth',
    },
    {
      name: 'binary transport failure',
      failAt: 'transfer',
      expectedCode: 'slack_file_upload_failed',
      expectedMethod: 'files.externalUpload',
      expectedError: 'http_503',
    },
    {
      name: 'binary transport rejection',
      failAt: 'transfer_throw',
      expectedCode: 'slack_file_upload_failed',
      expectedMethod: 'files.externalUpload',
      expectedError: 'socket reset',
    },
    {
      name: 'completion ok false',
      failAt: 'complete',
      expectedCode: 'slack_api_failed',
      expectedMethod: 'files.completeUploadExternal',
      expectedError: 'not_in_channel',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const calls = [];
      await assert.rejects(deliverSlackNotification({
        channel: 'C_FILES',
        text: 'attaching',
        file_url: 'https://artifacts.example/report.bin',
        file_name: 'report.bin',
      }, {
        token: 'xoxb-test',
        resolveHost: resolvePublicTestHost,
        get: async () => ({ status: 200, data: Buffer.from([1, 2, 3]) }),
        post: async url => {
          calls.push(url);
          if (url.endsWith('/chat.postMessage')) {
            return ok({ channel: 'C_FILES', ts: '1900000000.500001' });
          }
          if (url.endsWith('/files.getUploadURLExternal')) {
            return fixture.failAt === 'ticket'
              ? { status: 200, data: { ok: false, error: 'invalid_auth' } }
              : ok({
                upload_url: 'https://files.slack.com/upload/v1/ticket-failure',
                file_id: 'F_FAILURE',
              });
          }
          if (url === 'https://files.slack.com/upload/v1/ticket-failure') {
            if (fixture.failAt === 'transfer_throw') throw new Error('socket reset');
            return fixture.failAt === 'transfer'
              ? { status: 503, data: 'unavailable' }
              : { status: 200, data: 'OK - 3' };
          }
          if (url.endsWith('/files.completeUploadExternal')) {
            return fixture.failAt === 'complete'
              ? { status: 200, data: { ok: false, error: 'not_in_channel' } }
              : ok({ files: [{ id: 'F_FAILURE' }] });
          }
          throw new Error(`unexpected URL ${url}`);
        },
      }), error => {
        assert.equal(error.code, fixture.expectedCode);
        const failedReceipt = error.delivery_receipts.at(-1);
        assert.equal(failedReceipt.method, fixture.expectedMethod);
        assert.equal(failedReceipt.ok, false);
        assert.equal(failedReceipt.error, fixture.expectedError);
        assert.equal(error.partial_delivery, true,
          'the preceding text post remains truthfully represented as delivered');
        return true;
      });
      assert.equal(calls.some(url => /files\.upload(?:$|\?)/.test(url)), false);
    });
  }
});

test('segmented Slack delivery surfaces partial failure with per-segment receipts', async () => {
  let calls = 0;
  await assert.rejects(postSlackSegments({
    channel: 'C_SEGMENTS',
    segments: ['first', 'second', 'third'],
    delivery: {
      mode: 'thread_broadcast',
      thread_ts: '1900000000.200000',
      reply_broadcast: true,
    },
    token: 'xoxb-test',
    deadlineAt: Date.now() + 5000,
    pauseMs: () => 0,
    post: async (_url, payload) => {
      calls += 1;
      assert.equal(payload.thread_ts, '1900000000.200000');
      assert.equal(payload.reply_broadcast, true);
      return calls === 1
        ? ok({ ts: '1900000000.200001', channel: 'C_SEGMENTS' })
        : { status: 200, data: { ok: false, error: 'rate_limited' } };
    },
  }), error => {
    assert.equal(error.code, 'slack_segment_delivery_failed');
    assert.equal(error.partial_delivery, true);
    assert.equal(error.delivered_segments, 1);
    assert.equal(error.attempted_segments, 2);
    assert.deepEqual(error.segment_receipts.map(receipt => receipt.ok), [true, false]);
    assert.equal(error.segment_receipts[1].error, 'rate_limited');
    return true;
  });
  assert.equal(calls, 2, 'delivery stops after the first failed segment');
});

test('conversations.replies pagination reads beyond the first 50 messages within one bound', async () => {
  const first = Array.from({ length: 50 }, (_, index) => ({
    ts: `1900000000.${String(index).padStart(6, '0')}`,
    text: `message ${index}`,
  }));
  const second = Array.from({ length: 5 }, (_, index) => ({
    ts: `1900000001.${String(index).padStart(6, '0')}`,
    text: `message ${index + 50}`,
  }));
  const urls = [];
  const result = await fetchSlackThreadPages({
    channel: 'C_PAGINATED',
    threadTs: '1900000000.000000',
    token: 'xoxb-test',
    deadlineMs: 2000,
    get: async url => {
      urls.push(url);
      return urls.length === 1
        ? ok({ messages: first, response_metadata: { next_cursor: 'next page token' } })
        : ok({ messages: second, response_metadata: { next_cursor: '' } });
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.messages.length, 55);
  assert.match(urls[1], /cursor=next\+page\+token/);
  assert.equal(result.receipts.every(receipt => receipt.ok), true);
});

test('conversations.replies pagination owns a terminal deadline even if transport stalls', async () => {
  const startedAt = Date.now();
  await assert.rejects(fetchSlackThreadPages({
    channel: 'C_STALLED',
    threadTs: '1900000000.100000',
    token: 'xoxb-test',
    deadlineMs: 30,
    get: async () => new Promise(() => {}),
  }), error => error.code === 'slack_thread_fetch_deadline_exceeded');
  assert.ok(Date.now() - startedAt < 250);
});

test('queued Slack extraction origin carries a bot identity and stable debounce key', () => {
  const first = buildSlackExtractionOrigin({
    channel: 'C_ORIGIN',
    user: 'U_PERSON',
    threadTs: '1900000000.300000',
    triggerTs: '1900000000.300001',
    botId: 'U_NORA',
  });
  const replay = buildSlackExtractionOrigin({
    channel: 'C_ORIGIN',
    user: 'U_PERSON',
    threadTs: '1900000000.300000',
    triggerTs: '1900000000.300001',
    botId: 'U_NORA',
  });
  assert.equal(first.bot_id, 'U_NORA');
  assert.equal(first.source_bot_id, '');
  assert.equal(first.debounce_key, 'slack:C_ORIGIN:1900000000.300000');
  assert.equal(first.dedupe_key, first.debounce_key);
  assert.deepEqual(replay, first);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const notifyRoute = serverSource.slice(
    serverSource.indexOf("app.post('/notify'"),
    serverSource.indexOf('registerMemoryRoutes', serverSource.indexOf("app.post('/notify'")),
  );
  assert.match(notifyRoute, /resolveSlackDelivery\(\{/);
  assert.match(notifyRoute, /delivery_mode: deliveryMode/);
  assert.match(notifyRoute, /materiality/);
  assert.match(notifyRoute, /source_ts: sourceTs/);
  assert.match(notifyRoute, /channel_type: requestedChannelType/);
  assert.match(notifyRoute, /ok:\s*false/);

  const liveHandler = serverSource.slice(
    serverSource.indexOf('async function handleSlackImpl'),
    serverSource.indexOf('\nasync function ', serverSource.indexOf('async function handleSlackImpl') + 20),
  );
  assert.match(liveHandler, /proactive:\s*mode === 'proactive'/);
  assert.match(liveHandler, /postSlackSegments\(\{[\s\S]*delivery:\s*slackDelivery/);
  assert.match(liveHandler, /buildSlackExtractionOrigin\(\{/);
  assert.match(
    serverSource,
    /finalizeStagedSlackReply[\s\S]*enqueueSlackExtractionJob\(\{/,
  );
  assert.match(serverSource,
    /processSlackExtractionJob[\s\S]*extractTasks\([\s\S]*strict:\s*true/);
  assert.match(serverSource, /source\.debounce_key \|\| source\.dedupe_key/);
  assert.doesNotMatch(liveHandler, /source\.bot_id \|\| 'unknown'/);
});
