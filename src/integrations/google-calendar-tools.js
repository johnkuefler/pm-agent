'use strict';

const crypto = require('crypto');

const WRITE_TOOL_NAMES = Object.freeze([
  'calendar_create_event',
  'calendar_update_event',
]);
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

function dateTime(value, label) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an RFC3339 date-time`);
  return parsed.toISOString();
}

function emails(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error('attendee_emails must contain at most 50 addresses');
  const list = [...new Set(value.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
  if (list.some(item => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))) {
    throw new Error('attendee_emails contains an invalid email address');
  }
  return list;
}

function compactEvent(event = {}) {
  return {
    id: event.id || null,
    summary: event.summary || '',
    description: event.description || '',
    location: event.location || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    status: event.status || null,
    attendees: (event.attendees || []).map(item => ({ email: item.email,
      response_status: item.responseStatus || null })),
    meeting_url: event.hangoutLink || (event.conferenceData?.entryPoints || [])
      .find(item => item.entryPointType === 'video')?.uri || null,
    html_link: event.htmlLink || null,
    updated: event.updated || null,
  };
}

function sameDateTime(actual, expected) {
  const actualTime = new Date(actual || '').getTime();
  const expectedTime = new Date(expected || '').getTime();
  return Number.isFinite(actualTime) && actualTime === expectedTime;
}

function hasRequestedAttendees(actual = [], requested = []) {
  const present = new Set(actual.map(item => String(item.email || '').toLowerCase()));
  return requested.every(email => present.has(email));
}

function createdEventMatches(actual, expected, attendeeEmails) {
  return actual?.status === 'confirmed'
    && actual?.id === expected.id
    && actual?.summary === expected.summary
    && sameDateTime(actual?.start?.dateTime, expected.start.dateTime)
    && sameDateTime(actual?.end?.dateTime, expected.end.dateTime)
    && hasRequestedAttendees(actual?.attendees, attendeeEmails);
}

function updatedEventMatches(actual, eventId, patch) {
  if (!actual || actual.id !== eventId || actual.status === 'cancelled') return false;
  if (patch.summary !== undefined && actual.summary !== patch.summary) return false;
  if (patch.description !== undefined && (actual.description || '') !== patch.description) return false;
  if (patch.location !== undefined && (actual.location || '') !== patch.location) return false;
  if (patch.start && !sameDateTime(actual.start?.dateTime, patch.start.dateTime)) return false;
  if (patch.end && !sameDateTime(actual.end?.dateTime, patch.end.dateTime)) return false;
  if (patch.attendees) {
    const actualEmails = (actual.attendees || []).map(item => String(item.email || '').toLowerCase()).sort();
    const expectedEmails = patch.attendees.map(item => item.email).sort();
    if (actualEmails.length !== expectedEmails.length
      || actualEmails.some((email, index) => email !== expectedEmails[index])) return false;
  }
  return true;
}

function deterministicEventId(interactionRef, input) {
  const source = `${String(interactionRef || 'slack')}:${String(input.summary || '')}:${String(input.start || '')}:${emails(input.attendee_emails).join(',')}`;
  return `nora${crypto.createHash('sha256').update(source).digest('hex').slice(0, 40)}`;
}

function createGoogleCalendarTools({ getAccessToken, http, interactionRef = '', calendarId = 'primary' }) {
  if (typeof getAccessToken !== 'function' || !http || typeof http.request !== 'function') {
    throw new Error('Google Calendar tools require getAccessToken and an HTTP client');
  }
  const calendar = encodeURIComponent(calendarId);
  async function request(method, url, { params, data, timeoutMs = 12000 } = {}) {
    const token = await getAccessToken();
    const response = await http.request({ method, url, params, data,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs });
    return response.data;
  }
  async function readEvent(eventId) {
    return request('get', `${GOOGLE_CALENDAR_API}/calendars/${calendar}/events/${encodeURIComponent(eventId)}`);
  }

  return [
    {
      definition: {
        name: 'calendar_list_events',
        description: 'Read events from Nora\'s connected Google Calendar. Use this to inspect her schedule before proposing or changing a meeting.',
        input_schema: { type: 'object', properties: {
          time_min: { type: 'string', description: 'RFC3339 lower bound. Defaults to now.' },
          time_max: { type: 'string', description: 'RFC3339 upper bound. Defaults to 14 days after time_min.' },
          search: { type: 'string', description: 'Optional text search.' },
          max_results: { type: 'integer', minimum: 1, maximum: 50 },
        } },
      },
      execute: async ({ time_min, time_max, search, max_results } = {}) => {
        const start = time_min ? dateTime(time_min, 'time_min') : new Date().toISOString();
        const end = time_max ? dateTime(time_max, 'time_max')
          : new Date(new Date(start).getTime() + 14 * 86400000).toISOString();
        if (new Date(end) <= new Date(start)) throw new Error('time_max must be after time_min');
        const data = await request('get', `${GOOGLE_CALENDAR_API}/calendars/${calendar}/events`, {
          params: { timeMin: start, timeMax: end, singleEvents: true, orderBy: 'startTime',
            maxResults: Math.max(1, Math.min(50, Number(max_results) || 25)), ...(search ? { q: String(search) } : {}) },
        });
        return { calendar_id: calendarId, time_min: start, time_max: end,
          events: (data?.items || []).map(compactEvent) };
      },
    },
    {
      definition: {
        name: 'calendar_get_free_busy',
        description: 'Read busy windows for Nora and supplied attendee calendar emails before scheduling a meeting. This returns authoritative busy intervals, not guessed availability.',
        input_schema: { type: 'object', properties: {
          time_min: { type: 'string' },
          time_max: { type: 'string' },
          attendee_emails: { type: 'array', items: { type: 'string' } },
          time_zone: { type: 'string', description: 'IANA time zone. Defaults to America/Chicago.' },
        }, required: ['time_min', 'time_max'] },
      },
      execute: async ({ time_min, time_max, attendee_emails, time_zone }) => {
        const start = dateTime(time_min, 'time_min');
        const end = dateTime(time_max, 'time_max');
        if (new Date(end) <= new Date(start)) throw new Error('time_max must be after time_min');
        const ids = ['primary', ...emails(attendee_emails)].slice(0, 50);
        const data = await request('post', `${GOOGLE_CALENDAR_API}/freeBusy`, {
          data: { timeMin: start, timeMax: end, timeZone: String(time_zone || 'America/Chicago'),
            items: ids.map(id => ({ id })) },
        });
        const calendars = Object.fromEntries(Object.entries(data?.calendars || {}).map(([id, value]) => [id, {
          busy: value.busy || [], errors: value.errors || [],
        }]));
        return { time_min: start, time_max: end, calendars };
      },
    },
    {
      definition: {
        name: 'calendar_create_event',
        description: 'Create and invite attendees to a Google Calendar event only when the requester explicitly asks to schedule or book it. Read the relevant calendars first. Use add_google_meet when they want a Meet link.',
        input_schema: { type: 'object', properties: {
          summary: { type: 'string' },
          start: { type: 'string', description: 'RFC3339 start date-time with time zone offset.' },
          end: { type: 'string', description: 'RFC3339 end date-time with time zone offset.' },
          attendee_emails: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          location: { type: 'string' },
          time_zone: { type: 'string' },
          add_google_meet: { type: 'boolean' },
        }, required: ['summary', 'start', 'end'] },
      },
      execute: async input => {
        const start = dateTime(input.start, 'start');
        const end = dateTime(input.end, 'end');
        if (new Date(end) <= new Date(start)) throw new Error('end must be after start');
        const attendeeEmails = emails(input.attendee_emails);
        const id = deterministicEventId(interactionRef, input);
        const event = {
          id,
          summary: String(input.summary || '').trim(),
          start: { dateTime: start, timeZone: String(input.time_zone || 'America/Chicago') },
          end: { dateTime: end, timeZone: String(input.time_zone || 'America/Chicago') },
          attendees: attendeeEmails.map(email => ({ email })),
          ...(input.description ? { description: String(input.description) } : {}),
          ...(input.location ? { location: String(input.location) } : {}),
          ...(input.add_google_meet ? { conferenceData: { createRequest: {
            requestId: crypto.createHash('sha256').update(id).digest('hex').slice(0, 24),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          } } } : {}),
        };
        if (!event.summary) throw new Error('summary is required');
        let created;
        try {
          created = await request('post', `${GOOGLE_CALENDAR_API}/calendars/${calendar}/events`, {
            params: { sendUpdates: 'all', conferenceDataVersion: input.add_google_meet ? 1 : 0 }, data: event,
          });
        } catch (error) {
          if (error?.response?.status !== 409) throw error;
          created = await readEvent(id);
        }
        const readback = await readEvent(created?.id || id);
        const verified = createdEventMatches(readback, event, attendeeEmails);
        return { ok: verified, verified, event: compactEvent(readback),
          ...(!verified ? { error: 'Calendar creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'calendar_update_event',
        description: 'Update an existing Google Calendar event only when the requester explicitly asks for that exact change. Read the event first to resolve its id and current state. This tool does not delete or cancel events.',
        input_schema: { type: 'object', properties: {
          event_id: { type: 'string' },
          summary: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          attendee_emails: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          location: { type: 'string' },
          time_zone: { type: 'string' },
        }, required: ['event_id'] },
      },
      execute: async input => {
        const eventId = String(input.event_id || '').trim();
        if (!eventId) throw new Error('event_id is required');
        const patch = {};
        if (input.summary !== undefined) patch.summary = String(input.summary).trim();
        if (input.description !== undefined) patch.description = String(input.description);
        if (input.location !== undefined) patch.location = String(input.location);
        if (input.attendee_emails !== undefined) patch.attendees = emails(input.attendee_emails).map(email => ({ email }));
        if (input.start !== undefined) patch.start = { dateTime: dateTime(input.start, 'start'),
          timeZone: String(input.time_zone || 'America/Chicago') };
        if (input.end !== undefined) patch.end = { dateTime: dateTime(input.end, 'end'),
          timeZone: String(input.time_zone || 'America/Chicago') };
        if (!Object.keys(patch).length) throw new Error('at least one event field must be updated');
        await request('patch', `${GOOGLE_CALENDAR_API}/calendars/${calendar}/events/${encodeURIComponent(eventId)}`, {
          params: { sendUpdates: 'all', conferenceDataVersion: 1 }, data: patch,
        });
        const readback = await readEvent(eventId);
        const verified = updatedEventMatches(readback, eventId, patch);
        return { ok: verified, verified, event: compactEvent(readback),
          ...(!verified ? { error: 'Calendar update could not be verified by readback.' } : {}) };
      },
    },
  ];
}

module.exports = { WRITE_TOOL_NAMES, compactEvent, deterministicEventId, createGoogleCalendarTools };
