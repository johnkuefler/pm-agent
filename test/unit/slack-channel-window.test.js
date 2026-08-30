'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSlackChannelWindow } = require('../../src/surfaces/slack/web-api');

test('bounded Slack channel reader paginates, sorts, and cleans the fixed channel window', async () => {
  const calls = [];
  const pages = [{ data: { ok: true, messages: [{
    ts: '2.000', user: 'U2', text: 'Second <@U1>',
  }], response_metadata: { next_cursor: 'next' } } }, { data: { ok: true, messages: [{
    ts: '1.000', user: 'U1', text: '', blocks: [{ type: 'section',
      text: { type: 'mrkdwn', text: 'Acme moved to Closed Won' } }],
  }], response_metadata: { next_cursor: '' } } }];
  const result = await readSlackChannelWindow('C07NMUBDP1R', {
    since: '1970-01-01T00:00:00Z', limit: 20,
    get: async url => { calls.push(url); return pages.shift(); },
    resolveUserName: async id => ({ U1: 'Mallory', U2: 'Brandee' })[id],
    resolveName: async () => 'int-sales',
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /channel=C07NMUBDP1R/);
  assert.match(calls[0], /oldest=0\.000000/);
  assert.match(calls[1], /cursor=next/);
  assert.equal(result.channel_name, 'int-sales');
  assert.deepEqual(result.messages.map(message => message.ts), ['1.000', '2.000']);
  assert.equal(result.messages[0].text, 'Acme moved to Closed Won');
  assert.equal(result.messages[1].text, 'Second @Mallory');
  assert.equal(result.messages[1].user_name, 'Brandee');
});

test('bounded Slack channel reader rejects an invalid date before provider access', async () => {
  let calls = 0;
  await assert.rejects(readSlackChannelWindow('C07NMUBDP1R', {
    since: 'not-a-date', get: async () => { calls += 1; },
  }), error => error.statusCode === 400 && /since must be/.test(error.message));
  assert.equal(calls, 0);
});

test('bounded Slack channel reader requires a starting boundary', async () => {
  await assert.rejects(
    readSlackChannelWindow('C07NMUBDP1R'),
    error => error.statusCode === 400 && /since is required/.test(error.message),
  );
});
