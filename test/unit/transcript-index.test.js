const test = require('node:test');
const assert = require('node:assert/strict');

const { TRANSCRIPT_STALE_MS, transcriptLiveness, describeTranscript,
  filterTranscriptsByStatus, sortTranscriptsNewestFirst } = require('../../src/surfaces/meeting/transcript-index');

const NOW = Date.parse('2026-07-26T18:00:00.000Z');
const minutesAgo = n => new Date(NOW - n * 60 * 1000).toISOString();

test('a meeting whose done webhook fired is ended', () => {
  const state = transcriptLiveness({ ended: minutesAgo(5), lastUtteranceAt: minutesAgo(6) }, NOW);
  assert.deepEqual(state, { in_progress: false, orphaned: false });
});

// The bug this module exists for: a live meeting whose transcript is still growing must never be
// reported as finished, because the hourly run files anything that looks finished.
test('a meeting still producing utterances is in progress', () => {
  const state = transcriptLiveness({ ended: null, lastUtteranceAt: minutesAgo(2) }, NOW);
  assert.equal(state.in_progress, true);
  assert.equal(state.orphaned, false);
});

test('a meeting with no utterances yet is in progress rather than invented complete', () => {
  const state = transcriptLiveness({ ended: null, lastUtteranceAt: null }, NOW);
  assert.deepEqual(state, { in_progress: true, orphaned: false });
});

// The other half: deleting the old fake outright would strand a transcript whose webhook never
// arrived, because `ended` would stay null forever and nothing would ever file it.
test('a transcript silent past the stale window is orphaned, not permanently live', () => {
  const state = transcriptLiveness(
    { ended: null, lastUtteranceAt: new Date(NOW - TRANSCRIPT_STALE_MS - 1000).toISOString() }, NOW);
  assert.equal(state.in_progress, false, 'an orphaned transcript must become filable');
  assert.equal(state.orphaned, true, 'and must stay visibly distinct from a clean end');
});

test('the stale boundary is not crossed a moment early', () => {
  const justInside = transcriptLiveness(
    { ended: null, lastUtteranceAt: new Date(NOW - TRANSCRIPT_STALE_MS + 1000).toISOString() }, NOW);
  assert.equal(justInside.in_progress, true);
});

// Both storage paths shape records through describeTranscript. They disagreed before: the JSON
// path substituted the last utterance for a missing `ended`, the Postgres path did not.
test('describeTranscript never invents an end timestamp', () => {
  const live = describeTranscript(
    { bot_id: 'b1', ended: null, last_utterance_at: minutesAgo(1) }, NOW);
  assert.equal(live.ended, null, 'a live meeting has no end date, however recently it spoke');
  assert.equal(live.in_progress, true);

  const done = describeTranscript(
    { bot_id: 'b2', ended: minutesAgo(90), last_utterance_at: minutesAgo(95) }, NOW);
  assert.equal(done.ended, minutesAgo(90));
  assert.equal(done.in_progress, false);
});

test('describeTranscript preserves the caller fields it was given', () => {
  const row = describeTranscript({ bot_id: 'b3', ended: minutesAgo(10), last_utterance_at: minutesAgo(12),
    url: '/transcripts/b3', utterance_count: 42, file: 'transcript-b3.json' }, NOW);
  assert.equal(row.url, '/transcripts/b3');
  assert.equal(row.utterance_count, 42);
  assert.equal(row.file, 'transcript-b3.json');
});

test('status filtering separates live meetings from filable ones', () => {
  const list = [
    describeTranscript({ bot_id: 'live', ended: null, last_utterance_at: minutesAgo(1) }, NOW),
    describeTranscript({ bot_id: 'done', ended: minutesAgo(20), last_utterance_at: minutesAgo(25) }, NOW),
    describeTranscript({ bot_id: 'orphan', ended: null,
      last_utterance_at: new Date(NOW - TRANSCRIPT_STALE_MS - 60000).toISOString() }, NOW),
  ];
  assert.deepEqual(filterTranscriptsByStatus(list, 'in_progress').map(t => t.bot_id), ['live']);
  assert.deepEqual(filterTranscriptsByStatus(list, 'ended').map(t => t.bot_id), ['done', 'orphan'],
    'an orphaned transcript is filable, which is the whole point of not stranding it');
  assert.equal(filterTranscriptsByStatus(list, 'all').length, 3);
  assert.equal(filterTranscriptsByStatus(list).length, 3, 'default must stay all for existing callers');
  assert.equal(filterTranscriptsByStatus(list, 'nonsense').length, 3, 'an unknown status must not silently hide meetings');
});

test('sorting puts the newest first and does not drop undated records', () => {
  const list = [
    describeTranscript({ bot_id: 'older', ended: minutesAgo(300), last_utterance_at: minutesAgo(305) }, NOW),
    describeTranscript({ bot_id: 'newer', ended: minutesAgo(30), last_utterance_at: minutesAgo(35) }, NOW),
    describeTranscript({ bot_id: 'live', ended: null, last_utterance_at: null }, NOW),
  ];
  const sorted = sortTranscriptsNewestFirst(list);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].bot_id, 'live', 'a record with no timestamps needs attention, so it leads');
  assert.deepEqual(sorted.slice(1).map(t => t.bot_id), ['newer', 'older']);
});
