'use strict';

function planTranscriptEpisodeBatch(recordedCount, transcript = []) {
  if (!Array.isArray(transcript) || !transcript.length) {
    return { recorded_before: 0, next_recorded: 0, entries: [] };
  }
  let recorded = Math.max(0, Number(recordedCount) || 0);
  if (recorded > transcript.length) recorded = 0;
  const entries = transcript.slice(recorded);
  return { recorded_before: recorded, next_recorded: recorded + entries.length, entries };
}

module.exports = { planTranscriptEpisodeBatch };
