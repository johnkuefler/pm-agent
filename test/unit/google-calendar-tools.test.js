'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WRITE_TOOL_NAMES, createGoogleCalendarTools } = require('../../src/integrations/google-calendar-tools');

function byName(tools, name) {
  return tools.find(tool => tool.definition.name === name);
}

function calendarTools(responder, calls = []) {
  return {
    calls,
    tools: createGoogleCalendarTools({
      getAccessToken: async () => 'access-token',
      interactionRef: 'slack:D1:100.2',
      http: { request: async request => {
        calls.push(request);
        return { data: await responder(request, calls.length) };
      } },
    }),
  };
}

test('Google Calendar exposes reads plus create and update, with no delete capability', () => {
  const { tools } = calendarTools(async () => ({}));
  assert.deepEqual(tools.map(tool => tool.definition.name), [
    'calendar_list_events',
    'calendar_get_free_busy',
    'calendar_create_event',
    'calendar_update_event',
  ]);
  assert.deepEqual([...WRITE_TOOL_NAMES], ['calendar_create_event', 'calendar_update_event']);
  assert.equal(tools.some(tool => /delete|cancel/.test(tool.definition.name)), false);
});

test('free-busy lookup checks Nora and requested attendee calendars', async () => {
  const { tools, calls } = calendarTools(async request => {
    assert.equal(request.method, 'post');
    return { calendars: {
      primary: { busy: [] },
      'person@example.com': { busy: [{ start: '2026-09-01T15:00:00Z', end: '2026-09-01T15:30:00Z' }] },
    } };
  });
  const result = await byName(tools, 'calendar_get_free_busy').execute({
    time_min: '2026-09-01T09:00:00-05:00',
    time_max: '2026-09-01T17:00:00-05:00',
    attendee_emails: ['Person@Example.com'],
  });

  assert.deepEqual(calls[0].data.items, [{ id: 'primary' }, { id: 'person@example.com' }]);
  assert.equal(result.calendars['person@example.com'].busy.length, 1);
});

test('event creation invites attendees, requests notifications, and verifies readback', async () => {
  let createdId;
  const { tools, calls } = calendarTools(async request => {
    if (request.method === 'post') {
      createdId = request.data.id;
      return { id: createdId };
    }
    return {
      id: createdId, status: 'confirmed', summary: 'Planning review',
      start: { dateTime: '2026-09-02T15:00:00Z' }, end: { dateTime: '2026-09-02T15:30:00Z' },
      attendees: [{ email: 'person@example.com', responseStatus: 'needsAction' }],
      htmlLink: 'https://calendar.google.com/event?id=verified',
    };
  });
  const input = {
    summary: 'Planning review', start: '2026-09-02T10:00:00-05:00',
    end: '2026-09-02T10:30:00-05:00', attendee_emails: ['person@example.com'],
    add_google_meet: true,
  };
  const result = await byName(tools, 'calendar_create_event').execute(input);

  assert.equal(result.verified, true);
  assert.match(createdId, /^nora[0-9a-f]{40}$/);
  assert.equal(calls[0].params.sendUpdates, 'all');
  assert.equal(calls[0].params.conferenceDataVersion, 1);
  assert.deepEqual(calls[0].data.attendees, [{ email: 'person@example.com' }]);
  assert.equal(calls[1].method, 'get');
});

test('event update patches the exact event and verifies it without exposing cancellation', async () => {
  const { tools, calls } = calendarTools(async request => request.method === 'patch'
    ? { id: 'event-9' }
    : { id: 'event-9', status: 'confirmed', summary: 'New title' });
  const result = await byName(tools, 'calendar_update_event').execute({
    event_id: 'event-9', summary: 'New title',
  });

  assert.equal(result.verified, true);
  assert.equal(calls[0].method, 'patch');
  assert.match(calls[0].url, /events\/event-9$/);
  assert.deepEqual(calls[0].data, { summary: 'New title' });
  assert.equal(calls[1].method, 'get');
});
