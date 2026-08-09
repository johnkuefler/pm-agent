'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCommunicationTool,
  targetsOnlyJohn,
  toolCommunication,
  httpCommunication,
  meetingVoiceCommunication,
  createCommunicationMirror,
  wrapCommunicationTools,
} = require('../../src/communications/mirror');

test('communication classification covers written, task, calendar, and gift boundaries', () => {
  for (const name of [
    'gmail_send_email', 'slack_send_message', 'teamwork_add_comment',
    'teamwork_create_task', 'gcal_create_event', 'send_gift',
  ]) assert.equal(isCommunicationTool(name), true, name);
  for (const name of ['fleet_status', 'list_agent_runs', 'gmail_search', 'get_calendar']) {
    assert.equal(isCommunicationTool(name), false, name);
  }
});

test('a connector request addressed only to John does not create a redundant monitor copy', () => {
  assert.equal(targetsOnlyJohn({ to: 'johnkuefler@limelightmarketing.com' }), true);
  assert.equal(targetsOnlyJohn({ recipients: ['John Kuefler'] }), true);
  assert.equal(targetsOnlyJohn({ recipients: ['John Kuefler', 'Mallory Maryman'] }), false);
  assert.equal(toolCommunication({ toolName: 'gmail_send_email', args: {
    to: 'johnkuefler@limelightmarketing.com', subject: 'Hi', body: 'Already to John',
  }, result: {} }), null);
});

test('connector monitor copy preserves the request while redacting credentials', () => {
  const record = toolCommunication({ connectionName: 'Google Workspace MCP',
    toolName: 'gmail_send_email', args: {
      to: 'mallory@example.com', subject: 'Launch', body: 'Please confirm Monday.',
      access_token: 'do-not-copy', nested: { password: 'also-secret' },
    }, result: { content: [] } });
  assert.equal(record.surface, 'Google Workspace MCP');
  assert.equal(record.target, 'mallory@example.com');
  assert.match(record.exact, /Please confirm Monday/);
  assert.doesNotMatch(record.exact, /do-not-copy|also-secret/);
  assert.match(record.exact, /\[redacted\]/);
});

test('a read-only connector result never becomes a monitor copy even if its name is misleading', () => {
  assert.equal(toolCommunication({ connectionName: 'Reports', toolName: 'send_status',
    args: {}, result: {}, writeCapable: false }), null);
});

test('a confirmed Fleet change copies the requester, exact change, and provider result', () => {
  const record = toolCommunication({ connectionName: 'LimeLight Fleet MCP',
    toolName: 'set_agent_once_instructions', writeCapable: true,
    args: { slug: 'content-agent', onceInstructions: 'Complete task 52.' },
    result: { structuredContent: { ok: true, pending: true } },
    fleetAuthority: { requesterName: 'Mallory Maryman', requesterId: 'UMALLORY',
      interactionRef: 'slack:D1:1.2', requestText: 'Push task 52 through.' } });
  assert.equal(record.target, 'content-agent');
  assert.match(record.exact, /Mallory Maryman/);
  assert.match(record.exact, /Push task 52 through/);
  assert.match(record.exact, /Complete task 52/);
  assert.match(record.exact, /pending/);
});

test('confirmed Slack and meeting chat deliveries become monitor records', () => {
  const slack = httpCommunication({ status: 200, data: { ok: true }, config: {
    url: 'https://slack.com/api/chat.postMessage',
    data: JSON.stringify({ channel: 'C123', thread_ts: '1.2', text: 'Exact Slack message' }),
  } });
  assert.deepEqual(slack, { surface: 'Slack', action: 'chat.postMessage', target: 'C123',
    thread: '1.2', exact: 'Exact Slack message' });
  const meeting = httpCommunication({ status: 200, data: {}, config: {
    url: 'https://us-west-2.recall.ai/api/v1/bot/bot-1/send_chat_message/',
    data: JSON.stringify({ message: 'Meeting reply' }),
  } });
  assert.equal(meeting.exact, 'Meeting reply');
  assert.equal(httpCommunication({ status: 200, data: { ok: true }, config: {
    url: 'https://slack.com/api/chat.postMessage', data: '{}', noraCommunicationMirror: true,
  } }), null);
});

test('voice monitoring skips a known John-only room and records other participants', () => {
  assert.equal(meetingVoiceCommunication({ participants: new Map([
    ['1', { name: 'John Kuefler' }],
  ]) }, 'Already heard live'), null);
  const record = meetingVoiceCommunication({ participants: new Map([
    ['1', { name: 'John Kuefler' }], ['2', { name: 'Mallory Maryman' }],
  ]) }, 'Let us decide the owner.');
  assert.match(record.target, /Mallory Maryman/);
  assert.equal(record.exact, 'Let us decide the owner.');
});

test('the monitor sends a separate exact copy, skips John, and stays outside budgets', async () => {
  const sent = [];
  const mirror = createCommunicationMirror({
    resolveJohnSlackId: () => 'UJOHN',
    openDirectMessage: async () => 'DJOHN',
    sendMessage: async (channel, text) => { sent.push({ channel, text }); return true; },
    now: () => new Date('2026-08-09T13:00:00.000Z'),
  });
  await mirror.observe({ surface: 'Slack', action: 'chat.postMessage', target: 'COTHER',
    exact: 'The exact outbound note.' });
  await mirror.observe({ surface: 'Slack', action: 'chat.postMessage', target: 'DJOHN',
    exact: 'This was already sent to John.' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'DJOHN');
  assert.match(sent[0].text, /The exact outbound note/);
  assert.equal(mirror.snapshot().mirrored, 1);
  assert.equal(mirror.snapshot().skipped_john, 1);
  assert.equal(mirror.snapshot().pending, 0);
});

test('the monitor retries opening the owner DM before dropping a copy', async () => {
  let opens = 0;
  const sent = [];
  const mirror = createCommunicationMirror({
    resolveJohnSlackId: () => 'UJOHN',
    openDirectMessage: async () => {
      opens += 1;
      if (opens < 3) throw new Error('temporary Slack failure');
      return 'DJOHN';
    },
    sendMessage: async (channel, text) => { sent.push({ channel, text }); return true; },
    sleep: async () => {},
  });
  await mirror.observe({ surface: 'Slack', action: 'chat.postMessage', target: 'COTHER',
    exact: 'Retry me.' });
  assert.equal(opens, 3);
  assert.equal(sent.length, 1);
  assert.equal(mirror.snapshot().failed, 0);
});

test('local communication tools are mirrored only after successful execution', async () => {
  const events = [];
  const tools = [{ definition: { name: 'teamwork_add_comment' },
    execute: async () => ({ ok: true, comment_id: '7' }) }];
  wrapCommunicationTools(tools, new Set(['teamwork_add_comment']), {
    observeTool: async event => { events.push(event); },
  }, 'Teamwork');
  const result = await tools[0].execute({ task_id: '42', body: 'Please confirm.' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.comment_id, '7');
  assert.equal(events.length, 1);
  assert.equal(events[0].surface, 'Teamwork');
  assert.equal(events[0].args.body, 'Please confirm.');
});
