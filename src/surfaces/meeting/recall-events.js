'use strict';

const crypto = require('crypto');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function relativeTimestamp(word, edge) {
  const value = word?.[`${edge}_timestamp`]?.relative;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function recallUtteranceSourceId({ transcriptId, participant, words }) {
  const first = words?.[0];
  const last = words?.at(-1);
  const start = relativeTimestamp(first, 'start');
  const end = relativeTimestamp(last, 'end');
  const identity = JSON.stringify({
    transcript_id: clean(transcriptId) || null,
    participant_id: participant?.id ?? null,
    participant_name: clean(participant?.name) || null,
    start,
    end,
    fallback_text: start == null && end == null
      ? (words || []).map(word => clean(word?.text)).filter(Boolean).join(' ') : null,
  });
  return `recall:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function parseRecallTranscriptEvent(event = {}, { now = new Date() } = {}) {
  if (event.event !== 'transcript.data') return null;
  const data = event.data?.data || {};
  const words = Array.isArray(data.words) ? data.words : [];
  const text = words.map(word => clean(word?.text)).filter(Boolean).join(' ')
    || clean(data.text);
  if (!text) return null;
  const participant = data.participant || {};
  const botId = clean(event.data?.bot?.id || event.data?.bot_id || event.bot_id);
  const transcriptId = clean(event.data?.transcript?.id || event.data?.transcript_id);
  return {
    bot_id: botId || null,
    utterance: {
      speaker: clean(participant.name) || 'Participant',
      text,
      timestamp: new Date(now).toISOString(),
      source: 'recall',
      source_id: recallUtteranceSourceId({ transcriptId, participant, words }),
    },
  };
}

function parseRecallStatusEvent(event = {}, { now = new Date() } = {}) {
  const modernEventCode = event.data?.bot?.id && /^bot\.[a-z_]+$/i.test(clean(event.event))
    ? clean(event.event).replace(/^bot\./, '') : '';
  const modernCode = clean(event.data?.data?.code || modernEventCode);
  const legacyCode = clean(event.data?.status?.code);
  const code = modernCode || legacyCode;
  const botId = clean(event.data?.bot?.id || event.data?.bot_id || event.bot_id);
  if (!code || !botId) return null;
  const updatedAt = event.data?.data?.updated_at || event.data?.status?.created_at || now;
  return { bot_id: botId, code, updated_at: new Date(updatedAt).toISOString() };
}

function appendUniqueUtterance(transcript, utterance) {
  if (!Array.isArray(transcript) || !utterance?.text) return false;
  if (utterance.source_id && transcript.some(item => item?.source_id === utterance.source_id)) {
    return false;
  }
  transcript.push(utterance);
  return true;
}

function mergeKeyedTranscriptHistories(durable, current) {
  const retained = Array.isArray(durable) ? durable : [];
  const live = Array.isArray(current) ? current : [];
  if (![...retained, ...live].every(item => clean(item?.source_id))) return null;
  const merged = retained.map(item => ({ ...item }));
  const seen = new Set(merged.map(item => item.source_id));
  for (const item of live) {
    if (seen.has(item.source_id)) continue;
    seen.add(item.source_id);
    merged.push({ ...item });
  }
  return merged;
}

function recordingStartedAt(bot = {}) {
  const change = (bot.status_changes || []).find(item => item.code === 'in_call_recording');
  return change?.created_at || bot.join_at || null;
}

function botDoneAt(bot = {}) {
  return (bot.status_changes || []).findLast(item => item.code === 'done')?.created_at || null;
}

function transcriptArtifact(bot = {}) {
  for (const recording of bot.recordings || []) {
    const transcript = recording.media_shortcuts?.transcript;
    if (transcript?.data?.download_url) return transcript;
  }
  return null;
}

function recallDownloadToUtterances(entries, { transcriptId = '', startedAt = null } = {}) {
  const baseMs = startedAt ? new Date(startedAt).getTime() : NaN;
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const words = Array.isArray(entry?.words) ? entry.words : [];
    const text = words.map(word => clean(word?.text)).filter(Boolean).join(' ');
    if (!text) return null;
    const participant = entry.participant || {};
    const relative = relativeTimestamp(words[0], 'start');
    const at = Number.isFinite(baseMs) && relative != null
      ? new Date(baseMs + (relative * 1000)) : new Date(index);
    return {
      speaker: clean(participant.name) || 'Participant',
      text,
      timestamp: at.toISOString(),
      source: 'recall',
      source_id: recallUtteranceSourceId({ transcriptId, participant, words }),
    };
  }).filter(Boolean);
}

function mergeAuthoritativeRecallTranscript(authoritative, local) {
  const combined = (Array.isArray(authoritative) ? authoritative : []).map(item => ({ ...item }));
  const seen = new Set(combined.map(item => item.source_id).filter(Boolean));
  for (const item of Array.isArray(local) ? local : []) {
    if (item?.source === 'recall') continue;
    if (item?.source_id && seen.has(item.source_id)) continue;
    if (item?.source_id) seen.add(item.source_id);
    combined.push({ ...item });
  }
  return combined.map((item, index) => ({ item, index })).sort((left, right) => {
    const leftAt = new Date(left.item.timestamp || 0).getTime();
    const rightAt = new Date(right.item.timestamp || 0).getTime();
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return left.index - right.index;
  }).map(entry => entry.item);
}

module.exports = {
  recallUtteranceSourceId,
  parseRecallTranscriptEvent,
  parseRecallStatusEvent,
  appendUniqueUtterance,
  mergeKeyedTranscriptHistories,
  recordingStartedAt,
  botDoneAt,
  transcriptArtifact,
  recallDownloadToUtterances,
  mergeAuthoritativeRecallTranscript,
};
