'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRecallTranscriptEvent, parseRecallStatusEvent,
  appendUniqueUtterance, mergeKeyedTranscriptHistories, recallDownloadToUtterances,
  mergeAuthoritativeRecallTranscript } = require('../../src/surfaces/meeting/recall-events');

function transcriptEvent(text = 'hello there') {
  return {
    event: 'transcript.data',
    data: {
      bot: { id: 'bot-1' },
      transcript: { id: 'transcript-1' },
      data: {
        participant: { id: 7, name: 'Lydia' },
        words: text.split(' ').map((word, index) => ({
          text: word,
          start_timestamp: { relative: index },
          end_timestamp: { relative: index + 0.5 },
        })),
      },
    },
  };
}

test('Recall transcript replays and revisions retain one stable source identity', () => {
  const first = parseRecallTranscriptEvent(transcriptEvent(), {
    now: new Date('2026-08-12T10:00:00Z'),
  });
  const replay = parseRecallTranscriptEvent(transcriptEvent(), {
    now: new Date('2026-08-12T10:01:00Z'),
  });
  const revision = parseRecallTranscriptEvent(transcriptEvent('hello again'), {
    now: new Date('2026-08-12T10:02:00Z'),
  });
  assert.equal(first.bot_id, 'bot-1');
  assert.equal(first.utterance.source_id, replay.utterance.source_id);
  assert.equal(first.utterance.source_id, revision.utterance.source_id);
  const transcript = [];
  assert.equal(appendUniqueUtterance(transcript, first.utterance), true);
  assert.equal(appendUniqueUtterance(transcript, replay.utterance), false);
  assert.equal(transcript.length, 1);
});

test('current and legacy Recall completion events both parse', () => {
  const modern = parseRecallStatusEvent({
    event: 'bot.done',
    data: { bot: { id: 'modern' }, data: { code: 'done', updated_at: '2026-08-12T11:00:00Z' } },
  });
  const legacy = parseRecallStatusEvent({
    event: 'bot.status_change',
    data: { bot_id: 'legacy', status: { code: 'done', created_at: '2026-08-12T12:00:00Z' } },
  });
  assert.deepEqual(modern, { bot_id: 'modern', code: 'done', updated_at: '2026-08-12T11:00:00.000Z' });
  assert.deepEqual(legacy, { bot_id: 'legacy', code: 'done', updated_at: '2026-08-12T12:00:00.000Z' });
});

test('keyed histories converge without overwriting durable rows', () => {
  const durable = [{ source_id: 'a', text: 'edited durable copy' }, { source_id: 'b', text: 'two' }];
  const current = [{ source_id: 'a', text: 'old live copy' }, { source_id: 'c', text: 'three' }];
  assert.deepEqual(mergeKeyedTranscriptHistories(durable, current), [
    durable[0], durable[1], current[1],
  ]);
  assert.equal(mergeKeyedTranscriptHistories([{ text: 'legacy' }], [{ text: 'other' }]), null);
});

test('authoritative Recall downloads replace partial Recall rows and preserve local activity', () => {
  const entries = [{ participant: { id: 1, name: 'Mallory' }, words: [
    { text: 'Project', start_timestamp: { relative: 1 }, end_timestamp: { relative: 1.4 } },
    { text: 'update', start_timestamp: { relative: 1.5 }, end_timestamp: { relative: 2 } },
  ] }];
  const authoritative = recallDownloadToUtterances(entries, {
    transcriptId: 'artifact-1', startedAt: '2026-08-12T12:00:00Z',
  });
  const local = [
    { source: 'recall', source_id: 'obsolete', text: 'partial' },
    { source: 'local', source_id: 'local:1', text: 'Nora answered', timestamp: '2026-08-12T12:00:03Z' },
  ];
  const merged = mergeAuthoritativeRecallTranscript(authoritative, local);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'Project update');
  assert.equal(merged[1].text, 'Nora answered');
});
