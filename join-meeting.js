require('dotenv').config();
const axios = require('axios');
axios.defaults.timeout = 12000;

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;
const SERVER_URL = 'https://pm-agent-production-c49e.up.railway.app';

async function sendNoraToMeeting(zoomUrl) {
  const res = await axios.post(`${RECALL_BASE}/bot/`, {
    meeting_url: zoomUrl,
    bot_name: "Nora",
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
      ]
    },
    variant: {
      zoom: "web_4_core",
      google_meet: "web_4_core",
      microsoft_teams: "web_4_core"
    },
    webhook_url: `${SERVER_URL}/webhook/status`
  }, {
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
    timeout: 12000,
  });

  const botId = res.data.id;
  console.log('✅ Nora joined. Bot ID:', botId);

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
