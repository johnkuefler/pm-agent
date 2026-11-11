'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-banter-'));
Object.assign(process.env, { NORA_DATA_DIR: dataDir, NORA_TEST_MODE: '1', DATABASE_URL: '',
  NORA_API_KEY: 'test-key', SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'test-bot-token',
  NORA_PM_TEAM_BANTER_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-model-key' });
const runtime = require('../../server');
let base;
test.before(async () => {
  const server = await runtime.start({ port: 0, background: false });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('signed untagged Slack events reach the bot-only social path once without any work tools', async t => {
  const sent = [], models = [], unexpected = [];
  t.mock.method(axios, 'get', async url => {
    if (url.startsWith('https://slack.com/api/conversations.history?')) return { data: { ok: true, messages: [] } };
    unexpected.push(url);
    throw new Error('Unexpected outbound GET');
  });
  t.mock.method(axios, 'post', async (url, payload, config) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      models.push(payload);
      return { data: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        reply: 'My fantasy roster is mostly backup connectors.', participation: 'unprompted',
      }) }] } };
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      assert.equal(config.headers.Authorization, 'Bearer test-bot-token');
      sent.push(payload);
      return { data: { ok: true, channel: payload.channel, ts: '123.456' } };
    }
    unexpected.push(url);
    throw new Error('Unexpected outbound POST');
  });
  const body = { type: 'event_callback', event_id: 'EvBanterTest', team_id: 'TTEST',
    authorizations: [{ user_id: 'UNORA', is_bot: true }], event: {
      type: 'message', channel: 'C031HHSBM1Q', channel_type: 'channel', user: 'UTEAM',
      ts: String(Date.now() / 1000), text: 'My fantasy football team is held together with duct tape.',
    } };
  async function deliver(input, valid = true) {
    const raw = JSON.stringify(input);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${crypto.createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${raw}`).digest('hex')}`;
    const response = await fetch(`${base}/webhook/slack`, { method: 'POST', body: raw, headers: {
      'Content-Type': 'application/json', 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': valid ? signature : 'invalid',
    } });
    await runtime.__test.drainSlackWebhookEvents();
    return response.status;
  }
  assert.equal(await deliver(body, false), 401);
  assert.equal(await deliver({ ...body, event: { ...body.event, channel: 'COTHER' } }), 200);
  assert.equal(sent.length, 0);
  assert.equal(await deliver(body), 200);
  assert.equal(await deliver(body), 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'C031HHSBM1Q');
  assert.equal(sent[0].thread_ts, undefined);
  assert.equal(models.length, 1);
  assert.equal(models[0].tools, undefined);
  assert.deepEqual(unexpected, []);
  const markers = JSON.parse(fs.readFileSync(path.join(dataDir, 'nora-markers.json'), 'utf8'));
  assert.equal(markers['slack-banter:C031HHSBM1Q'].last_reply_ts, '123.456');
  assert.equal(markers['slack-banter:C031HHSBM1Q'].unprompted_count, 1);
});
