require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;

// Load prompt from file
const PROMPT_PATH = path.join(__dirname, 'nora-prompt.md');
const VOLUME_DIR = '/data';
const MEMORY_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-memory.json');
const MEMORY_PATH_LOCAL = path.join(__dirname, 'nora-memory.json');
const TASKS_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-tasks.json');
const TASKS_PATH_LOCAL = path.join(__dirname, 'nora-tasks.json');

// Use Railway volume if available, fall back to local file for dev
function getMemoryPath() {
  if (fs.existsSync(VOLUME_DIR)) return MEMORY_PATH_VOLUME;
  return MEMORY_PATH_LOCAL;
}

// Seed volume with local memory file on first run
function initMemory() {
  const memPath = getMemoryPath();
  if (memPath === MEMORY_PATH_VOLUME && !fs.existsSync(MEMORY_PATH_VOLUME)) {
    try {
      const seed = fs.readFileSync(MEMORY_PATH_LOCAL, 'utf8');
      fs.writeFileSync(MEMORY_PATH_VOLUME, seed);
      console.log('🧠 Seeded memory to volume');
    } catch { /* no seed file, start fresh */ }
  }
}

function loadPrompt() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(getMemoryPath(), 'utf8'));
  } catch { return []; }
}

function saveMemory(memory) {
  fs.writeFileSync(getMemoryPath(), JSON.stringify(memory, null, 2));
}

// Task queue — same pattern as memory
function getTasksPath() {
  if (fs.existsSync(VOLUME_DIR)) return TASKS_PATH_VOLUME;
  return TASKS_PATH_LOCAL;
}

function loadTasks() {
  try {
    return JSON.parse(fs.readFileSync(getTasksPath(), 'utf8'));
  } catch { return []; }
}

function saveTasks(tasks) {
  fs.writeFileSync(getTasksPath(), JSON.stringify(tasks, null, 2));
}

function addTask(task) {
  const tasks = loadTasks();
  const id = `nora-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  tasks.push({
    id,
    ...task,
    status: 'pending',
    created: new Date().toISOString(),
    completed: null
  });
  saveTasks(tasks);
  console.log('📋 Task added:', id, task.action);
  return id;
}

initMemory();

function buildSystemPrompt() {
  const base = loadPrompt();
  const memory = loadMemory();
  if (memory.length === 0) return base;
  const memoryBlock = memory.map(m => `- ${m.fact}`).join('\n');
  return `${base}\n\n[Your memory]\n${memoryBlock}`;
}

// Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Claude instructions page — serves prompt + API docs for scheduled Claude Code sessions
app.get('/instructions', (req, res) => {
  res.sendFile(path.join(__dirname, 'instructions.html'));
});

// Nora's system prompt as raw text (for Claude Code to fetch)
app.get('/prompt', (req, res) => {
  res.type('text/plain').send(loadPrompt());
});

// Join meeting via API
app.post('/join', async (req, res) => {
  try {
    const { meeting_url } = req.body;
    if (!meeting_url) return res.status(400).json({ error: 'meeting_url is required' });

    const SERVER_URL = `https://${req.get('host')}`;
    const botRes = await axios.post(`${RECALL_BASE}/bot/`, {
      meeting_url,
      bot_name: 'Nora',
      recording_config: {
        transcript: { provider: { meeting_captions: {} } },
        realtime_endpoints: [{
          type: 'webhook',
          url: `${SERVER_URL}/webhook/transcript`,
          events: ['transcript.data']
        }]
      },
      automatic_audio_output: {
        in_call_recording: {
          data: { kind: 'mp3', b64_data: 'SUQzAwAAAAAAJlRQRTEAAAAcAAAAU291bmRKYXkuY29tIFNvdW5kIEVmZmVjdHMA' }
        }
      },
      webhook_url: `${SERVER_URL}/webhook/status`
    }, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` }
    });

    activeBotId = botRes.data.id;
    console.log('✅ Nora joined via web. Bot ID:', activeBotId);
    res.json({ bot_id: botRes.data.id });
  } catch (err) {
    console.error('Join error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// One session per bot
const sessions = {};
let activeBotId = null;

// Register bot ID when Nora joins a meeting
app.post('/register-bot', (req, res) => {
  activeBotId = req.body.bot_id;
  console.log('🤖 Registered bot:', activeBotId);
  res.json({ ok: true });
});

// Recall.ai sends transcript chunks here
app.post('/webhook/transcript', async (req, res) => {
  res.sendStatus(200);

  console.log('📨 Webhook received:', JSON.stringify(req.body).slice(0, 800));

  const event = req.body;
  if (event.event !== 'transcript.data') return;

  const bot_id = event.data?.bot_id || event.bot_id || activeBotId;
  const words = event.data?.data?.words;
  const text = words?.map(w => w.text).join(' ') || event.data?.data?.text;
  const speaker = event.data?.data?.participant?.name || 'Participant';

  if (!text) return;
  console.log(`[bot_id: ${bot_id}] [${speaker}]: ${text}`);

  console.log(`[${speaker}]: ${text}`);

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [] };
  const session = sessions[bot_id];

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  const lower = text.toLowerCase().replace(/[,\.!\?]/g, '');

  // Stop/interrupt phrases — cut Nora off mid-speech
  if (lower.includes('stop nora') || lower.includes('nora stop') || lower.includes('hold on') || lower.includes('never mind') || lower.includes('nevermind')) {
    console.log('🛑 Stop phrase detected');
    if (session.abortController) session.abortController.abort();
    await silenceBot(bot_id);
    return;
  }

  if (!lower.includes('hey nora') && !lower.includes('nora ')) return;

  // Abort any in-progress response before starting a new one
  if (session.abortController) {
    console.log('⏭️ Aborting previous response');
    session.abortController.abort();
    await silenceBot(bot_id);
  }

  console.log('🎙️ Nora triggered');
  await handleNora(bot_id, text, session);
});

// Zoom chat trigger — type "@nora your question" in chat
app.post('/webhook/chat', async (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  const text = data?.chat_message?.text || '';
  if (!text.toLowerCase().startsWith('@nora')) return;

  const query = text.replace(/@nora/i, '').trim();
  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [] };
  await handleNora(bot_id, query, sessions[bot_id]);
});

// Meeting status updates — track bot_id and clean up
app.post('/webhook/status', async (req, res) => {
  res.sendStatus(200);
  console.log('📡 Status webhook:', JSON.stringify(req.body).slice(0, 300));
  const { bot_id, data } = req.body;
  if (bot_id) {
    activeBotId = bot_id;
    console.log('📡 Tracked bot_id from status:', bot_id);
  }
  if (data?.status?.code === 'done') {
    console.log(`Meeting ended. Cleaning up session ${bot_id}`);
    delete sessions[bot_id];
    if (activeBotId === bot_id) activeBotId = null;
  }
});

// Memory API — view and edit Nora's memory
app.get('/memory', (req, res) => res.json(loadMemory()));

app.post('/memory', (req, res) => {
  const { fact, source } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact is required' });
  const memory = loadMemory();
  memory.push({ fact, added: new Date().toISOString().split('T')[0], source: source || 'manual' });
  saveMemory(memory);
  console.log('🧠 Memory added:', fact);
  res.json({ ok: true, memory });
});

app.delete('/memory/:index', (req, res) => {
  const memory = loadMemory();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= memory.length) return res.status(404).json({ error: 'index out of range' });
  const removed = memory.splice(idx, 1);
  saveMemory(memory);
  console.log('🧠 Memory removed:', removed[0].fact);
  res.json({ ok: true, memory });
});

// Task queue API
app.get('/tasks', (req, res) => {
  const tasks = loadTasks();
  const status = req.query.status; // ?status=pending or ?status=done
  if (status) return res.json(tasks.filter(t => t.status === status));
  res.json(tasks);
});

app.post('/tasks', (req, res) => {
  const { action, detail, assignee, due } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });
  const id = addTask({ action, detail: detail || '', assignee: assignee || '', due: due || '' });
  res.json({ ok: true, id });
});

app.patch('/tasks/:id/complete', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status === 'done') return res.json({ ok: true, already: true, task });
  task.status = 'done';
  task.completed = new Date().toISOString();
  saveTasks(tasks);
  console.log('✅ Task completed:', task.id, task.action);
  res.json({ ok: true, task });
});

app.delete('/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'task not found' });
  const removed = tasks.splice(idx, 1);
  saveTasks(tasks);
  console.log('🗑️ Task deleted:', removed[0].id);
  res.json({ ok: true });
});

async function handleNora(botId, triggerText, session) {
  const abortController = new AbortController();
  session.abortController = abortController;

  try {
    const meetingContext = session.buffer.slice(-10).join('\n');
    const userMessage = `[Recent meeting conversation]\n${meetingContext}\n\n[What triggered you]\n${triggerText}`;

    session.history.push({ role: 'user', content: userMessage });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        temperature: 0.9,
        system: buildSystemPrompt(),
        messages: session.history
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        signal: abortController.signal
      }
    );

    if (abortController.signal.aborted) return;

    const fullReply = response.data.content
      .filter(b => b.type === 'text')
      .map(b => b.text).join(' ');

    console.log('🤖 Nora:', fullReply);
    session.history.push({ role: 'assistant', content: fullReply });
    if (session.history.length > 20) session.history.splice(0, 2);

    if (abortController.signal.aborted) return;
    await speakInMeeting(botId, fullReply);

    // Check for memories and action items in background
    extractMemory(meetingContext, triggerText, fullReply).catch(() => {});
    extractTasks(meetingContext, triggerText, fullReply).catch(() => {});
  } catch (err) {
    if (err.name === 'CanceledError' || abortController.signal.aborted) {
      console.log('🚫 Response aborted');
      return;
    }
    console.error('Claude error:', err.response?.data || err.message);
  } finally {
    if (session.abortController === abortController) {
      session.abortController = null;
    }
  }
}

async function extractMemory(context, trigger, reply) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        temperature: 0,
        system: `You decide if something should be saved to Nora's long-term memory. ONLY save something if one of these is true: (1) someone explicitly asked Nora to remember something (e.g. "Nora remember that..." or "don't forget..."), or (2) Nora was asked to do a specific action item with a clear owner and deadline. That's it. Do NOT save general discussion, decisions, status updates, opinions, project details, or anything else — even if it seems useful. When in doubt, return []. Respond with a JSON array of short fact strings, or an empty array [].`,
        messages: [{ role: 'user', content: `Meeting snippet:\n${context}\n\nTriggering message: ${trigger}\n\nNora's response: ${reply}\n\nFacts worth remembering (JSON array or []):` }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const text = response.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;

    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts) || facts.length === 0) return;

    const memory = loadMemory();
    const existingFacts = new Set(memory.map(m => m.fact.toLowerCase()));
    let added = 0;
    for (const fact of facts) {
      if (typeof fact === 'string' && fact.trim() && !existingFacts.has(fact.toLowerCase())) {
        memory.push({ fact, added: new Date().toISOString().split('T')[0], source: 'meeting' });
        existingFacts.add(fact.toLowerCase());
        added++;
      }
    }
    if (added > 0) {
      saveMemory(memory);
      console.log(`🧠 Auto-saved ${added} memor${added === 1 ? 'y' : 'ies'}:`, facts);
    }
  } catch (err) {
    console.error('Memory extraction error:', err.message);
  }
}

async function extractTasks(context, trigger, reply) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: `You extract action items that Nora was explicitly asked to do. ONLY extract tasks where someone directly asked Nora to take an action — things like "Nora, schedule a meeting with...", "Nora, send Kyle an email about...", "Nora, create a task for...", "Nora, remind me to...". Do NOT extract general discussion, suggestions Nora made, or things other people said they would do. Return a JSON array of objects with: action (what to do), detail (specifics), assignee (who it's for), due (deadline if mentioned, otherwise ""). Return [] if no action items.`,
        messages: [{ role: 'user', content: `Meeting snippet:\n${context}\n\nTriggering message: ${trigger}\n\nNora's response: ${reply}\n\nAction items for Nora (JSON array or []):` }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const text = response.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;

    const items = JSON.parse(match[0]);
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
      if (item.action && typeof item.action === 'string') {
        addTask({ action: item.action, detail: item.detail || '', assignee: item.assignee || '', due: item.due || '' });
      }
    }
  } catch (err) {
    console.error('Task extraction error:', err.message);
  }
}

// Tiny silent MP3 — cuts off any playing audio
async function silenceBot(botId) {
  try {
    await axios.post(
      `${RECALL_BASE}/bot/${botId}/output_audio/`,
      { kind: 'mp3', b64_data: 'SUQzAwAAAAAAJlRQRTEAAAAcAAAAU291bmRKYXkuY29tIFNvdW5kIEVmZmVjdHMA' },
      { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } }
    );
    console.log('🔇 Nora silenced');
  } catch (err) {
    console.error('Silence error:', err.message);
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

    console.log('🔊 Nora spoke');
  } catch (err) {
    const errData = err.response?.data;
    const errMsg = Buffer.isBuffer(errData) ? errData.toString('utf8') : errData;
    console.error('Voice error:', errMsg || err.message);
  }
}

app.listen(process.env.PORT, () => {
  console.log(`Nora server running on port ${process.env.PORT}`);
});