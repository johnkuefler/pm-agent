'use strict';

const { mergeKeyedTranscriptHistories } = require('./recall-events');

// When a transcript checkpoint fails, how many more times is it worth trying?
//
// The write path refuses to overwrite durable history that the in-memory transcript does not
// extend. That refusal is correct and must stay. What was wrong is what happened next: the
// checkpoint re-armed forever, so a divergence that no retry can resolve produced an endless
// 30-second loop of failing writes. Production logs showed it reach retry 338 on one meeting,
// roughly three hours of two database round-trips per attempt, and it would only have stopped at
// the next process restart.
//
// The distinction that matters is whether a retry could plausibly succeed. A timeout or a dropped
// connection is worth retrying. A structural divergence, where neither the durable nor the
// in-memory transcript is a prefix of the other, is deterministic: the same comparison will fail
// the same way every time. Nothing in the retry path repairs it, so retrying is pure waste and it
// buries the one log line an operator needed to see.

// Enough attempts to ride out a database blip, not enough to spin all afternoon.
const MAX_TRANSIENT_ATTEMPTS = 6;
// A divergence gets a second look in case a concurrent write was mid-flight, then stops.
const MAX_DIVERGENCE_ATTEMPTS = 2;
const RETRY_CEILING_MS = 30000;
const BASE_RETRY_MS = 1000;

const DIVERGENCE_PATTERN = /diverged from its durable prefix|expected-count conflict persisted|exceeds in-memory length/i;

function transcriptStartsWith(transcript, prefix) {
  if (!Array.isArray(transcript) || !Array.isArray(prefix) || prefix.length > transcript.length) return false;
  return prefix.every((item, index) => JSON.stringify(transcript[index]) === JSON.stringify(item));
}

function createMeetingTranscriptHydrator({ getTranscript, persistedCounts }) {
  return async function ensureMeetingTranscriptHydrated(botId, session) {
    if (!session || session.transcriptHydrated === true) return session;
    if (session.transcriptHydrationPromise) return session.transcriptHydrationPromise;
    const hydration = (async () => {
      const durable = await getTranscript(botId);
      const retained = Array.isArray(durable?.transcript) ? durable.transcript : [];
      const current = Array.isArray(session.transcript) ? session.transcript : [];
      if (retained.length && !transcriptStartsWith(current, retained)) {
        session.transcript = mergeKeyedTranscriptHistories(retained, current)
          || [...retained, ...current];
      }
      persistedCounts.set(botId, retained.length);
      const recent = session.transcript.slice(-20);
      session.buffer = recent.map(item => `${item.speaker || 'Participant'}: ${item.text || ''}`);
      session.transcriptHydrated = true;
      return session;
    })();
    session.transcriptHydrationPromise = hydration;
    try {
      return await hydration;
    } finally {
      if (session.transcriptHydrationPromise === hydration) session.transcriptHydrationPromise = null;
    }
  };
}

function isUnresolvableDivergence(error) {
  return DIVERGENCE_PATTERN.test(String(error?.message || error || ''));
}

// Exponential backoff, matching the original schedule so nothing gets slower, just bounded.
function retryDelayMs(attempt) {
  return Math.min(RETRY_CEILING_MS, BASE_RETRY_MS * (2 ** Math.min(attempt, 5)));
}

// `attempt` is the count of failures so far, including the one being handled.
function checkpointRetryPlan(attempt, error) {
  const diverged = isUnresolvableDivergence(error);
  const limit = diverged ? MAX_DIVERGENCE_ATTEMPTS : MAX_TRANSIENT_ATTEMPTS;
  if (attempt >= limit) {
    return {
      retry: false,
      diverged,
      // The transcript is not lost when this happens: the in-memory copy is intact and the durable
      // copy is untouched. What is lost is automatic convergence, so say so plainly.
      reason: diverged
        ? 'durable and in-memory transcripts diverged; no retry can reconcile them, so checkpointing stopped'
        : `checkpoint failed ${attempt} times; stopping retries to avoid an unbounded write loop`,
    };
  }
  return { retry: true, diverged, delayMs: retryDelayMs(attempt) };
}

// The incremental write itself. Only the tail past the durable count is sent, and a write is
// refused outright unless one transcript is a prefix of the other, because anything else would
// silently overwrite utterances that are not in memory. This is the check that produces the
// divergence the retry policy above declines to loop on.
async function appendLiveTranscript({ botId, session, transcript, ended, db, persistedCounts,
  transcriptStartsWith, hydrate }) {
  if (hydrate) await hydrate(botId, session);
  let snapshot = [...(session?.transcript || transcript || [])];
  let expected = persistedCounts.get(botId) || 0;
  if (expected > snapshot.length) {
    throw new Error(`transcript checkpoint count ${expected} exceeds in-memory length ${snapshot.length}`);
  }
  let result = await db.appendTranscript(botId, ended || null, snapshot.slice(expected), expected);
  if (!result.applied) {
    const durable = await db.getTranscript(botId);
    const retained = Array.isArray(durable?.transcript) ? durable.transcript : [];
    if (transcriptStartsWith(snapshot, retained)) {
      expected = retained.length;
    } else if (transcriptStartsWith(retained, snapshot)) {
      snapshot = retained;
      if (session) session.transcript = retained;
      expected = retained.length;
    } else {
      // Recall can redeliver an event after a process or transport boundary. Server-generated
      // timestamps made the two copies byte-different even though they represented the same
      // utterance. Stable source ids let us preserve every durable row, discard only confirmed
      // duplicates, and append genuinely new rows. Legacy unkeyed history still fails closed.
      const merged = mergeKeyedTranscriptHistories(retained, snapshot);
      if (!merged) {
        throw new Error('transcript checkpoint diverged from its durable prefix; refusing destructive overwrite');
      }
      snapshot = merged;
      if (session) session.transcript = merged;
      expected = retained.length;
    }
    result = await db.appendTranscript(botId, ended || null, snapshot.slice(expected), expected);
    if (!result.applied) throw new Error('transcript checkpoint expected-count conflict persisted after reload');
  }
  persistedCounts.set(botId, result.utterance_count);
  return result;
}

// The record and the single log line for a checkpoint that gave up. Built here so the server keeps
// only the wiring, and so the wording stays with the reasoning above that explains it.
function abandonedCheckpointReport({ botId, attempt, error, plan, inMemoryUtterances = null }) {
  return {
    record: { reason: plan.reason, diverged: plan.diverged, attempts: attempt,
      error: String(error?.message || error), at: new Date().toISOString(),
      in_memory_utterances: inMemoryUtterances },
    message: `⛔ Transcript checkpoint abandoned for ${botId} after ${attempt} attempt(s): ${plan.reason}. `
      + 'The in-memory transcript is intact and the durable copy was not overwritten; '
      + `inspect GET /transcripts/${botId} before restarting.`,
  };
}

// Editing or deleting one utterance rewrites durable history. Doing that without applying the same
// change to a live in-memory session is what creates a divergence neither side can resolve: a
// delete shifts every later index, so the two transcripts differ in the middle rather than one
// extending the other. Applying the identical mutation keeps the durable copy a prefix of the live
// one, and preserves utterances that arrived while the edit was in flight.
function applyUtteranceEditToSession(sessionTranscript, index, { speaker, text } = {}) {
  if (!Array.isArray(sessionTranscript) || !sessionTranscript[index]) return false;
  if (speaker !== undefined) sessionTranscript[index].speaker = speaker;
  if (text !== undefined) sessionTranscript[index].text = text;
  return true;
}

function applyUtteranceDeleteToSession(sessionTranscript, index) {
  if (!Array.isArray(sessionTranscript) || index < 0 || index >= sessionTranscript.length) return false;
  sessionTranscript.splice(index, 1);
  return true;
}

module.exports = {
  MAX_TRANSIENT_ATTEMPTS,
  MAX_DIVERGENCE_ATTEMPTS,
  RETRY_CEILING_MS,
  transcriptStartsWith,
  createMeetingTranscriptHydrator,
  isUnresolvableDivergence,
  retryDelayMs,
  checkpointRetryPlan,
  abandonedCheckpointReport,
  appendLiveTranscript,
  applyUtteranceEditToSession,
  applyUtteranceDeleteToSession,
};
