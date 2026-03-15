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
const PROJECTS_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-projects.json');
const PROJECTS_PATH_LOCAL = path.join(__dirname, 'nora-projects.json');

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

// Projects — same pattern as memory/tasks
function getProjectsPath() {
  if (fs.existsSync(VOLUME_DIR)) return PROJECTS_PATH_VOLUME;
  return PROJECTS_PATH_LOCAL;
}

function loadProjects() {
  try {
    return JSON.parse(fs.readFileSync(getProjectsPath(), 'utf8'));
  } catch { return []; }
}

function saveProjects(projects) {
  fs.writeFileSync(getProjectsPath(), JSON.stringify(projects, null, 2));
}

function addTask(task) {
  const tasks = loadTasks();
  const id = `nora-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  tasks.push({
    id,
    ...task,
    source_channel: task.source_channel || '',
    source_user: task.source_user || '',
    source_bot_id: task.source_bot_id || '',
    context: task.context || '',
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
  const projects = loadProjects();

  if (memory.length > 0 || projects.length > 0) {
    // Group memories by project
    const general = memory.filter(m => !m.project);
    const byProject = {};
    for (const m of memory) {
      if (m.project) {
        if (!byProject[m.project]) byProject[m.project] = [];
        byProject[m.project].push(m);
      }
    }

    let memoryBlock = '[Your memory]\n';

    if (general.length > 0) {
      memoryBlock += '\n## General\n' + general.map(m => `- ${m.fact}`).join('\n');
    }

    // Include project details + project-specific memories together
    const allProjectNames = new Set([...projects.map(p => p.name), ...Object.keys(byProject)]);
    for (const name of allProjectNames) {
      memoryBlock += `\n\n## ${name}`;
      const proj = projects.find(p => p.name === name);
      if (proj && proj.details) {
        memoryBlock += `\n${proj.details}`;
      }
      if (byProject[name]) {
        memoryBlock += '\n' + byProject[name].map(m => `- ${m.fact}`).join('\n');
      }
    }

    base = `${base}\n\n${memoryBlock}`;
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

app.get('/architecture', (req, res) => {
  res.sendFile(path.join(__dirname, 'architecture.html'));
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
  Response: [{ "fact": "string", "project": "string (empty if general)", "added": "YYYY-MM-DD", "source": "meeting|slack|manual|system", "source_bot_id": "Recall.ai bot ID if from a meeting (empty otherwise)" }]

- POST /memory                  — Add a new memory
  Body: { "fact": "string", "source": "string", "project": "string (optional)" }
  Response: { "ok": true, "memory": [...] }

- DELETE /memory/:index         — Remove memory by array index
  Response: { "ok": true, "memory": [...] }

- DELETE /memory                — Clear all memory
  Response: { "ok": true, "memory": [] }

### Projects
- GET  /projects                — Returns all projects
  Response: [{ "name": "string", "details": "string", "created": "ISO 8601" }]

- GET  /projects/:name          — Returns a project with its associated memories
  Response: { "name": "string", "details": "string", "created": "ISO 8601", "memories": [...] }

- POST /projects                — Create a new project
  Body: { "name": "string", "details": "string" }
  Response: { "ok": true, "project": {...} }

- PUT  /projects/:name          — Update a project's name or details
  Body: { "name": "string (optional)", "details": "string (optional)" }
  Response: { "ok": true, "project": {...} }

- DELETE /projects/:name        — Delete a project
  Response: { "ok": true }

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

- DELETE /transcripts/:botId    — Delete a transcript
  Response: { "ok": true }
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
  "source_bot_id": "Recall.ai bot ID if task came from a meeting (use to fetch full transcript via GET /transcripts/{bot_id})",
  "context": "Conversation snippet surrounding the task request — includes the trigger, Nora's reply, and recent utterances",
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
  "project": "Project name (empty string if general)",
  "added": "YYYY-MM-DD",
  "source": "meeting | slack | manual | system | auto",
  "source_bot_id": "Recall.ai bot ID linking to the meeting transcript this memory was extracted from (empty string if not from a meeting). Use GET /transcripts/{source_bot_id} to fetch the full transcript."
}

### Project Schema
{
  "name": "Project name",
  "details": "Free-text project details — stakeholders, timelines, context, etc.",
  "created": "ISO 8601 timestamp"
}

## Processing Pending Tasks

1. Fetch pending tasks:
   GET ${baseUrl}/tasks?status=pending

2. For each pending task, read the task's "context" field first — it contains the conversation snippet around when the task was requested. If the task has a "source_bot_id", you can fetch the full meeting transcript for deeper context:
   GET ${baseUrl}/transcripts/{source_bot_id}
   Use this to understand nuances like who should be invited, what tone to use, specific details mentioned in conversation, etc.

3. Determine the right action:
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
        transcript: { provider: { assembly_ai_v3_streaming: { speech_model: 'universal-streaming-english' } } },
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
    if (!sessions[activeBotId]) sessions[activeBotId] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, utterancesSinceEval: 0 };
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

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, utterancesSinceEval: 0 };
  const session = sessions[bot_id];

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  session.transcript.push({ speaker, text, timestamp: new Date().toISOString() });

  // Persist transcript incrementally so nothing is lost if the meeting ends abruptly
  try {
    const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
    const transcriptData = { bot_id, ended: null, transcript: session.transcript };
    fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify(transcriptData, null, 2));
  } catch (err) {
    console.error('Transcript incremental save error:', err.message);
  }

  const lower = text.toLowerCase().replace(/[,\.!\?]/g, '');

  // Stop/interrupt phrases — cut Nora off mid-speech
  if (lower.includes('stop nora') || lower.includes('nora stop') || lower.includes('hold on') || lower.includes('never mind') || lower.includes('nevermind')) {
    console.log('🛑 Stop phrase detected');
    if (session.abortController) session.abortController.abort();
    await silenceBot(bot_id);
    return;
  }

  // Wake word trigger — always respond
  if (lower.includes('hey nora') || lower.includes('nora ')) {
    if (session.abortController) {
      console.log('⏭️ Aborting previous response');
      session.abortController.abort();
      await silenceBot(bot_id);
    }
    console.log('🎙️ Nora triggered');
    await handleNora(bot_id, text, session);
    return;
  }

  // Proactive interjection — evaluate every 10 utterances if enabled
  if (session.proactive) {
    session.utterancesSinceEval++;
    if (session.utterancesSinceEval >= 10) {
      session.utterancesSinceEval = 0;
      evaluateInterjection(bot_id, session).catch(err => {
        console.error('Proactive eval error:', err.message);
      });
    }
  }
});

// Zoom chat trigger — type "@nora your question" in chat
app.post('/webhook/chat', async (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  const text = data?.chat_message?.text || '';
  if (!text.toLowerCase().startsWith('@nora')) return;

  const query = text.replace(/@nora/i, '').trim();
  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, utterancesSinceEval: 0 };
  await handleNora(bot_id, query, sessions[bot_id]);
});

// Proactive mode toggle — enable/disable Nora interjecting without wake word
app.get('/proactive', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.json({ proactive: false, active_session: false });
  res.json({ proactive: sessions[bot_id].proactive, bot_id });
});

app.post('/proactive', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.status(404).json({ error: 'No active meeting session' });
  const enabled = req.body.enabled !== undefined ? !!req.body.enabled : !sessions[bot_id].proactive;
  sessions[bot_id].proactive = enabled;
  sessions[bot_id].utterancesSinceEval = 0;
  console.log(`🧠 Proactive mode ${enabled ? 'enabled' : 'disabled'} for ${bot_id}`);
  res.json({ ok: true, proactive: enabled, bot_id });
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
  const { fact, source, project } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact is required' });
  const memory = loadMemory();
  memory.push({ fact, project: project || '', added: new Date().toISOString().split('T')[0], source: source || 'manual' });
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

// Projects API — manage project knowledge bases
app.get('/projects', (req, res) => res.json(loadProjects()));

app.get('/projects/:name', (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Include project-specific memories
  const memory = loadMemory();
  const projectMemories = memory.filter(m => m.project && m.project.toLowerCase() === req.params.name.toLowerCase());
  res.json({ ...project, memories: projectMemories });
});

app.post('/projects', (req, res) => {
  const { name, details } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const projects = loadProjects();
  const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Project already exists', project: existing });
  const project = { name, details: details || '', created: new Date().toISOString() };
  projects.push(project);
  saveProjects(projects);
  console.log('📁 Project added:', name);
  res.json({ ok: true, project });
});

app.put('/projects/:name', (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const { name, details } = req.body;
  if (name) projects[idx].name = name;
  if (details !== undefined) projects[idx].details = details;
  projects[idx].updated = new Date().toISOString();
  saveProjects(projects);
  console.log('📁 Project updated:', projects[idx].name);
  res.json({ ok: true, project: projects[idx] });
});

app.delete('/projects/:name', (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const removed = projects.splice(idx, 1);
  saveProjects(projects);
  console.log('📁 Project deleted:', removed[0].name);
  res.json({ ok: true });
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

app.delete('/transcripts/:botId', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  const filePath = path.join(dir, `transcript-${req.params.botId}.json`);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'transcript not found' });
    fs.unlinkSync(filePath);
    console.log('🗑️ Transcript deleted:', req.params.botId);
    res.json({ ok: true });
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

// Proactive interjection — evaluate whether Nora should speak up without being called
async function evaluateInterjection(botId, session) {
  // Don't evaluate if Nora is already speaking
  if (session.abortController) return;

  const recentBuffer = session.buffer.slice(-15).join('\n');
  const memory = loadMemory();
  const memoryBlock = memory.length > 0 ? memory.map(m => `- ${m.fact}`).join('\n') : 'No memories stored.';

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20241022',
      max_tokens: 200,
      system: `You are an evaluation function — not a conversational assistant. Your job is to decide if Nora, an AI PM assistant in a live meeting, should interject RIGHT NOW without being called upon.

You must respond with EXACTLY one of:
INTERJECT: <a short natural sentence Nora should say>
NO

Rules — you must say NO unless ALL of these are true:
1. Someone stated something factually wrong that Nora can correct using her memory below
2. OR a direct question was asked and went unanswered for multiple exchanges and Nora has the specific answer in her memory
3. OR a deadline, commitment, or conflict was mentioned that contradicts something in Nora's memory
4. There is a clear pause or opening in conversation (not mid-discussion)
5. Nora's interjection would be genuinely valuable — not just "helpful"

Say NO if:
- The conversation is flowing normally and people are handling things fine
- Someone might answer the question themselves in the next few exchanges
- Nora would just be agreeing, summarizing, or adding minor context
- The topic is social, off-topic, or not related to work Nora tracks
- You're even slightly unsure whether Nora should speak

Nora's memory:
${memoryBlock}`,
      messages: [{ role: 'user', content: `Here are the last 15 utterances from the meeting:\n\n${recentBuffer}\n\nShould Nora interject?` }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const result = response.data.content[0]?.text?.trim() || 'NO';
    console.log(`🧠 Proactive eval: ${result}`);

    if (result.startsWith('INTERJECT:')) {
      const interjection = result.replace('INTERJECT:', '').trim();
      console.log(`💡 Nora interjecting: ${interjection}`);
      // Use handleNora so it goes through the full pipeline (history, transcript, TTS)
      await handleNora(botId, `[Nora is proactively interjecting because she has relevant information] ${interjection}`, session);
    }
  } catch (err) {
    console.error('Proactive eval error:', err.message);
  }
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

    // Add Nora's reply to the transcript
    session.transcript.push({ speaker: 'Nora', text: fullReply, timestamp: new Date().toISOString() });
    try {
      const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
      fs.writeFileSync(path.join(dir, `transcript-${botId}.json`), JSON.stringify({ bot_id: botId, ended: null, transcript: session.transcript }, null, 2));
    } catch (err) {
      console.error('Transcript incremental save error:', err.message);
    }

    if (abortController.signal.aborted) return;
    await speakInMeeting(botId, fullReply);

    // Only extract if Nora gave a definitive response, not clarifying questions
    if (!isAskingClarification(fullReply)) {
      extractMemory(meetingContext, triggerText, fullReply, botId).catch(() => {});
      extractTasks(meetingContext, triggerText, fullReply, { channel: 'zoom', bot_id: botId }).catch(() => {});
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

async function extractMemory(context, trigger, reply, sourceBotId) {
  try {
    const projects = loadProjects();
    const projectNames = projects.map(p => p.name);
    const projectHint = projectNames.length > 0
      ? `\n\nKnown projects: ${projectNames.join(', ')}. If the fact relates to one of these projects, use that exact name. If it relates to a different project, use whatever name was mentioned. If it's general (not project-specific), use "".`
      : '\n\nIf the fact relates to a specific project, include the project name as mentioned in conversation. If it\'s general, use "".';

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: `You decide if something should be saved to Nora's long-term memory. ONLY save something if one of these is true: (1) someone explicitly asked Nora to remember something (e.g. "Nora remember that..." or "don't forget..."), or (2) Nora was asked to do a specific action item with a clear owner and deadline. That's it. Do NOT save general discussion, decisions, status updates, opinions, project details, or anything else — even if it seems useful. When in doubt, return []. Respond with a JSON array of objects with "fact" (string) and "project" (string — project name if relevant, empty string if general).${projectHint}`,
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

    const items = JSON.parse(match[0]);
    if (!Array.isArray(items) || items.length === 0) return;

    const memory = loadMemory();
    const existingFacts = new Set(memory.map(m => m.fact.toLowerCase()));
    let added = 0;
    for (const item of items) {
      // Support both old format (plain strings) and new format (objects with fact + project)
      const fact = typeof item === 'string' ? item : item.fact;
      const project = typeof item === 'string' ? '' : (item.project || '');
      if (typeof fact === 'string' && fact.trim() && !existingFacts.has(fact.toLowerCase())) {
        memory.push({ fact, project, added: new Date().toISOString().split('T')[0], source: sourceBotId ? 'meeting' : 'slack', source_bot_id: sourceBotId || '' });
        existingFacts.add(fact.toLowerCase());
        added++;
      }
    }
    if (added > 0) {
      saveMemory(memory);
      console.log(`🧠 Auto-saved ${added} memor${added === 1 ? 'y' : 'ies'}:`, items);
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

    // Build context snippet: the conversation around when the task was requested
    const contextSnippet = `${context}\n\n[Trigger]: ${trigger}\n[Nora replied]: ${reply}`;

    for (const item of items) {
      if (item.action && typeof item.action === 'string') {
        addTask({
          action: item.action,
          detail: item.detail || '',
          assignee: item.assignee || '',
          due: item.due || '',
          source_channel: source.channel || '',
          source_user: source.user || '',
          source_bot_id: source.bot_id || '',
          context: contextSnippet
        });
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