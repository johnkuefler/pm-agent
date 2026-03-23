require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;
const SERVER_URL = 'https://pm-agent-production-c49e.up.railway.app';
const WS_URL = 'wss://pm-agent-production-c49e.up.railway.app';

async function sendNoraToMeeting(zoomUrl) {
  const sessionToken = crypto.randomBytes(32).toString('hex');

  const voiceAgentUrl = `${SERVER_URL}/voice-agent?wss=${encodeURIComponent(WS_URL + '/ws/openai-relay')}&server=${encodeURIComponent(SERVER_URL)}&token=${sessionToken}`;

  const res = await axios.post(`${RECALL_BASE}/bot/`, {
    meeting_url: zoomUrl,
    bot_name: "Nora",
    output_media: {
      camera: {
        kind: "webpage",
        config: {
          url: voiceAgentUrl
        }
      }
    },
    recording_config: {
      transcript: {
        provider: { assembly_ai_v3_streaming: { speech_model: 'universal-streaming-english' } }
      },
      realtime_endpoints: [
        {
          type: 'webhook',
          url: `${SERVER_URL}/webhook/transcript`,
          events: ['transcript.data']
        }
      ],
      include_bot_in_recording: { audio: true }
    },
    variant: {
      zoom: "web_4_core",
      google_meet: "web_4_core",
      microsoft_teams: "web_4_core"
    },
    webhook_url: `${SERVER_URL}/webhook/status`
  }, {
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` }
  });

  const botId = res.data.id;
  console.log('✅ Nora joined. Bot ID:', botId);

  // Register bot ID and session token with the server
  await axios.post(`${SERVER_URL}/register-bot`, { bot_id: botId, session_token: sessionToken }).catch(() => {});

  return botId;
}

const zoomUrl = process.argv[2];
if (!zoomUrl) {
  console.error('Usage: node join-meeting.js "https://us02web.zoom.us/j/YOUR_MEETING_ID"');
  process.exit(1);
}

sendNoraToMeeting(zoomUrl).catch(err => {
  console.error('Error:', err.response?.data || err.message);
});