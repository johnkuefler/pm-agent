'use strict';

// Meeting chat is not a conversational surface. It accepts only these two exact voice-control
// commands so Nora can remain safely muted until a participant deliberately turns her on.
function parseNoraMuteCommand(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '').trim();
  const match = normalized.match(/^(?:@?nora[\s,:-]+(unmute|mute)|(unmute|mute)[\s,:-]+@?nora)$/);
  return match ? (match[1] || match[2]) : null;
}

function registerMeetingChatControls(app, { sessions, newSession, verifyRecallRealtime,
  axios, RECALL_BASE, RECALL_CONTROL_TIMEOUT_MS }) {
function setMeetingMuted(botId, muted) {
  if (!botId) return null;
  const session = sessions[botId] || (sessions[botId] = newSession());
  session.muted = Boolean(muted);
  if (session.voiceClientWs?.readyState === 1) {
    try {
      session.voiceClientWs.send(JSON.stringify({ type: 'nora.mute', muted: session.muted }));
    } catch (error) {
      // The browser may disconnect between the ready-state check and send. The session flag is
      // authoritative and will be replayed if the avatar reconnects.
      console.warn(`Meeting mute signal failed for ${botId}:`, error.message);
    }
  }
  return session;
}

app.post('/webhook/chat-control', verifyRecallRealtime, async (req, res) => {
  res.sendStatus(200);
  const eventType = req.body?.event;
  if (eventType !== 'participant_events.chat_message') return;
  const eventData = req.body?.data?.data;
  const text = eventData?.data?.text || req.body?.data?.chat_message?.text || '';
  const command = parseNoraMuteCommand(text);
  if (!command) return;
  const botId = req.body?.data?.bot?.id;
  if (!botId) return;

  const muted = command === 'mute';
  setMeetingMuted(botId, muted);
  const speaker = eventData?.participant?.name || 'participant';
  console.log(`Meeting voice ${muted ? 'muted' : 'unmuted'} by ${speaker} for bot ${botId}`);
  const message = muted
    ? 'Muted. Type “Nora unmute” when you want me to speak again.'
    : 'Voice on. Say “Nora” when you want me.';
  try {
    await axios.post(`${RECALL_BASE}/bot/${botId}/send_chat_message/`, { message }, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
      timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(`Meeting mute confirmation failed for ${botId}:`, error.message);
  }
});
}

module.exports = { registerMeetingChatControls, parseNoraMuteCommand };
