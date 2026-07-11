'use strict';

function registerCoworkInstructionsRoute(app) {
  // Cowork instructions — plain text reference for scheduled Cowork tasks
  app.get('/cowork-instructions', (req, res) => {
    res.type('text/plain').send(`# Nora — Cowork Instructions
  # Generated: ${new Date().toISOString()}

  ## What is Nora?
  Nora is a voice-enabled AI project management assistant for LimeLight Marketing. She joins meetings via Recall.ai's Output Media feature, using OpenAI's Realtime API for real-time voice conversations. She also responds to Slack messages. She has persistent memory, a task queue, and saves full meeting transcripts. External agents (like Cowork scheduled tasks) process her task queue and analyze transcripts.

  ## Calendar auto-join
  Nora's Google Calendar (nora@limelightmarketing.com) is connected to Recall.ai Calendar V2. When she's invited to a meeting with a Zoom/Meet/Teams URL, the server auto-schedules her bot via the calendar.sync_events webhook — so calendar-invited meetings appear in her transcripts without anyone pressing "Send Nora." Inclusion rule: she must be in the event's attendee list. Opt-out: include "[no-nora]" or "[skip-nora]" anywhere in the event title. You do NOT need to schedule recurring tasks to make this work; it's handled live by the webhook.

  ## Authentication

  The following endpoints require an API key: /memory, /projects, /tasks, /teamwork, /notify, /transcripts, /dreams, /interactions, /run-lock, /markers.
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
  Each entry has a stable "id" — use it for all deletes/updates. NEVER mutate by array index
  (the index shifts between your read and your write under concurrency, which corrupts the store).
  - GET  /memory                  — Returns full memory array
    Response: [{ "id": "m-...", "fact": "string", "project": "string (empty if general)", "added": "YYYY-MM-DD", "source": "meeting|slack|manual|system|auto|opinion|learning", "source_bot_id": "..." }]

  - POST /memory                  — Add a new memory
    Body: { "fact": "string", "source": "string", "project": "string (optional)" }
    Response: { "ok": true, "id": "m-...", "memory": [...] }

  - DELETE /memory/by-id/:id      — PREFERRED. Remove one memory by its stable id. 404 if not found.
    Response: { "ok": true, "removed": {...}, "memory": [...] }

  - POST /memory/bulk-delete      — PREFERRED for batches (dedup/prune). Atomic, one operation.
    Body: { "ids": ["m-...", "m-..."] }
    Response: { "ok": true, "removed_count": N, "removed": [...] }

  - PUT  /memory/:idOrIndex       — Update a memory's fact/project (prefers id; index fallback).
    Body: { "fact": "string", "project": "string (optional)" }

  - DELETE /memory/:index         — LEGACY index delete. UNSAFE under concurrency — do NOT use.
    Kept only for back-compat. Use /memory/by-id/:id or /memory/bulk-delete instead.

  - DELETE /memory                — Clear all memory
    Response: { "ok": true, "memory": [] }

  All memory mutations are serialized server-side (single in-process lock) and written atomically
  (temp-file + rename), so concurrent writers can't lose updates or read a half-written file.

  ### Run lock (prevent overlapping cowork runs)
  - POST /run-lock                — Acquire the advisory run lock. Body: { "holder": "run-...", "ttl_seconds": 3000 }
    Response: { "acquired": true|false, "held_by"?: "...", "expires_at": "..." }. Acquire at the TOP
    of a run; if acquired=false, another run is active — skip all shared-state mutation this run.
  - GET  /run-lock                — { "locked": bool, "holder": ..., "expires_at": ... }
  - DELETE /run-lock?holder=...   — Release (only the holder can). Always release at run end.
    The lock auto-expires after its TTL so a crashed run can't wedge it.

  ### Markers (operational idempotency — NOT knowledge)
  Use these for "have I already done X" bookkeeping (filed a transcript, dreamed today, sent
  warmth this week, responded to a Slack msg). Do NOT put these in /memory anymore — memory is
  for knowledge Nora references in conversation; markers are bookkeeping that used to bloat it.
  Key scheme (examples): "filed-transcript:<bot_id>", "skipped-transcript:<bot_id>",
  "dreamed:<YYYY-MM-DD>", "memory-dedup:<YYYY-MM-DD>", "stale-tasks-flagged:<YYYY-MM-DD>",
  "warmth:<person-lowercase>:<YYYY-MM-DD>", "slack-responded:<ts>", "bootstrap:<name>".
  - GET  /markers/:key            — The idempotency check. Response: { "exists": bool, "marker": {...}|null }
  - GET  /markers?prefix=filed-transcript:  — List a category. Response: { "count", "markers": {...} }
  - POST /markers                 — Set/upsert. Body: { "key": "filed-transcript:abc", "data": { "url": "...", "client": "CCKC" } }
    "data" is optional free-form metadata. Idempotent.
  - POST /markers/bulk            — Set many. Body: { "markers": { "key1": {..}, "key2": {..} } }
  - DELETE /markers/:key          — Remove a marker.
  - POST /markers/migrate         — One-time: sweep marker-shaped entries OUT of /memory into
    /markers and delete them from memory. ?dry_run=true to preview. Idempotent (re-run finds none).
    Response: { "moved", "removed_from_memory", "by_category" }.

  ### Projects
  - GET  /projects                — Returns all projects
    Response: [{ "name", "details", "created", "client?", "status?", "pm?", "phase?", "tags?",
                  "last_activity?", "last_research_at?", "last_research_summary?",
                  "teamwork_id?", "auto_created?" }]

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

  - POST /projects/sync-from-teamwork — Sync /projects from the Teamwork active project list.
    Pulls active Teamwork projects (paginated v3 API), filters out archived/opportunity/
    LimeLight-internal, then reconciles against Nora's store:
      - Missing → created with name, client (from TW company), status='active', details (from
        TW description)
      - auto_created stubs → promoted by filling in TW metadata (clears auto_created flag)
      - Existing curated records → left alone (don't overwrite manual edits)
    Idempotent — safe to call every cowork run. Replaces the multi-step MCP workflow that
    used to live in the Idle Knowledge Round.
    Body (optional): { "dry_run": true } to preview without applying changes.
    Response: { "ok", "dry_run", "teamwork_total", "after_filter", "pages_fetched",
                "created", "promoted", "unchanged",
                "created_names": [...], "promoted_names": [...] }

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

  - POST /tasks                   — Add a task. Supports one-shot scheduled tasks and
    recurring ones. The cowork loop polls GET /tasks?status=pending, which by default
    HIDES tasks whose "scheduled_for" is still in the future — those reappear in the
    queue once their fire time has passed. Use ?include=all to see scheduled+pending.
    Body fields:
      action          — required, the verb/short label
      detail          — freeform context
      assignee        — usually "nora" for things she should run
      due             — optional human-readable due note (unrelated to scheduled_for)
      scheduled_for   — optional ISO datetime. Task is filtered out of the queue until
                        this moment has passed. Omit for "do now".
      recurrence      — optional. Keyword DSL, all times America/Chicago:
                          daily:HH:MM             — every day
                          weekdays:HH:MM          — Mon-Fri only
                          weekly:dayname:HH:MM    — e.g., weekly:friday:16:00
                          monthly:N:HH:MM         — Nth day (1-31, clamped to month length)
                        When set, completion auto-rolls scheduled_for to the next fire time
                        and resets the task to pending. If you set recurrence without
                        scheduled_for, the server seeds the first fire time from the rule.
    Response: { "ok": true, "id": "nora-...", "scheduled_for": "...", "recurrence": "..." }

  - PATCH /tasks/:id/complete     — Mark task done (idempotent).
    For one-shot tasks: status flips to "done".
    For recurring tasks: same row recycles — scheduled_for advances, status returns to
    pending, last_run records the completion. Response includes "rolled_to" with the
    next fire time when this happens.

  - DELETE /tasks/:id             — Delete a task (use this to stop a recurring task
    entirely; PATCH/complete on a recurring task will keep rolling it forward).

  ### Slack file inbox
  When someone Slacks Nora a file, the server downloads it to a local inbox and creates
  a task whose action starts with "File ... from Slack". The task's detail lists every
  attached file's inbox_id. Cowork loop's job is to fetch each file via this inbox
  endpoint, upload it to the right Drive folder (use the two-hop pattern documented in
  the cowork prompt — staging folder → copy_file into client drive), reply with the
  Drive link in the original Slack thread, and clean up the inbox entries.

  - GET    /admin/inbox                       — List all files currently in the inbox.
    Response: { "files": [{ "inbox_id", "filename", "size", "created" }, ...] }
  - GET    /admin/inbox/file/:inbox_id        — Download the raw file bytes (with
    Content-Disposition so curl writes the original filename).
  - POST   /admin/inbox/file/:inbox_id/upload-to-drive
    — Server-side upload of the inbox file to Google Drive using Nora's stored OAuth
    refresh token. Use this for BINARY files (PNG, JPG, PDF, decks, images) — the
    Drive MCP's create_file path only handles text content reliably. Body:
    { "parent_folder_id": "<folder id>", "filename": "<final name>", "mimetype": "<optional>" }
    Response: { "ok": true, "file": { "id", "name", "webViewLink", "mimeType", "parents" } }
    The returned webViewLink is what you paste in the Slack thread.
  - DELETE /admin/inbox/file/:inbox_id        — Delete the file from the inbox after
    successful Drive upload so the volume doesn't grow forever.

  ### Transcripts
  - GET  /transcripts             — List all saved transcripts, newest first
    Response: [{ "bot_id", "ended", "file", "url", "utterance_count" }]

  - GET  /transcripts/:botId      — Full transcript for a meeting
    Response: { "bot_id", "ended", "transcript": [{ "speaker", "text", "timestamp" }] }
    404 if not found.

  - DELETE /transcripts/:botId    — Delete a transcript
    Response: { "ok": true }
    404 if not found.

  ### Dreams (nightly memory consolidation + reflection log)
  - GET  /dreams                  — List all recorded dreams, newest first
    Response: [{ "id", "date", "started", "finished", "consolidation": {...}, "reflection": {...}, "narrative" }]

  - POST /dreams                  — Record a completed dream (cowork loop calls this at the end of the Dreaming Round)
    Body: {
      "date": "YYYY-MM-DD",
      "started": "<ISO>", "finished": "<ISO>",
      "consolidation": { "memories_before": N, "memories_after": M, "duplicates_removed": X,
                         "fragments_merged": Y, "stale_pruned": Z, "contradictions_resolved": W,
                         "examples": ["merged 'Gracie is PM' + 'Gracie Krokroskia, APM' → kept detailed", ...] },
      "reflection": { "takes_added": ["<take>", ...], "takes_retired": ["<old take>", ...],
                      "ideas": ["<idea/thought>", ...] },
      "review": { "interactions_reviewed": N,
                  "outcomes": { "appreciated": A, "landed": B, "neutral": C, "ignored": D, "corrected": E },
                  "learnings_added": ["<learning>", ...], "learnings_retired": ["<old learning>", ...] },
      "narrative": "<first-person 'what I dreamed about' summary in Nora's voice>"
    }
    Server stamps id + finished if omitted. Caps stored dreams at the newest ~120.
    Response: { "ok": true, "dream": {...} }

  - GET    /dreams/:id            — Full detail for one dream. 404 if not found.
  - DELETE /dreams/:id            — Delete a dream entry. 404 if not found.

  ### Interactions (RSI feedback loop — Nora's outbound contributions + how they landed)
  The server logs every Slack reply Nora posts. The dream's Review movement reads these back,
  judges how each landed (via the Slack MCP — thread replies, reactions, adjacent messages),
  and distills [Your learnings].
  - GET  /interactions            — Worklist of logged interactions, newest first.
    Query: ?reviewed=false (un-assessed only) · ?since=ISO · ?limit=N (default 100)
    Response: [{ "id", "created", "reviewed", "outcome", "channel", "thread_ts", "ts",
                 "channel_type", "kind" ("reply"|"dm_reply"|"proactive"), "text",
                 "trigger" (the message she replied to), "user", "requester_name", "signal"? }]

  - POST /interactions/:id/outcome — Write back how an interaction landed (dream calls this).
    Body: { "outcome": "landed"|"appreciated"|"neutral"|"ignored"|"corrected",
            "signal": "<what the replies/reactions/adjacent messages actually showed>" }
    Marks it reviewed. Response: { "ok": true, "interaction": {...} }

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

  ### Financial-info access control

  The live Slack handler enforces a per-user gate on financial information. Replies to users
  NOT on the approved list have dollar amounts / rates / fees / budgets / margins stripped
  or replaced with a polite redirect. Three layers of defense:

    1. System-prompt gate — the handler tells the model the recipient's approval status
       before generating; unapproved → "never share financial figures, redirect instead."
    2. Output scrubber — regex check on the generated reply at egress; if recipient is
       unapproved AND reply contains financial patterns, the whole reply is replaced
       with the safe redirect before posting. Catches model rule-violations.
    3. Memory CAN contain financial content — distribution is gated at the output side,
       not at the memory layer. Save what's true; the live handler decides who can see it.
       (Earlier behavior rejected financial-content writes with 422; that turned out to
       be too aggressive — false positives like "Marketing Retainer 2026" were getting
       blocked because "retainer" + a 4-digit year matched the pattern.)

  Approved set: LimeLight PM team (John, Mallory, Gracie, Kinsey) + execs (Brandee, Andy) +
  account managers (Kyle Tapper, Kayla Clark, Caitlin Blackwell).

  - GET  /slack/financial-approved — List approved Slack user IDs and names.
    Response: { "count", "approved": [{ "user_id", "name" }] }

  - POST /slack/financial-approved/:userId — Add a user.
    Body (optional): { "name": "John Kuefler" }
    Response: { "ok": true, "user_id", "name" }

  - DELETE /slack/financial-approved/:userId — Remove a user.
    Response: { "ok": true, "user_id" }

  ### Approved-list bootstrap (run once on first cowork run after deploy)

  The financial-approved list starts empty. On the first cowork run after this feature deploys,
  populate it via slack_search_users lookups for each approved person, then POST each user_id
  with their name. Save a memory marker once done so future runs don't repeat the lookup:

    Approved names to look up: John Kuefler, Mallory Maryman, Gracie Krokroskia, Kinsey Landry,
    Brandee Johnson, Andy Warren.

    For each, slack_search_users by name → POST /slack/financial-approved/{user_id} with
    body { "name": "<name>" }. Then save:
      POST /memory { "fact": "Bootstrapped slack-financial-approved list on YYYY-MM-DD with
                              the 6 PM/exec users", "source": "auto" }

  Until the list is populated, ALL users are treated as unapproved (fail-closed). That's safe
  behavior for the gap window but means John can't get financial details via Slack live until
  his ID is added — populate the list ASAP after the deploy.

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
                "scan_errors", "scope_warnings": [...],
                "unhandled_count",
                "unhandled": [{ "channel", "channel_name", "is_private", "ts",
                                 "thread_ts", "user", "text", "permalink_path" }] }
    Use this in cowork's Slack safety-net step instead of slack_search_public_and_private.
    Once cowork responds via /notify (with thread_ts = ts or thread_ts), the thread gets
    auto-marked joined and the same mention won't reappear on the next run.

    Slack bot scopes required (Bot Token Scopes in OAuth & Permissions):
      channels:read  + channels:history   for public channels
      groups:read    + groups:history     for private channels (e.g., #pm-team)
    After adding scopes, REINSTALL the app in the workspace. The endpoint degrades
    gracefully if some scopes are missing — it returns whatever it could read and
    populates "scope_warnings" with what's missing. If scope_warnings is non-empty,
    the response is partial and you should treat the missing channel types as opaque.

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
    "fact": "Short fact string (or, when source='opinion', a take/take-like opinion phrased as Nora's view)",
    "project": "Project name (empty string if general)",
    "added": "YYYY-MM-DD",
    "source": "meeting | slack | manual | system | auto | opinion",
    "source_bot_id": "Recall.ai bot ID linking to the meeting transcript this memory was extracted from (empty string if not from a meeting). Use GET /transcripts/{source_bot_id} to fetch the full transcript."
  }

  Note: memories with source='opinion' are rendered separately in Nora's system prompt as a
  [Your takes] block (vs. the [Your memory] block for everything else). Opinions are formed by
  the cowork loop's weekly Reflection Round — they're Nora's interpretations, not raw facts.
  The live handler distinguishes them so Nora frames opinions as opinions ("honestly I think...",
  "from what I've watched...") rather than as facts.

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
    "last_research_summary": "Optional free-text summary of the most recent research round",
    "teamwork_id": "Numeric Teamwork project ID, captured by /projects/sync-from-teamwork. Use as the project_id filter for twprojects-list_tasks / list_tasklists / list_milestones (which all work). Workaround for known MCP bugs: twprojects-get_project always 500s, twprojects-search fails on most queries (Go decode errors on comments/calendar events), and twprojects-list_projects 500s when given any page/page_size/search_term param. /projects/sync-from-teamwork uses Teamwork's REST API directly so it's unaffected by the MCP issues."
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
  - Google Drive: Search files, read documents/sheets, find shared resources. KNOWN BUG:
    the connector's create_file does NOT work on shared drives (returns "User cannot add
    children to the specified folder" — missing supportsAllDrives flag). copy_file works
    fine on shared drives. To write a NEW file to a client shared drive, use the two-hop
    pattern: create_file in a staging folder in My Drive, then copy_file from staging into
    the destination. See cowork-prompt.md "Writing Files to Client Shared Drives" for the
    full pattern + caching guidance.
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
     - Google Drive: Search FIRST for client/project context — briefs, meeting notes, deliverables, specs, presentations (briefs and meeting notes moved here from Confluence on 2026-05-21)
     - Confluence: Search for internal process documentation and client-specific operations docs (NOT briefs or meeting notes anymore)
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
     - Google Drive: client/project/campaign briefs, meeting notes, deliverables, decks, specs
       (briefs and meeting notes moved here from Confluence on 2026-05-21 — this is the
       primary source for client/project context now; leave $ amounts out of memory entries
       since they may surface in future Slack replies to non-approved recipients)
     - Confluence: internal process documentation and client-specific operations docs only
       (no longer holds briefs or meeting notes)
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
     { "summary": "Reconciled from Teamwork + deepened with Drive brief + recent task comments" }
     This bumps last_research_at and prevents re-picking the same project tomorrow.

  8. (Optional) Save a one-line general memory recording that the round happened:
     POST /memory
     { "fact": "Idle research round on Pitsco on 2026-05-09: added 4 memories (sources: Teamwork tasks/milestones, Drive brief)",
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
}

module.exports = { registerCoworkInstructionsRoute };
