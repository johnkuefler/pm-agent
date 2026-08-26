'use strict';

const { botDoneAt, transcriptArtifact, recordingStartedAt,
  recallDownloadToUtterances, mergeAuthoritativeRecallTranscript } = require('./recall-events');

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function createRecallTranscriptRecovery({ listTranscripts, getTranscript, fetchBot,
  fetchDownload, persistTranscript, now = () => new Date(), logger = console,
  staleMs = DEFAULT_STALE_MS, maxAgeMs = DEFAULT_MAX_AGE_MS, limit = 3 } = {}) {
  if (![listTranscripts, getTranscript, fetchBot, fetchDownload, persistTranscript]
    .every(value => typeof value === 'function')) {
    throw new TypeError('Recall transcript recovery requires storage, Recall reads, and persistence');
  }

  async function reconcile() {
    const at = now();
    const nowMs = at.getTime();
    const rows = await listTranscripts();
    const candidates = (Array.isArray(rows) ? rows : []).filter(item => {
      if (item.ended || !item.last_utterance_at) return false;
      const last = new Date(item.last_utterance_at).getTime();
      return Number.isFinite(last) && nowMs - last >= staleMs && nowMs - last <= maxAgeMs;
    }).sort((left, right) => new Date(right.last_utterance_at) - new Date(left.last_utterance_at))
      .slice(0, Math.max(1, Number(limit) || 3));
    const results = [];
    for (const row of candidates) {
      try {
        const bot = await fetchBot(row.bot_id);
        const endedAt = botDoneAt(bot);
        if (!endedAt) {
          results.push({ bot_id: row.bot_id, state: 'not_done' });
          continue;
        }
        const artifact = transcriptArtifact(bot);
        const local = await getTranscript(row.bot_id);
        let transcript = Array.isArray(local?.transcript) ? local.transcript : [];
        let source = 'local_finalization';
        if (artifact) {
          const downloaded = await fetchDownload(artifact.data.download_url);
          const authoritative = recallDownloadToUtterances(downloaded, {
            transcriptId: artifact.id,
            startedAt: recordingStartedAt(bot),
          });
          if (authoritative.length > Math.max(2, transcript.length * 1.2)) {
            transcript = mergeAuthoritativeRecallTranscript(authoritative, transcript);
            source = 'recall_authoritative_recovery';
          }
        }
        await persistTranscript({ bot_id: row.bot_id, ended: endedAt, transcript, source });
        results.push({ bot_id: row.bot_id, state: 'recovered', source,
          utterance_count: transcript.length, ended: endedAt });
      } catch (error) {
        logger.warn?.(`Recall transcript recovery failed for ${row.bot_id}: ${error.message}`);
        results.push({ bot_id: row.bot_id, state: 'failed', error: error.message });
      }
    }
    return { checked: candidates.length,
      recovered: results.filter(item => item.state === 'recovered').length, results };
  }

  return { reconcile };
}

function createRecallTranscriptRecoveryRuntime({ get, recallBase, apiKey, controlTimeoutMs,
  listTranscripts, getTranscript, saveTranscript, sessions, checkpointStalled,
  checkpointAttempts, persistedCounts, refreshRecentMeetings,
  enqueuePostProcessing, logger = console }) {
  return createRecallTranscriptRecovery({
    listTranscripts,
    getTranscript,
    fetchBot: async botId => (await get(`${recallBase}/bot/${encodeURIComponent(botId)}/`, {
      headers: { Authorization: `Token ${apiKey}` }, timeout: controlTimeoutMs,
    })).data,
    fetchDownload: async downloadUrl => (await get(downloadUrl, { timeout: 30000 })).data,
    persistTranscript: async ({ bot_id: botId, ended, transcript, source }) => {
      const meetingMeta = sessions[botId]?.meetingMeta || {};
      await saveTranscript(botId, transcript, ended, { recordEpisode: false });
      checkpointStalled.delete(botId);
      checkpointAttempts.delete(botId);
      persistedCounts.set(botId, transcript.length);
      delete sessions[botId];
      await refreshRecentMeetings();
      if (transcript.length) enqueuePostProcessing({ botId, ended, transcript, meetingMeta });
      logger.log?.(`Recovered and finalized Recall transcript ${botId} from ${source} (${transcript.length} utterances)`);
    },
    staleMs: 10 * 60 * 1000,
    limit: 24,
    logger,
  });
}

module.exports = { DEFAULT_STALE_MS, DEFAULT_MAX_AGE_MS, createRecallTranscriptRecovery,
  createRecallTranscriptRecoveryRuntime };
