require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();

// Capture raw body for Slack signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

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
    source_channel: task.source_channel || '',
    source_user: task.source_user || '',
    status: 'pending',
    created: new Date().toISOString(),
    completed: null
  });
  saveTasks(tasks);
  console.log('📋 Task added:', id, task.action);
  return id;
}

initMemory();

function buildSystemPrompt(channel = 'zoom', transcript = null) {
  let base = loadPrompt();

  // Swap channel-specific framing
  if (channel === 'slack') {
    base = base.replace(
      'You are in a live Zoom meeting. Keep responses short — 2-3 sentences max. You are speaking out loud so no markdown, no bullet points, no lists. Natural spoken language only.',
      'You are responding in Slack. Keep responses concise but you can use markdown formatting, bullet points, and code blocks when helpful. A few sentences is ideal — don\'t write essays.'
    );
  }

  const memory = loadMemory();
  if (memory.length > 0) {
    const memoryBlock = memory.map(m => `- ${m.fact}`).join('\n');
    base = `${base}\n\n[Your memory]\n${memoryBlock}`;
  }

  // Inject live transcript context if available
  if (transcript && transcript.length > 0) {
    const recent = transcript.slice(-30);
    const transcriptBlock = recent.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
    base = `${base}\n\n[What's been discussed in this meeting so far]\n${transcriptBlock}`;
  }

  return base;
}

// Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Claude instructions page — serves prompt + API docs for scheduled Claude Code sessions
app.get('/instructions', (req, res) => {
  res.sendFile(path.join(__dirname, 'instructions.html'));
});

// Cowork instructions — plain text reference for scheduled Cowork tasks
app.get('/cowork-instructions', (req, res) => {
  const baseUrl = `https://${req.get('host')}`;
  res.type('text/plain').send(`# Nora — Cowork Instructions
# Generated: ${new Date().toISOString()}
# Base URL: ${baseUrl}

## What is Nora?
Nora is a voice-enabled AI project management assistant for LimeLight Marketing. She joins Zoom meetings via Recall.ai, listens to conversations, responds when triggered, and speaks back using ElevenLabs TTS. She also responds to Slack messages. She has persistent memory, a task queue, and saves full meeting transcripts. External agents (like Cowork scheduled tasks) process her task queue and analyze transcripts.

## Base URL
${baseUrl}

## API Endpoints

### Memory
- GET  /memory                  — Returns full memory array
  Response: [{ "fact": "string", "added": "YYYY-MM-DD", "source": "meeting|slack|manual|system" }]

- POST /memory                  — Add a new memory
  Body: { "fact": "string", "source": "string" }
  Response: { "ok": true, "memory": [...] }

- DELETE /memory/:index         — Remove memory by array index
  Response: { "ok": true, "memory": [...] }

- DELETE /memory                — Clear all memory
  Response: { "ok": true, "memory": [] }

### Tasks
- GET  /tasks                   — List all tasks. Filter: ?status=pending or ?status=done
  Response: [{ "id", "action", "detail", "assignee", "due", "source_channel", "source_user", "status", "created", "completed" }]

- POST /tasks                   — Add a task
  Body: { "action": "string", "detail": "string", "assignee": "string", "due": "string" }
  Response: { "ok": true, "id": "nora-..." }

- PATCH /tasks/:id/complete     — Mark task done (idempotent)
  Response: { "ok": true, "task": {...} }
  If already done: { "ok": true, "already": true, "task": {...} }

- DELETE /tasks/:id             — Delete a task
  Response: { "ok": true }

### Transcripts
- GET  /transcripts             — List all saved transcripts, newest first
  Response: [{ "bot_id", "ended", "file", "url", "utterance_count" }]

- GET  /transcripts/:botId      — Full transcript for a meeting
  Response: { "bot_id", "ended", "transcript": [{ "speaker", "text", "timestamp" }] }
  404 if not found.

### Notifications
- POST /notify                  — Post a message to Slack as Nora
  Body: { "channel": "C...", "text": "string" }  (or "user": "U..." for DMs)
  Optional: "blocks" (Block Kit), "file_url" + "file_name", "thread_ts"
  Response: { "ok": true, "channel": "...", "ts": "..." }

### Other
- GET  /                        — Dashboard web UI
- GET  /prompt                  — Nora's raw system prompt (text/plain)
- GET  /instructions            — Full HTML reference page
- POST /join                    — Send Nora to a Zoom meeting. Body: { "meeting_url": "..." }

## Schemas

### Task Schema
{
  "id": "nora-{timestamp}-{random}",
  "action": "What Nora was asked to do",
  "detail": "Specifics or context",
  "assignee": "Person it's for",
  "due": "Deadline if mentioned, otherwise empty",
  "source_channel": "slack:C0123... or zoom",
  "source_user": "U0123... (Slack user ID)",
  "status": "pending | done",
  "created": "ISO 8601 timestamp",
  "completed": "ISO 8601 timestamp or null"
}

### Transcript Schema
{
  "bot_id": "Recall.ai bot ID",
  "ended": "ISO 8601 timestamp",
  "transcript": [
    { "speaker": "Person Name", "text": "What they said", "timestamp": "ISO 8601" }
  ]
}

### Memory Schema
{
  "fact": "Short fact string",
  "added": "YYYY-MM-DD",
  "source": "meeting | slack | manual | system | auto"
}

## Processing Pending Tasks

1. Fetch pending tasks:
   GET ${baseUrl}/tasks?status=pending

2. For each pending task, determine the right action:
   - "Schedule a meeting..." → use Google Calendar MCP (gcal) to create event
   - "Send an email to..." → use Gmail MCP to draft/send
   - "Create a task in Teamwork..." → use Teamwork MCP (twprojects) to create task
   - "Send a Slack message..." → use Slack MCP to post message
   - "Remind [person] about..." → determine best channel and notify

3. Execute the action using the appropriate MCP tool.

4. Notify the requester that it's done:
   POST ${baseUrl}/notify
   {
     "channel": "C0123ABCDEF",  // from task.source_channel (strip "slack:" prefix)
     "text": "Done — scheduled the follow-up with Kyle for Tuesday at 2pm."
   }
   - If source_channel starts with "slack:", strip the prefix to get the channel ID.
   - If source_channel is "zoom", use task.source_user to DM them instead.

5. Mark the task as done:
   PATCH ${baseUrl}/tasks/{task_id}/complete

6. Optionally, add a memory about what was done:
   POST ${baseUrl}/memory
   { "fact": "Sent Q2 report to Brandee on 2026-03-14", "source": "auto" }

## Processing Transcripts

1. Check for new transcripts:
   GET ${baseUrl}/transcripts

2. For each transcript you haven't processed yet, fetch the full content:
   GET ${baseUrl}/transcripts/{bot_id}

3. Analyze the transcript for:
   - Action items and decisions not already captured as tasks
   - Key decisions that should be recorded as memories
   - Follow-ups that need scheduling

4. Create new tasks for any action items found:
   POST ${baseUrl}/tasks
   { "action": "...", "detail": "From meeting transcript", "assignee": "...", "due": "..." }

5. Post a meeting summary to Slack:
   POST ${baseUrl}/notify
   {
     "channel": "C0123ABCDEF",
     "text": "Meeting summary from [date]:\\n- Key decisions...\\n- Action items..."
   }

## Available MCP Integrations
- Teamwork (twprojects): Create/update tasks, milestones, projects, time logs
- Teamwork Desk (twdesk): Manage support tickets, customers, messages
- Google Calendar (gcal): Create/update events, find free time, check availability
- Gmail: Search messages, read threads, create drafts
- Slack: Send messages, search channels, read threads
`);
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
        transcript: { provider: { assembly_ai: {} } },
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

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null };
  const session = sessions[bot_id];

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  session.transcript.push({ speaker, text, timestamp: new Date().toISOString() });

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
  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null };
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
    // Persist transcript before cleaning up
    const session = sessions[bot_id];
    if (session && session.transcript && session.transcript.length > 0) {
      try {
        const transcriptData = {
          bot_id,
          ended: new Date().toISOString(),
          transcript: session.transcript
        };
        const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
        fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify(transcriptData, null, 2));
        console.log(`📝 Transcript saved: transcript-${bot_id}.json (${session.transcript.length} utterances)`);
      } catch (err) {
        console.error('Transcript save error:', err.message);
      }
    }
    delete sessions[bot_id];
    if (activeBotId === bot_id) activeBotId = null;
  }
});

// Slack webhook — @mentions and DMs
const slackSessions = {}; // channel/DM conversation history

function verifySlackSignature(req) {
  const sigSecret = process.env.SLACK_SIGNING_SECRET;
  if (!sigSecret) return true; // skip in dev if not set
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!timestamp || !sig) return false;
  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const basestring = `v0:${timestamp}:${req.rawBody}`;
  const hash = 'v0=' + crypto.createHmac('sha256', sigSecret).update(basestring).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
}

app.post('/webhook/slack', async (req, res) => {
  // URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify signature
  if (!verifySlackSignature(req)) {
    console.error('❌ Slack signature verification failed');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const event = req.body.event;
  if (!event) return;

  // Ignore bot messages (prevent loops)
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Handle app_mention and direct messages
  if (event.type !== 'app_mention' && event.type !== 'message') return;

  const text = event.text || '';
  const channel = event.channel;
  const user = event.user;
  const threadTs = event.thread_ts || event.ts; // reply in thread

  // Strip the @mention tag from the text
  const query = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!query) return;

  console.log(`💬 Slack [${event.type}] from ${user}: ${query}`);

  await handleSlack(channel, user, query, threadTs);
});

async function handleSlack(channel, user, text, threadTs) {
  try {
    // Per-channel conversation history
    if (!slackSessions[channel]) slackSessions[channel] = [];
    const history = slackSessions[channel];

    history.push({ role: 'user', content: `[Slack user <@${user}>]: ${text}` });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0.9,
        system: buildSystemPrompt('slack'),
        messages: history
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

    console.log('🤖 Nora (Slack):', reply);
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2);

    // Post reply to Slack
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: reply,
      thread_ts: threadTs
    }, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });

    // Only extract tasks/memory if Nora's reply isn't asking clarifying questions
    if (!isAskingClarification(reply)) {
      extractTasks(text, text, reply, { channel: `slack:${channel}`, user }).catch(() => {});
      extractMemory(text, text, reply).catch(() => {});
    } else {
      console.log('⏸️ Skipping extraction — Nora is asking clarifying questions');
    }
  } catch (err) {
    console.error('Slack handler error:', err.response?.data || err.message);
    // Try to post error message back
    try {
      await axios.post('https://slack.com/api/chat.postMessage', {
        channel,
        text: "Sorry, hit an error processing that. Check the logs.",
        thread_ts: threadTs
      }, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
    } catch {}
  }
}

// Notify endpoint — Claude Code calls this to have Nora post follow-ups
app.post('/notify', async (req, res) => {
  const { channel, user, text, blocks, file_url, file_name, thread_ts } = req.body;

  // Determine where to send — channel ID, or DM a user
  const target = channel || user;
  if (!target || !text) return res.status(400).json({ error: 'channel or user, and text are required' });

  try {
    // If DMing a user by Slack user ID, open a DM channel first
    let channelId = target;
    if (target.startsWith('U')) {
      const dmRes = await axios.post('https://slack.com/api/conversations.open', {
        users: target
      }, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      channelId = dmRes.data.channel?.id || target;
    }

    // Post the message
    const msgPayload = { channel: channelId, text };
    if (blocks) msgPayload.blocks = blocks;
    if (thread_ts) msgPayload.thread_ts = thread_ts;

    const msgRes = await axios.post('https://slack.com/api/chat.postMessage', msgPayload, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });

    // Upload a file if provided
    if (file_url && file_name) {
      // Download the file first
      const fileData = await axios.get(file_url, { responseType: 'arraybuffer' });
      const formData = new FormData();
      formData.append('channels', channelId);
      formData.append('filename', file_name);
      formData.append('title', file_name);
      formData.append('file', new Blob([fileData.data]), file_name);
      if (thread_ts) formData.append('thread_ts', thread_ts);

      await axios.post('https://slack.com/api/files.upload', formData, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
    }

    console.log('📤 Nora notified:', channelId, text.slice(0, 100));
    res.json({ ok: true, channel: channelId, ts: msgRes.data.ts });
  } catch (err) {
    console.error('Notify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
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

app.delete('/memory', (req, res) => {
  saveMemory([]);
  console.log('🧠 Memory cleared');
  res.json({ ok: true, memory: [] });
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

// Transcript API — list and retrieve saved meeting transcripts
app.get('/transcripts', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('transcript-') && f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          bot_id: data.bot_id,
          ended: data.ended,
          file: f,
          url: `/transcripts/${data.bot_id}`,
          utterance_count: data.transcript ? data.transcript.length : 0
        };
      } catch { return null; }
    }).filter(Boolean);
    // Sort newest first
    list.sort((a, b) => new Date(b.ended) - new Date(a.ended));
    res.json(list);
  } catch {
    res.json([]);
  }
});

app.get('/transcripts/:botId', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  const filePath = path.join(dir, `transcript-${req.params.botId}.json`);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'transcript not found' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect if Nora's reply is asking clarifying questions rather than confirming an action
function isAskingClarification(reply) {
  const lower = reply.toLowerCase();
  const clarifyPatterns = [
    /do you mean/,
    /which (one|project|client|competitor|team|person)/,
    /can you clarify/,
    /what (specifically|exactly|do you mean)/,
    /could you (be more specific|clarify|elaborate)/,
    /are you (referring to|talking about|looking for)/,
    /did you mean/,
    /just to clarify/,
    /before i (do that|get started|jump in|dig in|start)/,
    /a few questions/,
    /couple (of )?questions/,
    /first.{0,20}(need to know|need some clarity|want to understand)/,
    /what('s| is) the (scope|timeline|deadline|priority)/,
    /who('s| is| should) (the|be)/
  ];
  // Must end with a question mark or match clarification patterns
  const hasQuestion = reply.trim().endsWith('?');
  const matchesPattern = clarifyPatterns.some(p => p.test(lower));
  return hasQuestion && matchesPattern;
}

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
        system: buildSystemPrompt('zoom', session.transcript),
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

    // Only extract if Nora gave a definitive response, not clarifying questions
    if (!isAskingClarification(fullReply)) {
      extractMemory(meetingContext, triggerText, fullReply).catch(() => {});
      extractTasks(meetingContext, triggerText, fullReply, { channel: 'zoom' }).catch(() => {});
    } else {
      console.log('⏸️ Skipping extraction — Nora is asking clarifying questions');
    }
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

async function extractTasks(context, trigger, reply, source = {}) {
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
        addTask({ action: item.action, detail: item.detail || '', assignee: item.assignee || '', due: item.due || '', source_channel: source.channel || '', source_user: source.user || '' });
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