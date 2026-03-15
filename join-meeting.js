require('dotenv').config();
const axios = require('axios');

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;
const SERVER_URL = 'https://pm-agent-production-c49e.up.railway.app';

async function sendNorahToMeeting(zoomUrl) {
  const res = await axios.post(`${RECALL_BASE}/bot/`, {
    meeting_url: zoomUrl,
    bot_name: "Norah",
    recording_config: {
      transcript: {
        provider: {
          meeting_captions: {}
        }
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: `${SERVER_URL}/webhook/transcript`,
          events: ["transcript.data"]
        }
      ]
    },
    automatic_audio_output: {
      in_call_recording: {
        data: {
          kind: "mp3",
          b64_data: "SUQzAwAAAAAAJlRQRTEAAAAcAAAAU291bmRKYXkuY29tIFNvdW5kIEVmZmVjdHMA"
        }
      }
    },
    webhook_url: `${SERVER_URL}/webhook/status`
  }, {
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` }
  });

  console.log('✅ Norah joined. Bot ID:', res.data.id);

  // Register bot ID with the server
  await axios.post(`${SERVER_URL}/register-bot`, { bot_id: res.data.id }).catch(() => {});

  return res.data.id;
}

const zoomUrl = process.argv[2];
if (!zoomUrl) {
  console.error('Usage: node join-meeting.js "https://us02web.zoom.us/j/YOUR_MEETING_ID"');
  process.exit(1);
}

sendNorahToMeeting(zoomUrl).catch(err => {
  console.error('Error:', err.response?.data || err.message);
});