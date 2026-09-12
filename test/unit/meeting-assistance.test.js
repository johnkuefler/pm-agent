'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventMetadata, selectProjects, meetingTerms, internalMeeting, priorMatch,
  createContextCollector } = require('../../src/surfaces/meeting/assistance-context');
const { validateNotes, transcriptChunks } = require('../../src/surfaces/meeting/assistance-model');
const { createMeetingAssistance } = require('../../src/surfaces/meeting/assistance-runtime');
const { contextChunks } = require('../../src/surfaces/meeting/gpt-live-relay');

const at = new Date('2026-09-14T15:00:00Z').getTime();
const ev = { id: 'ev-1', start_time: new Date(at + 10 * 60000).toISOString(),
  end_time: new Date(at + 40 * 60000).toISOString(), meeting_url: 'https://zoom.us/j/123',
  raw: { summary: 'KCBR Weekly', recurringEventId: 'series-1', attendees: [
    { email: 'nora@agency.test' }, { email: 'john@agency.test' },
  ] } };

test('calendar metadata supports ordinary invites and rejects declined/cancelled attendance', () => {
  const meta = eventMetadata(ev, 'nora@agency.test');
  assert.equal(meta.invited, true);
  assert.equal(meta.series_id, 'series-1');
  assert.deepEqual(meetingTerms(meta, 'nora@agency.test'), ['kcbr']);
  assert.equal(internalMeeting(meta, 'nora@agency.test'), true);
  assert.equal(eventMetadata({ ...ev, is_deleted: true }, 'nora@agency.test').cancelled, true);
  assert.equal(eventMetadata({ ...ev, raw: { ...ev.raw, attendees: [
    { email: 'nora@agency.test', responseStatus: 'declined' },
  ] } }, 'nora@agency.test').invited, false);
  assert.equal(internalMeeting({ attendees: [] }, 'nora@agency.test'), false);
  assert.equal(internalMeeting({ attendees: [{ email: 'customer@kcbr.com' }] }, 'nora@agency.test'), false);
});

test('ambiguous project matches do not choose a client; attendee domains can resolve generic titles', () => {
  const one = { id: 1, name: 'KCBR website', company: 'KCBR' };
  assert.deepEqual(selectProjects([one], ['kcbr']), [one]);
  assert.deepEqual(selectProjects([one, { id: 2, name: 'KCBR research', company: 'Other client' }], ['kcbr']), [one]);
  assert.deepEqual(selectProjects([one, { id: 2, name: 'KCBR research', company: 'KCBR group' }], ['kcbr']), []);
  assert.deepEqual(meetingTerms({ title: 'Weekly sync', attendees: [{ email: 'am@kcbr.com' }] }, 'nora@agency.test'), ['kcbr']);
  const website = { id: 3, name: 'CCKC - Website Rebuild', company: 'Catholic Charities' };
  assert.deepEqual(selectProjects([website,
    { id: 4, name: 'CCKC - Client Journey', company: 'Catholic Charities' },
    { id: 5, name: 'Opportunity - CCKC Hosting & Web Support', company: 'LimeLight' },
  ], ['cckc'], 'INT: CCKC Web Status Meeting'), [website]);
});

test('series history is usable only for the same attendee audience', () => {
  const meta = eventMetadata(ev, 'nora@agency.test');
  const previous = { meta: { ...meta, event_id: 'previous' } };
  assert.equal(priorMatch(meta, previous), true);
  assert.equal(priorMatch(meta, { meta: { ...previous.meta, attendees: [{ email: 'other@agency.test' }] } }), false);
});

test('external audiences do not receive internal Slack and private lookups never run for unknown audiences', async () => {
  let reads = 0;
  const collector = createContextCollector({ teamworkTools: () => [],
    get: async () => { reads++; throw new Error('must not read Slack'); },
    slackToken: () => 'token', ownEmail: () => 'nora@agency.test', financialContent: () => false });
  await collector.collect({ title: 'KCBR', attendees: [{ email: 'customer@kcbr.com' }] }, {});
  const unknown = await collector.collect({ title: 'KCBR', attendees: [] }, {});
  assert.equal(reads, 0);
  assert.match(unknown.gaps[0], /attendees could not be resolved/);
});

test('todo evidence is checked against the actual transcript and missing owners/dates remain unknown', () => {
  const transcript = [{ speaker: 'John', text: 'Santi will do the migration by Friday.' }];
  const valid = { text: 'Migrate', owner: 'Santi', due_text: 'Friday', source_index: 0,
    quote: transcript[0].text };
  const notes = validateNotes({ summary: 'Discussed migration', todos: [valid,
    { ...valid, quote: 'Invented quote' }, { ...valid, source_index: 99 },
    { ...valid, owner: 'Alex', due_text: 'Monday' }] }, transcript);
  assert.equal(notes.todos.length, 2);
  assert.equal(notes.todos[0].owner, 'Santi');
  assert.equal(notes.todos[1].owner, null);
  assert.equal(notes.todos[1].due_text, null);
});

test('transcript segments retain original evidence indexes and voice appends preserve Unicode', () => {
  const transcript = Array.from({ length: 10 }, (_, n) => ({ speaker: 'A', text: String(n).repeat(100) }));
  const chunks = transcriptChunks(transcript, 300);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map(item => item.index), transcript.map((_, i) => i));
  const text = '😀中文 hello '.repeat(200);
  assert.equal(contextChunks(text).join(''), text);
  assert.ok(contextChunks(text).every(chunk => Buffer.byteLength(chunk) <= 400));
});

async function fixture(t, overrides = {}) {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  t.after(() => { if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey; });
  const saved = new Map();
  const docs = new Map();
  const published = [];
  let count = 0, time = at;
  const db = { DB_SCHEMA: 'test', q: async () => ({ rows: [...saved.values()].map(value => ({ value: structuredClone(value) })) }),
    getState: async key => structuredClone(saved.get(key) || null),
    setState: async (key, value) => saved.set(key, structuredClone(value)) };
  const deps = { db, databaseReady: () => true, directory: '.', writeThrough: (_key, fn) => fn(),
    get: async () => { throw new Error('unexpected provider read'); }, post: async () => {},
    calendarState: () => ({ google_email: 'nora@agency.test' }), recallBase: () => 'https://example.test',
    getTranscript: async id => structuredClone(docs.get(id) || null), teamworkTools: () => [], financialContent: () => false,
    beginBackground: () => ({ allowed: true, signal: new AbortController().signal, release() {} }),
    publishContext: (id, brief) => published.push({ id, brief }), now: () => time,
    collector: { collect: async meta => ({ meeting: meta, projects: [], sources: [], gaps: [] }) },
    model: { brief: async () => { count++; return 'KCBR project status'; },
      notes: async (_meta, _chunk, transcript) => validateNotes({ summary: 'Migration discussed',
        todos: [{ text: 'Migrate', owner: 'Santi', due_text: 'Friday', source_index: 0, quote: transcript[0].text }] }, transcript) },
    logger: { warn() {} }, ...overrides };
  const runtime = createMeetingAssistance(deps);
  await runtime.init();
  return { runtime, deps, docs, published, saved, count: () => count, advance: ms => { time += ms; } };
}

test('preparation runs near start once, survives restart, and an edited invite refreshes it', async t => {
  const f = await fixture(t);
  await f.runtime.calendar({ ...ev, start_time: new Date(at + 60 * 60000).toISOString() }, 'bot-1');
  await f.runtime.tick();
  assert.equal(f.count(), 0);
  await f.runtime.calendar(ev, 'bot-1');
  await f.runtime.tick();
  assert.equal(f.count(), 1);
  assert.match(f.published[0].brief, /KCBR project/);
  await f.runtime.tick();
  assert.equal(f.count(), 1);
  const restarted = createMeetingAssistance(f.deps);
  await restarted.init();
  await restarted.tick();
  assert.equal(f.count(), 1);
  await restarted.calendar({ ...ev, raw: { ...ev.raw, summary: 'KCBR kickoff' } }, 'bot-1');
  await restarted.tick();
  assert.equal(f.count(), 2);
});

test('notes require ended durable transcripts, are idempotent, and refresh after edits', async t => {
  const f = await fixture(t);
  await f.runtime.calendar(ev, 'bot-1');
  const doc = { bot_id: 'bot-1', ended: null, transcript: [{ speaker: 'John', text: 'Santi will migrate by Friday.' }] };
  f.docs.set('bot-1', doc);
  await f.runtime.finished('bot-1');
  assert.equal(f.runtime.peek('bot-1').notes, undefined);
  doc.ended = new Date(at).toISOString();
  await f.runtime.finished('bot-1');
  await f.runtime.tick();
  let data = await f.runtime.decorate(doc);
  assert.equal(data.notes.status, 'ready');
  assert.equal(data.preparation.status, 'skipped');
  assert.equal(data.notes.result.todos[0].owner, 'Santi');
  await f.runtime.finished('bot-1');
  assert.equal(f.runtime.peek('bot-1').notes.status, 'ready');
  doc.transcript[0].text = 'Alex will migrate by Monday.';
  data = await f.runtime.decorate(doc);
  assert.equal(data.notes.result, undefined, 'stale evidence cannot be displayed');
  await f.runtime.finished('bot-1');
  assert.equal(f.runtime.peek('bot-1').notes.status, 'pending');
  await f.runtime.tick();
  data = await f.runtime.decorate(doc);
  assert.equal(data.notes.result.todos[0].owner, null, 'model cannot retain the old owner');
});

test('cancellations and transcript deletion prevent queued work from being resurrected', async t => {
  const f = await fixture(t);
  await f.runtime.calendar({ ...ev, is_deleted: true }, 'bot-1');
  await f.runtime.tick();
  assert.equal(f.count(), 0);
  await f.runtime.remove('bot-1');
  await f.runtime.calendar(ev, 'bot-1');
  await f.runtime.tick();
  assert.equal(f.count(), 0);
  assert.equal(f.runtime.peek('bot-1').deleted, true);
  assert.equal(f.runtime.peek('bot-1').meta, undefined);
});

test('provider failures stop after three attempts', async t => {
  const f = await fixture(t, { model: { brief: async () => { throw new Error('Unavailable'); } } });
  await f.runtime.calendar(ev, 'bot-1');
  for (let i = 0; i < 3; i++) { await f.runtime.tick(); f.advance(61000); }
  assert.equal(f.runtime.peek('bot-1').prep.status, 'failed');
  assert.equal(f.runtime.peek('bot-1').prep.attempts, 3);
  await f.runtime.tick();
  assert.equal(f.runtime.peek('bot-1').prep.attempts, 3);
});

test('foreground preemption leaves preparation queued and does not spend a retry', async t => {
  const controller = new AbortController();
  const f = await fixture(t, {
    beginBackground: () => ({ allowed: true, signal: controller.signal, release() {} }),
    model: { brief: async () => { controller.abort(); throw new Error('preempted'); } },
  });
  await f.runtime.calendar(ev, 'bot-1');
  await f.runtime.tick();
  assert.equal(f.runtime.peek('bot-1').prep.attempts, 0);
  assert.equal(f.runtime.peek('bot-1').prep.status, 'pending');
});

test('a long meeting receives a final reconciliation after all segments, without duplicating segments', async t => {
  let reconciled = 0;
  const f = await fixture(t, { model: {
    notes: async () => ({ summary: 'segment', decisions: [], todos: [], open_questions: [], risks: [] }),
    reconcile: async (_meta, segments) => {
      reconciled++;
      assert.equal(segments.length, 2);
      return { summary: 'Final decisions after corrections', decisions: [], todos: [], open_questions: [], risks: [] };
    },
  } });
  const doc = { bot_id: 'bot-1', ended: new Date(at).toISOString(), transcript:
    Array.from({ length: 4 }, () => ({ speaker: 'A', text: 'a'.repeat(7000) })) };
  f.docs.set('bot-1', doc);
  await f.runtime.finished('bot-1');
  await f.runtime.tick();
  await f.runtime.tick();
  assert.equal(f.runtime.peek('bot-1').notes.status, 'pending');
  await f.runtime.tick();
  assert.equal(f.runtime.peek('bot-1').notes.status, 'ready');
  await f.runtime.tick();
  assert.equal(reconciled, 1);
});
