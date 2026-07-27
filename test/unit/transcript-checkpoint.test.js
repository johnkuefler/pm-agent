const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_TRANSIENT_ATTEMPTS, MAX_DIVERGENCE_ATTEMPTS, RETRY_CEILING_MS,
  isUnresolvableDivergence, retryDelayMs, checkpointRetryPlan, abandonedCheckpointReport,
  appendLiveTranscript, applyUtteranceEditToSession,
  applyUtteranceDeleteToSession } = require('../../src/surfaces/meeting/transcript-checkpoint');

const DIVERGED = new Error('transcript checkpoint diverged from its durable prefix; refusing destructive overwrite');
const TRANSIENT = new Error('connection terminated unexpectedly');

// Production reached retry 338 on a single meeting because the checkpoint re-armed forever on an
// error no retry could resolve. Bounding it is the whole point of this module.
test('a divergence stops retrying instead of looping forever', () => {
  assert.equal(checkpointRetryPlan(1, DIVERGED).retry, true, 'one more try in case a write was mid-flight');
  const stop = checkpointRetryPlan(MAX_DIVERGENCE_ATTEMPTS, DIVERGED);
  assert.equal(stop.retry, false);
  assert.equal(stop.diverged, true);
  assert.match(stop.reason, /no retry can reconcile/);
  for (const attempt of [3, 12, 338]) {
    assert.equal(checkpointRetryPlan(attempt, DIVERGED).retry, false,
      `attempt ${attempt} must not re-arm`);
  }
});

test('a transient failure still gets a real number of retries', () => {
  for (let attempt = 1; attempt < MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    assert.equal(checkpointRetryPlan(attempt, TRANSIENT).retry, true, `attempt ${attempt} should retry`);
  }
  const stop = checkpointRetryPlan(MAX_TRANSIENT_ATTEMPTS, TRANSIENT);
  assert.equal(stop.retry, false);
  assert.equal(stop.diverged, false);
  assert.match(stop.reason, /unbounded write loop/);
});

test('every unresolvable write-path error is recognized', () => {
  assert.equal(isUnresolvableDivergence(DIVERGED), true);
  assert.equal(isUnresolvableDivergence(new Error('transcript checkpoint expected-count conflict persisted after reload')), true);
  assert.equal(isUnresolvableDivergence(new Error('transcript checkpoint count 5 exceeds in-memory length 3')), true);
  assert.equal(isUnresolvableDivergence(TRANSIENT), false);
});

test('backoff still climbs and still caps', () => {
  assert.ok(retryDelayMs(1) < retryDelayMs(3));
  assert.equal(retryDelayMs(99), RETRY_CEILING_MS);
});

test('the abandonment report names the meeting and says the data is safe', () => {
  const plan = checkpointRetryPlan(MAX_DIVERGENCE_ATTEMPTS, DIVERGED);
  const { record, message } = abandonedCheckpointReport({ botId: 'bot-9', attempt: 2,
    error: DIVERGED, plan, inMemoryUtterances: 412 });
  assert.equal(record.diverged, true);
  assert.equal(record.attempts, 2);
  assert.equal(record.in_memory_utterances, 412);
  assert.match(message, /bot-9/);
  assert.match(message, /in-memory transcript is intact/);
});

// The write path itself. Refusing a destructive overwrite is correct and must survive refactoring.
function fakeDb({ durable = [], applyFirst = true }) {
  const calls = [];
  return {
    calls,
    async appendTranscript(botId, ended, tail, expected) {
      calls.push({ tail: tail.length, expected });
      if (!applyFirst && calls.length === 1) return { applied: false };
      return { applied: true, utterance_count: expected + tail.length };
    },
    async getTranscript() { return { transcript: durable }; },
  };
}
const startsWith = (list, prefix) => prefix.every((item, index) =>
  JSON.stringify(list[index]) === JSON.stringify(item));
const line = text => ({ text });

test('a normal append sends only the tail past the durable count', async () => {
  const db = fakeDb({});
  const persistedCounts = new Map([['b', 2]]);
  const session = { transcript: [line('a'), line('b'), line('c')] };
  const result = await appendLiveTranscript({ botId: 'b', session, ended: null, db,
    persistedCounts, transcriptStartsWith: startsWith });
  assert.deepEqual(db.calls[0], { tail: 1, expected: 2 });
  assert.equal(result.utterance_count, 3);
  assert.equal(persistedCounts.get('b'), 3);
});

test('a durable copy that ran ahead is adopted rather than overwritten', async () => {
  const durable = [line('a'), line('b'), line('c')];
  const db = fakeDb({ durable, applyFirst: false });
  const session = { transcript: [line('a'), line('b')] };
  await appendLiveTranscript({ botId: 'b', session, ended: null, db,
    persistedCounts: new Map([['b', 2]]), transcriptStartsWith: startsWith });
  assert.equal(session.transcript.length, 3, 'the session takes the durable copy');
});

test('a genuine divergence refuses to write at all', async () => {
  // Durable had an utterance removed from the middle, so neither side is a prefix of the other.
  const db = fakeDb({ durable: [line('a'), line('c')], applyFirst: false });
  const session = { transcript: [line('a'), line('b'), line('c')] };
  await assert.rejects(
    appendLiveTranscript({ botId: 'b', session, ended: null, db,
      persistedCounts: new Map([['b', 3]]), transcriptStartsWith: startsWith }),
    /diverged from its durable prefix/);
  assert.deepEqual(session.transcript.map(u => u.text), ['a', 'b', 'c'],
    'the in-memory transcript must survive a refused write');
});

// Root cause: a dashboard edit rewrote durable history without touching the live session, so the
// two drifted apart in the middle and no retry could ever reconcile them.
test('an edit applied to the session keeps durable a prefix of live', () => {
  const session = [line('a'), line('b'), line('c')];
  assert.equal(applyUtteranceEditToSession(session, 1, { text: 'B' }), true);
  assert.equal(session[1].text, 'B');
  assert.equal(applyUtteranceEditToSession(session, 9, { text: 'x' }), false, 'out of range is a no-op');
});

test('a delete applied to the session preserves utterances that arrived during the edit', () => {
  const session = [line('a'), line('b'), line('c'), line('d')];
  assert.equal(applyUtteranceDeleteToSession(session, 1), true);
  assert.deepEqual(session.map(u => u.text), ['a', 'c', 'd'],
    'later utterances shift with the durable copy rather than diverging from it');
  assert.equal(applyUtteranceDeleteToSession(session, 99), false);
  assert.equal(applyUtteranceDeleteToSession(null, 0), false);
});
