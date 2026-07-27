'use strict';

// Is a meeting still happening, and is its transcript safe to file?
//
// This looks trivial and is not. `ended` is written when Recall's done webhook fires. The JSON
// fallback path used to substitute the last utterance timestamp when `ended` was missing, which
// made a meeting that is still in progress look finished. Anything filtering on `ended` then
// treated a live meeting as complete, and the hourly run could file a transcript to Drive while
// people were still talking.
//
// Deleting that substitution alone would trade one bug for another. It existed for a real reason:
// when a bot dies or the webhook never arrives, `ended` stays null forever, and a transcript that
// is honestly "not ended" would never be filed at all. So liveness is decided by recency instead:
// a meeting with no `ended` is in progress only while its transcript is still growing. Once it has
// been silent past the stale window it is treated as orphaned, which is filable and separately
// visible so the condition can be noticed rather than silently absorbed.

// Recall sends the done webhook within seconds of a meeting ending. Half an hour of total silence
// means the meeting is over and the webhook is not coming, not that everyone stopped talking.
const TRANSCRIPT_STALE_MS = 30 * 60 * 1000;

const TRANSCRIPT_STATUSES = ['all', 'ended', 'in_progress'];

// `ended` stays exactly what the webhook wrote, null included. Callers that need a timestamp for
// display should fall back to last_utterance_at themselves rather than have one invented here.
function transcriptLiveness({ ended = null, lastUtteranceAt = null } = {}, now = Date.now()) {
  if (ended) return { in_progress: false, orphaned: false };
  const lastActivity = lastUtteranceAt ? new Date(lastUtteranceAt).getTime() : NaN;
  // No utterances at all and no end: nothing has been captured, so there is nothing to file and
  // no evidence the meeting is over. Treat it as live rather than inventing a completion.
  if (!Number.isFinite(lastActivity)) return { in_progress: true, orphaned: false };
  const silentFor = now - lastActivity;
  if (silentFor < TRANSCRIPT_STALE_MS) return { in_progress: true, orphaned: false };
  return { in_progress: false, orphaned: true };
}

// Shape one transcript record from either storage path. Both paths must agree: they disagreed
// before, and the JSON path was the dishonest one.
function describeTranscript(record, now = Date.now()) {
  const liveness = transcriptLiveness(
    { ended: record.ended || null, lastUtteranceAt: record.last_utterance_at || null }, now);
  return { ...record, ended: record.ended || null, ...liveness };
}

function filterTranscriptsByStatus(list, status = 'all') {
  const requested = String(status || 'all');
  if (requested === 'ended') return list.filter(item => !item.in_progress);
  if (requested === 'in_progress') return list.filter(item => item.in_progress);
  return list;
}

// Newest first. A transcript with no end date sorts to the top because it is either live or needs
// attention, which is the order a human scanning the list wants.
function sortTranscriptsNewestFirst(list) {
  const at = item => {
    const stamp = item.ended || item.last_utterance_at;
    const value = stamp ? new Date(stamp).getTime() : NaN;
    return Number.isFinite(value) ? value : Infinity;
  };
  return list.slice().sort((a, b) => at(b) - at(a));
}

module.exports = {
  TRANSCRIPT_STALE_MS,
  TRANSCRIPT_STATUSES,
  transcriptLiveness,
  describeTranscript,
  filterTranscriptsByStatus,
  sortTranscriptsNewestFirst,
};
