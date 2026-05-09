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

// Ensure a project record exists for a given name. Creates a stub if missing.
// Returns the canonical project name (existing record wins on case mismatch) so callers
// can normalize memory entries against the canonical casing.
function ensureProject(name) {
  if (!name || !name.trim()) return '';
  const trimmed = name.trim();
  const projects = loadProjects();
  const existing = projects.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.name;
  projects.push({
    name: trimmed,
    details: '',
    created: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    auto_created: true
  });
  saveProjects(projects);
  console.log('📁 Project auto-created from memory scoping:', trimmed);
  return trimmed;
}

// Bump a project's last_activity timestamp. No-op if project doesn't exist.
function bumpProjectActivity(name) {
  if (!name || !name.trim()) return;
  const projects = loadProjects();
  const proj = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!proj) return;
  proj.last_activity = new Date().toISOString();
  saveProjects(projects);
}

// Slack threads Nora has replied in. Used to keep conversations going without re-mention.
// Persisted so a deploy/restart doesn't drop active conversations.
//
// Each entry tracks: when joined, when Nora was last actively addressed/responded, and a
// counter of inbound messages since. Threads "go stale" once the counter or time gap exceeds
// thresholds — at which point Nora drops out and a re-mention is required to wake her back up.
const SLACK_THREADS_PATH_VOLUME = path.join(VOLUME_DIR, 'slack-threads.json');
const SLACK_THREADS_PATH_LOCAL = path.join(__dirname, 'slack-threads.json');
const SLACK_THREADS_CAP = 1000; // hard cap on tracked threads, oldest evicted
const THREAD_STALE_MSG_COUNT = 5; // messages since last addressed before going stale
const THREAD_STALE_AGE_MS = 30 * 60 * 1000; // 30 minutes since last addressed before going stale

function getSlackThreadsPath() {
  if (fs.existsSync(VOLUME_DIR)) return SLACK_THREADS_PATH_VOLUME;
  return SLACK_THREADS_PATH_LOCAL;
}

function loadSlackThreads() {
  try {
    const raw = JSON.parse(fs.readFileSync(getSlackThreadsPath(), 'utf8'));
    // Migrate legacy shape (string ISO → object)
    const migrated = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        migrated[k] = { joined_at: v, last_addressed: v, msgs_since_addressed: 0 };
      } else {
        migrated[k] = v;
      }
    }
    return migrated;
  } catch { return {}; }
}

function saveSlackThreads(threads) {
  fs.writeFileSync(getSlackThreadsPath(), JSON.stringify(threads, null, 2));
}

// In-memory cache of joined threads. Key format: `${channel}:${thread_ts}`
// DMs aren't tracked here — every DM message gets a response.
let slackJoinedThreads = loadSlackThreads();

// Called when Nora has either been directly addressed or has just responded in a thread.
// Resets the staleness counter so the conversation stays warm.
function markThreadJoined(channel, threadTs) {
  if (!channel || !threadTs) return;
  const key = `${channel}:${threadTs}`;
  const now = new Date().toISOString();
  const existing = slackJoinedThreads[key];
  slackJoinedThreads[key] = {
    joined_at: existing?.joined_at || now,
    last_addressed: now,
    msgs_since_addressed: 0
  };
  // Evict oldest if over cap
  const keys = Object.keys(slackJoinedThreads);
  if (keys.length > SLACK_THREADS_CAP) {
    const sorted = keys.sort((a, b) => slackJoinedThreads[a].last_addressed.localeCompare(slackJoinedThreads[b].last_addressed));
    const toEvict = keys.length - SLACK_THREADS_CAP;
    for (let i = 0; i < toEvict; i++) delete slackJoinedThreads[sorted[i]];
  }
  saveSlackThreads(slackJoinedThreads);
}

// Called when an inbound message arrives in a joined thread but Nora doesn't respond.
// Drives the staleness counter so eventually the thread cools off.
function recordThreadInbound(channel, threadTs) {
  if (!channel || !threadTs) return;
  const key = `${channel}:${threadTs}`;
  const entry = slackJoinedThreads[key];
  if (!entry) return;
  entry.msgs_since_addressed = (entry.msgs_since_addressed || 0) + 1;
  saveSlackThreads(slackJoinedThreads);
}

function isThreadJoined(channel, threadTs) {
  if (!channel || !threadTs) return false;
  return !!slackJoinedThreads[`${channel}:${threadTs}`];
}

// A thread is "stale" if Nora has gone too many messages or too long without being addressed.
// Stale threads require a re-mention to re-engage — protects against drift and side chatter.
function isThreadStale(channel, threadTs) {
  if (!channel || !threadTs) return false;
  const entry = slackJoinedThreads[`${channel}:${threadTs}`];
  if (!entry) return false;
  if ((entry.msgs_since_addressed || 0) >= THREAD_STALE_MSG_COUNT) return true;
  const ageMs = Date.now() - new Date(entry.last_addressed).getTime();
  if (ageMs > THREAD_STALE_AGE_MS) return true;
  return false;
}

function isThreadActive(channel, threadTs) {
  return isThreadJoined(channel, threadTs) && !isThreadStale(channel, threadTs);
}

// Channels where Nora is allowed to speak proactively (interject without being @mentioned)
// when she has substantive context to add. STRICT opt-in by channel — default everywhere is off.
// Unsolicited interjections are a fast trust-breaker, so this is gated on:
//   1. Channel must be in this allow-list (via POST /slack/proactive-channels/:channel)
//   2. A stricter Claude gate than thread-continuation runs every time
//   3. Per-channel cooldown after each successful proactive post
const SLACK_PROACTIVE_PATH_VOLUME = path.join(VOLUME_DIR, 'slack-proactive-channels.json');
const SLACK_PROACTIVE_PATH_LOCAL = path.join(__dirname, 'slack-proactive-channels.json');
const PROACTIVE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between proactive posts in the same channel

function getSlackProactivePath() {
  if (fs.existsSync(VOLUME_DIR)) return SLACK_PROACTIVE_PATH_VOLUME;
  return SLACK_PROACTIVE_PATH_LOCAL;
}

function loadSlackProactiveChannels() {
  try {
    return new Set(JSON.parse(fs.readFileSync(getSlackProactivePath(), 'utf8')));
  } catch { return new Set(); }
}

function saveSlackProactiveChannels(set) {
  fs.writeFileSync(getSlackProactivePath(), JSON.stringify([...set], null, 2));
}

let slackProactiveChannels = loadSlackProactiveChannels();
const slackProactiveCooldown = {}; // channel → ms timestamp of last proactive post (in-memory, resets on restart)

function isProactiveEnabled(channel) {
  return slackProactiveChannels.has(channel);
}

function isProactiveCooldownActive(channel) {
  const last = slackProactiveCooldown[channel];
  if (!last) return false;
  return (Date.now() - last) < PROACTIVE_COOLDOWN_MS;
}

function markProactivePost(channel) {
  slackProactiveCooldown[channel] = Date.now();
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
    source_thread_ts: task.source_thread_ts || '',
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

  // For realtime voice, use a compact version with capped memory
  const isRealtime = channel === 'realtime';
  const memoryCharBudget = isRealtime ? 3000 : Infinity;
  const maxTranscriptLines = isRealtime ? 10 : 30;

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
      const generalItems = isRealtime ? general.slice(-15) : general;
      memoryBlock += '\n## General\n' + generalItems.map(m => `- ${m.fact}`).join('\n');
    }

    // Include project details + project-specific memories together
    const allProjectNames = new Set([...projects.map(p => p.name), ...Object.keys(byProject)]);
    for (const name of allProjectNames) {
      if (isRealtime && memoryBlock.length >= memoryCharBudget) break;
      memoryBlock += `\n\n## ${name}`;
      const proj = projects.find(p => p.name === name);
      if (proj) {
        const meta = [];
        if (proj.client) meta.push(`client: ${proj.client}`);
        if (proj.status) meta.push(`status: ${proj.status}`);
        if (proj.pm) meta.push(`PM: ${proj.pm}`);
        if (proj.phase) meta.push(`phase: ${proj.phase}`);
        if (meta.length > 0) memoryBlock += `\n(${meta.join(' · ')})`;
        if (proj.details) {
          const details = isRealtime ? proj.details.slice(0, 300) : proj.details;
          memoryBlock += `\n${details}`;
        }
      }
      if (byProject[name]) {
        const items = isRealtime ? byProject[name].slice(-5) : byProject[name];
        memoryBlock += '\n' + items.map(m => `- ${m.fact}`).join('\n');
      }
    }

    if (isRealtime && memoryBlock.length > memoryCharBudget) {
      memoryBlock = memoryBlock.slice(0, memoryCharBudget) + '\n...';
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

  // Inject live transcript context if available (skip for realtime — the model already hears the audio)
  if (!isRealtime && transcript && transcript.length > 0) {
    const recent = transcript.slice(-maxTranscriptLines);
    const transcriptBlock = recent.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
    base = `${base}\n\n[What's been discussed in this meeting so far]\n${transcriptBlock}`;
  }

  // For realtime, add voice-specific guidance
  if (isRealtime) {
    base += '\n\nIMPORTANT: Always respond in English, regardless of what language someone speaks to you in.';
    base += '\n\nMEETING ETIQUETTE: You are often in meetings with multiple people. Only speak when directly addressed by name (\"Nora\") or when someone clearly asks you a question. If people are talking to each other, stay quiet and listen — do not interject. Wait for a clear pause directed at you before responding. If you\'re unsure whether someone was talking to you, stay silent.';
  }

  return base;
}

// Simple API key auth middleware — checks ?key= query param or Authorization: Bearer header
// Skips auth if NORA_API_KEY is not set (open access for local dev)
// Skips auth for same-origin browser requests (dashboard/instructions pages)
function requireAuth(req, res, next) {
  const apiKey = process.env.NORA_API_KEY;
  if (!apiKey) return next(); // no key configured = open access
  // Allow same-origin browser requests (from dashboard, instructions pages)
  if (req.headers['sec-fetch-site'] === 'same-origin') return next();
  const provided = req.query.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided === apiKey) return next();
  return res.status(401).json({ error: 'unauthorized — provide ?key= or Authorization: Bearer header' });
}

// Public routes (no auth) — dashboard, static pages, inbound webhooks
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
  res.type('text/plain').send(`# Nora — Cowork Instructions
# Generated: ${new Date().toISOString()}

## What is Nora?
Nora is a voice-enabled AI project management assistant for LimeLight Marketing. She joins meetings via Recall.ai's Output Media feature, using OpenAI's Realtime API for real-time voice conversations. She also responds to Slack messages. She has persistent memory, a task queue, and saves full meeting transcripts. External agents (like Cowork scheduled tasks) process her task queue and analyze transcripts.

## Authentication

The following endpoints require an API key: /memory, /projects, /tasks, /teamwork, /notify, /transcripts.
All other endpoints (dashboard, webhooks, join, mute, proactive, etc.) are open.

Pass the key as a query parameter or header:
- Query param: ?key=YOUR_NORA_API_KEY (append to any request URL)
- Header: Authorization: Bearer YOUR_NORA_API_KEY

Examples:
  GET /tasks?status=pending&key=YOUR_KEY
  GET /memory?key=YOUR_KEY
  GET /teamwork/tasks/12345/stage?stage=Done&key=YOUR_KEY
  POST /notify  (with header: Authorization: Bearer YOUR_KEY)

If NORA_API_KEY is not set in the environment, auth is disabled (open access for local dev).

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
  Response: [{ "name", "details", "created", "client?", "status?", "pm?", "phase?", "tags?",
                "last_activity?", "last_research_at?", "last_research_summary?", "auto_created?" }]

- GET  /projects/:name          — Returns a project with its associated memories + summary
  Response: { ...project, "memory_count": N, "last_memory_at": "YYYY-MM-DD", "memories": [...] }

- GET  /projects/coverage       — Bulk coverage view, sorted "most in need first".
  Drives the idle-time research loop — pick the first item, research it, touch it.
  By default skips:
    - archived/wrapped/completed projects
    - "Opportunity - " sales pipeline projects
    - LimeLight-internal projects (name starts with "LimeLight" or client is "LimeLight" /
      "LimeLight Marketing") — these are the agency's own work, not client engagements,
      and aren't the focus of proactive research
    - projects researched within the cooldown window (default 1 day)
  Query params:
    ?limit=20                 (max results)
    ?cooldown_days=1          (skip projects researched within N days)
    ?include_archived=true    (default false)
    ?include_opportunities=true  (default false)
    ?include_internal=true    (default false — include LimeLight-internal projects)
  Response: { "count": N, "cooldown_days": 1, "projects": [<coverage row>, ...] }

- GET  /projects/:name/coverage — Single-project coverage row.
  Response: { "name", "status", "memory_count", "last_memory_at", "days_since_last_memory",
              "details_length", "last_activity", "updated",
              "last_research_at", "days_since_last_research",
              "auto_created", "has_client", "has_status", "has_pm", "has_phase",
              "thinness_score" (lower = thinner; sort ascending to prioritize) }

- POST /projects/:name/research-touch — Mark a project as researched (after an idle round).
  Bumps last_research_at to now. Optional body: { "summary": "what you found / where" }.
  Cooldown filtering on /projects/coverage uses last_research_at to avoid re-picks.
  Response: { "ok": true, "project": {...} }

- POST /projects                — Create a new project. Optional fields are first-class.
  Body: { "name": "string (required)", "details": "string (optional)",
          "client": "string", "status": "string", "pm": "string",
          "phase": "string", "tags": ["string", ...] }
  Response: { "ok": true, "project": {...} }

- PUT  /projects/:name          — Update any project field. Same optional fields as POST.
  Body: { "name?", "details?", "client?", "status?", "pm?", "phase?", "tags?" }
  Setting any of details/client/status/pm/phase on an auto-created stub clears the auto_created flag.
  Response: { "ok": true, "project": {...} }

- DELETE /projects/:name        — Delete a project
  Response: { "ok": true }

Note: When you POST/PUT a memory with a "project" field that doesn't exist yet, the server now
auto-creates a stub project record (with auto_created: true) and normalizes the project name to
canonical casing. This means /memory and /projects can no longer drift out of sync — every
project-scoped memory has a corresponding project record. The cowork loop's daily "validate
project consistency" pass should now mostly find auto-created stubs that need details filled in
rather than orphaned references.

### Tasks
- GET  /tasks                   — List all tasks. Filter: ?status=pending or ?status=done
  Response: [{ "id", "action", "detail", "assignee", "due",
                "source_channel", "source_user", "source_thread_ts",
                "status", "created", "completed" }]

  Important: tasks queued from a Slack thread now include "source_thread_ts". When you
  notify the requester (POST /notify), pass that value as "thread_ts" so the resolution
  posts back into the original thread instead of as a fresh channel message. This is what
  makes the conversation feel continuous from the user's side: they ask Nora something live,
  she promises a follow-up, then the answer lands in the same thread within the hour.
  If "source_thread_ts" is empty (Zoom tasks, DMs), omit thread_ts and notify normally.

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
  Note: When this posts in a channel thread (not a DM), Nora is automatically marked
  as joined to that thread — meaning users can reply in-thread and reach her without
  having to @mention her again. See /slack/threads to inspect or prune.

### Slack Conversation State
Nora supports real back-and-forth conversations in Slack:
  - DMs: every message gets a reply (always).
  - Channel @mention: replies and joins the thread.
  - Thread follow-up (no re-mention): if Nora has replied in a thread and it hasn't gone
    stale, she keeps responding without re-mention. A thread "goes stale" after 5 messages
    where Nora wasn't directly addressed, or after 30 minutes since her last engagement.
    Stale threads require a re-mention to wake her up. Persisted across restarts.

Three spam guards layered on top of thread continuation:
  1. Auto-stale (above) — drops her out of long-drifted threads
  2. Heuristic skip — sub-4-char messages, emoji-only reactions, or messages mentioning
     someone other than Nora are dropped before any LLM cost
  3. Claude gate — a cheap Haiku call asks "is this directed at Nora?" on every thread
     continuation; defaults to "no" on uncertainty/error

For DMs and explicit @mentions, none of the spam guards apply — those always respond.

- GET  /slack/threads           — List threads Nora is currently joined to (newest first).
  Response: { "count": N, "active": N, "stale": N,
              "stale_thresholds": { "msg_count": 5, "age_minutes": 30 },
              "threads": [{ "channel", "thread_ts", "joined_at", "last_addressed",
                            "msgs_since_addressed", "stale" }] }

- DELETE /slack/threads/:channel/:ts — Untrack a thread so Nora stops auto-responding there.
  Use when she's been pulled into a thread that doesn't actually need her ongoing presence.
  Response: { "ok": true }

- POST /slack/threads/:channel/:ts — Manually mark a thread as joined WITHOUT posting.
  Use when /slack/unhandled-mentions surfaces something cowork deliberately wants to skip
  (cold outreach, automated cross-post, etc.) — calling this suppresses the mention from
  future unhandled-mentions calls without sending a response.
  Response: { "ok": true, "joined": { "channel", "thread_ts" } }

### Proactive Channel Speaking (opt-in)
Nora can speak proactively in specific channels without being @mentioned, when her live
handler's stricter Claude gate decides she has substantive context to add. STRICT opt-in
by channel — default everywhere is off, because unsolicited interjections are a fast
trust-breaker.

When proactive is enabled for a channel:
  - Every non-mention, non-thread message in that channel runs through a stricter Claude
    gate than the thread-continuation one (defaults harder to "no", looks for SPECIFIC
    facts Nora can contribute, not generic helpfulness).
  - The model gets a final chance to abort at generation time by returning empty.
  - After a successful proactive post, the channel is cooled down for 30 minutes — Nora
    won't chime in again until then, even if the gate would otherwise pass.

- GET  /slack/proactive-channels — List channels with proactive speaking enabled, plus
  current cooldown status per channel.
  Response: { "count", "cooldown_minutes", "channels": [{ "channel", "cooldown_active",
              "last_proactive_post" }] }

- POST /slack/proactive-channels/:channel — Enable proactive speaking in a channel.
  Response: { "ok": true, "channel", "enabled": true }

- DELETE /slack/proactive-channels/:channel — Disable proactive speaking and clear cooldown.
  Response: { "ok": true, "channel", "enabled": false }

- GET  /slack/unhandled-mentions — Find @mentions of the Nora bot that the live handler
  missed (server restart, signature failure, subscription gap, etc.). Uses the BOT'S
  point of view via SLACK_BOT_TOKEN, not the user account's — important because the
  user account cowork is connected to may not be a member of every channel the bot is
  in, so slack_search_public_and_private would falsely report "0 unhandled."
  Filters out:
    - Channels where the bot isn't a member
    - DMs (those go through the live handler reliably)
    - Bot-authored messages and message subtype edits
    - Mentions whose thread is already in /slack/threads (the bot already responded)
  Query params:
    ?minutes=120                (look back N minutes, default 120)
  Response: { "bot_user_id", "since_minutes", "channels_scanned", "channels_total",
              "scan_errors", "unhandled_count",
              "unhandled": [{ "channel", "channel_name", "is_private", "ts",
                               "thread_ts", "user", "text", "permalink_path" }] }
  Use this in cowork's Slack safety-net step instead of slack_search_public_and_private.
  Once cowork responds via /notify (with thread_ts = ts or thread_ts), the thread gets
  auto-marked joined and the same mention won't reappear on the next run.

Slack app config requirement: For thread continuation in channels to work, the Slack app
must subscribe to message.channels (and message.groups for private channels) — not just
app_mention. Without those subscriptions, Slack only delivers @mention events and Nora
won't see follow-ups in threads she's joined.

### Other
- GET  /                        — Dashboard web UI
- GET  /prompt                  — Nora's raw system prompt (text/plain)
- GET  /instructions            — Full HTML reference page
- POST /join                    — Send Nora to a Zoom meeting. Body: { "meeting_url": "..." }

### Teamwork Integration
- GET  /teamwork/tasks/:taskId/stage?stage=In+Progress — Move a Teamwork task to a different workflow stage
  Query param: stage (required, case-insensitive)
  The taskId is the Teamwork task ID (numeric). Stage name matching is case-insensitive.
  Automatically looks up the task's project, finds the workflow, and moves the task to the matching stage.
  Use this instead of Teamwork MCP for stage/board column changes — the MCP does not support workflow operations.
  Response: { "ok": true, "taskId": "...", "stage": "...", "workflowId": ..., "stageId": ... }
  Returns 404 if stage name not found in any workflow for the task's project.

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
  "source_thread_ts": "Slack thread timestamp if task originated in a channel thread (empty for DMs/Zoom). Pass as thread_ts to /notify so the resolution lands in the original thread.",
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
  "name": "Project name (canonical casing — referenced by memories)",
  "details": "Free-text project details — stakeholders, timelines, context, etc.",
  "created": "ISO 8601 timestamp",
  "updated": "ISO 8601 timestamp (set on PUT)",
  "last_activity": "ISO 8601 timestamp (auto-bumped when a memory references this project)",
  "client": "Client name (optional)",
  "status": "active | on-hold | wrapped | archived (optional, free-form)",
  "pm": "Project manager name (optional)",
  "phase": "discovery | design | build | launch | post-launch (optional, free-form)",
  "tags": ["optional", "string", "array"],
  "auto_created": "true if the record was created as a stub when a memory referenced an unknown project (clear by PUT'ing details/client/status/pm/phase)",
  "last_research_at": "ISO 8601 timestamp of the most recent idle-round research touch (set by POST /projects/:name/research-touch)",
  "last_research_summary": "Optional free-text summary of the most recent research round"
}

## Processing Pending Tasks

1. Fetch pending tasks:
   GET /tasks?status=pending

2. For each pending task, read the task's "context" field first — it contains the conversation snippet around when the task was requested. If the task has a "source_bot_id", you can fetch the full meeting transcript for deeper context:
   GET /transcripts/{source_bot_id}
   Use this to understand nuances like who should be invited, what tone to use, specific details mentioned in conversation, etc.

3. Determine the right action and execute it using the appropriate MCP tool:
   - "Schedule a meeting..." → use Google Calendar MCP (gcal) to create event
   - "Send an email to..." → use Gmail MCP to draft/send
   - "Create a task in Teamwork..." → use Teamwork MCP (twprojects) to create task
   - "Send a Slack message..." → use Slack MCP to post message
   - "Remind [person] about..." → determine best channel and notify
   - Stage/workflow changes → use GET /teamwork/tasks/:taskId/stage (the Teamwork MCP can't do stages)

4. Notify the requester that it's done:
   POST /notify
   {
     "channel": "C0123ABCDEF",  // from task.source_channel (strip "slack:" prefix)
     "text": "Done — scheduled the follow-up with Kyle for Tuesday at 2pm.",
     "thread_ts": "1710432000.000100"  // pass task.source_thread_ts when present
   }
   - If source_channel starts with "slack:", strip the prefix to get the channel ID.
   - If source_channel is "zoom", use task.source_user to DM them instead.
   - If task.source_thread_ts is non-empty, ALWAYS pass it as thread_ts so your reply
     lands in the same thread where the conversation started. This is what makes Nora
     feel responsive: a user asks her live, she promises a follow-up, the answer arrives
     in-thread within the hour. Skipping thread_ts breaks that experience.

5. Mark the task as done:
   PATCH /tasks/{task_id}/complete

6. Optionally, add a memory about what was done:
   POST /memory
   { "fact": "Sent Q2 report to Brandee on 2026-03-14", "source": "auto" }

## Processing Transcripts

1. Check for new transcripts:
   GET /transcripts

2. For each transcript you haven't processed yet, fetch the full content:
   GET /transcripts/{bot_id}

3. Analyze the transcript for:
   - Action items and decisions not already captured as tasks
   - Key decisions that should be recorded as memories
   - Follow-ups that need scheduling

4. Create new tasks for any action items found:
   POST /tasks
   { "action": "...", "detail": "From meeting transcript", "assignee": "...", "due": "..." }

5. Post a meeting summary to Slack:
   POST /notify
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
- LimeLight PM MCP: Forecasts, estimates, and project profitability — see below

## LimeLight PM MCP Overview

Three internal LimeLight apps wrapped behind a single connector. Use REACTIVELY only —
invoke when a queued task or live request explicitly asks for it. Don't run profitability
or forecast scans proactively (that's exactly the kind of repetitive margin noise that
trains people to ignore Nora). Tool descriptions inside the MCP itself spell out
parameters and safety guidance — read those when calling rather than memorizing here.

Three modules:

- **Profitability** (read-only): agency-wide KPIs, project health, at-risk projects,
  client portfolio rollups, team utilization, retainer list and per-retainer utilization,
  over-service report, agency rate history. Backed by the Teamwork Dashboard. Use when
  someone asks "is X at risk?", "what's our utilization?", "how's the retainer for Y
  tracking?", etc. All output is subject to Rule 2 — strip dollar figures unless the
  recipient is on the financial-info approved list.

- **Estimates** (read + DRAFT-only writes): read estimates, line items, SOW summaries;
  search past estimates by keyword; list recent and templates; create draft estimates or
  clone an existing estimate to draft. Writes never finalize, send, or approve — they
  always return a review URL that a human reviews before anything goes out. Use when
  someone asks Nora to "draft an estimate for X based on Y" or "what did we charge for
  similar work last year?". Always include the returned review URL in the notify back
  to the requester.

- **Forecast** (read + writes): read full forecast overview / months / resources /
  settings; write tools to add or update months, add/update/remove resources, set target
  margin, clone a month forward. Use when someone asks Nora to adjust the forecast (e.g.,
  "add Aaron at 20 hrs/week to the May forecast", "set the target margin to 35% for Q2",
  "clone May to June"). Month deletion is intentionally not exposed.

Three cross-cutting workflows:

- pm_morning_brief: a single-call rollup of at-risk projects, current-month over-service,
  active retainers, stale draft estimates (>7 days), and current-month forecast vs target.
  Available if asked, but DON'T run it on every hourly run — that turns into noise.

- reconcile_estimate_to_actuals: takes estimate_id + project_id, returns a delta with an
  on_track boolean. Use when someone asks "is X tracking to estimate?". Save the
  qualitative result (without dollar amounts) as a memory so it's available for future
  context.

- portfolio_pricing_benchmark: keyword search across past estimates with status breakdown
  and dollar stats. Use when drafting a new estimate to find pricing precedent.

### Critical guardrails for this MCP

- **Write tools fire only on explicit request.** The MCP's tool descriptions assume
  Claude can confirm with a live user before calling — cowork is async, no live user,
  so the queued task IS the confirmation. Never adjust a forecast or draft an estimate
  because something "looked off" during a passive scan.
- **Always surface review URLs and IDs returned by writes** in the notify back to the
  requester so they can verify before any human approval/send.
- **Rule 2 still binds.** Cowork can pull margin data via the read tools, but the
  response strips dollar figures unless the recipient is on the financial-info approved
  list (Mallory/Gracie/Kinsey/John/Andy/Brandee). For others, describe the work
  qualitatively ("Pitsco is currently flagged at-risk") without numbers.

## Processing Research Tasks

Some tasks will have action: "research". These are auto-created when Nora detected a knowledge gap in her response — she didn't have enough context to answer well. The goal is to fill that gap so she's prepared next time.

1. Identify research tasks:
   GET /tasks?status=pending
   Filter for tasks where action === "research"

2. Read the task's "detail" field — it describes what to research and may include search terms.
   Read the task's "context" field — it shows the conversation where the gap was detected.

3. Search for information using available MCP tools:
   - Confluence: Search for internal docs, project pages, process documentation, meeting notes
   - Google Drive: Search for shared docs, spreadsheets, presentations, project files
   - Gmail: Search for relevant email threads that might contain context
   - Slack: Search channel history for discussions about the topic

4. Synthesize findings into concise memory facts and save them:
   POST /memory
   { "fact": "Concise fact learned from research", "source": "auto", "project": "ProjectName" }

   Guidelines for research memories:
   - Keep each fact concise and specific (1-2 sentences)
   - Include concrete details: dates, names, numbers, decisions
   - Tag with the correct project name
   - Create multiple focused memories rather than one long one
   - Only save facts that are accurate and clearly stated in the source docs

5. Notify the original requester (if applicable):
   POST /notify
   Use the task's source_channel/source_user to let them know Nora has updated her knowledge.
   If task.source_thread_ts is set, pass it as thread_ts so the reply lands in-thread.
   Example: "I've done some research on [topic] and updated my notes. Ask me again anytime!"

6. Mark the research task as done:
   PATCH /tasks/{task_id}/complete

## Idle Knowledge Round

Nora's hourly run shouldn't end with "nothing to do." When the rest of the run was quiet
— no pending tasks worth processing, no relevant emails, no Slack to handle, no follow-ups
due — spend the idle time deepening Nora's knowledge on a single project. Over time this
turns "I don't have specifics on Pitsco" into "Pitsco's launch is May 14, blocked on QA."

Run this AT MOST once per hourly run. ONE project per round. 3–5 memories max.
Skip if the run has already done substantive work — it's only for genuinely idle hours.

The round leads with Teamwork because Teamwork is the source of truth for what LimeLight
is actively working on. Nora's local /projects store is just whatever has been mentioned
in conversations or manually added — entire active projects may be missing. Reconciling
against Teamwork first ensures the biggest knowledge gaps (whole projects Nora doesn't
know about) get prioritized over deepening already-known projects.

1. Pull active Teamwork projects:
   Use the Teamwork MCP — twprojects-list_projects (filter for active, not archived/deleted).
   Skip anything starting with "Opportunity - " (sales pipeline, not Nora's concern) and
   anything that's clearly LimeLight-internal work (name starts with "LimeLight" or the
   project is for LimeLight as the client, e.g. internal tooling, agency website,
   internal HR/ops projects). Nora's research focus is client engagements, not internal
   agency operations.

2. Reconcile against Nora's project store:
   GET /projects
   For each active Teamwork project:
   - If Nora doesn't have a record at all → POST /projects with name, client, status: "active",
     pm (from Teamwork project members or owner), and a brief details line from Teamwork's
     project description. This fills the biggest gaps first.
   - If Nora's record has auto_created: true → PUT /projects/:name with the metadata from
     Teamwork to promote the stub. Setting any of details/client/status/pm/phase clears the
     auto_created flag automatically.
   - If a Nora project is no longer active in Teamwork (status archived/deleted there) →
     consider PUT /projects/:name { "status": "wrapped" } so /projects/coverage stops
     surfacing it for future research rounds.

3. Pick a research target:
   GET /projects/coverage?limit=5
   The list is pre-sorted "most in need first" and excludes archived/wrapped/completed
   projects, "Opportunity - " sales pipeline, and projects researched in the last day.
   After step 2's reconciliation, newly-created records will rank near the top because
   they're brand-new with zero memories. If the list is empty, skip the rest of the round.

4. Pull what Nora already knows about the target:
   GET /projects/{name}  (returns project record + all scoped memories)
   This is your "what's already covered" baseline — don't add memories that duplicate it.

5. Research, leading with Teamwork:
   - twprojects-get_project — official description, dates, members, owner
   - twprojects-list_tasks (filter to this project) — active work, blockers, recent activity
   - twprojects-list_milestones — upcoming deliverables and deadlines
   - twprojects-list_comments_by_task on key tasks — actual conversation context

   Then supplement with sources Teamwork doesn't capture:
   - Confluence "LLM Client Space": client briefs, project briefs, campaign briefs, process docs
   - Google Drive: project deliverables, decks, specs (leave $ amounts out of memory entries
     since they may surface in future Slack replies to non-approved recipients)
   - Gmail: recent threads (last 30 days) mentioning the project name
   - Slack: recent channel activity if the project has a known channel

6. Synthesize 3–5 concise project-scoped memories:
   POST /memory
   { "fact": "Pitsco launch target is May 14 per Q2 plan deck (last updated by Andy 2026-04-22).",
     "source": "auto",
     "project": "Pitsco" }

   Guidelines:
   - Each fact: 1–2 sentences, concrete (names, dates, decisions, blockers, status)
   - Don't restate what's already in project.details or existing memories
   - Don't synthesize speculation — if a doc says "we may launch in May," save that hedge,
     don't promote it to "launching in May"
   - Prefer current state from Teamwork over older docs from Drive/Confluence when they conflict
   - Skip the round if you can't find 3 substantive facts. Don't pad.

7. Mark the project as researched:
   POST /projects/{name}/research-touch
   { "summary": "Reconciled from Teamwork + deepened with Confluence brief + recent task comments" }
   This bumps last_research_at and prevents re-picking the same project tomorrow.

8. (Optional) Save a one-line general memory recording that the round happened:
   POST /memory
   { "fact": "Idle research round on Pitsco on 2026-05-09: added 4 memories (sources: Teamwork tasks/milestones, Confluence brief)",
     "source": "auto" }

Guardrails:
- The cooldown_days filter on /projects/coverage already prevents re-picking the same
  project tomorrow. You don't need to track this yourself — trust the API's sort.
- The Teamwork reconciliation in step 2 is the most valuable side effect of this round —
  even if you don't proceed to deep research, just reconciling new active projects into
  Nora's store is a meaningful improvement. If you reconcile but find no good research
  target, that's still a successful round.
- Don't include this round in the end-of-run summary unless something noteworthy was
  discovered (e.g., "Found Pitsco launch slipped to May 14 — not previously in memory"
  or "Reconciled 2 new Teamwork projects into Nora's store").
- Never run this round on a project the user has flagged "do not touch" (check memory
  for any "skip Nora research on X" entries before picking).
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
        realtime_endpoints: [
          {
            type: 'webhook',
            url: `${SERVER_URL}/webhook/transcript`,
            events: ['transcript.data']
          },
          {
            type: 'webhook',
            url: `${SERVER_URL}/webhook/chat`,
            events: ['participant_events.chat_message']
          }
        ],
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

    if (!sessions[botId]) sessions[botId] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, oneOnOne: false, muted: false, utterancesSinceEval: 0 };
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

// Recall.ai sends speaker-identified transcript chunks here (primary transcript path)
app.post('/webhook/transcript', async (req, res) => {
  res.sendStatus(200);

  const event = req.body;
  if (event.event !== 'transcript.data') return;

  const bot_id = event.data?.bot?.id || event.data?.bot_id || event.bot_id || activeBotId;
  const words = event.data?.data?.words;
  const text = words?.map(w => w.text).join(' ') || event.data?.data?.text;
  const speaker = event.data?.data?.participant?.name || 'Participant';

  if (!text) return;
  console.log(`[${speaker}]: ${text}`);

  if (!sessions[bot_id]) sessions[bot_id] = { history: [], buffer: [], transcript: [], abortController: null, convModeTimer: null, proactive: false, oneOnOne: false, muted: false, utterancesSinceEval: 0 };
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

// Zoom chat trigger — type "@nora your question" in chat, Nora replies via chat
const chatSessions = {}; // bot_id → conversation history for chat context

app.post('/webhook/chat', async (req, res) => {
  res.sendStatus(200);

  // Recall.ai participant_events.chat_message payload
  const eventType = req.body?.event;
  const eventData = req.body?.data?.data;

  if (eventType !== 'participant_events.chat_message') return;

  const participant = eventData?.participant;
  const chatData = eventData?.data;
  const text = chatData?.text || '';
  const speaker = participant?.name || 'Unknown';

  // Also try legacy format for backward compatibility
  const legacyText = req.body?.data?.chat_message?.text;
  const finalText = text || legacyText || '';

  if (!finalText) return;

  // Determine bot_id from the webhook payload
  const bot_id = req.body?.data?.bot?.id;
  if (!bot_id) {
    console.log(`💬 Chat (no bot_id): [${speaker}]: ${finalText}`);
    return;
  }

  console.log(`💬 Zoom chat [${speaker}]: ${finalText}`);

  // Add to transcript if session exists
  const session = sessions[bot_id];
  if (session) {
    session.transcript.push({ speaker: `${speaker} (chat)`, text: finalText, timestamp: new Date().toISOString() });
    session.buffer.push(`${speaker} (chat): ${finalText}`);
    if (session.buffer.length > 20) session.buffer.shift();
  }

  // Only respond if message contains @nora (case-insensitive)
  if (!finalText.toLowerCase().includes('@nora') && !finalText.toLowerCase().includes('nora')) return;

  // Strip "@nora" or "nora" from the beginning and clean up
  const query = finalText.replace(/@?nora/gi, '').trim();
  if (!query) return;

  console.log(`💬 Chat trigger from ${speaker}: ${query}`);

  try {
    // Maintain per-bot chat conversation history
    if (!chatSessions[bot_id]) chatSessions[bot_id] = [];
    const history = chatSessions[bot_id];

    history.push({ role: 'user', content: `[${speaker} via Zoom chat]: ${query}` });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0.9,
        system: buildSystemPrompt('slack'), // use slack-style formatting (markdown ok, concise)
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

    console.log('🤖 Nora (chat):', reply);
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2);

    // Send reply back to Zoom chat via Recall.ai
    await axios.post(
      `${RECALL_BASE}/bot/${bot_id}/send_chat_message/`,
      { message: reply },
      { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } }
    );

    // Add Nora's chat reply to transcript
    if (session) {
      session.transcript.push({ speaker: 'Nora (chat)', text: reply, timestamp: new Date().toISOString() });
      try {
        const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
        fs.writeFileSync(path.join(dir, `transcript-${bot_id}.json`), JSON.stringify({ bot_id, ended: null, transcript: session.transcript }, null, 2));
      } catch (err) {
        console.error('Transcript save error:', err.message);
      }
    }

    // Extract tasks/memory from chat interaction
    const meetingContext = session ? session.buffer.slice(-10).join('\n') : query;
    if (!isAskingClarification(reply)) {
      extractTasks(meetingContext, query, reply, { channel: 'zoom', bot_id }).catch(() => {});
      extractMemory(meetingContext, query, reply, bot_id).catch(() => {});
      extractResearchNeeds(meetingContext, query, reply, { channel: 'zoom', bot_id }).catch(() => {});
    }
  } catch (err) {
    console.error('Chat response error:', err.response?.data || err.message);
    // Try to send error message back to chat
    try {
      await axios.post(
        `${RECALL_BASE}/bot/${bot_id}/send_chat_message/`,
        { message: "Sorry, I hit an error processing that." },
        { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } }
      );
    } catch {}
  }
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

// Mute mode toggle — Nora listens and captures action items but does not speak
app.get('/mute', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.json({ muted: false, active_session: false });
  res.json({ muted: sessions[bot_id].muted, bot_id });
});

app.post('/mute', (req, res) => {
  const bot_id = activeBotId;
  if (!bot_id || !sessions[bot_id]) return res.status(404).json({ error: 'No active meeting session' });
  const session = sessions[bot_id];
  const enabled = req.body.enabled !== undefined ? !!req.body.enabled : !session.muted;
  session.muted = enabled;
  console.log(`🔇 Mute mode ${enabled ? 'enabled' : 'disabled'} for ${bot_id}`);

  // Live-update the OpenAI Realtime session if connected
  if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
    const updatedPrompt = buildSystemPrompt('realtime', session.transcript);
    session.openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: enabled ? ['text'] : ['text', 'audio'],
        instructions: enabled
          ? updatedPrompt + '\n\nYOU ARE CURRENTLY MUTED — your audio output is disabled and participants cannot hear you. Do NOT respond at all. Do not generate any text replies, acknowledgments, offers to help, or commentary. Just listen silently. The only exception is if someone says your name and directly asks you a question or gives you a task — in that case, respond with a brief text note. Otherwise, produce absolutely no output.'
          : updatedPrompt
      }
    }));
  }

  // Notify the browser to suppress/resume audio playback
  if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
    session.clientWs.send(JSON.stringify({ type: 'nora.mute', muted: enabled }));
  }

  res.json({ ok: true, muted: enabled, bot_id });
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
    delete chatSessions[bot_id];
    if (activeBotId === bot_id) activeBotId = null;
  }
});

// Slack webhook — @mentions, DMs, and follow-ups in threads Nora has joined
// Session history is keyed per-thread (or per-DM-channel) so concurrent conversations stay isolated.
const slackSessions = {};

// Cached Nora bot user ID, resolved lazily from the first event payload's authorizations.
// Used to detect @mentions in raw `message.channels` events (which arrive as type=message, not app_mention).
let noraBotUserId = null;

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

// Build a session key that scopes conversation history correctly.
// - DMs: per-channel (a DM channel = one conversation)
// - Channel threads: per-thread (so distinct threads in same channel don't bleed)
function slackSessionKey(channel, threadTs, channelType) {
  if (channelType === 'im' || channelType === 'mpim') return `dm:${channel}`;
  if (threadTs) return `thread:${channel}:${threadTs}`;
  return `channel:${channel}`;
}

// Cheap heuristic to drop obvious non-Nora-directed chatter before spending a Claude call.
// Returns true if the message is clearly not for Nora (acknowledgments, emoji-only, side chatter).
function isObviouslyNotForNora(text, botUserId) {
  const trimmed = (text || '').trim();
  // Very short messages — usually "ok", "lol", "yes", reactions
  if (trimmed.length < 4) return true;
  // Strip Slack-style :emoji: codes and unicode emoji; if there's nothing meaningful left, skip
  const stripped = trimmed
    .replace(/:[a-z0-9_+-]+:/gi, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, '');
  if (stripped.length < 4) return true;
  // Mentions another user but not Nora — message is directed elsewhere
  const mentions = trimmed.match(/<@[A-Z0-9]+>/g) || [];
  if (mentions.length > 0 && botUserId && !mentions.some(m => m.includes(botUserId))) {
    return true;
  }
  return false;
}

// Claude gate: ask Haiku whether the new message is actually directed at Nora before responding.
// Used only for thread continuation (DMs and explicit @mentions skip the gate). Defaults to no
// on errors or ambiguity — better to stay quiet than to chime in unwanted.
async function shouldEngageInThread(history, newMessage) {
  try {
    const recent = history.slice(-6).map(m => `${m.role === 'assistant' ? 'Nora' : 'User'}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        temperature: 0,
        system: 'You decide whether a new Slack message in a thread is directed at Nora (an AI project manager) and warrants a response from her. Reply with exactly "yes" or "no" — nothing else. Default to "no" if uncertain. Reply "yes" only when the message is clearly asking Nora something, addressing her directly, or seeking her input on the topic of the thread. Reply "no" for: thanks/acknowledgments, side chatter between humans, messages directed at other people, status updates not seeking input, or anything ambiguous.',
        messages: [{ role: 'user', content: `Recent thread:\n${recent}\n\nNew message: "${newMessage}"\n\nDirected at Nora and warrants a response?` }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 5000
      }
    );
    const text = response.data.content.filter(b => b.type === 'text').map(b => b.text).join('').toLowerCase().trim();
    return text.startsWith('yes');
  } catch (err) {
    console.error('shouldEngageInThread error:', err.message);
    return false; // err on the side of silence
  }
}

// Stricter Claude gate for proactive channel speaking — Nora is uninvited here, so the
// bar is much higher than thread continuation. Defaults to no on any ambiguity. The
// gate is told to look for SPECIFIC facts Nora can add from memory, not generic helpfulness.
async function shouldEngageProactively(newMessage) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        temperature: 0,
        system: 'You decide if Nora (an AI project manager for LimeLight Marketing) should chime in unsolicited on a Slack channel message. Nora was NOT mentioned and NOT addressed — she would be interjecting on her own initiative. The bar is very high: reply "yes" ONLY if the message asks a specific factual question that Nora has substantive, specific context to answer (concrete project facts, dates, decisions, names). Reply "no" for: greetings, social chatter, opinions/discussion, vague questions, anything where her contribution would be generic, anything she has no specific memory about, or anything ambiguous. When in doubt, ALWAYS "no". Unsolicited interjections fast-break trust — silence is the safe default. Reply with exactly "yes" or "no".',
        messages: [{ role: 'user', content: `Channel message (Nora was NOT mentioned): "${newMessage}"\n\nShould Nora chime in unsolicited?` }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 5000
      }
    );
    const text = response.data.content.filter(b => b.type === 'text').map(b => b.text).join('').toLowerCase().trim();
    return text.startsWith('yes');
  } catch (err) {
    console.error('shouldEngageProactively error:', err.message);
    return false;
  }
}

// Decide whether Nora should respond to this Slack event.
// She responds if: (a) it's a DM, (b) she was @mentioned, (c) it's an active joined thread,
// or (d) the channel is on the proactive-speaking allow-list and not in cooldown (still
// subject to the proactive Claude gate downstream).
//
// Dedup note: when the Slack app subscribes to both app_mention and message.channels, every
// @mention fires BOTH events with the same content. We let app_mention own those replies and
// skip duplicate message events that contain a Nora @mention.
function shouldRespond(event) {
  // DMs always
  if (event.channel_type === 'im' || event.channel_type === 'mpim') return true;
  // Explicit app_mention event type — Slack delivers this when the bot is mentioned
  if (event.type === 'app_mention') return true;
  // Skip duplicate message event for an @mention — app_mention already handled it
  if (event.type === 'message' && noraBotUserId && event.text && event.text.includes(`<@${noraBotUserId}>`)) {
    return false;
  }
  // Follow-up in an active (joined + not stale) thread
  if (event.thread_ts && isThreadActive(event.channel, event.thread_ts)) return true;
  // Proactive channel speaking — only if explicitly enabled for this channel and not in cooldown
  if (event.type === 'message' && isProactiveEnabled(event.channel) && !isProactiveCooldownActive(event.channel)) {
    return true;
  }
  return false;
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

  // Cache Nora's bot user ID from authorizations on first event — needed to detect
  // @mentions in raw `message.channels` events (which arrive as type=message, not app_mention)
  if (!noraBotUserId && req.body.authorizations && req.body.authorizations[0]) {
    noraBotUserId = req.body.authorizations[0].user_id;
    console.log('🤖 Resolved Nora bot user ID:', noraBotUserId);
  }

  const event = req.body.event;
  if (!event) return;

  // Ignore bot messages (prevent loops, including Nora's own posts)
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Only handle app_mention and message event types
  if (event.type !== 'app_mention' && event.type !== 'message') return;

  // Skip irrelevant message subtypes (channel_join, message_changed, etc.)
  if (event.subtype && event.subtype !== 'thread_broadcast') return;

  const text = event.text || '';
  const channel = event.channel;
  const user = event.user;
  // For top-level messages, replying with thread_ts=event.ts starts a new thread on that message.
  // For thread replies, we get event.thread_ts.
  const threadTs = event.thread_ts || event.ts;

  // Strip @mention tags from the text
  const query = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!query) return;

  // Track every inbound to a joined thread regardless of whether we end up responding.
  // This drives the staleness counter so the thread eventually cools off if Nora isn't being addressed.
  const inJoinedThread = !!event.thread_ts && isThreadJoined(channel, event.thread_ts);
  if (inJoinedThread && event.type === 'message') {
    recordThreadInbound(channel, event.thread_ts);
  }

  // Decide whether to respond at the routing level (DM, mention, active thread, or
  // proactive-enabled channel)
  if (!shouldRespond(event)) return;

  // For non-DM, non-mention messages, apply heuristic + Claude gate before committing
  // to a response. The gate differs based on whether this is thread continuation
  // (Nora was already invited) or proactive interjection (Nora was not invited at all).
  const isDM = event.channel_type === 'im' || event.channel_type === 'mpim';
  const isMention = event.type === 'app_mention';
  const inActiveThread = !!event.thread_ts && isThreadActive(channel, event.thread_ts);
  const isProactive = !isDM && !isMention && !inActiveThread; // implies proactive-enabled by shouldRespond

  let mode = 'normal';
  if (!isDM && !isMention) {
    if (isObviouslyNotForNora(query, noraBotUserId)) {
      console.log(`💬 Slack skip (heuristic): ${query.slice(0, 60)}`);
      return;
    }
    let engage;
    if (isProactive) {
      engage = await shouldEngageProactively(query);
      mode = 'proactive';
    } else {
      const sessionKey = slackSessionKey(channel, event.thread_ts, event.channel_type);
      const history = slackSessions[sessionKey] || [];
      engage = await shouldEngageInThread(history, query);
    }
    if (!engage) {
      console.log(`💬 Slack skip (${isProactive ? 'proactive' : 'thread'} gate): ${query.slice(0, 60)}`);
      return;
    }
  }

  console.log(`💬 Slack [${event.type}/${event.channel_type || '?'}${event.thread_ts ? '/thread' : ''}${mode === 'proactive' ? '/proactive' : ''}] from ${user}: ${query.slice(0, 100)}`);

  await handleSlack(channel, user, query, threadTs, event.channel_type, mode);
});

async function handleSlack(channel, user, text, threadTs, channelType, mode = 'normal') {
  try {
    // Per-thread (or per-DM) conversation history so distinct conversations don't bleed
    const key = slackSessionKey(channel, threadTs, channelType);
    if (!slackSessions[key]) slackSessions[key] = [];
    const history = slackSessions[key];

    history.push({ role: 'user', content: `[Slack user <@${user}>]: ${text}` });

    // Proactive mode: tell the model it's chiming in unsolicited and give it explicit
    // permission to abort (output nothing) if on reflection it doesn't have something
    // specific to add. This is a second chance to stay quiet after the gate fired.
    let systemPrompt = buildSystemPrompt('slack');
    if (mode === 'proactive') {
      systemPrompt += '\n\nYou are chiming in PROACTIVELY in a Slack channel — nobody @mentioned you. The earlier gate fired because the message looks like something you might have specific context on. Acknowledge that you\'re jumping in (e.g., "Chiming in —", "Quick add —"), be brief, and lead with the specific fact you can contribute. Critical: if on reflection you don\'t actually have a specific, useful fact to add beyond what\'s already been said, OUTPUT NOTHING (empty response). Silence is the right call when in doubt — unsolicited interjections fast-break trust. Better to stay quiet than chime in with something generic.';
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0.9,
        system: systemPrompt,
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

    // Allow proactive mode to opt out at generation time by returning nothing.
    if (mode === 'proactive' && !reply.trim()) {
      console.log('💬 Slack proactive abort (empty reply): model declined to chime in');
      // Don't pollute history with the user-line + nothing; pop the user message we just added
      history.pop();
      return;
    }

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

    // Mark this thread as one Nora has joined so follow-ups don't require re-mention.
    // DMs aren't tracked (every DM message is responded to via channel_type check).
    if (channelType !== 'im' && channelType !== 'mpim') {
      markThreadJoined(channel, threadTs);
    }

    // Proactive cooldown: after a successful unsolicited post, suppress further proactive
    // posts in this channel for PROACTIVE_COOLDOWN_MS so Nora doesn't chatter.
    if (mode === 'proactive') {
      markProactivePost(channel);
    }

    // Only extract tasks/memory if Nora's reply isn't asking clarifying questions
    if (!isAskingClarification(reply)) {
      // Pass thread_ts through so cowork can post the resolution back into this same thread.
      // DMs don't have meaningful threads — pass empty string so /notify uses default behavior.
      const sourceThreadTs = (channelType === 'im' || channelType === 'mpim') ? '' : threadTs;
      extractTasks(text, text, reply, { channel: `slack:${channel}`, user, thread_ts: sourceThreadTs }).catch(() => {});
      extractMemory(text, text, reply).catch(() => {});
      extractResearchNeeds(text, text, reply, { channel: `slack:${channel}`, user, thread_ts: sourceThreadTs }).catch(() => {});
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

// Slack thread admin — view and prune which threads Nora is "in" (will respond without re-mention)
app.get('/slack/threads', requireAuth, (req, res) => {
  const list = Object.entries(slackJoinedThreads).map(([key, entry]) => {
    const [channel, ts] = key.split(':');
    return {
      channel,
      thread_ts: ts,
      joined_at: entry.joined_at,
      last_addressed: entry.last_addressed,
      msgs_since_addressed: entry.msgs_since_addressed || 0,
      stale: isThreadStale(channel, ts)
    };
  });
  list.sort((a, b) => b.last_addressed.localeCompare(a.last_addressed));
  res.json({
    count: list.length,
    active: list.filter(t => !t.stale).length,
    stale: list.filter(t => t.stale).length,
    stale_thresholds: { msg_count: THREAD_STALE_MSG_COUNT, age_minutes: THREAD_STALE_AGE_MS / 60000 },
    threads: list
  });
});

app.delete('/slack/threads/:channel/:ts', requireAuth, (req, res) => {
  const key = `${req.params.channel}:${req.params.ts}`;
  if (!slackJoinedThreads[key]) return res.status(404).json({ error: 'thread not tracked' });
  delete slackJoinedThreads[key];
  saveSlackThreads(slackJoinedThreads);
  console.log('💬 Slack thread untracked:', key);
  res.json({ ok: true });
});

// Manually mark a thread as joined without posting. Used by the cowork loop to suppress
// /slack/unhandled-mentions hits that it deliberately wants to skip (cold outreach,
// automated cross-posts, etc.) without sending a response. The thread will be filtered
// out of subsequent unhandled-mentions calls and treated as "active" for thread
// continuation by the live handler.
app.post('/slack/threads/:channel/:ts', requireAuth, (req, res) => {
  const { channel, ts } = req.params;
  if (!channel || !ts) return res.status(400).json({ error: 'channel and ts are required' });
  markThreadJoined(channel, ts);
  console.log('💬 Slack thread manually marked joined:', `${channel}:${ts}`);
  res.json({ ok: true, joined: { channel, thread_ts: ts } });
});

// Proactive channel admin — control which channels Nora is allowed to speak in proactively
// (without being @mentioned). DEFAULT IS OFF for every channel — strict opt-in.
app.get('/slack/proactive-channels', requireAuth, (req, res) => {
  const channels = [...slackProactiveChannels].map(c => ({
    channel: c,
    cooldown_active: isProactiveCooldownActive(c),
    last_proactive_post: slackProactiveCooldown[c] ? new Date(slackProactiveCooldown[c]).toISOString() : null
  }));
  res.json({
    count: channels.length,
    cooldown_minutes: PROACTIVE_COOLDOWN_MS / 60000,
    channels
  });
});

app.post('/slack/proactive-channels/:channel', requireAuth, (req, res) => {
  const { channel } = req.params;
  if (!channel) return res.status(400).json({ error: 'channel is required' });
  slackProactiveChannels.add(channel);
  saveSlackProactiveChannels(slackProactiveChannels);
  console.log('💬 Slack proactive speaking enabled for channel:', channel);
  res.json({ ok: true, channel, enabled: true });
});

app.delete('/slack/proactive-channels/:channel', requireAuth, (req, res) => {
  const { channel } = req.params;
  if (!slackProactiveChannels.has(channel)) {
    return res.status(404).json({ error: 'channel not currently enabled for proactive speaking' });
  }
  slackProactiveChannels.delete(channel);
  saveSlackProactiveChannels(slackProactiveChannels);
  delete slackProactiveCooldown[channel];
  console.log('💬 Slack proactive speaking disabled for channel:', channel);
  res.json({ ok: true, channel, enabled: false });
});

// Resolve Nora's bot user ID, falling back to auth.test if it hasn't been
// captured from a webhook payload yet (e.g., fresh boot with no incoming events).
async function getNoraBotUserId() {
  if (noraBotUserId) return noraBotUserId;
  const r = await axios.post('https://slack.com/api/auth.test', null, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  if (!r.data.ok) throw new Error(`auth.test failed: ${r.data.error}`);
  noraBotUserId = r.data.user_id;
  console.log('🤖 Resolved Nora bot user ID via auth.test:', noraBotUserId);
  return noraBotUserId;
}

// Find @mentions of the bot in channels Nora's app is a member of that haven't been
// responded to. This uses the BOT'S point of view (via SLACK_BOT_TOKEN), not the user
// account's, which is the right perspective for "what did the live handler miss?" —
// the user account that cowork is connected to may not be a member of the same
// channels as the bot, so a user-account search would falsely report "0 unhandled."
//
// A mention is "unhandled" if the bot hasn't joined its thread (slackJoinedThreads).
// Since the bot auto-marks threads joined after replying, anything missing from
// that set is a mention the live handler dropped.
//
// Skips DMs entirely — those go through the live handler reliably and there's no
// channel-membership gap to worry about.
app.get('/slack/unhandled-mentions', requireAuth, async (req, res) => {
  const minutes = Math.max(1, parseInt(req.query.minutes || '120', 10));
  const sinceUnix = Math.floor((Date.now() - minutes * 60 * 1000) / 1000);
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' });

  try {
    const botUserId = await getNoraBotUserId();
    const headers = { Authorization: `Bearer ${botToken}` };
    const mentionToken = `<@${botUserId}>`;

    // List the bot's channel memberships (skip DMs and group DMs).
    const channels = [];
    let cursor = '';
    do {
      const url = `https://slack.com/api/users.conversations?types=public_channel,private_channel&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await axios.get(url, { headers });
      if (!r.data.ok) throw new Error(`users.conversations failed: ${r.data.error}`);
      for (const c of r.data.channels) channels.push(c);
      cursor = r.data.response_metadata?.next_cursor || '';
    } while (cursor);

    const unhandled = [];
    let scanned = 0;
    let scanErrors = 0;

    for (const channel of channels) {
      try {
        const histRes = await axios.get(
          `https://slack.com/api/conversations.history?channel=${channel.id}&oldest=${sinceUnix}&limit=100`,
          { headers }
        );
        if (!histRes.data.ok) {
          scanErrors++;
          continue;
        }
        scanned++;
        for (const msg of histRes.data.messages || []) {
          // Skip bot-authored messages (including Nora's own replies) and edits/system events
          if (msg.bot_id || msg.subtype === 'bot_message') continue;
          if (msg.subtype && msg.subtype !== 'thread_broadcast') continue;
          if (!msg.text || !msg.text.includes(mentionToken)) continue;

          // The thread the bot would have joined when responding
          const effectiveThreadTs = msg.thread_ts || msg.ts;
          if (isThreadJoined(channel.id, effectiveThreadTs)) continue;

          unhandled.push({
            channel: channel.id,
            channel_name: channel.name || null,
            is_private: !!channel.is_private,
            ts: msg.ts,
            thread_ts: msg.thread_ts || null,
            user: msg.user || null,
            text: msg.text,
            permalink_path: `archives/${channel.id}/p${msg.ts.replace('.', '')}${msg.thread_ts ? `?thread_ts=${msg.thread_ts}` : ''}`
          });
        }
      } catch (err) {
        scanErrors++;
        console.error(`history fetch failed for ${channel.id}:`, err.message);
      }
    }

    // Newest first — most actionable mentions surface at the top
    unhandled.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));

    res.json({
      bot_user_id: botUserId,
      since_minutes: minutes,
      channels_scanned: scanned,
      channels_total: channels.length,
      scan_errors: scanErrors,
      unhandled_count: unhandled.length,
      unhandled
    });
  } catch (err) {
    console.error('unhandled-mentions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Notify endpoint — Claude Code calls this to have Nora post follow-ups
app.post('/notify', requireAuth, async (req, res) => {
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

    // If we posted in a channel thread (not a DM), mark Nora as joined so user follow-ups
    // in that thread reach her without re-mention. DMs (channelId starts with 'D') skip this.
    const postedTs = msgRes.data.ts;
    const effectiveThread = thread_ts || postedTs;
    if (channelId && !channelId.startsWith('D') && effectiveThread) {
      markThreadJoined(channelId, effectiveThread);
    }

    console.log('📤 Nora notified:', channelId, text.slice(0, 100));
    res.json({ ok: true, channel: channelId, ts: postedTs });
  } catch (err) {
    console.error('Notify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Memory API — view and edit Nora's memory
app.get('/memory', requireAuth, (req, res) => res.json(loadMemory()));

app.post('/memory', requireAuth, (req, res) => {
  const { fact, source, project } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact is required' });
  // Normalize project to canonical casing (creating a stub record if needed).
  // This stops the drift the cowork loop has to clean up daily — projects referenced
  // by memories are guaranteed to exist in /projects.
  const canonicalProject = project ? ensureProject(project) : '';
  const memory = loadMemory();
  memory.push({ fact, project: canonicalProject, added: new Date().toISOString().split('T')[0], source: source || 'manual' });
  saveMemory(memory);
  if (canonicalProject) bumpProjectActivity(canonicalProject);
  console.log('🧠 Memory added:', fact);
  res.json({ ok: true, memory });
});

app.delete('/memory/:index', requireAuth, (req, res) => {
  const memory = loadMemory();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= memory.length) return res.status(404).json({ error: 'index out of range' });
  const removed = memory.splice(idx, 1);
  saveMemory(memory);
  console.log('🧠 Memory removed:', removed[0].fact);
  res.json({ ok: true, memory });
});

app.put('/memory/:index', requireAuth, (req, res) => {
  const memory = loadMemory();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= memory.length) return res.status(404).json({ error: 'index out of range' });
  const { fact, project } = req.body;
  if (!fact) return res.status(400).json({ error: 'fact is required' });
  memory[idx].fact = fact;
  if (project !== undefined) {
    memory[idx].project = project ? ensureProject(project) : '';
  }
  saveMemory(memory);
  if (memory[idx].project) bumpProjectActivity(memory[idx].project);
  console.log('🧠 Memory updated:', fact);
  res.json({ ok: true, memory });
});

app.delete('/memory', requireAuth, (req, res) => {
  saveMemory([]);
  console.log('🧠 Memory cleared');
  res.json({ ok: true, memory: [] });
});

// Projects API — manage project knowledge bases
app.get('/projects', requireAuth, (req, res) => res.json(loadProjects()));

// Compute the coverage row for a single project — shared by /projects/:name/coverage
// and the bulk /projects/coverage endpoint that drives idle-time research.
function computeProjectCoverage(project, allMemories) {
  const projectMemories = allMemories.filter(m =>
    m.project && m.project.toLowerCase() === project.name.toLowerCase()
  );
  const last_memory_at = projectMemories.reduce(
    (max, m) => (m.added && m.added > max) ? m.added : max, ''
  );
  const detailsLen = (project.details || '').length;
  const days_since_last_memory = last_memory_at
    ? Math.floor((Date.now() - new Date(last_memory_at).getTime()) / 86400000)
    : null;
  const days_since_last_research = project.last_research_at
    ? Math.floor((Date.now() - new Date(project.last_research_at).getTime()) / 86400000)
    : null;
  const thinness =
    Math.min(projectMemories.length, 20) * 5 +
    Math.min(detailsLen, 1000) / 50 +
    (project.client ? 5 : 0) +
    (project.status ? 5 : 0) +
    (project.pm ? 5 : 0);
  return {
    name: project.name,
    status: project.status || null,
    memory_count: projectMemories.length,
    last_memory_at,
    days_since_last_memory,
    details_length: detailsLen,
    last_activity: project.last_activity || null,
    updated: project.updated || null,
    last_research_at: project.last_research_at || null,
    days_since_last_research,
    auto_created: !!project.auto_created,
    has_client: !!project.client,
    has_status: !!project.status,
    has_pm: !!project.pm,
    has_phase: !!project.phase,
    thinness_score: Math.round(thinness)
  };
}

// Bulk coverage view — drives the cowork idle-time research loop.
// Sorted "most in need first": never-researched bubbles up, then thinness, then oldest research.
// By default skips archived/wrapped/completed projects, "Opportunity - " sales pipeline projects,
// and LimeLight-internal projects (the agency's own work, not client work) since those don't
// benefit from proactive research focused on client engagements.
app.get('/projects/coverage', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  const includeArchived = req.query.include_archived === 'true';
  const includeOpportunities = req.query.include_opportunities === 'true';
  const includeInternal = req.query.include_internal === 'true';
  const cooldownDays = parseInt(req.query.cooldown_days || '1', 10);

  const projects = loadProjects();
  const memory = loadMemory();
  const cooldownMs = cooldownDays * 86400000;

  let rows = projects.map(p => computeProjectCoverage(p, memory));

  if (!includeArchived) {
    rows = rows.filter(r => {
      const s = (r.status || '').toLowerCase();
      return !['archived', 'wrapped', 'completed', 'done'].includes(s);
    });
  }
  if (!includeOpportunities) {
    rows = rows.filter(r => !r.name.toLowerCase().startsWith('opportunity - '));
  }
  if (!includeInternal) {
    // Detect LimeLight-internal projects by name prefix or client field. Two heuristics
    // because some internal projects use the "LimeLight ..." name convention while others
    // are tagged via client = "LimeLight" / "LimeLight Marketing".
    rows = rows.filter(r => {
      const name = r.name.toLowerCase();
      if (name.startsWith('limelight ') || name === 'limelight') return false;
      const project = projects.find(p => p.name === r.name);
      const client = (project?.client || '').toLowerCase().trim();
      if (client === 'limelight' || client === 'limelight marketing') return false;
      return true;
    });
  }

  // Filter out projects researched within the cooldown window — prevents same-project
  // re-pick on the next hourly run after the cowork loop touches it.
  rows = rows.filter(r => {
    if (!r.last_research_at) return true; // never researched, fair game
    return (Date.now() - new Date(r.last_research_at).getTime()) > cooldownMs;
  });

  // Sort: never-researched first, then thinnest, then oldest research date as tiebreaker
  rows.sort((a, b) => {
    if (!a.last_research_at && b.last_research_at) return -1;
    if (a.last_research_at && !b.last_research_at) return 1;
    if (a.thinness_score !== b.thinness_score) return a.thinness_score - b.thinness_score;
    return (a.last_research_at || '').localeCompare(b.last_research_at || '');
  });

  res.json({
    count: rows.length,
    cooldown_days: cooldownDays,
    projects: rows.slice(0, limit)
  });
});

app.get('/projects/:name', requireAuth, (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Include project-specific memories
  const memory = loadMemory();
  const projectMemories = memory.filter(m => m.project && m.project.toLowerCase() === req.params.name.toLowerCase());
  // Summary: most recent memory date, count
  const memory_count = projectMemories.length;
  const last_memory_at = projectMemories.reduce((max, m) => (m.added && m.added > max) ? m.added : max, '');
  res.json({ ...project, memory_count, last_memory_at, memories: projectMemories });
});

// Coverage view — used by the cowork loop to identify projects needing more research.
// Returns metrics that help rank "thin" or "stale" projects without pulling all memories.
app.get('/projects/:name/coverage', requireAuth, (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(computeProjectCoverage(project, loadMemory()));
});

// Mark a project as researched. Cowork calls this after completing an idle-research round
// so the same project doesn't get re-picked on the next hourly run.
// Optionally accepts a free-text "summary" describing what was found / where, stored on
// the project for context.
app.post('/projects/:name/research-touch', requireAuth, (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  projects[idx].last_research_at = new Date().toISOString();
  if (req.body && typeof req.body.summary === 'string') {
    projects[idx].last_research_summary = req.body.summary;
  }
  saveProjects(projects);
  console.log('🔬 Project research-touched:', projects[idx].name);
  res.json({ ok: true, project: projects[idx] });
});

app.post('/projects', requireAuth, (req, res) => {
  const { name, details, client, status, pm, phase, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const projects = loadProjects();
  const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Project already exists', project: existing });
  const project = {
    name,
    details: details || '',
    created: new Date().toISOString()
  };
  if (client !== undefined) project.client = client;
  if (status !== undefined) project.status = status;
  if (pm !== undefined) project.pm = pm;
  if (phase !== undefined) project.phase = phase;
  if (tags !== undefined) project.tags = Array.isArray(tags) ? tags : [];
  projects.push(project);
  saveProjects(projects);
  console.log('📁 Project added:', name);
  res.json({ ok: true, project });
});

app.put('/projects/:name', requireAuth, (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const { name, details, client, status, pm, phase, tags } = req.body;
  if (name) projects[idx].name = name;
  if (details !== undefined) projects[idx].details = details;
  if (client !== undefined) projects[idx].client = client;
  if (status !== undefined) projects[idx].status = status;
  if (pm !== undefined) projects[idx].pm = pm;
  if (phase !== undefined) projects[idx].phase = phase;
  if (tags !== undefined) projects[idx].tags = Array.isArray(tags) ? tags : [];
  projects[idx].updated = new Date().toISOString();
  // Promoting a stub to a curated record clears the auto_created flag
  if (projects[idx].auto_created && (details || client || status || pm || phase)) {
    delete projects[idx].auto_created;
  }
  saveProjects(projects);
  console.log('📁 Project updated:', projects[idx].name);
  res.json({ ok: true, project: projects[idx] });
});

app.delete('/projects/:name', requireAuth, (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name.toLowerCase() === req.params.name.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const removed = projects.splice(idx, 1);
  saveProjects(projects);
  console.log('📁 Project deleted:', removed[0].name);
  res.json({ ok: true });
});

// Task queue API
app.get('/tasks', requireAuth, (req, res) => {
  const tasks = loadTasks();
  const status = req.query.status; // ?status=pending or ?status=done
  if (status) return res.json(tasks.filter(t => t.status === status));
  res.json(tasks);
});

app.post('/tasks', requireAuth, (req, res) => {
  const { action, detail, assignee, due } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });
  const id = addTask({ action, detail: detail || '', assignee: assignee || '', due: due || '' });
  res.json({ ok: true, id });
});

app.patch('/tasks/:id/complete', requireAuth, (req, res) => {
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

app.delete('/tasks/:id', requireAuth, (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'task not found' });
  const removed = tasks.splice(idx, 1);
  saveTasks(tasks);
  console.log('🗑️ Task deleted:', removed[0].id);
  res.json({ ok: true });
});

app.put('/tasks/:id', requireAuth, (req, res) => {
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

// Teamwork: update a task's workflow stage by task ID and stage name
app.get('/teamwork/tasks/:taskId/stage', requireAuth, async (req, res) => {
  const stage = req.query.stage;
  const { taskId } = req.params;
  if (!stage) return res.status(400).json({ error: 'stage is required' });

  const twKey = process.env.TEAMWORK_API_KEY;
  const twBase = process.env.TEAMWORK_BASE_URL; // e.g. https://yourcompany.teamwork.com
  if (!twKey || !twBase) return res.status(500).json({ error: 'TEAMWORK_API_KEY and TEAMWORK_BASE_URL must be set' });

  const twAuth = 'Basic ' + Buffer.from(`${twKey}:`).toString('base64');
  const twHeaders = { Authorization: twAuth, 'Content-Type': 'application/json' };

  try {
    // 1. Get the task to find its project ID — try v1 endpoint first (known structure from existing client)
    const taskRes = await axios.get(`${twBase}/tasks/${taskId}.json`, { headers: twHeaders });
    const taskData = taskRes.data;
    const todoItem = taskData?.['todo-item'] || taskData?.task;
    const projectId = todoItem?.['project-id'] || todoItem?.project?.id || todoItem?.projectId;
    if (!projectId) return res.status(404).json({ error: 'could not determine project for task' });

    // 2. Get workflows for the project
    const wfRes = await axios.get(`${twBase}/projects/api/v3/projects/${projectId}/workflows.json`, { headers: twHeaders });
    const workflows = wfRes.data?.workflows || [];
    if (workflows.length === 0) return res.status(404).json({ error: 'no workflows found for this project' });

    // 3. Search each workflow's stages for a matching stage name
    let targetWorkflowId = null;
    let targetStageId = null;

    for (const wf of workflows) {
      const stagesRes = await axios.get(`${twBase}/projects/api/v3/workflows/${wf.id}/stages.json`, { headers: twHeaders });
      const stages = stagesRes.data?.stages || [];
      const match = stages.find(s => s.name.toLowerCase() === stage.toLowerCase());
      if (match) {
        targetWorkflowId = wf.id;
        targetStageId = match.id;
        break;
      }
    }

    if (!targetStageId) return res.status(404).json({ error: `stage "${stage}" not found in any workflow for this project` });

    // 4. Move the task to the target stage
    await axios.post(
      `${twBase}/projects/api/v3/workflows/${targetWorkflowId}/stages/${targetStageId}/tasks.json`,
      { taskIds: [parseInt(taskId, 10)] },
      { headers: twHeaders }
    );

    console.log(`✅ Teamwork task ${taskId} moved to stage "${stage}"`);
    res.json({ ok: true, taskId, stage, workflowId: targetWorkflowId, stageId: targetStageId });
  } catch (err) {
    console.error('Teamwork stage update error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Transcript API — list and retrieve saved meeting transcripts
app.get('/transcripts', requireAuth, (req, res) => {
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

app.get('/transcripts/:botId', requireAuth, (req, res) => {
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

app.delete('/transcripts/:botId', requireAuth, (req, res) => {
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

app.put('/transcripts/:botId/utterances/:index', requireAuth, (req, res) => {
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

app.delete('/transcripts/:botId/utterances/:index', requireAuth, (req, res) => {
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
    const projectsTouched = new Set();
    for (const item of items) {
      // Support both old format (plain strings) and new format (objects with fact + project)
      const fact = typeof item === 'string' ? item : item.fact;
      const rawProject = typeof item === 'string' ? '' : (item.project || '');
      // Normalize project name to canonical casing, auto-creating a stub record if needed.
      const project = rawProject ? ensureProject(rawProject) : '';
      if (typeof fact === 'string' && fact.trim() && !existingFacts.has(fact.toLowerCase())) {
        memory.push({ fact, project, added: new Date().toISOString().split('T')[0], source: sourceBotId ? 'meeting' : 'slack', source_bot_id: sourceBotId || '' });
        existingFacts.add(fact.toLowerCase());
        if (project) projectsTouched.add(project);
        added++;
      }
    }
    if (added > 0) {
      saveMemory(memory);
      for (const p of projectsTouched) bumpProjectActivity(p);
      console.log(`🧠 Auto-saved ${added} memor${added === 1 ? 'y' : 'ies'}:`, items);
    }
  } catch (err) {
    console.error('Memory extraction error:', err.message);
  }
}

async function extractTasks(context, trigger, reply, source = {}) {
  try {
    // Debounce: skip if we just ran extraction within the last 5 seconds for this bot
    const botId = source.bot_id || 'unknown';
    const now = Date.now();
    if (!extractTasks._lastRun) extractTasks._lastRun = {};
    if (extractTasks._lastRun[botId] && now - extractTasks._lastRun[botId] < 5000) {
      console.log('⏩ Skipping task extraction (debounce)');
      return;
    }
    extractTasks._lastRun[botId] = now;

    const existingTasks = loadTasks().filter(t => t.status === 'pending');
    const recentTaskList = existingTasks.slice(-10).map(t =>
      `- ${t.action}${t.detail ? ' (' + t.detail + ')' : ''}${t.assignee ? ' [' + t.assignee + ']' : ''}`
    ).join('\n');

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: `You extract action items that Nora (an AI PM assistant) was explicitly asked to do. ONLY extract tasks where someone directly asked Nora to take an action — things like "Nora, schedule a meeting with...", "Nora, send Kyle an email about...", "Nora, remind me to...".

CRITICAL RULES:
- Extract exactly ONE task per distinct request. Do not split a single request into multiple tasks.
- Extract the UNDERLYING action, not a meta-action. If someone says "create a Teamwork task for Aaron to update staging", the task is "Update staging environment" assigned to Aaron — NOT "Create a Teamwork task".
- IGNORE Nora's reply when determining what to extract. Only extract from what the user said.
- Do NOT extract general discussion, suggestions Nora made, or things other people said they would do.
- Do NOT extract tasks that already exist in the pending tasks list below. If something similar is already tracked, return [].
- If the conversation is just casual/social (greetings, small talk, status updates), return [].

EXISTING PENDING TASKS (do not duplicate these):
${recentTaskList || '(none)'}

Return a JSON array of objects with: action (short verb phrase — what to do), detail (specifics, keep brief), assignee (who it's for, if mentioned), due (deadline if mentioned, otherwise ""). Return [] if no NEW action items.`,
        messages: [{ role: 'user', content: `Meeting context:\n${context}\n\nTriggering utterance: ${trigger}\n\nNora's response: ${reply}\n\nNew action items for Nora (JSON array or []):` }]
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

    let filteredItems = items.filter(i => i.action && typeof i.action === 'string');
    if (filteredItems.length === 0) return;

    // Secondary dedup check: compare against existing tasks with Claude
    if (existingTasks.length > 0) {
      try {
        const existingList = existingTasks.map(t => `- ${t.action}${t.detail ? ' (' + t.detail + ')' : ''}${t.assignee ? ' [' + t.assignee + ']' : ''}`).join('\n');
        const newList = filteredItems.map((t, i) => `${i}: ${t.action}${t.detail ? ' (' + t.detail + ')' : ''}${t.assignee ? ' [' + t.assignee + ']' : ''}`).join('\n');
        const dedupRes = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            temperature: 0,
            system: `You check for duplicate tasks. Given existing tasks and new candidates, return a JSON array of indices of new tasks that are genuinely NOT duplicates.

A task IS a duplicate if:
- An existing task covers the same action for the same person/purpose, even if worded differently
- It's a meta-version of an existing task (e.g. "create a task to update staging" duplicates "update staging environment")
- Two new candidates cover the same thing — only keep one

Be strict — if in doubt, it's a duplicate. Return only indices of truly new tasks, e.g. [0, 2]. If all duplicates, return [].`,
            messages: [{ role: 'user', content: `Existing pending tasks:\n${existingList}\n\nNew candidates:\n${newList}\n\nIndices of non-duplicate new tasks:` }]
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
        source_thread_ts: source.thread_ts || '',
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
      source_thread_ts: source.thread_ts || '',
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
  const systemPrompt = buildSystemPrompt('realtime', session?.transcript);
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

  // Store WebSocket references on the session so /mute can send live updates
  if (session) {
    session.openaiWs = openaiWs;
    session.clientWs = ws;
  }

  const messageQueue = [];

  openaiWs.on('open', () => {
    console.log('🧠 Connected to OpenAI Realtime API');

    const isMuted = session?.muted;

    // Configure the session with Nora's personality and settings
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: isMuted ? ['text'] : ['text', 'audio'],
        instructions: isMuted
          ? systemPrompt + '\n\nYOU ARE CURRENTLY MUTED — your audio output is disabled and participants cannot hear you. Do NOT respond at all. Do not generate any text replies, acknowledgments, offers to help, or commentary. Just listen silently. The only exception is if someone says your name and directly asks you a question or gives you a task — in that case, respond with a brief text note. Otherwise, produce absolutely no output.'
          : systemPrompt,
        voice: 'sage',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1500
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

      // Capture user speech transcription from OpenAI Whisper
      // Note: speaker names come from Recall.ai's /webhook/transcript (via real_time_transcription).
      // We still log Whisper transcriptions and add to buffer for Nora's context,
      // but skip adding to session.transcript to avoid duplicates — Recall's webhook handles that with proper names.
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const userText = msg.transcript?.trim();
        if (userText) {
          console.log('🗣️ User (transcribed by Whisper):', userText.slice(0, 200));
          const session = sessions[botId];
          if (session) {
            // Add to rolling buffer for Nora's conversational context
            session.buffer.push(`Participant: ${userText}`);
            if (session.buffer.length > 20) session.buffer.shift();
            // Transcript entry is handled by /webhook/transcript with actual speaker names
          }
        }
      }

      // Track response completions
      if (msg.type === 'response.done' && msg.response) {
        const outputs = msg.response.output || [];
        for (const item of outputs) {
          if (item.type === 'message' && item.role === 'assistant') {
            // Audio responses (normal mode)
            const audioTranscript = item.content?.find(c => c.type === 'audio')?.transcript;
            if (audioTranscript) {
              console.log('🤖 Nora (voice):', audioTranscript.slice(0, 200));
            }

            // Text-only responses (muted mode) — only process if Nora was directly addressed
            const textContent = item.content?.find(c => c.type === 'text')?.text;
            if (textContent && sessions[botId]?.muted) {
              const session = sessions[botId];
              const recentUtterances = session.buffer.slice(-5).join('\n').toLowerCase();
              const wasAddressed = recentUtterances.includes('nora');

              if (wasAddressed) {
                console.log('🔇 Nora (muted, addressed):', textContent.slice(0, 200));
                session.transcript.push({ speaker: 'Nora (muted)', text: textContent, timestamp: new Date().toISOString() });
                try {
                  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
                  fs.writeFileSync(path.join(dir, `transcript-${botId}.json`), JSON.stringify({ bot_id: botId, ended: null, transcript: session.transcript }, null, 2));
                } catch (err) {
                  console.error('Transcript save error:', err.message);
                }
                const meetingContext = session.buffer.slice(-10).join('\n');
                const triggerText = session.buffer.slice(-3).join('\n');
                if (!isAskingClarification(textContent)) {
                  extractTasks(meetingContext, triggerText, textContent, { channel: 'zoom', bot_id: botId }).catch(() => {});
                }
              } else {
                console.log('🔇 Nora (muted, discarded):', textContent.slice(0, 200));
              }
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
    const s = sessions[botId];
    const isMuted = s?.muted;
    const updatedPrompt = buildSystemPrompt('realtime', s?.transcript);
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: isMuted ? ['text'] : ['text', 'audio'],
        instructions: isMuted
          ? updatedPrompt + '\n\nYOU ARE CURRENTLY MUTED — your audio output is disabled and participants cannot hear you. Do NOT respond at all. Do not generate any text replies, acknowledgments, offers to help, or commentary. Just listen silently. The only exception is if someone says your name and directly asks you a question or gives you a task — in that case, respond with a brief text note. Otherwise, produce absolutely no output.'
          : updatedPrompt
      }
    }));
    console.log('🔄 Refreshed Nora instructions with latest memory');
  }, 5 * 60 * 1000); // every 5 minutes

  // Cleanup
  ws.on('close', () => {
    console.log(`🔌 Voice agent WebSocket closed for bot: ${botId}`);
    clearInterval(refreshInterval);
    if (sessions[botId]) {
      sessions[botId].openaiWs = null;
      sessions[botId].clientWs = null;
    }
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