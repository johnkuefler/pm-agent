require('dotenv').config();
const axios = require('axios');
axios.defaults.timeout = 12000;

const SERVER_URL = (process.env.NORA_SERVER_URL || 'https://pm-agent-production-c49e.up.railway.app').replace(/\/$/, '');

async function sendNoraToMeeting(zoomUrl) {
  const res = await axios.post(`${SERVER_URL}/join`, { meeting_url: zoomUrl }, {
    headers: process.env.NORA_API_KEY
      ? { Authorization: `Bearer ${process.env.NORA_API_KEY}` }
      : {},
    timeout: 12000,
  });

  const botId = res.data.bot_id;
  console.log(`✅ Nora joined. Bot ID: ${botId}. GPT-Live voice: ${res.data.voice_enabled ? 'on' : 'off'}`);

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
