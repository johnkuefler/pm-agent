require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const app = express();
const server = http.createServer(app);

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
      'You are in a live meeting. Keep responses short — 2-3 sentences max. You are speaking out loud so no markdown, no bullet points, no lists. Natural spoken language only. You can be interrupted at any time — that\'s fine, conversations are like that.',
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

  // Inject recent tasks so Nora knows what she's been asked to do
  const tasks = loadTasks();
  if (tasks.length > 0) {
    const recentTasks = tasks.slice(-5);
    const tasksBlock = recentTasks.map(t => `- [${t.status}] ${t.action}${t.detail ? ': ' + t.detail : ''}${t.assignee ? ' (for ' + t.assignee + ')' : ''}`).join('\n');
    base = `${base}\n\n[Your recent tasks]\n${tasksBlock}`;
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
Nora is a voice-enabled AI project management assistant for LimeLight Marketing. She joins meetings via Recall.ai's Output Media feature, using OpenAI's Realtime API for real-time voice conversations. She also responds to Slack messages. She has persistent memory, a task queue, and saves full meeting transcripts. External agents (like Cowork scheduled tasks) process her task queue and analyze transcripts.

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
- Confluence: Search pages, read content, find project documentation
- Google Drive: Search files, read documents/sheets, find shared resources

## Processing Research Tasks

Some tasks will have action: "research". These are auto-created when Nora detected a knowledge gap in her response — she didn't have enough context to answer well. The goal is to fill that gap so she's prepared next time.

1. Identify research tasks:
   GET ${baseUrl}/tasks?status=pending
   Filter for tasks where action === "research"

2. Read the task's "detail" field — it describes what to research and may include search terms.
   Read the task's "context" field — it shows the conversation where the gap was detected.

3. Search for information using available MCP tools:
   - Confluence: Search for internal docs, project pages, process documentation, meeting notes
   - Google Drive: Search for shared docs, spreadsheets, presentations, project files
   - Gmail: Search for relevant email threads that might contain context
   - Slack: Search channel history for discussions about the topic

4. Synthesize findings into concise memory facts and save them:
   POST ${baseUrl}/memory
   { "fact": "Concise fact learned from research", "source": "auto", "project": "ProjectName" }

   Guidelines for research memories:
   - Keep each fact concise and specific (1-2 sentences)
   - Include concrete details: dates, names, numbers, decisions
   - Tag with the correct project name
   - Create multiple focused memories rather than one long one
   - Only save facts that are accurate and clearly stated in the source docs

5. Notify the original requester (if applicable):
   POST ${baseUrl}/notify
   Use the task's source_channel/source_user to let them know Nora has updated her knowledge.
   Example: "I've done some research on [topic] and updated my notes. Ask me again anytime!"

6. Mark the research task as done:
   PATCH ${baseUrl}/tasks/{task_id}/complete
`);
});

// Nora's system prompt as raw text (for Claude Code to fetch)
app.get('/prompt', (req, res) => {
  res.type('text/plain').send(loadPrompt());
});

// Voice agent webpage — served to Recall.ai bot's output_media browser
app.get('/voice-agent', (req, res) => {
  res.sendFile(path.join(__dirname, 'voice-agent.html'));
});

// Voice agent response callback — webpage POSTs Nora's transcribed responses here for extraction
app.post('/voice-agent/response', async (req, res) => {
  const { text, token } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // Validate session token and look up bot_id
  const bot_id = sessionTokens[token];
  if (!bot_id) {
    return res.status(401).json({ error: 'invalid session' });
  }

  res.json({ ok: true });

  // Add Nora's response to transcript
  const session = sessions[bot_id];
  if (session) {
    session.transcript.push({ speaker: 'Nora', text, timestamp: new Date().toISOString() });
    try {
      const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
      fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify({ bot_id, ended: null, transcript: session.transcript }, null, 2));
    } catch (err) {
      console.error('Transcript save error:', err.message);
    }

    // Build context from recent buffer
    const meetingContext = session.buffer.slice(-10).join('\n');
    const triggerText = session.buffer.slice(-3).join('\n'); // recent conversation that triggered the response

    // Run extraction pipelines (memory, tasks, research)
    if (!isAskingClarification(text)) {
      extractMemory(meetingContext, triggerText, text, bot_id).catch(() => {});
      extractTasks(meetingContext, triggerText, text, { channel: 'zoom', bot_id }).catch(() => {});
      extractResearchNeeds(meetingContext, triggerText, text, { channel: 'zoom', bot_id }).catch(() => {});
    }
  }
});

// Pending transcript utterances — keyed by bot_id:speaker, holds latest partial
// Recall streams partial transcripts (word by word). We only save when a new
// utterance starts (different speaker or new original_transcript_id) or after
// a debounce timeout.
const pendingUtterances = {};

// Transcript relay — voice agent webpage forwards Recall's transcript WS data here
app.post('/webhook/transcript-relay', (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  if (!bot_id || !data) return;

  const is_final = data.transcript?.is_final ?? data.is_final;
  const words = data.transcript?.words;
  const text = words?.map(w => w.text).join(' ') || data.transcript?.text;
  const speaker = data.transcript?.participant?.name || data.transcript?.speaker || 'Participant';
  const transcriptId = data.transcript?.original_transcript_id || data.original_transcript_id;
  if (!text) return;

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, oneOnOne: false, utterancesSinceEval: 0 };
  const session = sessions[bot_id];

  const key = `${bot_id}:${speaker}`;
  const pending = pendingUtterances[key];

  // If this is a continuation of the same utterance, update the pending text
  if (pending && (!transcriptId || pending.transcriptId === transcriptId)) {
    pending.text = text;
    pending.timestamp = new Date().toISOString();
    // Reset the debounce timer
    clearTimeout(pending.timer);
  } else {
    // New utterance or new speaker — flush the previous pending one
    if (pending) {
      clearTimeout(pending.timer);
      flushPendingUtterance(pending);
    }
    pendingUtterances[key] = {
      bot_id, speaker, text, transcriptId,
      timestamp: new Date().toISOString()
    };
  }

  // If Recall marked it final, flush immediately
  if (is_final) {
    clearTimeout(pendingUtterances[key]?.timer);
    flushPendingUtterance(pendingUtterances[key]);
    delete pendingUtterances[key];
    return;
  }

  // Otherwise debounce — flush after 2s of no updates
  pendingUtterances[key].timer = setTimeout(() => {
    const p = pendingUtterances[key];
    if (p) {
      flushPendingUtterance(p);
      delete pendingUtterances[key];
    }
  }, 2000);
});

function flushPendingUtterance(pending) {
  if (!pending || !pending.text) return;
  const { bot_id, speaker, text, timestamp } = pending;

  console.log(`[${speaker}]: ${text}`);

  const session = sessions[bot_id];
  if (!session) return;

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  session.transcript.push({ speaker, text, timestamp });

  // Persist
  try {
    const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
    fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify({ bot_id, ended: null, transcript: session.transcript }, null, 2));
  } catch (err) {
    console.error('Transcript save error:', err.message);
  }
}

// Session tokens for voice agent auth — maps token → botId
const sessionTokens = {};

// Join meeting via API — uses output_media for real-time voice agent
app.post('/join', async (req, res) => {
  try {
    const { meeting_url } = req.body;
    if (!meeting_url) return res.status(400).json({ error: 'meeting_url is required' });

    const SERVER_URL = `https://${req.get('host')}`;
    const WS_URL = `wss://${req.get('host')}`;

    // Generate a session token for this bot
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const voiceAgentUrl = `${SERVER_URL}/voice-agent?wss=${encodeURIComponent(WS_URL + '/ws/openai-relay')}&server=${encodeURIComponent(SERVER_URL)}&token=${sessionToken}`;

    const botRes = await axios.post(`${RECALL_BASE}/bot/`, {
      meeting_url,
      bot_name: 'Nora',
      output_media: {
        camera: {
          kind: 'webpage',
          config: {
            url: voiceAgentUrl
          }
        }
      },
      recording_config: {
        transcript: {
          provider: { assembly_ai_v3_streaming: { speech_model: 'universal-streaming-english' } }
        },
        include_bot_in_recording: { audio: true }
      },
      variant: {
        zoom: 'web_4_core',
        google_meet: 'web_4_core',
        microsoft_teams: 'web_4_core'
      },
      webhook_url: `${SERVER_URL}/webhook/status`
    }, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` }
    });

    const botId = botRes.data.id;
    activeBotId = botId;
    sessionTokens[sessionToken] = botId;

    if (!sessions[botId]) sessions[botId] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, oneOnOne: false, utterancesSinceEval: 0 };
    console.log('✅ Nora joined via output_media. Bot ID:', botId);
    res.json({ bot_id: botId });
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
  if (req.body.session_token && req.body.bot_id) {
    sessionTokens[req.body.session_token] = req.body.bot_id;
  }
  console.log('🤖 Registered bot:', activeBotId);
  res.json({ ok: true });
});

// Recall.ai sends transcript chunks here (kept for backward compatibility / webhook-based bots)
app.post('/webhook/transcript', async (req, res) => {
  res.sendStatus(200);

  const event = req.body;
  if (event.event !== 'transcript.data') return;

  const bot_id = event.data?.bot_id || event.bot_id || activeBotId;
  const words = event.data?.data?.words;
  const text = words?.map(w => w.text).join(' ') || event.data?.data?.text;
  const speaker = event.data?.data?.participant?.name || 'Participant';

  if (!text) return;
  console.log(`[${speaker}]: ${text}`);

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, oneOnOne: false, utterancesSinceEval: 0 };
  const session = sessions[bot_id];

  session.buffer.push(`${speaker}: ${text}`);
  if (session.buffer.length > 20) session.buffer.shift();

  session.transcript.push({ speaker, text, timestamp: new Date().toISOString() });

  // Persist transcript incrementally
  try {
    const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
    fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify({ bot_id, ended: null, transcript: session.transcript }, null, 2));
  } catch (err) {
    console.error('Transcript save error:', err.message);
  }
});

// Zoom chat trigger — type "@nora your question" in chat (kept for backward compatibility)
app.post('/webhook/chat', async (req, res) => {
  res.sendStatus(200);
  const { bot_id, data } = req.body;
  const text = data?.chat_message?.text || '';
  if (!text.toLowerCase().startsWith('@nora')) return;
  // Chat triggers are informational only with output_media — Nora handles voice directly
  console.log(`💬 Chat message received: ${text}`);
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

// One-on-one mode toggle — Nora responds to every utterance without wake word
app.get('/one-on-one', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.json({ oneOnOne: false, active_session: false });
  res.json({ oneOnOne: sessions[bot_id].oneOnOne, bot_id });
});

app.post('/one-on-one', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.status(404).json({ error: 'No active meeting session' });
  const enabled = req.body.enabled !== undefined ? !!req.body.enabled : !sessions[bot_id].oneOnOne;
  sessions[bot_id].oneOnOne = enabled;
  console.log(`💬 One-on-one mode ${enabled ? 'enabled' : 'disabled'} for ${bot_id}`);
  res.json({ ok: true, oneOnOne: enabled, bot_id });
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
      extractResearchNeeds(text, text, reply, { channel: `slack:${channel}`, user }).catch(() => {});
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

app.put('/memory/:index', (req, res) => {
  const memory = loadMemory();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= memory.length) return res.status(404).json({ error: 'index out of range' });
  const { fact, project } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact is required' });
  memory[idx].fact = fact;
  if (project !== undefined) memory[idx].project = project;
  saveMemory(memory);
  console.log('🧠 Memory updated:', fact);
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

app.put('/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const { action, detail, assignee, due } = req.body;
  if (action !== undefined) task.action = action;
  if (detail !== undefined) task.detail = detail;
  if (assignee !== undefined) task.assignee = assignee;
  if (due !== undefined) task.due = due;
  saveTasks(tasks);
  console.log('✏️ Task updated:', task.id, task.action);
  res.json({ ok: true, task });
});

// Transcript API — list and retrieve saved meeting transcripts
app.get('/transcripts', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('transcript-') && f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // Derive ended from last utterance if null (orphaned sessions)
        let ended = data.ended;
        if (!ended && data.transcript && data.transcript.length > 0) {
          ended = data.transcript[data.transcript.length - 1].timestamp || null;
        }
        return {
          bot_id: data.bot_id,
          ended,
          file: f,
          url: `/transcripts/${data.bot_id}`,
          utterance_count: data.transcript ? data.transcript.length : 0
        };
      } catch { return null; }
    }).filter(Boolean);
    // Sort newest first — null (in-progress) sorts to top
    list.sort((a, b) => (b.ended ? new Date(b.ended).getTime() : Infinity) - (a.ended ? new Date(a.ended).getTime() : Infinity));
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

app.put('/transcripts/:botId/utterances/:index', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  const filePath = path.join(dir, `transcript-${req.params.botId}.json`);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'transcript not found' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const idx = parseInt(req.params.index);
    if (idx < 0 || idx >= data.transcript.length) return res.status(404).json({ error: 'utterance index out of range' });
    const { speaker, text } = req.body;
    if (speaker !== undefined) data.transcript[idx].speaker = speaker;
    if (text !== undefined) data.transcript[idx].text = text;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log('✏️ Transcript utterance updated:', req.params.botId, 'index', idx);
    res.json({ ok: true, utterance: data.transcript[idx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/transcripts/:botId/utterances/:index', (req, res) => {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  const filePath = path.join(dir, `transcript-${req.params.botId}.json`);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'transcript not found' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const idx = parseInt(req.params.index);
    if (idx < 0 || idx >= data.transcript.length) return res.status(404).json({ error: 'utterance index out of range' });
    const removed = data.transcript.splice(idx, 1);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log('🗑️ Transcript utterance deleted:', req.params.botId, 'index', idx, removed[0].text.slice(0, 50));
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

// Note: Proactive interjection and handleNora are no longer needed for output_media.
// OpenAI Realtime handles the voice conversation directly in the bot's browser.
// The extraction pipelines are triggered via /voice-agent/response when OpenAI finishes a response.

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
        system: `You extract action items that Nora was explicitly asked to do. ONLY extract tasks where someone directly asked Nora to take an action — things like "Nora, schedule a meeting with...", "Nora, send Kyle an email about...", "Nora, remind me to...".

CRITICAL RULES:
- Extract exactly ONE task per request. Do not create multiple tasks from a single request.
- Extract the UNDERLYING action, not a meta-action. If someone says "create a Teamwork task for Aaron to update staging", the task is "Update staging environment" assigned to Aaron — NOT "Create a Teamwork task for Aaron". The task creation itself is just the delivery mechanism.
- IGNORE Nora's reply when extracting. Only look at what the user asked. Nora's reply is just confirmation — do not extract tasks from her words.
- Do NOT extract general discussion, suggestions Nora made, or things other people said they would do.

Return a JSON array of objects with: action (what to do), detail (specifics), assignee (who it's for), due (deadline if mentioned, otherwise ""). Return [] if no action items.`,
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

    // Deduplicate: ask Claude to check new tasks against existing pending tasks
    const existingTasks = loadTasks().filter(t => t.status === 'pending');
    let filteredItems = items.filter(i => i.action && typeof i.action === 'string');
    if (filteredItems.length > 0 && existingTasks.length > 0) {
      try {
        const existingList = existingTasks.map(t => `- ${t.action}${t.detail ? ' (' + t.detail + ')' : ''}`).join('\n');
        const newList = filteredItems.map((t, i) => `${i}: ${t.action}${t.detail ? ' (' + t.detail + ')' : ''}`).join('\n');
        const dedupRes = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            temperature: 0,
            system: `You check for duplicate tasks. Given a list of existing tasks and a list of new candidate tasks, return a JSON array of the indices (numbers) of new tasks that are NOT duplicates.

A task is a duplicate if:
- An existing task already covers the same action for the same person/purpose, even if worded differently
- A new task is a meta-version of an existing task (e.g. "create a task for Aaron to update staging" is a duplicate of "update staging environment" assigned to Aaron)
- Two new candidate tasks are duplicates of each other — only keep one

Be strict — if it's essentially the same request, it's a duplicate. Return only the indices of truly new tasks as a JSON array of numbers, e.g. [0, 2]. If all are duplicates, return [].`,
            messages: [{ role: 'user', content: `Existing pending tasks:\n${existingList}\n\nNew candidate tasks:\n${newList}\n\nIndices of non-duplicate new tasks (JSON array):` }]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            }
          }
        );
        const dedupText = dedupRes.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const dedupMatch = dedupText.match(/\[[\s\S]*?\]/);
        if (dedupMatch) {
          const keepIndices = JSON.parse(dedupMatch[0]);
          if (Array.isArray(keepIndices)) {
            const before = filteredItems.length;
            filteredItems = filteredItems.filter((_, i) => keepIndices.includes(i));
            if (filteredItems.length < before) {
              console.log(`🔍 Dedup: ${before - filteredItems.length} duplicate task(s) filtered out`);
            }
          }
        }
      } catch (dedupErr) {
        console.error('Task dedup check error (proceeding anyway):', dedupErr.message);
      }
    }

    // Build context snippet: the conversation around when the task was requested
    const contextSnippet = `${context}\n\n[Trigger]: ${trigger}\n[Nora replied]: ${reply}`;

    for (const item of filteredItems) {
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
  } catch (err) {
    console.error('Task extraction error:', err.message);
  }
}

async function extractResearchNeeds(context, trigger, reply, source = {}) {
  try {
    const memory = loadMemory();
    const projects = loadProjects();
    const memorySnapshot = memory.slice(-30).map(m => `- ${m.fact}${m.project ? ' [' + m.project + ']' : ''}`).join('\n');
    const projectList = projects.map(p => p.name).join(', ');

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: `You evaluate whether an AI assistant named Nora showed a knowledge gap in her response. Nora is a PM agent for a marketing agency. She has memory and project notes, but sometimes gets asked about things she doesn't have enough context on.

A knowledge gap means Nora's reply:
- Was vague, hedging, or clearly lacked specifics ("I'm not sure about...", "I don't have details on...", "you'd need to check...")
- Gave a generic answer when the question was about a specific project, client, or internal process
- Acknowledged she didn't have information
- Answered but was clearly missing key context that would exist in internal docs

Do NOT flag a gap if:
- Nora answered confidently with specific information
- The question was about scheduling, task creation, or reminders (those are actions, not knowledge)
- Nora was asked to do something, not asked about something
- The question was clearly hypothetical or opinion-based

If there IS a knowledge gap, return a JSON object: { "needed": true, "topic": "short description of what to research", "project": "project name if relevant, empty string otherwise", "search_terms": ["keyword1", "keyword2"] }

If there is NO gap, return: { "needed": false }`,
        messages: [{ role: 'user', content: `Nora's current memory (recent):\n${memorySnapshot || '(empty)'}\n\nKnown projects: ${projectList || '(none)'}\n\nConversation:\n${context}\n\nTrigger: ${trigger}\n\nNora's response: ${reply}\n\nDoes Nora's response show a knowledge gap?` }]
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
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    const result = JSON.parse(match[0]);
    if (!result.needed) return;

    const searchTerms = Array.isArray(result.search_terms) ? result.search_terms.join(', ') : '';
    addTask({
      action: 'research',
      detail: `Research: ${result.topic}. Search Confluence and Google Drive for relevant docs.${searchTerms ? ' Search terms: ' + searchTerms : ''}`,
      assignee: 'Nora',
      due: '',
      source_channel: source.channel || '',
      source_user: source.user || '',
      source_bot_id: source.bot_id || '',
      context: `${context}\n\n[Trigger]: ${trigger}\n[Nora replied]: ${reply}\n[Knowledge gap detected]: ${result.topic}`
    });
    console.log(`🔬 Research task created: ${result.topic}${result.project ? ' [' + result.project + ']' : ''}`);
  } catch (err) {
    console.error('Research extraction error:', err.message);
  }
}

// Note: silenceBot() and speakInMeeting() removed — output_media handles audio directly
// via the voice agent webpage and OpenAI Realtime API

// Backfill transcript files that have ended: null using last utterance timestamp
function backfillTranscriptDates() {
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('transcript-') && f.endsWith('.json'));
    let fixed = 0;
    for (const f of files) {
      try {
        const filePath = path.join(dir, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.ended && data.transcript && data.transcript.length > 0) {
          const lastUtterance = data.transcript[data.transcript.length - 1];
          const ts = lastUtterance.timestamp || lastUtterance.time;
          if (ts) {
            data.ended = ts;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            fixed++;
            console.log(`Backfilled ended timestamp for ${data.bot_id}: ${ts}`);
          }
        }
      } catch (err) {
        console.error(`Error backfilling ${f}:`, err.message);
      }
    }
    if (fixed > 0) console.log(`Backfilled ${fixed} transcript(s)`);
  } catch {}
}

// ---- WebSocket relay: proxies between voice agent webpage and OpenAI Realtime API ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `https://${request.headers.host}`);

  if (url.pathname === '/ws/openai-relay') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');

  // Validate session token and look up bot_id
  const botId = sessionTokens[token];
  if (!botId) {
    console.error('❌ WebSocket auth failed — invalid token');
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log(`🔌 Voice agent WebSocket connected for bot: ${botId}`);

  // Send bot_id to the webpage so it can use it for transcript relay
  ws.send(JSON.stringify({ type: 'nora.session', bot_id: botId }));

  // Build Nora's system prompt with memory and context
  const session = sessions[botId];
  const systemPrompt = buildSystemPrompt('zoom', session?.transcript);
  console.log(`📋 System prompt length: ${systemPrompt.length} chars`);

  // Connect to OpenAI Realtime API
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set');
    ws.close(4002, 'Server misconfigured');
    return;
  }

  let openaiWs;
  try {
    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
  } catch (err) {
    console.error('OpenAI WebSocket creation error:', err.message);
    ws.close(4003, 'Failed to connect to OpenAI');
    return;
  }

  const messageQueue = [];

  openaiWs.on('open', () => {
    console.log('🧠 Connected to OpenAI Realtime API');

    // Configure the session with Nora's personality and settings
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: systemPrompt,
        voice: 'sage',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700
        },
        temperature: 0.9,
        max_response_output_tokens: 1024
      }
    }));

    // Flush queued messages
    while (messageQueue.length) {
      const msg = messageQueue.shift();
      openaiWs.send(msg);
    }
  });

  // Relay: OpenAI → Browser
  let openaiEventCount = 0;
  openaiWs.on('message', (data) => {
    try {
      const str = data.toString();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(str);
      }

      const msg = JSON.parse(str);
      openaiEventCount++;

      // Log all non-audio events (audio.delta is too noisy)
      if (msg.type !== 'response.audio.delta') {
        console.log(`⬅️ OpenAI → Browser [${msg.type}]`);
      }

      // Log session.created and session.updated in detail to verify modalities
      if (msg.type === 'session.created' || msg.type === 'session.updated') {
        console.log(`🧠 Session config:`, JSON.stringify({
          modalities: msg.session?.modalities,
          voice: msg.session?.voice,
          model: msg.session?.model,
          input_audio_format: msg.session?.input_audio_format,
          output_audio_format: msg.session?.output_audio_format
        }));
      }

      // Log errors in detail
      if (msg.type === 'error') {
        console.error('❌ OpenAI error:', JSON.stringify(msg.error));
      }

      // Track response completions
      if (msg.type === 'response.done' && msg.response) {
        const outputs = msg.response.output || [];
        for (const item of outputs) {
          if (item.type === 'message' && item.role === 'assistant') {
            const transcript = item.content?.find(c => c.type === 'audio')?.transcript;
            if (transcript) {
              console.log('🤖 Nora (voice):', transcript.slice(0, 200));
            }
          }
        }
      }
    } catch (err) {
      console.error('OpenAI relay error:', err.message);
    }
  });

  // Relay: Browser → OpenAI
  let browserAudioChunks = 0;
  ws.on('message', (data) => {
    try {
      const str = data.toString();

      // Log non-audio events, count audio chunks
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === 'input_audio_buffer.append') {
          browserAudioChunks++;
          if (browserAudioChunks === 1 || browserAudioChunks % 50 === 0) {
            console.log(`➡️ Browser → OpenAI [input_audio_buffer.append] (chunk #${browserAudioChunks}, ~${parsed.audio?.length || 0} base64 chars)`);
          }
        } else {
          console.log(`➡️ Browser → OpenAI [${parsed.type}]`);
        }
      } catch {}

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(str);
      } else {
        messageQueue.push(str);
      }
    } catch (err) {
      console.error('Browser relay error:', err.message);
    }
  });

  // Periodically refresh Nora's instructions with latest memory
  const refreshInterval = setInterval(() => {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    const updatedPrompt = buildSystemPrompt('zoom', sessions[botId]?.transcript);
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: { instructions: updatedPrompt }
    }));
    console.log('🔄 Refreshed Nora instructions with latest memory');
  }, 5 * 60 * 1000); // every 5 minutes

  // Cleanup
  ws.on('close', () => {
    console.log(`🔌 Voice agent WebSocket closed for bot: ${botId}`);
    clearInterval(refreshInterval);
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
  });

  openaiWs.on('close', () => {
    console.log('🧠 OpenAI Realtime connection closed');
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WebSocket error:', err.message);
  });

  ws.on('error', (err) => {
    console.error('Client WebSocket error:', err.message);
  });
});

server.listen(process.env.PORT, () => {
  console.log(`Nora server running on port ${process.env.PORT}`);
  backfillTranscriptDates();
});