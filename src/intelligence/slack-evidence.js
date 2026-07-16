'use strict';

function parseCanonicalMessageRef(ref) {
  if (String(ref?.type || ref?.channel || '').trim().toLowerCase() !== 'slack_message') return null;
  const match = String(ref?.id || '').trim()
    .match(/^([CDG][A-Z0-9]{8,}):(\d{10,}\.\d{6}):(\d{10,}\.\d{6})$/);
  if (!match) return null;
  const [, channel, threadTs, messageTs] = match;
  if (BigInt(messageTs.replace('.', '')) < BigInt(threadTs.replace('.', ''))) return null;
  return { channel, thread_ts: threadTs, message_ts: messageTs,
    id: `${channel}:${threadTs}:${messageTs}` };
}

function validEvidenceRefs(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref && typeof ref === 'object'
    && String(ref.type || ref.channel || '').trim() && String(ref.id || ref.url || '').trim());
}

function validCanonicalSlackRefs(refs) {
  return validEvidenceRefs(refs) && refs.every(ref =>
    String(ref.type || ref.channel || '').trim().toLowerCase() !== 'slack_message'
      || Boolean(parseCanonicalMessageRef(ref)));
}

function stableHumanSnapshot(snapshot = {}) {
  const parsed = parseCanonicalMessageRef(snapshot.evidence_ref);
  if (!parsed || parsed.id !== snapshot.evidence_ref.id
    || snapshot.channel !== parsed.channel || snapshot.thread_ts !== parsed.thread_ts
    || snapshot.message_ts !== parsed.message_ts || !String(snapshot.author_id || '').trim()
    || !String(snapshot.author_name || '').trim() || !String(snapshot.text || '').trim()) {
    throw new Error('Slack source readback does not exactly match its canonical evidence reference');
  }
  return {
    evidence_ref: { type: 'slack_message', id: parsed.id }, channel: parsed.channel,
    thread_ts: parsed.thread_ts, message_ts: parsed.message_ts,
    author_id: String(snapshot.author_id).slice(0, 100),
    author_name: String(snapshot.author_name).slice(0, 300),
    author_name_verified: snapshot.author_name_verified === true,
    text: String(snapshot.text).slice(0, 12000),
    edited_ts: snapshot.edited_ts ? String(snapshot.edited_ts).slice(0, 40) : null,
  };
}

module.exports = {
  parseCanonicalMessageRef, stableHumanSnapshot, validCanonicalSlackRefs, validEvidenceRefs,
};
