require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;

const SYSTEM_PROMPT = `You are Norah. PM agent for LimeLight Marketing, a digital agency in Pittsburg KS.

You are in a live Zoom meeting. Keep responses short — 2-3 sentences max. You are speaking out loud so no markdown, no bullet points, no lists. Natural spoken language only.

You talk like a real person. Fragments are fine. Don't always wrap things up cleanly. Push back when something's off. When something is genuinely good, say so once and move on. No filler words, no sycophantic openers.

Battle-tested. You've run projects, managed creatives, argued about scope at 4pm on a Friday. You care whether LimeLight wins.

LimeLight context:
- John Kuefler — Sr. Director, Partner. Runs strategy, estimation, delivery.
- Kinsey Landry — PM, 1 month in, new to the role.
- Dianne — AM, B2B pod, HubSpot. Elle — AM, D2C pod, Klaviyo.
- Active clients: Pitsco Education, Lincoln Center Theater (May 2026), Lettermen's Energy, US Alliance Life (April 2026 fixed fee), MSG, Russell Cellular, VFW Foundation, Morton Salt, NDS, Catholic Charities, KCCTE, Green Gorilla Cleaning.
- Teamwork is the system of record. Fixed fee work means tight scope — flag creep immediately.`;

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', agent: 'Norah' }));

// One session per bot
const sessions = {};

// Recall.ai sends transcript chunks here
app.post('/webhook/transcript', async (req, res) => {
  res.sendStatus(200);

  console.log('📨 Webhook received:', JSON.stringify(req.body).slice(0, 500));

  const event = req.body;
  if (event.event !== 'transcript.data') return;

  const bot_id = event.data?.bot_id;
  const words = event.data?.data?.words;
  const text = words?.map(w => w.text).join(' ') || event.data?.data?.text;
  const speaker = event.data?.data?.participant?.name || 'Participant';

  if (!bot_id || !text) return;

  console.log(`[${speaker}]: ${text}`);

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [] };
  const session = sessions[bot_id];

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  const lower = text.toLowerCase();
  if (!lower.includes('hey norah') && !lower.includes('norah,') && !lower.includes('hey nora') && !lower.includes('nora,')) return;

  console.log('🎙️ Norah triggered');
  await handleNorah(bot_id, text, session);
});

// Zoom chat trigger — type "@norah your question" in chat
app.post('/webhook/chat', async (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  const text = data?.chat_message?.text || '';
  if (!text.toLowerCase().startsWith('@norah')) return;

  const query = text.replace(/@norah/i, '').trim();
  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [] };
  await handleNorah(bot_id, query, sessions[bot_id]);
});

// Meeting ended — clean up
app.post('/webhook/status', async (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  if (data?.status?.code === 'done') {
    console.log(`Meeting ended. Cleaning up session ${bot_id}`);
    delete sessions[bot_id];
  }
});

async function handleNorah(botId, triggerText, session) {
  try {
    const meetingContext = session.buffer.slice(-10).join('\n');
    const userMessage = `[Recent meeting conversation]\n${meetingContext}\n\n[What triggered you]\n${triggerText}`;

    session.history.push({ role: 'user', content: userMessage });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        temperature: 0.9,
        system: SYSTEM_PROMPT,
        messages: session.history
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const reply = response.data.content
      .filter(b => b.type === 'text')
      .map(b => b.text).join(' ');

    console.log('🤖 Norah:', reply);
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 20) session.history.splice(0, 2);

    await speakInMeeting(botId, reply);
  } catch (err) {
    console.error('Claude error:', err.response?.data || err.message);
  }
}

async function speakInMeeting(botId, text) {
  try {
    // ElevenLabs TTS
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true }
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        responseType: 'arraybuffer'
      }
    );

    const b64Audio = Buffer.from(ttsRes.data).toString('base64');

    // Push audio into Zoom via Recall.ai
    await axios.post(
      `${RECALL_BASE}/bot/${botId}/output_audio/`,
      { kind: 'mp3', b64_data: b64Audio },
      { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } }
    );

    console.log('🔊 Norah spoke');
  } catch (err) {
    console.error('Voice error:', err.response?.data || err.message);
  }
}

app.listen(process.env.PORT, () => {
  console.log(`Norah server running on port ${process.env.PORT}`);
});