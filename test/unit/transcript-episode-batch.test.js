'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planTranscriptEpisodeBatch } = require('../../src/runtime/transcript-episode-batch');

test('transcript episode batches include only entries not durably recorded yet', () => {
  const transcript = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];
  const batch = planTranscriptEpisodeBatch(1, transcript);
  assert.deepEqual(batch.entries.map(item => item.text), ['two', 'three']);
  assert.equal(batch.next_recorded, 3);
});

test('utterances arriving during persistence remain eligible for the next batch', () => {
  const transcript = [{ text: 'one' }, { text: 'two' }];
  const first = planTranscriptEpisodeBatch(0, transcript);
  transcript.push({ text: 'arrived while first batch persisted' });
  const second = planTranscriptEpisodeBatch(first.next_recorded, transcript);
  assert.deepEqual(first.entries.map(item => item.text), ['one', 'two']);
  assert.deepEqual(second.entries.map(item => item.text), ['arrived while first batch persisted']);
});

test('a replaced shorter transcript safely restarts its episode projection', () => {
  const batch = planTranscriptEpisodeBatch(20, [{ text: 'replacement' }]);
  assert.equal(batch.recorded_before, 0);
  assert.deepEqual(batch.entries, [{ text: 'replacement' }]);
});
