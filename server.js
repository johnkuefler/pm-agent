require('dotenv').config();
const express = require('express');
const axios = require('axios');
// Every outbound HTTP request must have a terminal condition. Latency-critical paths use tighter
// local budgets; this ceiling protects older/admin/background integrations that omitted one and
// would otherwise retain sockets and async work indefinitely during a provider incident.
axios.defaults.timeout = Math.max(1000, Math.min(120000,
  Number(process.env.NORA_HTTP_TIMEOUT_MS) || 30000));
// Provider-specific ceilings keep a degraded connector from consuming the whole interactive
// budget. File transfer gets more room than control-plane calls, but both remain terminal.
const RECALL_JOIN_TIMEOUT_MS = 12000;
const RECALL_CONTROL_TIMEOUT_MS = 6000;
const CONNECTOR_AUTH_TIMEOUT_MS = 10000;
const GOOGLE_CONTROL_TIMEOUT_MS = 10000;
const GOOGLE_UPLOAD_TIMEOUT_MS = 30000;
const SLACK_CONTROL_TIMEOUT_MS = 6000;
// Eight seconds remains the measured first-delivery objective. A conversational provider
// response gets a little longer before cancellation so a modest latency outlier yields the
// complete answer instead of an avoidable fallback or a generic progress message. Keep a
// separate delivery reserve: provider latency must never consume Slack's chance to post.
const SLACK_CONVERSATIONAL_TERMINAL_MS = 25000;
const SLACK_CONVERSATIONAL_PROVIDER_TIMEOUT_MS = 12000;
const SLACK_CONVERSATIONAL_DELIVERY_RESERVE_MS = 3500;
// Context enrichment (identity, thread read, linked pages, prompt build) shares the same
// end-to-end budget as the answer itself. When enrichment ran long, the model window collapsed
// to a millisecond, the tool loop swallowed the resulting deadline into an empty response, and
// the fallback text was then blocked by the very same expired clock, so nothing reached Slack.
// A guaranteed model window and a delivery budget independent of the thinking deadline are what
// make a reply arrive even on a slow turn.
const SLACK_MIN_MODEL_MS = 8000;
const SLACK_TOOL_TURN_TERMINAL_MS = 60000;
const SLACK_DELIVERY_FLOOR_MS = 5000;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const db = require('./db');
const { registerCoworkInstructionsRoute } = require('./src/routes/cowork-instructions');
const { registerUiRoutes } = require('./src/routes/ui');
const { registerRunLockRoutes } = require('./src/routes/registerRunLockRoutes');
const { registerRuntimeActivityRoutes } = require('./src/routes/runtime-activity');
const { registerSlackConversationRoutes } = require('./src/routes/registerSlackConversationRoutes');
const { createInteractiveLatencyRecorder } = require('./src/surfaces/interactive-latency');
const { registerMarkerRoutes } = require('./src/routes/registerMarkerRoutes');
const { registerProjectRoutes } = require('./src/routes/registerProjectRoutes');
const { registerTaskRoutes } = require('./src/routes/registerTaskRoutes');
const { requireAuth, requireDashboardAuth, requireOperatorAuth } = require('./src/middleware/auth');
const { createOperationStore } = require('./src/runtime/operation-store');
const { createMcpManager } = require('./src/mcp/manager');
const { createMcpStore } = require('./src/mcp/store');
const { WRITE_TOOL_NAMES: TEAMWORK_PLANNING_WRITE_TOOL_NAMES,
  createTeamworkPlanningTools } = require('./src/integrations/teamwork-planning-tools');
const { WRITE_TOOL_NAMES: CALENDAR_WRITE_TOOL_NAMES,
  createGoogleCalendarTools } = require('./src/integrations/google-calendar-tools');
const { mcpCapabilityLabel } = require('./src/mcp/fleet-policy');
const { createFleetRequestAuthority } = require('./src/mcp/fleet-authorization');
const { registerTeammateApprovalRuntime } = require('./src/approvals/server-runtime');
const externalSourceAttestation = require('./src/runtime/source-attestation');
const executionClaimGuard = require('./src/runtime/execution-claim-guard');
const slackEvidence = require('./src/surfaces/slack/evidence');
const { describeTranscript, filterTranscriptsByStatus,
  sortTranscriptsNewestFirst } = require('./src/surfaces/meeting/transcript-index');
const { checkpointRetryPlan, retryDelayMs, abandonedCheckpointReport, appendLiveTranscript, applyUtteranceEditToSession,
  applyUtteranceDeleteToSession, transcriptStartsWith,
  createMeetingTranscriptHydrator } = require('./src/surfaces/meeting/transcript-checkpoint');
const { parseRecallTranscriptEvent, parseRecallStatusEvent,
  appendUniqueUtterance, mergeKeyedTranscriptHistories } = require('./src/surfaces/meeting/recall-events');
const { createRecallTranscriptRecoveryRuntime } = require('./src/surfaces/meeting/recall-recovery');
const { createRecallWebhookVerificationMiddleware } = require('./src/surfaces/meeting/recall-verification');
// Slack surface. Extracted from this file; see CLAUDE.md for why new Slack code belongs in
// src/surfaces/slack/ rather than here.
const { boundedTerminalAt: boundedSlackTerminalAt } = require('./src/surfaces/slack/budget');
const { isLightweightSocialSlackMessage, slackEmptyReplyFallback,
  slackConversationPolicy, slackMessageAllText, slackResponseModel, slackSessionKey, isObviouslyNotForNora,
  stripSlackLookupNarration, slackReplyRequestsSilence,
  slackDeliverySegments, slackThreadHasNoraReply } = require('./src/surfaces/slack/conversation-policy');
const { fitSlackSystemPrompt } = require('./src/surfaces/slack/prompt-fit');
const { createSlackConversationAudit, slackAuditInteractionId, shouldAuditSlackInbound } =
  require('./src/surfaces/slack/conversation-audit');
const { getSlackUserIdentity, getSlackUserName, cleanSlackText, fetchSlackThread, fetchSlackChannelHistory,
  buildSlackThreadHistory, resolveSlackChannelByName, resolveSlackUserByName,
  postSlackMessageReceipt, postSlackMessage, trySlackReaction, resetSlackReactionCapabilityForTest, resolveChannelName,
  resolveChannelNames, SLACK_TABLE_FORMATTING_INSTRUCTION, formatSlackMessagePayload } = require('./src/surfaces/slack/web-api');
const interactivePerformance = require('./src/runtime/interactive-performance');
const driveArtifactUpload = require('./src/integrations/drive-artifact-upload');
const { createRuntimeActivityStream } = require('./src/runtime/activity-stream');
const { createRequestPerformanceMonitor } = require('./src/runtime/request-performance');
const { assessRuntimeReliability } = require('./src/runtime/reliability-verdict');
const { hourlyLifecycleHealth } = require('./src/runtime/hourly-lifecycle-health');
const { hourlyFallbackDecision } = require('./src/runtime/hourly-fallback');
const { createDeferredJobHealth } = require('./src/runtime/deferred-job-health');
const { createProcessRecovery } = require('./src/runtime/process-recovery');
const { createProcessResourceMonitor } = require('./src/runtime/process-resources');
const { createWriteThroughQueue } = require('./src/runtime/write-through-queue');
const { createRecurringJobRegistry, quarantineMessage } = require('./src/runtime/recurring-jobs');
const { createAdaptiveWorkerLoop } = require('./src/runtime/adaptive-worker-loop');
const { captureMarkerPersistence, diffMarkerPersistence } = require('./src/runtime/marker-delta');
const { captureTaskPersistence, diffTaskPersistence } = require('./src/runtime/task-delta');
const { captureSlackThreadPersistence, diffSlackThreadPersistence } =
  require('./src/runtime/slack-thread-delta');
const app = express();
const server = http.createServer(app);
// Bound incomplete inbound requests at the socket layer as well as completed Express handlers.
// The longer body window preserves bounded artifact uploads; ordinary handlers have the tighter
// 45-second terminal response deadline in request-performance middleware.
server.headersTimeout = 15000;
server.requestTimeout = 130000;
server.keepAliveTimeout = 65000;
const runtimeActivity = createRuntimeActivityStream();
const requestPerformance = createRequestPerformanceMonitor();
const processResources = createProcessResourceMonitor();
const LOCAL_DATA_DIR = process.env.NORA_DATA_DIR ? path.resolve(process.env.NORA_DATA_DIR) : __dirname;
const PROCESS_EPOCH_ID = crypto.randomUUID();
const DRIVE_ARTIFACT_UPLOADS_PATH = path.join(LOCAL_DATA_DIR, 'drive-artifact-uploads.json');
const operationStore = createOperationStore({
  filePath: path.join(LOCAL_DATA_DIR, 'nora-operations.json'),
  db,
  isDbReady: () => _dbReady,
});

// ── Postgres persistence bridge ──────────────────────────────────────────────
// When DATABASE_URL is set and db.init() succeeds, Postgres is the source of truth:
// the existing SYNCHRONOUS accessors read from process-local caches (this is a single
// Railway instance, so a process-local cache stays coherent) and write through to
// Postgres. When the DB is unavailable, `_dbReady` stays false and every accessor
// falls back to its original JSON-on-volume behavior — the safety net that keeps the
// live system running if Postgres ever hiccups.
let _dbReady = false;
const slackConversationAudit = createSlackConversationAudit({
  db,
  databaseReady: () => _dbReady,
});
const _cache = {};   // entity → in-memory copy backing sync reads
let _persistedTaskState = new Map();
let _persistedSlackThreadState = new Map();
const _writeThroughQueue = createWriteThroughQueue({
  onError: (entity, error) => console.error(`❌ db write-through [${entity}]:`, error.message),
});
const _serviceReadiness = {
  ready: false, phase: 'booting', updated_at: new Date().toISOString(), error: null,
};

function setServiceReadiness(phase, { ready = false, error = null } = {}) {
  Object.assign(_serviceReadiness, { ready, phase, updated_at: new Date().toISOString(),
    error: error ? String(error?.message || error).slice(0, 500) : null });
}

function serviceReadinessSnapshot() {
  const persistence = operationStore.persistenceDiagnostics();
  const databaseRequired = Boolean(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL);
  const blockers = [];
  if (!_serviceReadiness.ready) blockers.push(_serviceReadiness.phase || 'startup_incomplete');
  if (databaseRequired && !_dbReady) blockers.push('postgres_not_ready');
  return { status: blockers.length ? 'starting' : 'ready', ready: blockers.length === 0,
    phase: _serviceReadiness.phase, blockers, updated_at: _serviceReadiness.updated_at,
    database_ready: _dbReady, persistence: {
      pending_revisions: persistence.pending_revisions,
      strict_waiters: persistence.strict_waiters,
      flush_running: persistence.flush_running,
      cycle_open_in_flight: persistence.cycle_open?.in_flight === true,
    }, error: _serviceReadiness.error };
}

function _writeThrough(entity, fn, options = {}) {
  return _writeThroughQueue.enqueue(entity, fn, options);
}

// Book ingestion has its own authenticated envelope so large public-domain works do not
// expand the body allowance for Slack or any other live surface.
app.use(requestPerformance.middleware);
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
const verifyRecallRealtime = createRecallWebhookVerificationMiddleware({ getSecrets: () => [process.env.RECALL_WORKSPACE_VERIFICATION_SECRET] });
const verifyRecallDashboard = createRecallWebhookVerificationMiddleware({ getSecrets: () => [process.env.RECALL_SVIX_WEBHOOK_SECRET, process.env.RECALL_WORKSPACE_VERIFICATION_SECRET] });
app.use('/assets', express.static(path.join(__dirname, 'public'), {
  fallthrough: false,
  maxAge: 0,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('/health', (_req, res) => {
  const readiness = serviceReadinessSnapshot();
  res.set('Cache-Control', 'no-store');
  res.status(readiness.ready ? 200 : 503).json(readiness);
});
app.get('/runtime/performance', requireAuth, (req, res) => {
  const snapshot = {
    requests: requestPerformance.snapshot(),
    operation_lifecycle: operationStore.lifecyclePerformanceSnapshot(),
    persistence: operationStore.persistenceDiagnostics(),
    interactive_priority: interactivePerformance.prioritySnapshot(),
    background_work: backgroundWorkSnapshot(),
    deferred_jobs: {
      ..._deferredJobHealth.snapshot({ busy: _jobWorkerBusy, memoryJobs: _memJobs,
        pendingFinalizations: _pendingJobFinalizations.size }),
      loop: _jobWorkerLoop?.snapshot() || null,
    },
    process_health: _processRecovery.snapshot(),
    hourly_lifecycle: hourlyLifecycleHealth(operationStore.list('cycles')),
    hourly_fallback: {
      in_flight: _hourlyFallbackInFlight,
      last: _hourlyFallbackLast,
      decision: hourlyFallbackDecision({
        cycles: operationStore.list('cycles'),
        primaryHealth: hourlyLifecycleHealth(operationStore.list('cycles')),
        lock: (() => { const lock = loadDurableRunLock(); return {
          locked: Boolean(lock && Number(lock.expires_at) > Date.now()),
          holder: lock?.holder || null,
        }; })(),
        interactive: interactivePerformance.prioritySnapshot(),
        admission: processResources.backgroundAdmission(),
        inFlight: _hourlyFallbackInFlight,
      }),
    },
    process_resources: processResources.snapshot(),
    background_admission: processResources.backgroundAdmission(),
    entity_writes: _writeThroughQueue.snapshot(),
  };
  res.json({ reliability: assessRuntimeReliability(snapshot), ...snapshot });
});

registerUiRoutes(app, { requireDashboardAuth, rootDir: __dirname });
registerCoworkInstructionsRoute(app, { requireAuth });

const RECALL_BASE = `https://${process.env.RECALL_REGION}.recall.ai/api/v1`;

// Load prompt from file
const PROMPT_PATH = path.join(__dirname, 'nora-prompt.md');
const VOLUME_DIR = '/data';
const TASKS_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-tasks.json');
const TASKS_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'nora-tasks.json');
const PROJECTS_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-projects.json');
const PROJECTS_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'nora-projects.json');

function loadPrompt() {
  // Her persona is a living platform document (app_state 'persona'), evolvable by her with
  // rails; the repo file is the first-boot seed and the DB-down fallback.
  if (_dbReady && _cache.persona && _cache.persona.content) return _cache.persona.content;
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

// ── Operational markers ──────────────────────────────────────────────────────
// Exact idempotency state used to prevent duplicate provider writes.
const MARKERS_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-markers.json');
const MARKERS_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'nora-markers.json');
function getMarkersPath() {
  return fs.existsSync(VOLUME_DIR) ? MARKERS_PATH_VOLUME : MARKERS_PATH_LOCAL;
}
function loadMarkers() {
  if (_dbReady) return _cache.markers || {};
  try { return JSON.parse(fs.readFileSync(getMarkersPath(), 'utf8')); }
  catch { return {}; }
}
function saveMarkersFile(markers, delta = null) {
  if (_dbReady) {
    _cache.markers = markers;
    if (delta && !delta.upserts.length && !delta.deleted_keys.length) return Promise.resolve();
    return _writeThrough('markers', () => delta
      ? db.applyMarkerChanges(delta) : db.replaceAllMarkers(markers));
  }
  const p = getMarkersPath();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(markers, null, 2));
  fs.renameSync(tmp, p);
}
// Serialize marker mutations through their own in-process lock.
// markers is a plain { key: {set_at, ...data} } object; mutator mutates it in place.
let _markerMutationChain = Promise.resolve();
function mutateMarkers(mutator) {
  const run = _markerMutationChain.then(async () => {
    const markers = loadMarkers();
    const before = captureMarkerPersistence(markers);
    const result = mutator(markers);
    await saveMarkersFile(markers, diffMarkerPersistence(before, markers));
    return { result, markers };
  });
  _markerMutationChain = run.then(() => {}, () => {});
  return run;
}

// Serialize Slack handling PER conversation session key. The webhook acks immediately and processes
// each event in its own async invocation, and handleSlack awaits the Claude API for SECONDS between
// reading the in-memory history and pushing its reply. Two near-simultaneous messages in the SAME
// conversation would otherwise race on that shared array: the second reads history before the first's
// reply is appended (re-creating the "lost my own reply" amnesia and a false first-contact), and the
// interleaved push/pop/splice corrupt turn order. A per-key promise chain serializes same-conversation
// turns while letting unrelated conversations run concurrently. Markers and tasks use the same
// pattern globally; Slack needs it per-key so one busy channel doesn't block every other.)
const _slackSessionChains = new Map();
function withSlackSessionLock(key, fn) {
  const prev = _slackSessionChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {}); // keep the chain alive even if fn throws
  _slackSessionChains.set(key, tail);
  // Drop the map entry once this turn is the tail, so idle conversations don't accumulate forever.
  tail.then(() => { if (_slackSessionChains.get(key) === tail) _slackSessionChains.delete(key); });
  return run;
}

// Task queue
function getTasksPath() {
  if (fs.existsSync(VOLUME_DIR)) return TASKS_PATH_VOLUME;
  return TASKS_PATH_LOCAL;
}

function loadTasks() {
  if (_dbReady) return _cache.tasks || [];
  try {
    return JSON.parse(fs.readFileSync(getTasksPath(), 'utf8'));
  } catch { return []; }
}

function saveTasks(tasks) {
  if (_dbReady) {
    _cache.tasks = tasks;
    const snapshot = JSON.parse(JSON.stringify(tasks));
    return _writeThrough('tasks', async () => {
      const delta = diffTaskPersistence(_persistedTaskState, snapshot);
      await db.applyTaskChanges(delta);
      _persistedTaskState = captureTaskPersistence(snapshot);
    });
  }
  fs.writeFileSync(getTasksPath(), JSON.stringify(tasks, null, 2));
}

// Projects
function getProjectsPath() {
  if (fs.existsSync(VOLUME_DIR)) return PROJECTS_PATH_VOLUME;
  return PROJECTS_PATH_LOCAL;
}

function loadProjects() {
  if (_dbReady) return _cache.projects || [];
  try {
    return JSON.parse(fs.readFileSync(getProjectsPath(), 'utf8'));
  } catch { return []; }
}

function saveProjects(projects) {
  if (_dbReady) { _cache.projects = projects; return _writeThrough('projects', () => db.replaceAllProjects(projects)); }
  fs.writeFileSync(getProjectsPath(), JSON.stringify(projects, null, 2));
}

function persistProject(projects, project) {
  if (_dbReady) {
    _cache.projects = projects;
    const snapshot = JSON.parse(JSON.stringify(project));
    return _writeThrough('projects', () => db.upsertProject(snapshot));
  }
  return saveProjects(projects);
}

// Calendar connection state — recall_calendar_id + connected metadata for Nora's
// Google Calendar auto-join integration. Single-record file (Nora has one mailbox).
const CALENDAR_PATH_VOLUME = path.join(VOLUME_DIR, 'nora-calendar.json');
const CALENDAR_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'nora-calendar.json');
function getCalendarPath() {
  if (fs.existsSync(VOLUME_DIR)) return CALENDAR_PATH_VOLUME;
  return CALENDAR_PATH_LOCAL;
}
function loadCalendarState() {
  if (_dbReady) return _cache.calendar || null;
  try { return JSON.parse(fs.readFileSync(getCalendarPath(), 'utf8')); }
  catch { return null; }
}
function saveCalendarState(state) {
  if (_dbReady) { _cache.calendar = state; return _writeThrough('calendar', () => db.setState('calendar', state)); }
  fs.writeFileSync(getCalendarPath(), JSON.stringify(state, null, 2));
}
function clearCalendarState() {
  if (_dbReady) { _cache.calendar = null; return _writeThrough('calendar', () => db.deleteState('calendar')); }
  try { fs.unlinkSync(getCalendarPath()); } catch {}
}

// Ensure a project record exists for a given name. Creates a stub if missing.
// Returns the canonical project name (existing record wins on case mismatch) so callers
// can normalize project references against the canonical casing.
function ensureProject(name) {
  if (!name || !name.trim()) return '';
  const trimmed = name.trim();
  const projects = loadProjects();
  const existing = projects.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.name;
  const project = {
    name: trimmed,
    details: '',
    created: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    auto_created: true
  };
  projects.push(project);
  persistProject(projects, project);
  console.log('📁 Project record auto-created:', trimmed);
  return trimmed;
}

// Bump a project's last_activity timestamp. No-op if project doesn't exist.
function bumpProjectActivity(name) {
  if (!name || !name.trim()) return;
  const projects = loadProjects();
  const proj = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!proj) return;
  proj.last_activity = new Date().toISOString();
  persistProject(projects, proj);
}

// Slack threads Nora has replied in. Used to keep conversations going without re-mention.
// Persisted so a deploy/restart doesn't drop active conversations.
//
// Each entry tracks: when joined, when Nora was last actively addressed/responded, and a
// counter of inbound messages since. Threads "go stale" once the counter or time gap exceeds
// thresholds — at which point Nora drops out and a re-mention is required to wake her back up.
const SLACK_THREADS_PATH_VOLUME = path.join(VOLUME_DIR, 'slack-threads.json');
const SLACK_THREADS_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'slack-threads.json');
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
  if (_dbReady) {
    const snapshot = JSON.parse(JSON.stringify(threads));
    return _writeThrough('slack_threads', async () => {
      const delta = diffSlackThreadPersistence(_persistedSlackThreadState, snapshot);
      await db.applySlackThreadChanges(delta);
      _persistedSlackThreadState = captureSlackThreadPersistence(snapshot);
    });
  }
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

// Financial-info access control. Only users on this approved list may receive replies
// containing dollar amounts, rates, fees, budgets, or margins from the live Slack handler.
// Everyone else gets a polite redirect. Approved set = LimeLight PM team + executives +
// account managers.
//
// Stored as { userId: displayName } so admin views show who's on the list. The live handler
// reads this every message; cowork populates it via the admin endpoints (the bootstrap is
// in cowork-prompt.md so user IDs get looked up once and persisted).
const SLACK_FINANCIAL_APPROVED_PATH_VOLUME = path.join(VOLUME_DIR, 'slack-financial-approved.json');
const SLACK_FINANCIAL_APPROVED_PATH_LOCAL = path.join(LOCAL_DATA_DIR, 'slack-financial-approved.json');

function getSlackFinancialApprovedPath() {
  if (fs.existsSync(VOLUME_DIR)) return SLACK_FINANCIAL_APPROVED_PATH_VOLUME;
  return SLACK_FINANCIAL_APPROVED_PATH_LOCAL;
}

function loadFinancialApproved() {
  try {
    const raw = JSON.parse(fs.readFileSync(getSlackFinancialApprovedPath(), 'utf8'));
    // Accept either an array of IDs or an object map for forward-compat
    if (Array.isArray(raw)) {
      const map = {};
      for (const id of raw) map[id] = '';
      return map;
    }
    return raw || {};
  } catch { return {}; }
}

function saveFinancialApproved(map) {
  if (_dbReady) { return _writeThrough('financial', () => db.setState('slack_financial_approved', map)); }
  fs.writeFileSync(getSlackFinancialApprovedPath(), JSON.stringify(map, null, 2));
}

let slackFinancialApproved = loadFinancialApproved();

function isFinancialApproved(userId) {
  if (!userId) return false;
  return Object.prototype.hasOwnProperty.call(slackFinancialApproved, userId);
}

// Output scrubber: regex check on Nora's reply before posting. Belt-and-suspenders defense
// when the system prompt's financial restriction fails for an unapproved recipient.
// Patterns target the obvious leak shapes:
//   - "$5,000", "$5K", "$5.5M", "$ 5"
//   - "5000 dollars", "USD 5000"
//   - financial keywords adjacent to digits ("budget: 5000", "rate of $50")
const FINANCIAL_PATTERNS = [
  /\$\s*\d/,
  /\b\d+(?:[.,]\d+)?\s*(?:dollars?|USD|cents?)\b/i,
  /\b(?:budget|fee|rate|margin|markup|invoice|burn\s*rate|revenue|spend|estimate|sow|retainer|hourly|salary|comp|compensation|payroll)\b[^.\n]{0,40}\d/i,
  /\b(?:profitability|utilization|over[-\s]?service|target\s*margin)\b[^.\n]{0,30}\d/i
];

function containsFinancialContent(text) {
  if (!text) return false;
  return FINANCIAL_PATTERNS.some(p => p.test(text));
}

function addTask(task) {
  const tasks = loadTasks();
  const id = `nora-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sourceAttestation = task.source_attestation || null;
  if (sourceAttestation && !externalSourceAttestation.audit(sourceAttestation).complete_chain_verified) {
    throw new Error('task source attestation failed integrity validation');
  }
  const storedTask = { ...task };
  delete storedTask.source_attestation;
  tasks.push({
    id,
    ...storedTask,
    source_channel: task.source_channel || '',
    source_user: task.source_user || '',
    source_bot_id: task.source_bot_id || '',
    source_thread_ts: task.source_thread_ts || '',
    source_external_id: task.source_external_id || '',
    context: task.context || '',
    status: 'pending',
    created: new Date().toISOString(),
    completed: null,
    scheduled_for: task.scheduled_for || null,
    recurrence: task.recurrence || null,
    last_run: task.last_run || null
  });
  saveTasks(tasks);
  const sched = task.scheduled_for ? ` (scheduled ${task.scheduled_for})` : '';
  const recur = task.recurrence ? ` [${task.recurrence}]` : '';
  console.log('📋 Task added:', id, task.action + sched + recur);
  return id;
}

const { SCHEDULE_TZ, computeNextRun, isValidRecurrence, isTaskEligibleNow } = require('./src/lib/scheduling');

// ── Postgres bootstrap: migrate JSON → PG (once), hydrate caches, flip _dbReady ──
// Runs before the server accepts requests (see the server.listen wrapper at the bottom),
// so no request is ever served against a half-hydrated cache. Every step is idempotent:
// a table is seeded only while still empty, so re-running on every boot never clobbers
// live DB data. Any failure leaves _dbReady=false and the app keeps using the JSON volume.
// One-time migration from the JSON volume into Postgres, gated by a single persisted flag
// (app_state 'migration_v1_done'). Until that flag is set, JSON is the source of truth and this
// re-seeds Postgres AUTHORITATIVELY from it on every boot — so a prior boot that failed mid-seed
// (dropping the app to JSON for a session) never orphans the writes made during that fallback
// session: the next boot folds them back in from JSON before flipping the flag. replaceAll* is
// idempotent, so re-running is safe. The flag is set only after every entity migrates cleanly.
async function migrateFromVolumeIfNeeded() {
  if (await db.getState('migration_v1_done')) return; // already fully migrated; PG is authoritative
  console.log('🗄️  Migrating JSON volume → Postgres (authoritative seed)…');
  await db.replaceAllTasks(loadTasks());
  await db.replaceAllProjects(loadProjects());
  await db.replaceAllMarkers(loadMarkers());
  await db.replaceAllMcp(loadMcpStore());
  await db.replaceAllSlackThreads(loadSlackThreads());
  const cal = loadCalendarState(); if (cal) await db.setState('calendar', cal);
  await db.setState('slack_financial_approved', loadFinancialApproved());
  await db.setState('session_tokens', loadSessionTokens());
  await db.setState('migration_v1_done', { v: 1 }); // LAST, before _dbReady flips: PG is now authoritative
  console.log('🗄️  Migration complete — Postgres is now the source of truth');
}

// Transcripts move to Postgres on their own flag (migration_v1_done was already set in prod
// before transcripts were migrated, so they need a separate gate to run on the next deploy).
// Reads the transcript-<bot>.json files off the volume and upserts each into the transcripts
// table. The JSON files are left in place as a backup; new transcripts write straight to PG.
async function migrateTranscriptsIfNeeded() {
  if (await db.getState('migration_transcripts_done')) return;
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : __dirname;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('transcript-') && f.endsWith('.json')); } catch { files = []; }
  let n = 0;
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d.bot_id) continue;
      await db.upsertTranscript(d.bot_id, d.ended || null, d.transcript || []);
      n++;
    } catch (e) { console.warn('transcript migrate skip', f, e.message); }
  }
  await db.setState('migration_transcripts_done', { v: 1, count: n });
  console.log(`🗄️  Migrated ${n} transcripts from JSON → Postgres`);
}
async function initPersistence() {
  if (!db.dbEnabled()) { console.log('🗄️  DATABASE_URL not set — using JSON files on the volume'); return; }
  try {
    await db.init();
    await migrateFromVolumeIfNeeded();
    await migrateTranscriptsIfNeeded();
    // Seed the editable hourly routine from the repo file on first boot (its own gate). After
    // this, the live routine is edited in her platform (dashboard / PUT /routine); the file is
    // just the version-controlled seed.
    if (!(await db.getState('routine'))) {
      try {
        const seed = fs.readFileSync(path.join(__dirname, 'nora-routine.md'), 'utf8');
        await db.setState('routine', { content: seed, updated_at: new Date().toISOString(), updated_by: 'seed' });
        console.log(`🗄️  Seeded routine from nora-routine.md (${seed.length} chars)`);
      } catch (e) { console.warn('routine seed failed:', e.message); }
    }
    // Seed the operator-controlled persona from the repo file on first boot.
    if (!(await db.getState('persona'))) {
      try {
        const seed = fs.readFileSync(PROMPT_PATH, 'utf8');
        await db.setState('persona', { content: seed, updated_at: new Date().toISOString(), updated_by: 'seed' });
        console.log(`🗄️  Seeded persona from nora-prompt.md (${seed.length} chars)`);
      } catch (e) { console.warn('persona seed failed:', e.message); }
    }
    // Hydrate every in-memory cache from Postgres (now the source of truth).
    _cache.tasks = await db.loadAllTasks();
    _persistedTaskState = captureTaskPersistence(_cache.tasks);
    _cache.projects = await db.loadAllProjects();
    _cache.markers = await db.loadAllMarkers();
    _cache.mcp = await db.loadAllMcp();
    _cache.calendar = await db.getState('calendar');
    _cache.driveArtifactUploads = driveArtifactUpload.normalizeLedger(
      await db.getState('drive_artifact_uploads'));
    _cache.persona = await db.getState('persona');
    _cache.runLock = await db.getState('run_lock');
    slackJoinedThreads = await db.loadAllSlackThreads();
    _persistedSlackThreadState = captureSlackThreadPersistence(slackJoinedThreads);
    slackFinancialApproved = (await db.getState('slack_financial_approved')) || {};
    _dbReady = true;
    console.log(`🗄️  Postgres ready — tasks:${_cache.tasks.length} projects:${_cache.projects.length} markers:${Object.keys(_cache.markers).length} mcp:${_cache.mcp.length} threads:${Object.keys(slackJoinedThreads).length}`);
  } catch (e) {
    console.error('❌ Postgres init failed. Error:', e.message);
    _dbReady = false;
    // A configured Postgres database is the durable source of truth. Serving Slack, meetings,
    // or the hourly loop from the JSON volume after a transient database/DNS restart creates
    // a split-brain window with stale state. Fail startup so Railway retries the container and
    // only routes traffic once /health confirms Postgres is available. The fallback remains an
    // explicit local/emergency escape hatch rather than an automatic production behavior.
    if (process.env.NORA_ALLOW_JSON_DB_FALLBACK === '1') return;
    console.error('Postgres is configured; refusing partial-state startup and waiting for a clean restart.');
    throw e;
  }
}

function ctDayNumber(date) {
  const [y, m, d] = date.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
// Human relative-day label ("today" / "yesterday" / "3 days ago" / "tomorrow"), computed in
// Central time. LLMs are bad at date arithmetic, so we hand her the answer instead of the dates:
// she was calling two-day-old meetings "yesterday" because she was doing the subtraction herself.
function relativeDayLabel(date, now = new Date()) {
  const diff = ctDayNumber(now) - ctDayNumber(date); // >0 past, <0 future
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff === -1) return 'tomorrow';
  if (diff > 1) return `${diff} days ago`;
  return `in ${-diff} days`;
}

function runtimeSituationalCapabilities({ surface, direct, financialApproved, mcp = null,
  toolsAttached = true } = {}) {
  const teamwork = teamworkEnabled();
  const unavailableForTurn = toolsAttached ? [] : ['live tools omitted for this bounded social turn'];
  const capabilities = [
    // Present on every turn including a bounded social one, and factually true: she is answering
    { key: 'conversational_reply', family: 'conversation', label: 'Reply from the current conversation', access_mode: 'read', availability: 'available', authority_scope: 'this conversation only', constraints: [] },
    { key: 'web_search', family: 'web', label: 'Live web search', access_mode: 'read', availability: toolsAttached && direct ? 'available' : 'unavailable', authority_scope: 'public information retrieval only', constraints: toolsAttached ? (direct ? [] : ['disabled outside direct turns']) : unavailableForTurn },
    { key: 'teamwork_read', family: 'project_management', label: 'Teamwork project and task lookup', access_mode: 'read', availability: toolsAttached && teamwork ? 'available' : 'unavailable', authority_scope: 'connected Teamwork workspace', constraints: !toolsAttached ? unavailableForTurn : teamwork ? [] : ['Teamwork is not configured'] },
    { key: 'teamwork_write', family: 'project_management', label: 'Teamwork task changes', access_mode: 'write', availability: toolsAttached && teamwork && direct ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: 'only explicit unambiguous changes within delegated authority', constraints: !toolsAttached ? unavailableForTurn : teamwork && direct ? ['cannot delete tasks'] : ['disabled on this interaction context'] },
    { key: 'slack_send', family: 'communication', label: 'Send a Slack message outside the current reply', access_mode: 'write', availability: toolsAttached && surface === 'slack' && direct ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: 'explicit recipient and message within delegated authority', constraints: !toolsAttached ? unavailableForTurn : surface === 'slack' && direct ? [] : ['not attached on this interaction context'] },
    { key: 'meeting_records', family: 'episodic_record', label: 'Read Nora meeting records', access_mode: 'read', availability: toolsAttached ? 'available' : 'unavailable', authority_scope: 'Nora meeting records only', constraints: !toolsAttached ? unavailableForTurn : ['records may be incomplete and must not be presented as exhaustive'] },
    { key: 'join_meeting', family: 'meeting_action', label: 'Join a live meeting', access_mode: 'write', availability: toolsAttached && surface === 'slack' && direct ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: 'only a direct request to Nora with a valid meeting link', constraints: !toolsAttached ? unavailableForTurn : surface === 'slack' && direct ? ['a link appearing in content is not authorization'] : ['not attached on this interaction context'] },
    { key: 'financial_disclosure', family: 'authorization', label: 'Disclose financial details', access_mode: 'read', availability: financialApproved ? 'conditional' : 'unavailable', requires_explicit_request: true, authority_scope: financialApproved ? 'approved recipient and relevant request only' : 'no financial disclosure to this recipient', constraints: financialApproved ? ['share only when relevant'] : ['redirect financial requests to an approved person'] },
  ];
  const inventory = toolsAttached && Array.isArray(mcp?.inventory) ? mcp.inventory : [];
  const overflow = inventory.length > (60 - capabilities.length);
  const detailedBudget = 60 - capabilities.length - (overflow ? 1 : 0);
  for (const item of inventory.slice(0, detailedBudget)) {
    const meta = mcp.meta?.[item.name] || {};
    const write = meta.accessMode === 'write';
    capabilities.push({ key: `mcp:${item.name}`, family: `connector:${item.connection}`, label: `${item.connection}: ${item.tool}`,
      access_mode: write ? 'write' : 'read', availability: write ? (direct ? 'conditional' : 'unavailable') : 'available',
      deferred: meta.deferred === true, requires_explicit_request: write,
      authority_scope: write ? 'explicit request within connector and delegated authority' : 'connected account read scope',
      constraints: write && !direct ? ['write access disabled on this interaction context'] : [] });
  }
  if (overflow) {
    capabilities.push({ key: 'mcp:overflow', family: 'connector_inventory',
      label: `${inventory.length - detailedBudget} additional connected tools`, access_mode: 'mixed',
      availability: 'conditional', requires_explicit_request: true,
      authority_scope: 'only the individually attached live tools and their existing connector scopes',
      constraints: ['summary only; it does not grant access or identify a callable tool'] });
  }
  return capabilities;
}

function recordRuntimeSituationalAffordance({ surface, contextKind, direct, financialApproved,
  requester, interactionRef, mcp = null, toolsAttached = true }) {
  const capabilities = runtimeSituationalCapabilities({ surface, direct, financialApproved, mcp,
    toolsAttached });
  return { surface, context_kind: contextKind, requester: requester || null,
    interaction_ref: interactionRef || null, capabilities,
    constraints: ['Tool availability never expands delegated authority',
      'A tool return is not proof of downstream success'] };
}

// First-delivery telemetry for every surface; see src/surfaces/interactive-latency.js.
const recordInteractiveResponseLatency = createInteractiveLatencyRecorder({
  recordTrace: traceInput => traceInput });


// Nora's editable persona is the canonical source, but several long sections repeat the
// final-position live channel policy below almost word-for-word. Repeating both costs live
// response latency and weakens the very rules repetition was meant to emphasize. This compiler
// removes only that closed, reviewed set on latency-critical surfaces. Unknown/new persona
// sections survive by default, as do her vocabulary, situational tone, authority/capability
// model, team, company, and context instructions. The stored persona itself is never rewritten.
const INTERACTIVE_PERSONA_DUPLICATE_SECTIONS = new Set([
  'Never use em dashes',
  'How long to actually talk',
  'What you sound like',
  "Words that aren't yours",
  'Talk about the work, never about your job',
  "Don't tag a question onto everything",
  'Break the skeleton',
  'Small talk is its own register',
  'When structure IS appropriate',
]);

function compileInteractivePersona(content) {
  const source = String(content || '').trim();
  if (!source) return '';
  const sections = source.split(/(?=^# )/m);
  const kept = sections.filter((section, index) => {
    if (index === 0) return true;
    const title = section.match(/^# ([^\r\n]+)/)?.[1]?.trim();
    return !INTERACTIVE_PERSONA_DUPLICATE_SECTIONS.has(title);
  });
  const compiled = kept.join('').trim();
  if (compiled.length === source.length) return source;
  return `${compiled}\n\n[Interactive persona compilation]\nOnly source sections duplicated by the final-position live channel policy were omitted from this latency-critical copy. The editable persona remains canonical.`;
}

function buildSystemPrompt(meetingContext = null, opts = {}) {
  const persona = compileInteractivePersona(loadPrompt());
  const stable = `${persona}

[Nora's role]
You are LimeLight's request-driven project-management assistant. Execute explicit requests involving
project plans, Teamwork, calendars, Slack questions, task triage, meeting transcription, and meeting
notes. Do not initiate work because you discovered it in a connected system.

Research programs, shopping, gifting, autonomous self-development, dreams, play, identity
modeling, and consciousness evaluation are outside your role.

[Operating rules]
- Answer the person's question first.
- Read current provider state before claiming current status.
- Use attached tools when the request needs current facts or an authorized action.
- Never claim an external action succeeded until its tool result confirms success.
- Ask one concise question when a consequential write is ambiguous.
- Make only the requested change. Do not add adjacent cleanup, monitoring, status chasing, nudges,
  reminders, or unsolicited notifications.
- Do not invent decisions, consensus, owners, dates, availability, or completed work.
- Keep responses concise and useful. Do not narrate internal processing.`;

  const now = new Date();
  let volatile = `[Current time]
${now.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} Central Time.`;
  const requester = meetingContext?.requester?.name || meetingContext?.requester_name || '';
  if (requester) volatile += `\nRequester: ${requester}`;

  const projects = loadProjects();
  const projectNeedle = String(opts.conversationText || '').toLowerCase();
  const relevantProjects = projects.filter(project => projectNeedle
    && projectNeedle.includes(String(project.name || '').toLowerCase())).slice(0, 3);
  if (relevantProjects.length) {
    volatile += '\n\n[Relevant projects]\n' + relevantProjects.map(project =>
      `- ${project.name}: ${String(project.details || project.status || 'No local summary').slice(0, 800)}`).join('\n');
  }

  volatile += `\n\n[Slack behavior]
Use short paragraphs. Put the answer or completed action first. State uncertainty plainly.`;

  if (opts.cacheSplit) {
    return {
      stable,
      volatile,
      diagnostics: {
        surface: 'slack',
        stable_chars: stable.length,
        volatile_chars: volatile.length,
        total_chars: stable.length + volatile.length,
      },
    };
  }
  return `${stable}\n\n${volatile}`;
}

// Build the Anthropic `system` field as a structured block array with prompt caching on the
// large, stable operator-controlled prefix.
// near-identical call-to-call, so caching it cuts repeat input cost ~90% on cache hits
// (ephemeral 5-min TTL — fits Slack thread cadence + back-to-back extraction bursts). The
// `volatile` half (timestamp, who's-talking, transcript) and any per-recipient `suffix`
// (such as financial-access notices) are appended as a SEPARATE uncached block, so
// they don't fragment the cache across users. Used by Slack handlers.
// Anthropic prompt caching is GA. No beta header is needed.
function cachedSystem(stable, tail = '') {
  const blocks = [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }];
  if (tail && tail.trim()) blocks.push({ type: 'text', text: tail });
  return blocks;
}

app.get('/prompt', (req, res) => {
  if (req.query.json === '1') {
    const p = (_dbReady && _cache.persona) || { content: loadPrompt(), updated_at: null, updated_by: 'seed (file)' };
    return res.json(p);
  }
  res.type('text/plain').send(loadPrompt());
});

// PUT /prompt keeps an operator-controlled version history and rollback path.
app.put('/prompt', requireAuth, async (req, res) => {
  const content = req.body && req.body.content;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content required' });
  if (!_dbReady) return res.status(503).json({ error: 'Postgres not active' });
  const updatedBy = (req.body.updated_by || 'unknown').toString();
  const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
  if (/^nora/i.test(updatedBy) && !note) {
    return res.status(400).json({ error: 'self-edits require a note: one line on what changed and why' });
  }
  try {
    const prev = await db.getState('persona');
    if (prev) {
      await db.setState('persona_prev', prev);
      const hist = (await db.getState('persona_history')) || [];
      hist.push({ updated_at: prev.updated_at, updated_by: prev.updated_by, note: prev.note || null, length: (prev.content || '').length, content: prev.content });
      while (hist.length > 8) hist.shift();
      await db.setState('persona_history', hist);
    }
    const rec = { content, updated_at: new Date().toISOString(), updated_by: updatedBy, note };
    await db.setState('persona', rec); _cache.persona = rec;
    console.log(`🎭 Persona updated by ${updatedBy} (${content.length} chars)${note ? ` — ${note}` : ''}`);
    res.json({ ok: true, updated_at: rec.updated_at, length: content.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/prompt/history', requireAuth, async (req, res) => {
  try {
    const hist = _dbReady ? ((await db.getState('persona_history')) || []) : [];
    res.json(hist.map(h => ({ updated_at: h.updated_at, updated_by: h.updated_by, note: h.note, length: h.length })).reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/prompt/rollback', requireAuth, async (req, res) => {
  if (!_dbReady) return res.status(503).json({ error: 'Postgres not active' });
  try {
    const prev = await db.getState('persona_prev');
    if (!prev || !prev.content) return res.status(404).json({ error: 'no previous version stored' });
    const rec = { content: prev.content, updated_at: new Date().toISOString(), updated_by: (req.body && req.body.updated_by) || 'rollback', note: `rolled back to version from ${prev.updated_at}` };
    await db.setState('persona', rec); _cache.persona = rec;
    console.log(`🎭 Persona rolled back to ${prev.updated_at}`);
    res.json({ ok: true, restored_from: prev.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /cowork-prompt — the stable hourly HARNESS (auth setup, run lock, CRITICAL RULES, and the
// instruction to fetch + run GET /routine). The Cowork task is a tiny bootstrap that fetches this
// and executes it, so the harness can be updated via a code deploy without touching Cowork.
// Authenticated because the response receives Nora's API key at request time (unlike /prompt and
// /routine, which don't). The tracked Markdown contains only a placeholder, keeping the credential
// out of source while preserving the existing self-contained Cowork harness.
app.get('/cowork-prompt', requireAuth, (req, res) => {
  try {
    const harness = fs.readFileSync(path.join(__dirname, 'cowork-prompt.md'), 'utf8')
      .replaceAll('{{NORA_API_KEY}}', process.env.NORA_API_KEY || '');
    res.type('text/markdown').send(harness);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nora's editable hourly routine ────────────────────────────────────────────
// The actual hourly steps (Steps 0-9) live here, in her platform, so she/John can edit them
// without a code deploy or a Cowork-config change. The stable harness (cowork-prompt.md) fetches
// GET /routine each hour and executes it. Source of truth is Postgres (app_state 'routine');
// nora-routine.md is only the first-boot seed. The API key is NOT in the routine (it's in the
// harness), so GET is unauthenticated like /prompt; PUT is authenticated.
async function loadRoutine() {
  if (_dbReady) {
    const r = await db.getState('routine');
    if (r && r.content) return r;
  }
  try {
    const local = path.join(LOCAL_DATA_DIR, 'nora-routine.md');
    const seed = fs.existsSync(local) ? local : path.join(__dirname, 'nora-routine.md');
    const p = fs.existsSync(path.join(VOLUME_DIR, 'nora-routine.md')) ? path.join(VOLUME_DIR, 'nora-routine.md') : seed;
    const content = fs.readFileSync(p, 'utf8');
    return { content, updated_at: null, updated_by: 'seed (file)' };
  } catch { return { content: '', updated_at: null, updated_by: null }; }
}
async function saveRoutine(content, updatedBy, note) {
  const rec = { content: String(content || ''), updated_at: new Date().toISOString(), updated_by: updatedBy || 'unknown', note: note || null };
  if (_dbReady) {
    const prev = await db.getState('routine');
    if (prev) {
      await db.setState('routine_prev', prev); // one-level fast undo
      // Version history (self-improvement safety rail): keep the last 8 full versions so a bad
      // self-edit is always recoverable and the routine's evolution is inspectable.
      const hist = (await db.getState('routine_history')) || [];
      hist.push({ updated_at: prev.updated_at, updated_by: prev.updated_by, note: prev.note || null, length: (prev.content || '').length, content: prev.content });
      while (hist.length > 8) hist.shift();
      await db.setState('routine_history', hist);
    }
    await db.setState('routine', rec);
    return rec;
  }
  const p = fs.existsSync(VOLUME_DIR) ? path.join(VOLUME_DIR, 'nora-routine.md') : path.join(LOCAL_DATA_DIR, 'nora-routine.md');
  fs.writeFileSync(p, rec.content);
  return rec;
}

// GET /routine — the routine markdown + metadata. Unauthenticated (no secrets; the harness has the key).
app.get('/routine', async (req, res) => {
  try { res.json(await loadRoutine()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /routine — replace the routine. Auth required. Body: { content, updated_by?, note? }.
// `note` is a one-line summary of WHAT changed and WHY; required when the updater is Nora
// herself (self-improvement edits must be explainable) and it lands in the version history.
app.put('/routine', requireAuth, async (req, res) => {
  const content = req.body && req.body.content;
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content (a non-empty markdown string) is required' });
  }
  const updatedBy = (req.body.updated_by || 'unknown').toString();
  const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
  if (/^nora/i.test(updatedBy) && !note) {
    return res.status(400).json({ error: 'self-edits require a note: one line on what changed and why' });
  }
  try {
    const rec = await saveRoutine(content, updatedBy, note);
    console.log(`📋 Routine updated by ${rec.updated_by} (${content.length} chars)${note ? ` — ${note}` : ''}`);
    res.json({ ok: true, updated_at: rec.updated_at, updated_by: rec.updated_by, length: content.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /routine/history — the last saved versions (metadata; ?full=true includes content).
app.get('/routine/history', requireAuth, async (req, res) => {
  try {
    const hist = _dbReady ? ((await db.getState('routine_history')) || []) : [];
    const out = req.query.full === 'true' ? hist : hist.map(h => ({ updated_at: h.updated_at, updated_by: h.updated_by, note: h.note, length: h.length }));
    res.json(out.slice().reverse()); // newest first
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /routine/rollback — restore the previous version (routine_prev). The escape hatch for
// a bad self-edit: one call puts the prior routine back and logs who rolled back.
app.post('/routine/rollback', requireAuth, async (req, res) => {
  if (!_dbReady) return res.status(503).json({ error: 'Postgres not active' });
  try {
    const prev = await db.getState('routine_prev');
    if (!prev || !prev.content) return res.status(404).json({ error: 'no previous version stored' });
    const rec = await saveRoutine(prev.content, (req.body && req.body.updated_by) || 'rollback', `rolled back to version from ${prev.updated_at} (${prev.updated_by})`);
    console.log(`📋 Routine rolled back to ${prev.updated_at}`);
    res.json({ ok: true, restored_from: prev.updated_at, updated_at: rec.updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recall needs a webpage camera source to display Nora in the participant tile. This page is
// deliberately static and silent. The legacy path keeps already-scheduled bots from opening a 404.
app.get('/voice-agent', (_req, res) => {
  res.sendFile(path.join(__dirname, 'meeting-avatar.html'));
});

// Recall bot configuration is transcription-only. The webpage camera is a static identity card;
// Nora does not publish audio, speak, chat, or inspect screen shares.
function buildBotConfig(serverHost, botName = 'Nora') {
  const SERVER_URL = `https://${serverHost}`;
  return {
    bot_name: botName,
    output_media: {
      camera: { kind: 'webpage', config: { url: `${SERVER_URL}/voice-agent` } }
    },
    recording_config: {
      transcript: {
        provider: { assembly_ai_v3_streaming: { speech_model: 'universal-streaming-english' } }
      },
      realtime_endpoints: [
        { type: 'webhook', url: `${SERVER_URL}/webhook/transcript`, events: ['transcript.data'] }
      ]
    },
    variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    webhook_url: `${SERVER_URL}/webhook/status`
  };
}

function newSession() {
  return { buffer: [], transcript: [], lastRecallLineAt: 0 };
}
// The server's own public host for Recall callbacks and the static avatar page when there is no
// inbound request to read it from, such as a join triggered from Slack.
function publicHost(fallback) {
  return process.env.RAILWAY_PUBLIC_DOMAIN
    || (process.env.PUBLIC_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    || fallback || '';
}

// A real meeting-join URL (Zoom / Meet / Teams / Webex). Used to validate what Nora is asked to
// join so she never fires the bot at a garbage or non-meeting link.
const MEETING_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s>|]+/i;
function extractMeetingUrl(text) {
  const m = MEETING_URL_RE.exec(String(text || '').replace(/[<>]/g, ' '));
  return m ? m[0].replace(/[.,);]+$/, '') : null;
}

// Core join logic, shared by the dashboard and Slack. The bot only captures transcripts.
async function startMeetingJoin({ meeting_url, source = 'manual_join', host }) {
  if (!meeting_url) throw new Error('meeting_url is required');
  const botConfig = buildBotConfig(host || publicHost());
  const botRes = await axios.post(`${RECALL_BASE}/bot/`, { meeting_url, ...botConfig }, {
    headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
    timeout: RECALL_JOIN_TIMEOUT_MS,
  });
  const botId = botRes.data.id;
  if (!sessions[botId]) sessions[botId] = newSession();
  console.log(`✅ Nora transcription bot joined. Bot ID: ${botId} (source: ${source})`);
  return { bot_id: botId };
}

app.post('/join', requireAuth, async (req, res) => {
  try {
    const { meeting_url } = req.body;
    if (!meeting_url) return res.status(400).json({ error: 'meeting_url is required' });
    res.json(await startMeetingJoin({ meeting_url, host: req.get('host') }));
  } catch (err) {
    console.error('Join error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});
// Dedup window so a redelivered Slack event (or the app posting twice) can't double-join a meeting.
const _recentAutoJoin = new Map();
async function handleSlackAutoJoin(event, link) {
  const now = Date.now();
  for (const [k, t] of _recentAutoJoin) if (now - t > 10 * 60 * 1000) _recentAutoJoin.delete(k);
  if (_recentAutoJoin.has(link)) return;
  _recentAutoJoin.set(link, now);
  try {
    const r = await startMeetingJoin({ meeting_url: link, source: 'slack_autojoin', host: publicHost() });
    await postSlackMessage(event.channel, "on my way into that meeting now.");
    console.log(`✅ Auto-joined meeting from Slack DM link (bot ${r.bot_id})`);
  } catch (e) {
    _recentAutoJoin.delete(link); // let a retry through
    await postSlackMessage(event.channel, `tried to hop into that meeting but couldn't. ${String(e.message).slice(0, 150)}. want me to try again?`).catch(() => {});
  }
}

const RECALL_V2_BASE = `https://${process.env.RECALL_REGION || 'us-east-1'}.recall.ai/api/v2`;
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
  'https://www.googleapis.com/auth/drive.file',
];
const oauthStates = new Map();

function newOAuthState() {
  const s = crypto.randomBytes(24).toString('hex');
  oauthStates.set(s, { created: Date.now() });
  // GC expired states
  for (const [k, v] of oauthStates) if (Date.now() - v.created > 10 * 60 * 1000) oauthStates.delete(k);
  return s;
}

function getGoogleOAuthRedirectUri(reqHost) {
  // Allow override for cases where the server is behind a tunnel / different public host.
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  return `https://${reqHost}/calendar/oauth/callback`;
}

// GET /calendar/connect — kicks off the OAuth handshake. Returns the URL to redirect to.
// Dashboard calls this via authed fetch, then window.location's to the returned authorize_url.
app.get('/calendar/connect', requireAuth, (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_OAUTH_CLIENT_ID not set' });
  const state = newOAuthState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleOAuthRedirectUri(req.get('host')),
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force consent so we always get a refresh_token, even on reconnect
    state
  });
  const authorize_url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.json({ authorize_url });
});

// GET /calendar/oauth/callback — Google redirects here with ?code=&state=
app.get('/calendar/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Google OAuth error: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');
  if (!oauthStates.has(state)) return res.status(400).send('Invalid or expired state');
  oauthStates.delete(state);

  try {
    // 1. Exchange the auth code for a refresh_token + access_token
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: getGoogleOAuthRedirectUri(req.get('host')),
      grant_type: 'authorization_code'
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: CONNECTOR_AUTH_TIMEOUT_MS,
    });
    const { refresh_token, access_token } = tokenRes.data;
    if (!refresh_token) {
      return res.status(400).send('Google did not return a refresh_token. If you previously connected this account, revoke access at https://myaccount.google.com/permissions and try again.');
    }

    // 2. Fetch the user's email so we know whose calendar this is (and for the attendee match later).
    const userinfoRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: CONNECTOR_AUTH_TIMEOUT_MS,
    });
    const googleEmail = userinfoRes.data.email;

    // 3. Hand the refresh token to Recall, which will manage it from here on.
    const SERVER_URL = `https://${req.get('host')}`;
    const recallRes = await axios.post(`${RECALL_V2_BASE}/calendars/`, {
      oauth_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      oauth_client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      oauth_refresh_token: refresh_token,
      platform: 'google_calendar',
      oauth_email: googleEmail,
      // webhook_url is deprecated on this endpoint but still functional. Cleanest path
      // until workspace-level webhook config is required.
      webhook_url: `${SERVER_URL}/webhook/recall-calendar`
    }, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: CONNECTOR_AUTH_TIMEOUT_MS,
    });

    saveCalendarState({
      recall_calendar_id: recallRes.data.id,
      google_email: googleEmail,
      connected_at: new Date().toISOString(),
      last_sync: null,
      // Persist Nora's Google refresh token so we can mint access tokens for Drive
      // uploads (and any other Google API calls we layer in later). Recall has its own
      // copy for calendar sync; this one is for our server-side use.
      oauth_refresh_token: refresh_token,
      oauth_scopes: GOOGLE_OAUTH_SCOPES.slice()
    });
    googleAccessTokenCache = null;
    console.log(`📅 Calendar connected: ${googleEmail} (recall_id: ${recallRes.data.id})`);

    // Bounce back to the dashboard with a success flag the UI can show.
    res.redirect('/?calendar_connected=1');
  } catch (err) {
    console.error('Calendar connect failed:', err.response?.data || err.message);
    res.status(500).send(`Calendar connect failed: ${JSON.stringify(err.response?.data || err.message)}`);
  }
});

// GET /calendar/status — read-only state for the dashboard UI
app.get('/calendar/status', requireAuth, (req, res) => {
  const state = loadCalendarState();
  if (!state) return res.json({ connected: false });
  res.json({
    connected: true,
    google_email: state.google_email,
    recall_calendar_id: state.recall_calendar_id,
    connected_at: state.connected_at,
    last_sync: state.last_sync,
    scheduling_enabled: Array.isArray(state.oauth_scopes)
      && state.oauth_scopes.includes('https://www.googleapis.com/auth/calendar.events')
  });
});

// DELETE /calendar — disconnect (drops local state; does not delete on Recall side
// — call Recall's DELETE /calendars/{id}/ manually if you want it removed there too).
app.delete('/calendar', requireAuth, async (req, res) => {
  const state = loadCalendarState();
  if (!state) return res.json({ ok: true, already: true });
  if (req.query.also_delete_on_recall === '1' && state.recall_calendar_id) {
    try {
      await axios.delete(`${RECALL_V2_BASE}/calendars/${state.recall_calendar_id}/`, {
        headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
        timeout: RECALL_CONTROL_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn('Recall calendar delete failed (continuing with local clear):', err.response?.data || err.message);
    }
  }
  clearCalendarState();
  googleAccessTokenCache = null;
  res.json({ ok: true });
});

const _acknowledgedMeetingWork = new Map();
let _acknowledgedMeetingWorkSequence = 0;
const _acknowledgedMeetingWorkHealth = {
  accepted: 0, completed: 0, failures: 0, shutdown_drain_timeouts: 0,
  last_failure: null, recent_failures: [],
};
function beginAcknowledgedMeetingWork(label) {
  const id = `meeting-event-${++_acknowledgedMeetingWorkSequence}`;
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const entry = {
    id, label: String(label || 'meeting event').slice(0, 120),
    started_at: Date.now(), promise, finished: false,
  };
  _acknowledgedMeetingWork.set(id, entry);
  _acknowledgedMeetingWorkHealth.accepted += 1;
  return {
    finish(error = null) {
      if (entry.finished) return;
      entry.finished = true;
      if (error) {
        const failure = {
          at: new Date().toISOString(), label: entry.label,
          error: String(error?.message || error).slice(0, 500),
        };
        _acknowledgedMeetingWorkHealth.failures += 1;
        _acknowledgedMeetingWorkHealth.last_failure = failure;
        _acknowledgedMeetingWorkHealth.recent_failures.push(failure);
        while (_acknowledgedMeetingWorkHealth.recent_failures.length > 20) {
          _acknowledgedMeetingWorkHealth.recent_failures.shift();
        }
      }
      _acknowledgedMeetingWorkHealth.completed += 1;
      _acknowledgedMeetingWork.delete(id);
      resolve();
    },
  };
}
function acknowledgedMeetingWorkSnapshot(now = Date.now()) {
  const active = [..._acknowledgedMeetingWork.values()].map(entry => ({
    id: entry.id, label: entry.label,
    age_ms: Math.max(0, Number(now) - entry.started_at),
  }));
  return {
    ..._acknowledgedMeetingWorkHealth,
    active_count: active.length,
    oldest_active_ms: Math.max(0, ...active.map(entry => entry.age_ms)),
    active,
  };
}
async function drainAcknowledgedMeetingWork({ timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 20000);
  while (true) {
    const pending = [..._acknowledgedMeetingWork.values()].map(entry => entry.promise);
    if (!pending.length) {
      await Promise.resolve();
      if (_acknowledgedMeetingWork.size === 0) return true;
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      _acknowledgedMeetingWorkHealth.shutdown_drain_timeouts += 1;
      return false;
    }
    let timer = null;
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(false), remainingMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      _acknowledgedMeetingWorkHealth.shutdown_drain_timeouts += 1;
      return false;
    }
  }
}

// POST /webhook/recall-calendar — fires on calendar.update / calendar.sync_events.
// For sync_events: re-list events updated since last_sync, find ones Nora is invited
// to that have a meeting URL, schedule a bot for each (deduped by event id).
app.post('/webhook/recall-calendar', verifyRecallDashboard, async (req, res) => {
  // Always 200 quickly so Recall doesn't retry; do the work async.
  res.json({ ok: true });
  const ownership = beginAcknowledgedMeetingWork('calendar-sync');
  try {

  const { event, data } = req.body || {};
  if (!event || !data) return;
  console.log(`📅 Recall calendar webhook: ${event}`);
  if (event !== 'calendar.sync_events') return;

  try {
    const state = loadCalendarState();
    if (!state || state.recall_calendar_id !== data.calendar_id) {
      console.warn(`📅 Webhook for unknown/mismatched calendar ${data.calendar_id}; ignoring`);
      return;
    }

    const updatedSince = data.last_updated_ts || state.last_sync || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ calendar_id: state.recall_calendar_id, updated_at__gte: updatedSince });
    const listRes = await axios.get(`${RECALL_V2_BASE}/calendar-events/?${params.toString()}`, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
      timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
    const events = listRes.data?.results || [];
    console.log(`📅 Re-listed ${events.length} calendar events since ${updatedSince}`);

    const noraEmail = (state.google_email || '').toLowerCase();
    const SERVER_HOST = req.get('host');

    for (const ev of events) {
      if (ev.is_deleted) continue;
      if (!ev.meeting_url) continue;

      // Skip past meetings (end time in the past). Slight grace window for late starts.
      const endTs = ev.end_time ? new Date(ev.end_time).getTime() : null;
      if (endTs && endTs < Date.now() - 5 * 60 * 1000) continue;

      // Inclusion rule: Nora must be explicitly invited. Recall surfaces attendee data
      // in several spots depending on provider — gather everything plausible and match
      // against any of them.
      const collectEmails = (event) => {
        const out = new Set();
        const pushEmail = v => { if (v && typeof v === 'string') out.add(v.toLowerCase()); };
        const visitAttendee = a => {
          if (!a) return;
          pushEmail(a.email);
          pushEmail(a.emailAddress?.address);  // Microsoft Graph shape
          pushEmail(a.address);
        };
        (event.attendees || []).forEach(visitAttendee);
        (event.raw?.attendees || []).forEach(visitAttendee);
        visitAttendee(event.organizer);
        visitAttendee(event.raw?.organizer);
        visitAttendee(event.raw?.creator);
        pushEmail(event.organizer_email);
        return out;
      };
      const eventEmails = collectEmails(ev);
      const noraInvited = eventEmails.has(noraEmail);
      if (!noraInvited) {
        console.log(`📅 Skipping event ${ev.id} — Nora (${noraEmail}) not found. Emails on event: [${[...eventEmails].join(', ') || '(none)'}]`);
        continue;
      }

      // Opt-out keyword in event title
      const title = (ev.raw?.summary || ev.summary || '').toLowerCase();
      if (title.includes('[no-nora]') || title.includes('[skip-nora]')) {
        console.log(`📅 Skipping event ${ev.id} — opt-out keyword in title`);
        continue;
      }

      const botConfig = buildBotConfig(SERVER_HOST);

      try {
        const scheduleRes = await axios.post(
          `${RECALL_V2_BASE}/calendar-events/${ev.id}/bot/`,
          {
            // Deduplication_key keyed by event id. If Recall already has a bot scheduled
            // with this key for the event, it returns the existing one instead of creating.
            deduplication_key: `nora-auto-${ev.id}`,
            bot_config: botConfig
          },
          {
            headers: { Authorization: `Token ${process.env.RECALL_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: RECALL_CONTROL_TIMEOUT_MS,
          }
        );
        const rd = scheduleRes.data || {};
        const bots = rd.bots || rd.bot_data || [];
        const latest = Array.isArray(bots) ? bots[bots.length - 1] : null;
        const botId = latest?.bot_id || latest?.id || latest?.bot?.id
                   || rd.bot_id || rd.id || rd.bot?.id || null;
        if (botId && !sessions[botId]) sessions[botId] = newSession();
        console.log(`📅 Auto-scheduled Nora to transcribe event "${ev.raw?.summary || ev.summary}"${botId ? ` → bot ${botId}` : ''}`);      } catch (botErr) {
        // Don't crash the whole sync if one event fails — log and continue.
        console.error(`📅 Failed to schedule bot for event ${ev.id}:`, botErr.response?.data || botErr.message);
      }
    }

    state.last_sync = new Date().toISOString();
    saveCalendarState(state);
  } catch (err) {
    console.error('Calendar webhook processing error:', err.response?.data || err.message);
  }
  } finally {
    ownership.finish();
  }
});

// One bounded live transcript session per Recall bot.
const sessions = {};
// Recall.ai sends speaker-identified transcript chunks here.
app.post('/webhook/transcript', verifyRecallRealtime, async (req, res) => {
  res.sendStatus(200);
  const ownership = beginAcknowledgedMeetingWork('transcript');
  let ownershipError = null;
  try {
    const parsed = parseRecallTranscriptEvent(req.body);
    if (!parsed?.bot_id) return;
    const botId = parsed.bot_id;
    const { speaker, text } = parsed.utterance;
    console.log(`[${speaker}]: ${text}`);
    if (!sessions[botId]) sessions[botId] = newSession();
    const session = sessions[botId];
    try {
      await ensureMeetingTranscriptHydrated(botId, session);
    } catch (error) {
      console.error(`Transcript resume failed for ${botId}; persistence will retry:`, error.message);
    }
    if (!appendUniqueUtterance(session.transcript, parsed.utterance)) return;
    session.lastRecallLineAt = Date.now();
    session.buffer.push(`${speaker}: ${text}`);
    if (session.buffer.length > 20) session.buffer.shift();
    scheduleTranscriptCheckpoint(botId, session.transcript);
  } catch (error) {
    ownershipError = error;
    throw error;
  } finally {
    ownership.finish(ownershipError);
  }
});
// Meeting status updates — track bot_id and clean up
app.post('/webhook/status', verifyRecallDashboard, async (req, res) => {
  res.sendStatus(200);
  const ownership = beginAcknowledgedMeetingWork('meeting-status');
  let ownershipError = null;
  try {
  console.log('📡 Status webhook:', JSON.stringify(req.body).slice(0, 300));
  const status = parseRecallStatusEvent(req.body);
  const bot_id = status?.bot_id || null;
  if (status?.code === 'done') {
    console.log(`Meeting ended. Cleaning up session ${bot_id}`);
    // Persist the final transcript before cleaning up.
    const session = sessions[bot_id];
    let retainSessionForTranscriptRetry = false;
    if (session?.transcript?.length > 0) {
      const transcriptData = {
        bot_id,
        ended: status.updated_at,
        transcript: session.transcript.map(item => ({ ...item })),
      };
      try {
        // Await the final write so the ended-finalized transcript is durable before the
        // session is torn down (the response was already sent above; this doesn't delay it).
        await saveTranscriptDoc(bot_id, transcriptData.transcript, transcriptData.ended, {
          incremental: true,
        });
        console.log(`📝 Transcript saved for ${bot_id} (${session.transcript.length} utterances)`);
      } catch (err) {
        console.error('Transcript save error:', err.message);
        // Preserve the hydrated in-memory session until a bounded, coalesced checkpoint succeeds.
        // Deleting it here would make a transient database outage lose the meeting's final lines.
        session.cleanupAfterTranscriptSave = true;
        retainSessionForTranscriptRetry = true;
        queueTranscriptCheckpoint(bot_id, session.transcript, {
          ended: status.updated_at, delayMs: 2000,
        });
      }
      try {
        await refreshRecentMeetingsCache();
      } catch (error) {
        console.warn('post-meeting recent-meetings refresh failed:', error.message);
      }
    }
    if (!retainSessionForTranscriptRetry) {
      delete sessions[bot_id];
      _transcriptPersistedCounts.delete(bot_id);
      _transcriptCheckpointAttempts.delete(bot_id);
    }
  }
  } catch (error) {
    ownershipError = error;
    throw error;
  } finally {
    ownership.finish(ownershipError);
  }
});

// Slack webhook — @mentions, DMs, and follow-ups in threads Nora has joined
// Session history is keyed per-thread / per-DM-channel / per-(channel,user) so concurrent
// conversations stay isolated.
const slackSessions = {};
// Record the newest inbound before entering the per-conversation lock. If a follow-up arrives while
// Nora is still composing, the older answer is stale and must not be delivered as a separate turn.
const latestSlackInboundBySession = new Map();
// Last-activity timestamp per session key. When a session has been idle past
// SLACK_SESSION_STALE_MS, the next message starts fresh instead of prepending hours-old turns from
// a possibly-different topic (which would both confuse the answer and re-surface stale context).
const slackSessionTouched = {};
const SLACK_SESSION_STALE_MS = 90 * 60 * 1000; // 90 min idle → treat the next message as a new convo

// Cached Nora bot user ID, resolved lazily from the first event payload's authorizations.
// Used to detect @mentions in raw `message.channels` events (which arrive as type=message, not app_mention).
let noraBotUserId = null;

async function settleWithin(promise, timeoutMs, fallback, label = 'optional lookup') {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.log(`${label} exceeded ${timeoutMs}ms; continuing on the latency-safe fallback`);
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(error => {
      console.warn(`${label} failed:`, error.message);
      return fallback;
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Promise.race returns a fallback on time but normally leaves the losing request alive. On a live
// reply that hidden tail can still occupy a socket or provider slot while the main model is trying
// to answer. Optional network work uses this form so its latency budget also ends the request.
async function settleWithinAbortable(operation, timeoutMs, fallback, label = 'optional lookup') {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.log(`${label} exceeded ${timeoutMs}ms; aborting and continuing on the latency-safe fallback`);
      resolve(fallback);
      controller.abort(new Error(`${label} exceeded latency budget`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)).catch(error => {
      if (!controller.signal.aborted) console.warn(`${label} failed:`, error.message);
      return fallback;
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejectWithinAbortable(operation, timeoutMs, label = 'operation') {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${timeoutMs}ms deadline`);
      error.code = 'interactive_deadline_exceeded';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function readExactSlackEvidence(ref, { get = axios.get,
  resolveUserName = getSlackUserName } = {}) {
  const parsed = slackEvidence.parseCanonicalMessageRef(ref);
  if (!parsed) throw new Error('Slack evidence reference is not canonical');
  const headers = { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };
  const replies = new URLSearchParams({ channel: parsed.channel, ts: parsed.thread_ts,
    oldest: parsed.message_ts, latest: parsed.message_ts, inclusive: 'true', limit: '20' });
  const history = new URLSearchParams({ channel: parsed.channel, oldest: parsed.message_ts,
    latest: parsed.message_ts, inclusive: 'true', limit: '20' });
  const attempts = parsed.thread_ts === parsed.message_ts
    ? [`https://slack.com/api/conversations.history?${history}`,
      `https://slack.com/api/conversations.replies?${replies}`]
    : [`https://slack.com/api/conversations.replies?${replies}`,
      `https://slack.com/api/conversations.history?${history}`];
  let message = null;
  const failures = [];
  for (const url of attempts) {
    try {
      const response = await get(url, { headers, timeout: 7000 });
      if (!response.data?.ok) {
        failures.push(response.data?.error || 'slack_readback_not_ok');
        continue;
      }
      message = (Array.isArray(response.data.messages) ? response.data.messages : [])
        .find(item => String(item?.ts) === parsed.message_ts) || null;
      if (message) break;
    } catch (error) { failures.push(String(error.message || error)); }
  }
  if (!message) throw new Error(`exact Slack evidence message was not found (${failures.join(', ')})`);
  if (!message.user || message.bot_id || message.subtype === 'bot_message') {
    throw new Error('exact evidence must be an attributable human Slack message');
  }
  const authorName = await resolveUserName(message.user);
  return slackEvidence.stableHumanSnapshot({
    evidence_ref: { type: 'slack_message', id: parsed.id }, channel: parsed.channel,
    thread_ts: parsed.thread_ts, message_ts: parsed.message_ts,
    author_id: message.user, author_name: authorName || message.user,
    author_name_verified: Boolean(authorName), text: String(message.text || ''),
    edited_ts: message.edited?.ts || null,
  });
}

async function readCommonGroundSlackEvidence(ref, options = {}) {
  return readExactSlackEvidence(ref, options);
}

// Decode the handful of HTML entities that survive tag-stripping. Not exhaustive — just
// the common ones that show up in readable page text.
function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } });
}

// Pull all http(s) URLs out of a Slack message (handles <url>, <url|label>, and plain).
function extractUrls(text) {
  const urls = new Set();
  let m;
  const wrapped = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g;
  while ((m = wrapped.exec(text || ''))) urls.add(m[1]);
  const plain = /\bhttps?:\/\/[^\s<>|]+/g;
  while ((m = plain.exec(text || ''))) urls.add(m[0].replace(/[).,]+$/, ''));
  return [...urls];
}

// Fetch a URL and return readable text (title + meta description + body), size-capped.
// SSRF guard: http/https only, no localhost/private ranges. Best-effort — returns null on
// any failure or for non-HTML content. JS-heavy SPA pages may yield little body text; the
// Slack unfurl (title/description) in the thread covers those.
async function fetchUrlText(url, { signal = undefined } = {}) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (/^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) return null;
    const r = await axios.get(url, {
      timeout: 8000, maxRedirects: 5, responseType: 'text',
      signal,
      maxContentLength: 6 * 1024 * 1024,
      headers: { 'User-Agent': 'NoraBot/1.0 (+https://limelightmarketing.com)', 'Accept': 'text/html,application/xhtml+xml' },
      validateStatus: s => s >= 200 && s < 400
    });
    const ct = String(r.headers['content-type'] || '');
    if (ct && !/text\/html|text\/plain|xhtml|application\/json/.test(ct)) return null;
    let html = String(r.data || '');
    const title = decodeHtmlEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
    const desc = decodeHtmlEntities(((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                                      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '').trim());
    html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
               .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n');
    const body = decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
    const head = [title && `Title: ${title}`, desc && `Description: ${desc}`].filter(Boolean).join('\n');
    const out = `${head}${head && body ? '\n\n' : ''}${body}`.trim();
    return out ? out.slice(0, 6000) : null;
  } catch { return null; }
}

// Credential-aware remote MCP connections. Secrets and even credential-bearing URLs are encrypted
// before persistence. The manager discovers tools once during Test/Connect, then exposes only the
// cached schemas to Slack without waiting on a remote server.
const mcpStore = createMcpStore({ fs, path, volumeDirectory: VOLUME_DIR,
  localDataDirectory: LOCAL_DATA_DIR, databaseReady: () => _dbReady,
  getCache: () => _cache.mcp || [], setCache: list => { _cache.mcp = list; },
  writeThrough: _writeThrough, replaceAll: db.replaceAllMcp });
const mcpManager = createMcpManager({
  loadConnections: mcpStore.load,
  saveConnections: mcpStore.save,
  encryptionSecret: process.env.MCP_CREDENTIALS_ENCRYPTION_KEY || process.env.NORA_API_KEY || 'nora-local-development-only',
  resolveDns: process.env.NORA_TEST_MODE !== '1',
});
// ── Teamwork direct-API tools (live READ access in Slack) ───────────────────
// Custom client-side tools: the model requests one, we execute it against the Teamwork API
// using the key the app already holds (no MCP, no OAuth), then feed the result back. All
// Writes require an explicit request, verify provider readback, and never expose deletion.
function teamworkEnabled() { return !!(process.env.TEAMWORK_API_KEY && process.env.TEAMWORK_BASE_URL); }
async function twApiGet(pathAndQuery, { signal, timeoutMs = 12000 } = {}) {
  const twKey = process.env.TEAMWORK_API_KEY, twBase = process.env.TEAMWORK_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${twKey}:`).toString('base64');
  const r = await axios.get(`${twBase}${pathAndQuery}`, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    timeout: Math.max(1, Math.min(12000, Number(timeoutMs) || 12000)), signal,
  });
  return r.data;
}
// Write helper (POST/PUT/DELETE) — used by the create/update/complete/comment tools. Uses
// Teamwork's stable v1 endpoints (well-documented for writes). DELETE is used internally for
// test cleanup only; it is NOT exposed as a tool (Nora cannot delete from chat).
async function twApiSend(method, pathAndQuery, body, { signal, timeoutMs = 15000 } = {}) {
  const twKey = process.env.TEAMWORK_API_KEY, twBase = process.env.TEAMWORK_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${twKey}:`).toString('base64');
  const r = await axios({
    method, url: `${twBase}${pathAndQuery}`,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    data: body, timeout: Math.max(1, Math.min(15000, Number(timeoutMs) || 15000)), signal,
  });
  return r.data;
}
const twYmd = (s) => s ? String(s).replace(/[^0-9]/g, '').slice(0, 8) : undefined; // YYYY-MM-DD → YYYYMMDD
// Teamwork v3 returns related objects as bare {id, type} refs and puts the real data in a
// top-level `included` sideload (requested via ?include=…). slimTwTask resolves assignee and
// tasklist refs to names using that sideload.
function slimTwTask(t, inc = {}) {
  const users = inc.users || {}, tasklists = inc.tasklists || {}, projects = inc.projects || {};
  const assignees = (t.assignees || []).map(a => {
    const u = users[a.id];
    return u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : `#${a.id}`;
  });
  // v3 task objects carry a tasklist ref but NO direct project ref, so resolve the project THROUGH
  // the sideloaded tasklist (tl.project.id / tl.projectId). That's what gives a cross-project "what's
  // due" list a project name on each row. Requires include=tasklists,projects on the query.
  const tl = (t.tasklist && tasklists[t.tasklist.id]) || null;
  const projId = tl && ((tl.project && tl.project.id) || tl.projectId);
  return {
    id: t.id, name: t.name, status: t.status,
    assignees: assignees.length ? assignees : undefined,
    due: t.dueDate || undefined,
    start: t.startDate || undefined,
    priority: t.priority || undefined,
    progress: t.progress != null ? t.progress : undefined,
    tasklist: (tl && tl.name) || undefined,
    project: (projId && projects[projId] && projects[projId].name) || undefined
  };
}

// Team capacity lookup for an explicit staffing question. Shared by the
// teamwork_team_capacity tool and the /teamwork/team-capacity endpoint.
async function teamworkTeamCapacity({ start_date, end_date, min_free_hours, user_ids }, request = {}) {
  const r1 = (n) => Math.round(n * 10) / 10;
  const minFree = (min_free_hours != null && min_free_hours !== '') ? Number(min_free_hours) : null;
  const scope = user_ids ? `&userIds=${encodeURIComponent(String(user_ids).split(',').map(s => s.trim()).filter(Boolean).join(','))}` : '';
  const d = await twApiGet(`/projects/api/v3/workload.json?startDate=${encodeURIComponent(start_date)}&endDate=${encodeURIComponent(end_date)}&include=users&pageSize=200${scope}`, request);
  const inc = d?.included?.users || {};
  const rows = [];
  for (const u of (d?.workload?.users || [])) {
    const info = inc[u.userId] || {};
    if (info.isClientUser) continue; // never staff a client contact
    const name = [info.firstName, info.lastName].filter(Boolean).join(' ') || `#${u.userId}`;
    if (/needs resourced|resource pool/i.test(name)) continue; // placeholder allocation buckets, not people
    const dayCapMin = (info.lengthOfDay || 8) * 60;
    let availDays = 0, freeMin = 0, allocMin = 0, capMin = 0, over = false;
    for (const x of Object.values(u.dates || {})) {
      if (x.unavailableDay) continue; // off / weekend / holiday
      availDays++;
      const a = x.capacityMinutes || 0;
      allocMin += a; capMin += dayCapMin; freeMin += Math.max(0, dayCapMin - a);
      if (a > dayCapMin) over = true; // booked beyond capacity that day
    }
    if (!availDays) continue; // off the entire window
    const bookedPct = capMin ? Math.round((allocMin / capMin) * 100) : 0;
    rows.push({ user: name, userId: u.userId, freeHours: r1(freeMin / 60), bookedPct, availableDays: availDays, over });
  }
  // Members with SOME tracked allocation are confirmed delivery resources; rank those by free hours.
  // People at 0% have NO tracked workload (usually just un-estimated work, not genuinely free), so
  // list them separately with a caveat rather than recommending them as "most open".
  const tracked = rows.filter(r => r.bookedPct > 0).sort((a, b) => b.freeHours - a.freeHours);
  const hasRoom = (minFree != null ? tracked.filter(r => r.freeHours >= minFree) : tracked).map(({ over, ...r }) => r);
  const untracked = rows.filter(r => r.bookedPct === 0).map(r => r.user);
  return {
    window: { start: start_date, end: end_date },
    ...(minFree != null ? { min_free_hours: minFree } : {}),
    team_size: rows.length,
    note: 'has_room = members with tracked Teamwork allocation who still have free hours (ranked, these are the real candidates). over_allocated = booked beyond capacity (flag these). unallocated = people with NO tracked workload, which usually means their work just is not estimated in Teamwork, so confirm before assuming they are free.',
    over_allocated: rows.filter(r => r.over).map(r => ({ user: r.user, bookedPct: r.bookedPct })),
    has_room: hasRoom.slice(0, 25),
    unallocated_count: untracked.length,
    unallocated: untracked.slice(0, 20)
  };
}

// Each tool: an Anthropic tool definition + an executor that returns a slimmed result.
const TEAMWORK_TOOLS = [
  { definition: {
      name: 'teamwork_find_projects',
      description: 'Find active Teamwork projects by name, or list active projects if no query. Use this first to resolve a project name to its id. Returns id, name, company, status.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'optional name search; omit to list active projects' } } }
    },
    execute: async ({ query }, request = {}) => {
      const q = query ? `&searchTerm=${encodeURIComponent(query)}` : '';
      const d = await twApiGet(`/projects/api/v3/projects.json?status=ACTIVE&pageSize=50&include=companies${q}`, request);
      const companies = d?.included?.companies || {};
      return (d?.projects || []).slice(0, 50).map(p => ({
        id: p.id, name: p.name, status: p.status,
        company: (p.company?.id && companies[p.company.id]?.name) || p.company?.name || ''
      }));
    } },
  { definition: {
      name: 'teamwork_get_project',
      description: 'Get a single Teamwork project\'s details by id: name, company, status, description, dates.',
      input_schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] }
    },
    execute: async ({ project_id }, request = {}) => {
      const d = await twApiGet(`/projects/api/v3/projects/${encodeURIComponent(project_id)}.json?include=companies`, request);
      const p = d?.project || {};
      const companies = d?.included?.companies || {};
      return { id: p.id, name: p.name, status: p.status, description: p.description,
        company: (p.company?.id && companies[p.company.id]?.name) || '',
        startDate: p.startAt || undefined, endDate: p.endAt || undefined };
    } },
  { definition: {
      name: 'teamwork_list_tasks',
      description: 'List tasks across all projects or one named project for an explicit request, with optional filters by assignee and due date. Returns task name, assignees, due date, priority, progress, task list, and project. Resolve a person with teamwork_list_people before filtering by assignee. Always scope cross-project requests by assignee or date.',
      input_schema: { type: 'object', properties: {
        project_id: { type: 'string', description: 'optional: scope to one project' },
        assigned_to_user_ids: { type: 'string', description: 'optional: comma-separated Teamwork user ids to scope to specific assignees (resolve via teamwork_list_people first)' },
        due_on: { type: 'string', description: 'optional: only tasks due on exactly this date (YYYY-MM-DD)' },
        due_after: { type: 'string', description: 'optional: only tasks due on or after this date (YYYY-MM-DD)' },
        due_before: { type: 'string', description: 'optional: only tasks due on or before this date (YYYY-MM-DD)' },
        include_completed: { type: 'boolean', description: 'default false' }
      } }
    },
    execute: async ({ project_id, assigned_to_user_ids, due_on, due_after, due_before, include_completed }, request = {}) => {
      const after = due_on || due_after, before = due_on || due_before;
      const assigneeSet = assigned_to_user_ids
        ? new Set(String(assigned_to_user_ids).split(',').map(s => s.trim()).filter(Boolean))
        : null;
      const filtering = !!(assigneeSet || after || before);
      // Server-side filters are passed best-effort (the v3 task endpoint honors most of these), but
      // because the exact param names can vary by Teamwork version we ALSO filter client-side below,
      // so the result is correctly scoped to the person/date even if the API ignores a param. Order
      // by due date ascending so soon-due tasks cluster at the front (keeps the date-scoped set in the
      // first page even when the server-side date filter is a no-op).
      const pageSize = filtering ? 250 : 75;
      // Server-side filter params verified against the live v3 tasks API (limelightmarketing4):
      // responsiblePartyIds scopes by assignee, dueAfter/dueBefore bound the due date (inclusive),
      // orderBy=dueDate sorts ascending. We STILL filter client-side below so a wrong/ignored param
      // can never hand back noise (the org has ~2,700 open tasks, so an unscoped result is useless).
      // `common` is the always-safe subset; if Teamwork ever rejects an optional param we fall back
      // to it and rely entirely on the client-side filter.
      const common = [`pageSize=${pageSize}`, `includeCompletedTasks=${include_completed ? 'true' : 'false'}`,
        'include=users,tasklists,projects'];
      if (project_id) common.push(`projectIds=${encodeURIComponent(project_id)}`);
      let queryParts = common.slice();
      queryParts.push('orderBy=dueDate', 'orderMode=asc');
      if (assigneeSet) queryParts.push(`responsiblePartyIds=${encodeURIComponent([...assigneeSet].join(','))}`);
      if (after) queryParts.push(`dueAfter=${encodeURIComponent(after)}`);
      if (before) queryParts.push(`dueBefore=${encodeURIComponent(before)}`);
      // Paginate when filtering so a single person's tasks aren't missed if the server filter no-ops.
      const MAX_PAGES = filtering ? 8 : 1;
      let all = [], inc = { users: {}, tasklists: {}, projects: {} }, page = 1;
      while (page <= MAX_PAGES) {
        let d;
        try {
          d = await twApiGet(`/projects/api/v3/tasks.json?${queryParts.join('&')}&page=${page}`, request);
        } catch (e) {
          if (queryParts.length > common.length) { queryParts = common.slice(); d = await twApiGet(`/projects/api/v3/tasks.json?${queryParts.join('&')}&page=${page}`, request); }
          else throw e;
        }
        const tasks = d?.tasks || [];
        const i = d?.included || {};
        Object.assign(inc.users, i.users || {});
        Object.assign(inc.tasklists, i.tasklists || {});
        Object.assign(inc.projects, i.projects || {});
        all.push(...tasks);
        if (tasks.length < pageSize) break; // last page
        page++;
      }
      // Client-side guarantee: scope by assignee id and due-date window regardless of server behavior.
      const aw = twYmd(after), bw = twYmd(before);
      const rows = all.filter(t => {
        if (assigneeSet) {
          const ids = (t.assignees || []).map(a => String(a.id));
          if (!ids.some(id => assigneeSet.has(id))) return false;
        }
        if (aw || bw) {
          const dd = twYmd(t.dueDate);
          if (!dd) return false; // a task with no due date can't satisfy a date filter
          if (aw && dd < aw) return false;
          if (bw && dd > bw) return false;
        }
        return true;
      });
      return rows.slice(0, 100).map(t => slimTwTask(t, inc));
    } },
  { definition: {
      name: 'teamwork_get_task',
      description: 'Get one task\'s full detail by id: description, assignees, due date, progress, status, tasklist, project.',
      input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
    },
    execute: async ({ task_id }, request = {}) => {
      const d = await twApiGet(`/projects/api/v3/tasks/${encodeURIComponent(task_id)}.json?include=users,tasklists,projects`, request);
      const t = d?.task || {};
      return { ...slimTwTask(t, d?.included || {}), description: (t.description || '').slice(0, 1500) || undefined };
    } },
  { definition: {
      name: 'teamwork_list_milestones',
      description: 'List milestones (deadlines), optionally scoped to a project. Returns name, deadline, status, project. Use for "what\'s due / what\'s the deadline" questions.',
      input_schema: { type: 'object', properties: { project_id: { type: 'string' } } }
    },
    execute: async ({ project_id }, request = {}) => {
      const q = project_id ? `&projectIds=${encodeURIComponent(project_id)}` : '';
      const d = await twApiGet(`/projects/api/v3/milestones.json?pageSize=75&include=projects${q}`, request);
      const projects = d?.included?.projects || {};
      return (d?.milestones || []).slice(0, 75).map(m => ({
        id: m.id, name: m.name, deadline: m.deadline, status: m.status, completed: m.completed,
        project: (m.project?.id && projects[m.project.id]?.name) || undefined
      }));
    } },
  { definition: {
      name: 'teamwork_list_tasklists',
      description: 'List a project\'s tasklists (how its work is grouped). Returns id and name. Needs a project_id.',
      input_schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] }
    },
    execute: async ({ project_id }, request = {}) => {
      const d = await twApiGet(`/projects/api/v3/tasklists.json?projectIds=${encodeURIComponent(project_id)}&pageSize=100`, request);
      return (d?.tasklists || []).slice(0, 100).map(l => ({ id: l.id, name: l.name }));
    } },
  { definition: {
      name: 'teamwork_list_people',
      description: 'List Teamwork people (team members). Returns id, name, company, title. Use to resolve who someone is or who\'s on the team.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'optional name search' } } }
    },
    execute: async ({ query }, request = {}) => {
      const q = query ? `&searchTerm=${encodeURIComponent(query)}` : '';
      const d = await twApiGet(`/projects/api/v3/people.json?pageSize=200&include=companies${q}`, request);
      const companies = d?.included?.companies || {};
      return (d?.people || []).slice(0, 200).map(p => ({
        id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(' '),
        company: (p.company?.id && companies[p.company.id]?.name) || '', title: p.title
      }));
    } },
  { definition: {
      name: 'teamwork_get_task_comments',
      description: 'Get recent comments / activity on a task by id. Use for "what\'s the latest on this task" questions.',
      input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
    },
    execute: async ({ task_id }, request = {}) => {
      const d = await twApiGet(`/projects/api/v3/tasks/${encodeURIComponent(task_id)}/comments.json?include=users&pageSize=20`, request);
      const users = d?.included?.users || {};
      return (d?.comments || []).slice(-20).map(c => {
        const uid = c.userId || (c.author && c.author.id);
        const u = uid && users[uid];
        return {
          author: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : (c.userFirstName || undefined),
          date: c.postedDateTime || c.createdAt || c.dateTime || undefined,
          body: (c.body || '').slice(0, 500)
        };
      });
    } },
  { definition: {
      name: 'teamwork_user_workload',
      description: 'Check how booked one or more people are over a date range (their CAPACITY / scheduling load), for decisions like "how booked is Santi next week" or "who has room to take this on". Returns, per person per day: percent booked, hours already allocated, hours free, and whether they are off/unavailable that day, plus a summary (available days, average booked %, total free hours, and their most-open day). Resolve people with teamwork_list_people to get their ids. Dates are YYYY-MM-DD; use the [Right now] block to work out "next week". This is workload CAPACITY, not the task list. Use teamwork_list_tasks to see WHAT they are actually working on.',
      input_schema: { type: 'object', properties: {
        user_ids: { type: 'string', description: 'required: comma-separated Teamwork user ids (resolve via teamwork_list_people)' },
        start_date: { type: 'string', description: 'required: window start, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'required: window end, YYYY-MM-DD' }
      }, required: ['user_ids', 'start_date', 'end_date'] }
    },
    execute: async ({ user_ids, start_date, end_date }, request = {}) => {
      const ids = String(user_ids).split(',').map(s => s.trim()).filter(Boolean).join(',');
      // Teamwork's Workload Planner endpoint. userIds scopes it (assignedToUserIds/responsiblePartyIds
      // do NOT filter here, verified live). include=users resolves names + each person's day length.
      const d = await twApiGet(`/projects/api/v3/workload.json?startDate=${encodeURIComponent(start_date)}&endDate=${encodeURIComponent(end_date)}&userIds=${encodeURIComponent(ids)}&include=users`, request);
      const incUsers = d?.included?.users || {};
      const wd = (s) => { try { return new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }); } catch { return ''; } };
      const r1 = (n) => Math.round(n * 10) / 10;
      return (d?.workload?.users || []).map(u => {
        const info = incUsers[u.userId] || {};
        const name = [info.firstName, info.lastName].filter(Boolean).join(' ') || `#${u.userId}`;
        const dayHours = info.lengthOfDay || 8;
        const dayCapMin = dayHours * 60;
        let availDays = 0, freeTotal = 0, allocAvail = 0, capAvail = 0, mostOpen = null;
        const days = Object.entries(u.dates || {}).map(([date, x]) => {
          // unavailableDay = not working / blocked (PTO, weekend, holiday). Report it as off rather
          // than a misleading "100% booked" so she never suggests scheduling into a day off.
          if (x.unavailableDay) return { date, weekday: wd(date), status: x.isHoliday ? 'holiday' : 'off' };
          const alloc = x.capacityMinutes || 0;
          const freeH = r1(Math.max(0, dayCapMin - alloc) / 60);
          availDays++; freeTotal += freeH; allocAvail += alloc; capAvail += dayCapMin;
          if (!mostOpen || freeH > mostOpen.freeHours) mostOpen = { date, weekday: wd(date), freeHours: freeH };
          return { date, weekday: wd(date), status: 'available',
            bookedPct: Math.round((alloc / dayCapMin) * 100), allocatedHours: r1(alloc / 60), freeHours: freeH };
        });
        return { user: name, userId: u.userId, dayHours, window: { start: start_date, end: end_date }, days,
          summary: {
            availableDays: availDays,
            avgBookedPct: capAvail ? Math.round((allocAvail / capAvail) * 100) : 0,
            freeHoursTotal: r1(freeTotal),
            mostOpenDay: mostOpen ? `${mostOpen.weekday} ${mostOpen.date} (${mostOpen.freeHours}h free)` : 'none (fully booked/unavailable)'
          } };
      });
    } },
  { definition: {
      name: 'teamwork_team_capacity',
      description: 'Check delivery-team capacity over a requested date range for a staffing question such as "who has room next week for a 10-hour build". Returns people ranked by free hours and an over-allocated list. Set min_free_hours to filter for the requested workload. Optionally pass user_ids to limit the lookup; otherwise it checks assignable teammates and excludes client contacts.',
      input_schema: { type: 'object', properties: {
        start_date: { type: 'string', description: 'required: window start, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'required: window end, YYYY-MM-DD' },
        min_free_hours: { type: 'number', description: 'optional: only list people with at least this many free hours in the window' },
        user_ids: { type: 'string', description: 'optional: comma-separated user ids to limit the sweep to specific people' }
      }, required: ['start_date', 'end_date'] }
    },
    execute: async (args, request = {}) => teamworkTeamCapacity(args, request) },

  // ── WRITE tools — Nora can create/update tasks, mark them done, and comment. Use ONLY when
  //    explicitly asked to create or change something. No delete tool exists (by design).
  { definition: {
      name: 'teamwork_create_task',
      description: 'Create a NEW task in a Teamwork tasklist. Tasks live inside tasklists, so first resolve the project (teamwork_find_projects) and its tasklist (teamwork_list_tasklists). To assign someone, get their id via teamwork_list_people. Use ONLY when explicitly asked to add/create a task. After it succeeds, tell the user what you created.',
      input_schema: { type: 'object', properties: {
        tasklist_id: { type: 'string', description: 'required — the tasklist to add the task to' },
        name: { type: 'string', description: 'the task title' },
        assignee_ids: { type: 'array', items: { type: 'string' }, description: 'optional Teamwork person ids' },
        due_date: { type: 'string', description: 'optional, YYYY-MM-DD' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'optional' },
        description: { type: 'string', description: 'optional detail' }
      }, required: ['tasklist_id', 'name'] }
    },
    execute: async ({ tasklist_id, name, assignee_ids, due_date, priority, description }) => {
      const item = { content: name };
      if (assignee_ids && assignee_ids.length) item['responsible-party-id'] = assignee_ids.join(',');
      if (due_date) item['due-date'] = twYmd(due_date);
      if (priority) item.priority = priority;
      if (description) item.description = description;
      const d = await twApiSend('post', `/tasklists/${encodeURIComponent(tasklist_id)}/tasks.json`, { 'todo-item': item });
      return { ok: true, task_id: d.id || d.taskId || (d.task && d.task.id), status: d.STATUS || 'OK' };
    } },
  { definition: {
      name: 'teamwork_update_task',
      description: 'Update an existing task: rename, change due date, reassign, set priority or progress. Use ONLY when explicitly asked to change a task. Resolve the task id first (teamwork_list_tasks / teamwork_find_projects). Report what you changed.',
      input_schema: { type: 'object', properties: {
        task_id: { type: 'string' },
        name: { type: 'string', description: 'optional new title' },
        due_date: { type: 'string', description: 'optional, YYYY-MM-DD' },
        assignee_ids: { type: 'array', items: { type: 'string' }, description: 'optional — replaces assignees' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        progress: { type: 'integer', description: 'optional 0-100' }
      }, required: ['task_id'] }
    },
    execute: async ({ task_id, name, due_date, assignee_ids, priority, progress }) => {
      const item = {};
      if (name) item.content = name;
      if (due_date) item['due-date'] = twYmd(due_date);
      if (assignee_ids) item['responsible-party-id'] = assignee_ids.join(',');
      if (priority) item.priority = priority;
      if (progress != null) item.progress = progress;
      await twApiSend('put', `/tasks/${encodeURIComponent(task_id)}.json`, { 'todo-item': item });
      return { ok: true, updated: Object.keys(item) };
    } },
  { definition: {
      name: 'teamwork_complete_task',
      description: 'Mark a task complete (done). Use when asked to close/finish/complete a task.',
      input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
    },
    execute: async ({ task_id }) => {
      await twApiSend('put', `/tasks/${encodeURIComponent(task_id)}/complete.json`, {});
      return { ok: true, status: 'completed' };
    } },
  { definition: {
      name: 'teamwork_reopen_task',
      description: 'Reopen a completed task (mark it not done again).',
      input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
    },
    execute: async ({ task_id }) => {
      await twApiSend('put', `/tasks/${encodeURIComponent(task_id)}/uncomplete.json`, {});
      return { ok: true, status: 'reopened' };
    } },
  { definition: {
      name: 'teamwork_add_comment',
      description: 'Add a comment to a task. Use when asked to leave a note/update/comment on a task. Does not notify followers by default.',
      input_schema: { type: 'object', properties: {
        task_id: { type: 'string' }, body: { type: 'string', description: 'the comment text' }
      }, required: ['task_id', 'body'] }
    },
    execute: async ({ task_id, body }) => {
      const d = await twApiSend('post', `/tasks/${encodeURIComponent(task_id)}/comments.json`, { comment: { body, notify: 'false' } });
      return { ok: true, comment_id: d.commentId || d.id || (d.comment && d.comment.id) };
    } },
];
// Teamwork WRITE tool names (create/update/complete/reopen/comment). READ tools are everything else.
TEAMWORK_TOOLS.push(...createTeamworkPlanningTools({ send: twApiSend, get: twApiGet, ymd: twYmd }));
const TW_WRITE_NAMES = new Set(['teamwork_create_task', 'teamwork_update_task', 'teamwork_complete_task',
  'teamwork_reopen_task', 'teamwork_add_comment', ...TEAMWORK_PLANNING_WRITE_TOOL_NAMES]);
const teammateApprovals = registerTeammateApprovalRuntime({ app, requireAuth, teamworkTools: TEAMWORK_TOOLS, db, dataDirectory: LOCAL_DATA_DIR, databaseReady: () => _dbReady, writeThrough: _writeThrough, resolveSlackIdentity: getSlackUserIdentity, sendProposal: postSlackMessageReceipt, postMessage: postSlackMessage });
// ── Slack SEND tool — lets Nora send a Slack message RIGHT NOW to another channel or person when
//    asked in a conversation, instead of queuing it for the hourly loop. Posts as the Nora bot (same
//    as her replies). Explicit requests only. Financial figures are
//    refused so she can't broadcast dollar amounts to a channel she may not control the audience of.
// Resolve a channel NAME (e.g. "pm-team") to its id among channels the bot is in. Cached ~10 min.
let _slackChanByName = null, _slackChanByNameAt = 0;
// Resolve a person's NAME to a Slack user id (real name, display name, or handle). Cached ~10 min.
let _slackUserByName = null, _slackUserByNameAt = 0;
const SLACK_SEND_TOOL = {
  definition: {
    name: 'slack_send_message',
    description: 'Send a Slack message RIGHT NOW to ANOTHER channel or person, on behalf of whoever you are talking to, instead of queuing it for the hourly loop. Use when they ask you to send/post/share/tell something to a channel ("send a note to the PM team") or DM a teammate ("let Mallory know ..."). Pass channel (a name like "pm-team" with or without #, or a channel id starting C) OR user (a person name or user id starting U), plus text. Use ONLY when clearly asked to send something; if the target or the wording is ambiguous, ask one quick question first. After it sends, say exactly what you sent and where. You are sending AS yourself (Nora), so attribute to the requester when it helps ("Heads up from John: ...") and never send something inappropriate coming from you. Never put dollar amounts or other financial figures in a sent message.',
    input_schema: { type: 'object', properties: {
      channel: { type: 'string', description: 'target channel: a name (e.g. "pm-team") or channel id (C...)' },
      user: { type: 'string', description: 'OR a person to DM: their name or Slack user id (U...)' },
      text: { type: 'string', description: 'the message to send, in your own voice' }
    }, required: ['text'] }
  },
  execute: async ({ channel, user, text }) => {
    if (!text || !text.trim()) return { error: 'text is required' };
    if (containsFinancialContent(text)) return { error: 'Refused: that message contains financial figures. You will not broadcast dollar amounts or rates to a channel or person; tell the requester to share those directly.' };
    const post = async (channelId, where) => {
      const r = await axios.post('https://slack.com/api/chat.postMessage', { channel: channelId, ...formatSlackMessagePayload(text) },
        { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 8000 });
      if (!r.data || !r.data.ok) return { error: `Slack send failed: ${r.data && r.data.error}` };
      return { ok: true, sent_to: where, ts: r.data.ts };
    };
    try {
      if (channel) {
        const id = /^C[A-Z0-9]/.test(channel) ? channel : await resolveSlackChannelByName(channel);
        if (!id) return { error: `Could not find a channel named "${channel}" that the Nora bot is a member of. The bot has to be added to a channel before it can post there.` };
        return await post(id, `#${String(channel).replace(/^#/, '')}`);
      }
      if (user) {
        const uid = /^U[A-Z0-9]/.test(user) ? user : await resolveSlackUserByName(user);
        if (!uid) return { error: `Could not find a person named "${user}".` };
        // Normal path: open the DM channel, then post. If conversations.open is blocked (most often a
        // missing im:write scope on the bot), fall back to posting straight to the user id (Slack also
        // routes that to the DM). Surface Slack's real error so the cause is obvious, not "couldn't open".
        let dmErr = '';
        try {
          const dm = await axios.post('https://slack.com/api/conversations.open', { users: uid },
            { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 8000 });
          if (dm.data && dm.data.ok && dm.data.channel && dm.data.channel.id) {
            return await post(dm.data.channel.id, `a DM to ${user}`);
          }
          dmErr = (dm.data && dm.data.error) || 'unknown';
        } catch (e) { dmErr = e.response?.data?.error || e.message; }
        const direct = await post(uid, `a DM to ${user}`); // fallback: post directly to the user id
        if (direct.ok) return direct;
        const scopeHint = /scope|not_allowed|cannot_dm|restricted/i.test(`${dmErr} ${direct.error || ''}`)
          ? ' This looks like a permissions gap: the Nora Slack app needs the "im:write" scope (and "mpim:write" for group DMs) added, then a reinstall. Channel posts don\'t need it.' : '';
        return { error: `Couldn't DM ${user}. Slack returned "${dmErr}" opening the DM.${scopeHint}` };
      }
      return { error: 'Give me a channel or a person to send to.' };
    } catch (e) {
      return { error: e.response?.data?.error || e.message || 'send failed' };
    }
  }
};

// ── Deferred-tool background jobs ───────────────────────────────────────────────
// Some MCP tools (ImageGen especially) run for minutes. Called inline in Slack,
// turn they'd blow the 16s tool timeout and stall the reply. Instead we ENQUEUE them, hand the
// turn back immediately ("on it, I'll post it here in a couple minutes"), and a worker runs the
// tool with a generous timeout and delivers the result back to the origin thread.
function buildNoraQueueTaskTool({ channel = '', threadTs = '', user = '', now = () => new Date(), add = addTask } = {}) {
  return {
    definition: {
      name: 'nora_queue_recurring_task',
      description: 'Queue work for YOURSELF (Nora) in your own durable task queue. Use this—not Teamwork project search—when someone asks you to remember, queue, schedule, or repeat something for yourself. Supports one-time tasks and weekly/biweekly recurrence. This records the work; it does not perform it immediately. Include the destination channel when the future task must post there.',
      input_schema: { type: 'object', properties: {
        action: { type: 'string', description: 'Short, concrete action you will perform.' },
        detail: { type: 'string', description: 'Enough context to perform it later, including what content to prepare.' },
        destination_channel: { type: 'string', description: 'Optional Slack destination, preferably the C... channel id supplied by the requester.' },
        repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'], description: 'How often to repeat: daily, weekdays (Mon-Fri), weekly, or monthly. Omit for a one-time task or when using interval_weeks.' },
        weekday: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], description: 'Required with repeat=weekly. Which day it runs.' },
        day_of_month: { type: 'integer', minimum: 1, maximum: 31, description: 'Required with repeat=monthly. Clamped to the month length, so 31 lands on the last day of a short month.' },
        interval_weeks: { type: 'integer', minimum: 1, maximum: 52, description: 'Every N weeks, for a cadence the repeat options do not cover. Set to 2 for biweekly.' },
        first_run_at: { type: 'string', description: 'Optional ISO datetime for the first run. If omitted for a recurring task, the first run is one interval from now.' },
        local_time: { type: 'string', description: 'Optional Central time HH:MM for recurring runs; defaults to the current Central time.' }
      }, required: ['action'] }
    },
    execute: async input => {
      const action = String(input?.action || '').trim();
      if (!action) return { error: 'action is required' };
      const current = now();
      let recurrence = null;
      const intervalWeeks = input?.interval_weeks == null ? null : Number(input.interval_weeks);
      const repeat = String(input?.repeat || '').trim().toLowerCase();
      if (repeat && intervalWeeks != null) return { error: 'use either repeat or interval_weeks, not both' };
      if (repeat || intervalWeeks != null) {
        const central = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ, hour12: false, hour: '2-digit', minute: '2-digit' })
          .formatToParts(current).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
        const localTime = String(input.local_time || `${String(Number(central.hour) % 24).padStart(2, '0')}:${central.minute}`);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return { error: 'local_time must be HH:MM in Central time' };
        // The scheduler has always understood daily, weekdays, weekly and monthly; only this tool's
        // schema was narrower, so "every weekday at nine" was unaskable from Slack even though
        // nothing underneath was missing.
        if (repeat === 'daily') recurrence = `daily:${localTime}`;
        else if (repeat === 'weekdays') recurrence = `weekdays:${localTime}`;
        else if (repeat === 'weekly') {
          const weekday = String(input?.weekday || '').trim().toLowerCase();
          if (!weekday) return { error: 'weekday is required when repeat is weekly' };
          recurrence = `weekly:${weekday}:${localTime}`;
        } else if (repeat === 'monthly') {
          const dom = Number(input?.day_of_month);
          if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { error: 'day_of_month must be an integer from 1 to 31 when repeat is monthly' };
          recurrence = `monthly:${dom}:${localTime}`;
        } else if (repeat) return { error: 'repeat must be daily, weekdays, weekly, or monthly' };
        else {
          if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 52) return { error: 'interval_weeks must be an integer from 1 to 52' };
          recurrence = `every:${intervalWeeks}:weeks:${localTime}`;
        }
        // Never persist a rule the scheduler cannot advance; that would queue work that never runs.
        if (!isValidRecurrence(recurrence)) return { error: `could not build a valid schedule from ${recurrence}` };
      }
      let scheduledFor = null;
      if (input?.first_run_at) {
        const parsed = new Date(input.first_run_at);
        if (Number.isNaN(parsed.getTime())) return { error: 'first_run_at must be a valid ISO datetime' };
        scheduledFor = parsed.toISOString();
      } else if (recurrence) scheduledFor = computeNextRun(recurrence, current);
      const destination = String(input?.destination_channel || '').trim();
      const detail = [String(input?.detail || '').trim(), destination ? `Deliver the finished result to Slack channel ${destination}.` : '']
        .filter(Boolean).join('\n');
      const id = add({ action, detail, assignee: 'Nora', scheduled_for: scheduledFor, recurrence,
        source_channel: channel ? `slack:${channel}` : 'slack', source_user: user,
        source_thread_ts: threadTs, source_external_id: threadTs, context: detail,
        metadata: destination ? { destination_channel: destination } : null });
      return { ok: true, task_id: id, action, scheduled_for: scheduledFor, recurrence,
        destination_channel: destination || null, message: recurrence
          ? `Queued for Nora and set to repeat every ${intervalWeeks} week${intervalWeeks === 1 ? '' : 's'}.`
          : 'Queued for Nora.' };
    }
  };
}

const DEFERRED_JOB_TIMEOUT_MS = 8 * 60 * 1000;
const DEFERRED_JOB_POLL_MS = 3000;
const MAX_MEMORY_JOB_PENDING = 100;
const MAX_MEMORY_JOB_RETAINED = 250;
const _memJobs = []; // in-memory fallback when Postgres isn't active (jobs don't survive restart)
const _pendingJobFinalizations = new Map();
const _deferredJobHealth = createDeferredJobHealth({ pollMs: DEFERRED_JOB_POLL_MS });

function pruneMemoryJobs() {
  while (_memJobs.length > MAX_MEMORY_JOB_RETAINED) {
    const terminal = _memJobs.findIndex(job => ['done', 'failed'].includes(job?.status));
    if (terminal < 0) break;
    _memJobs.splice(terminal, 1);
  }
}

function enqueueMemoryJob(job) {
  pruneMemoryJobs();
  const active = _memJobs.filter(item => ['queued', 'running'].includes(item?.status)).length;
  if (active >= MAX_MEMORY_JOB_PENDING) {
    _deferredJobHealth.fallbackRejected();
    const error = new Error(`deferred connector queue is at its ${MAX_MEMORY_JOB_PENDING}-job safety limit`);
    error.code = 'deferred_job_queue_full';
    throw error;
  }
  _memJobs.push({ ...job, status: 'queued', _queued_at: Date.now() });
  _deferredJobHealth.fallbackEnqueued();
  pruneMemoryJobs();
}

const resolveJohnSlackId = () => process.env.NORA_OWNER_SLACK_ID || 'UJYKB4788';

const ACTION_WRITE_NAME = /(?:create|update|complete|reopen|add_comment|send|post|write|delete|remove|join|upload|move|rename|queue|schedule)/i;

function actionInteractionRef(origin = {}) {
  return origin.interaction_ref || origin.thread_ts || origin.bot_id || origin.channel || origin.kind || 'unknown';
}

function safelyBeginToolExecution({ toolUseId, toolName, args, meta, origin = {}, deferred = false }) {
  try {
    return operationStore.beginActionExecution({
      tool_use_id: toolUseId, tool_name: meta?.toolName || toolName,
      tool_family: meta?.connectionName || String(toolName || '').split('_')[0] || 'tool',
      actor_class: 'model_selected', selection_origin: 'model_tool_use',
      surface: origin.kind || 'unknown', interaction_ref: actionInteractionRef(origin), requester: origin.requester || null,
      access_mode: meta?.accessMode || (ACTION_WRITE_NAME.test(String(toolName || '')) ? 'write' : 'read'),
      deferred, arguments: args || {},
    });
  } catch (error) {
    console.warn(`action execution selection receipt failed for ${toolName}: ${error.message}`);
    return null;
  }
}

function safelyQueueToolExecution(execution, jobId) {
  if (!execution) return;
  try { operationStore.markActionExecutionQueued(execution.id, { job_id: jobId }); }
  catch (error) { console.warn(`action execution queue receipt failed for ${execution.tool_name}: ${error.message}`); }
}

function safelyCompleteToolExecution(executionId, status, resultOrError) {
  if (!executionId) return;
  try {
    operationStore.completeActionExecution(executionId, status === 'succeeded'
      ? { status, result: resultOrError }
      : { status: 'failed', error: String(resultOrError?.message || resultOrError || 'tool failed') });
  } catch (error) { console.warn(`action execution completion receipt failed for ${executionId}: ${error.message}`); }
}

async function enqueueDeferredJob({ connectionId, toolName, args, origin, label }) {
  const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const job = { id, kind: (origin && origin.kind) || 'slack', connection_id: connectionId, tool_name: toolName, label: label || toolName, args: args || {}, origin: origin || {} };
  if (_dbReady) { try { await db.enqueueJob(job); } catch (e) { console.warn('enqueueJob failed, using bounded memory fallback:', e.message); enqueueMemoryJob(job); } }
  else enqueueMemoryJob(job);
  console.log(`🧵 Deferred job ${id} queued: ${toolName} (origin ${job.kind})`);
  return { id };
}

// Turn a raw tool result into a short human message. ImageGen and most media tools return public
// URLs, which are the payload; otherwise summarize.
function renderJobResult(result, label) {
  let text = '';
  try { text = typeof result === 'string' ? result : JSON.stringify(result); } catch { text = String(result); }
  const urls = [...new Set((text.match(/https?:\/\/[^\s"'`)\]]+/g) || []))].slice(0, 6);
  if (urls.length) return `here's ${label ? label.toLowerCase() : 'what you asked for'}:\n${urls.join('\n')}`;
  return `done with ${label || 'that'}.` + (text && text.length < 500 ? ` ${text}` : '');
}

async function deliverJobMessage(job, text) {
  const origin = job.origin || {};
  if (origin.kind === 'slack' && origin.channel) {
    const posted = await postSlackMessage(origin.channel, text, origin.thread_ts);
    if (!posted) { const j = resolveJohnSlackId(); if (j) await postSlackMessage(j, `(couldn't reach the original thread) ${text}`); }
    return;
  }
  const johnId = resolveJohnSlackId();
  if (johnId) await postSlackMessage(johnId, text);
  else console.warn(`job ${job.id}: no delivery target (origin ${origin.kind}, no John ID in memory)`);
}

async function deliverJobResult(job, { ok, result, error }) {
  const label = job.label || job.tool_name;
  const text = ok
    ? renderJobResult(result, label)
    : `couldn't finish ${label || 'that'}. ${String(error || 'it failed').slice(0, 200)}. want me to retry?`;
  return deliverJobMessage(job, text);
}

async function recoverInterruptedDeferredJobs() {
  if (!_dbReady) return [];
  const interrupted = await db.interruptRunningJobs();
  for (const job of interrupted) {
    const label = job.label || job.tool_name || 'that connector action';
    const message = `the service restarted while ${label} was still in progress. I can't verify whether the provider completed it, so I did not retry it and risk doing it twice. please check the destination before asking me to retry.`;
    safelyCompleteToolExecution(job.origin?.action_execution_id, 'failed',
      'Service restart left the external action outcome unknown; automatic retry was suppressed.');
    await deliverJobMessage(job, message).catch(error =>
      console.warn(`Interrupted deferred job ${job.id} notice could not be delivered: ${error.message}`));
  }
  if (interrupted.length) {
    console.warn(`Marked ${interrupted.length} interrupted deferred connector job(s) outcome-unknown without replay`);
  }
  return interrupted;
}

async function processNextJob() {
  let job = null;
  if (_dbReady) {
    if (typeof db.backgroundAllowed === 'function' && !db.backgroundAllowed()) return;
    job = await db.claimNextQueuedJob();
  }
  else { const idx = _memJobs.findIndex(j => j.status === 'queued'); if (idx >= 0) { job = _memJobs[idx]; job.status = 'running'; } }
  if (!job) return;
  const jobActivity = runtimeActivity.begin({ id: `job:${job.id}`, lane: 'background',
    kind: 'deferred_tool_job', label: 'Running a deferred connector task',
    detail: 'Executing work that was intentionally moved out of a live Slack or meeting response.',
    source: 'job-worker', meta: { step: job.tool_name || 'connector_tool', surface: job.kind || 'background' } });
  let result;
  try {
    result = await mcpManager.callTool(job.connection_id, job.tool_name, job.args || {}, { timeout: DEFERRED_JOB_TIMEOUT_MS });
  } catch (e) {
    const error = e.response?.data?.message || e.message || 'tool failed';
    if (_dbReady) {
      try { await db.finishJob(job.id, { status: 'failed', error }); }
      catch (finishError) {
        _pendingJobFinalizations.set(job.id, { status: 'failed', error });
        console.warn(`Deferred job ${job.id} failure outcome is pending persistence: ${finishError.message}`);
      }
    } else { job.status = 'failed'; pruneMemoryJobs(); }
    safelyCompleteToolExecution(job.origin?.action_execution_id, 'failed', error);
    await deliverJobResult(job, { ok: false, error }).catch(deliveryError =>
      console.warn(`Deferred job ${job.id} failure notice could not be delivered: ${deliveryError.message}`));
    runtimeActivity.finish(jobActivity.id, { status: 'failed',
      detail: 'The deferred connector task failed without blocking the live response path.',
      outcome: 'Failure notice routed to the originating surface.' });
    _deferredJobHealth.jobFailed();
    console.warn(`❌ Deferred job ${job.id} failed: ${error}`);
    return;
  }

  if (_dbReady) {
    try { await db.finishJob(job.id, { status: 'done', result }); }
    catch (error) {
      _pendingJobFinalizations.set(job.id, { status: 'done', result });
      console.warn(`Deferred job ${job.id} completion is pending persistence: ${error.message}`);
    }
  } else { job.status = 'done'; pruneMemoryJobs(); }
  safelyCompleteToolExecution(job.origin?.action_execution_id, 'succeeded', result);
  await deliverJobResult(job, { ok: true, result }).catch(error =>
    console.warn(`Deferred job ${job.id} result could not be delivered: ${error.message}`));
  runtimeActivity.finish(jobActivity.id, { status: 'completed',
    detail: 'The deferred connector task completed and its result was routed back.',
    outcome: 'Delivery attempted on the originating surface.' });
  _deferredJobHealth.jobCompleted();
  console.log(`✅ Deferred job ${job.id} done: ${job.tool_name}`);
}

async function flushPendingJobFinalizations() {
  if (!_dbReady || !_pendingJobFinalizations.size) return;
  for (const [jobId, outcome] of _pendingJobFinalizations) {
    await db.finishJob(jobId, outcome);
    _pendingJobFinalizations.delete(jobId);
  }
}

let _jobWorkerBusy = false;
let _jobWorkerLoop = null;
function deferredJobWorkerAdmission({
  operationalLock = activeDurableRunLock(),
  resourceAdmission = processResources.backgroundAdmission(),
  now = Date.now(),
} = {}) {
  if (operationalLock) {
    return {
      allowed: false,
      reason: 'operational_run_active',
      retry_after_ms: Math.max(1000, Number(operationalLock.expires_at) - Number(now)),
    };
  }
  if (resourceAdmission?.allowed === false) {
    return {
      allowed: false,
      reason: resourceAdmission.reason || 'resource_pressure',
      retry_after_ms: Math.max(1000, Number(resourceAdmission.retry_after_ms) || 5000),
    };
  }
  return { allowed: true, reason: null, retry_after_ms: 0 };
}

async function jobWorkerTick() {
  if (_jobWorkerBusy) return; // serial: one job at a time, no overlap
  _jobWorkerBusy = true;
  _deferredJobHealth.pollStarted();
  try {
    const admission = deferredJobWorkerAdmission();
    if (!admission.allowed) {
      // Do not claim the durable row until it is safe to start. A claimed MCP write cannot be
      // blindly aborted and retried because the remote provider may have committed the side
      // effect before the transport learned the outcome.
      _deferredJobHealth.workerSucceeded();
      return { state: 'deferred', ...admission };
    }
    await flushPendingJobFinalizations();
    await processNextJob();
    _deferredJobHealth.workerSucceeded();
    return { state: 'completed' };
  } catch (error) {
    _deferredJobHealth.workerFailed(error);
    throw error;
  } finally { _jobWorkerBusy = false; }
}
async function startJobWorker() {
  if (_jobWorkerLoop && !_jobWorkerLoop.snapshot().closed) return;
  _jobWorkerLoop = createAdaptiveWorkerLoop({
    name: 'deferred-connector-worker',
    bootstrap: recoverInterruptedDeferredJobs,
    tick: jobWorkerTick,
    nextDelayMs: () => _deferredJobHealth.schedule(),
    onError: error =>
      console.warn(`Deferred job worker paused for bounded backoff: ${error.message}`),
  });
  _runtimeIntervals.push(_jobWorkerLoop);
  await _jobWorkerLoop.start();
}

// Run a Claude request that may use client-side tools, executing them and looping until the
// model produces its final answer. Web search is server-side; Teamwork and MCP tools execute here.
// opts.deferredMeta + opts.origin: when the model calls a tool flagged deferred, enqueue it as a
// background job and hand back a synthetic result instead of running it inline.
async function runClaudeToolLoop(reqBody, headers, executors, maxIters = 6, opts = {}) {
  const URL = 'https://api.anthropic.com/v1/messages';
  const post = opts.post || axios.post;
  const startedAt = Date.now();
  const deadlineMs = Number.isFinite(Number(opts.deadlineMs))
    ? Math.max(1, Number(opts.deadlineMs)) : null;
  const providerTimeoutMs = Math.max(1000, Number(opts.providerTimeoutMs) || 30000);
  const toolTimeoutMs = Math.max(1000, Number(opts.toolTimeoutMs) || 12000);
  const finalizationReserveMs = deadlineMs == null ? 0 : Math.min(8000, providerTimeoutMs,
    Math.max(1, Math.floor(deadlineMs * 0.25)));
  const writeStartMinimumMs = Math.max(1000, Number(opts.writeStartMinimumMs) || 15000);
  const writeToolNames = new Set(opts.writeToolNames || []);
  const durableWriteReceipts = opts.durableWriteReceipts === true;
  const writeReceiptTimeoutMs = Math.max(1000,
    Number(opts.writeReceiptTimeoutMs) || 8000);
  const persistActionReceipt = opts.persistActionReceipt
    || (() => operationStore.persistStrict());
  const remaining = () => deadlineMs == null ? Infinity : deadlineMs - (Date.now() - startedAt);
  const operationSignal = signal => opts.signal
    ? AbortSignal.any([signal, opts.signal]) : signal;
  const withinDeadline = async (label, maximumMs, operation) => {
    if (opts.signal?.aborted) {
      const error = opts.signal.reason instanceof Error
        ? opts.signal.reason : new Error(`${label} cancelled by foreground priority`);
      error.code ||= 'background_preempted';
      throw error;
    }
    const left = remaining();
    if (left <= 0) {
      const error = new Error(`${label} could not start because the interactive deadline elapsed`);
      error.code = 'interactive_deadline_exceeded';
      throw error;
    }
    const timeoutMs = Math.max(1, Math.min(maximumMs, left));
    return rejectWithinAbortable(operation, timeoutMs, label);
  };
  const callProvider = body => withinDeadline('Claude response', providerTimeoutMs,
    signal => post(URL, body, { ...headers, signal: operationSignal(signal),
      timeout: Math.max(1, Math.min(providerTimeoutMs, remaining())) }));
  const deadlineResponse = () => ({ data: { content: [], stop_reason: 'interactive_deadline' } });
  let response;
  try { response = await callProvider(reqBody); }
  catch (error) {
    if (error.code !== 'interactive_deadline_exceeded') throw error;
    // Swallowing this silently made a budget exhaustion look identical to a model that chose to
    // say nothing, which is exactly the ambiguity that hid the Slack delivery regression.
    console.warn(`Claude tool loop yielded an empty response: the interactive deadline elapsed before the provider replied (budget ${deadlineMs ?? 'none'}ms)`);
    response = deadlineResponse();
  }
  let iters = 0;
  const firedTools = []; // client-side tools that actually executed this turn (for downstream dedup)
  const actionExecutionIds = [];
  const exactToolResults = new Map();
  const toolCallCounts = new Map();
  while (iters < maxIters) {
    const sr = response.data.stop_reason;
    // Server-side web search can pause the turn at its internal limit — continue
    // by re-sending the accumulated assistant content; otherwise the turn can end with no text.
    if (sr === 'pause_turn') {
      iters++;
      reqBody.messages.push({ role: 'assistant', content: response.data.content });
      try { response = await callProvider(reqBody); }
      catch (error) {
        if (error.code !== 'interactive_deadline_exceeded') throw error;
        break;
      }
      continue;
    }
    if (sr !== 'tool_use') break;
    iters++;
    const toolUses = response.data.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) break;
    const results = [];
    for (const tu of toolUses) {
      let content;
      const normalizedInput = tu.input && typeof tu.input === 'object'
        ? Object.fromEntries(Object.entries(tu.input).sort(([a], [b]) => a.localeCompare(b))) : (tu.input || {});
      const fingerprint = `${tu.name}:${JSON.stringify(normalizedInput)}`;
      const priorCount = toolCallCounts.get(tu.name) || 0;
      const perToolLimit = Number(opts.toolCallLimits?.[tu.name] || 0);
      if (exactToolResults.has(fingerprint)) {
        content = JSON.stringify({ blocked: true, reason: 'duplicate_tool_call', message: 'This exact call already ran in this turn. Use its prior result and answer now; do not call it again.' });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content });
        continue;
      }
      if (perToolLimit > 0 && priorCount >= perToolLimit) {
        content = JSON.stringify({ blocked: true, reason: 'tool_call_limit', message: `You already used ${tu.name} ${priorCount} times this turn. Use the evidence you have and answer now, or state the single missing detail without asking the user to repeat themselves.` });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content });
        continue;
      }
      toolCallCounts.set(tu.name, priorCount + 1);
      // Deferred tool (e.g. ImageGen): don't run it inline — it takes minutes. Enqueue a job and
      // tell the model it's been kicked off, so the live turn ends now and the result is delivered
      // to this thread later by the worker.
      const dm = opts.deferredMeta && opts.deferredMeta[tu.name];
      const writeCapable = writeToolNames.has(tu.name) || dm?.accessMode === 'write';
      const executionMeta = writeCapable
        ? { ...(dm || {}), accessMode: 'write' } : dm;
      const execution = safelyBeginToolExecution({ toolUseId: tu.id, toolName: tu.name,
        args: tu.input || {}, meta: executionMeta, origin: opts.origin || {},
        deferred: Boolean(dm?.deferred) });
      if (execution) actionExecutionIds.push(execution.id);
      if (writeCapable && durableWriteReceipts) {
        if (!execution) {
          content = JSON.stringify({
            error: 'write refused because its durable selection receipt could not be created',
          });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content });
          continue;
        }
        try {
          await withinDeadline(`${tu.name} write-ahead receipt`,
            writeReceiptTimeoutMs, () => persistActionReceipt());
        } catch (error) {
          safelyCompleteToolExecution(execution.id, 'failed', error);
          // The connector has not started, so retrying is safe. Close the receipt for operator
          // visibility when persistence recovers, but never let this cleanup start the write.
          await withinDeadline(`${tu.name} refused-write receipt`,
            writeReceiptTimeoutMs, () => persistActionReceipt()).catch(() => {});
          content = JSON.stringify({
            error: 'write not started because its selection receipt was not durable',
          });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content });
          continue;
        }
      }
      if (dm && dm.deferred) {
        try {
          const origin = { ...(opts.origin || { kind: 'slack' }), ...(execution ? { action_execution_id: execution.id } : {}) };
          const { id } = await enqueueDeferredJob({ connectionId: dm.connectionId, toolName: dm.toolName, args: tu.input || {}, origin, label: dm.connectionName });
          safelyQueueToolExecution(execution, id);
          firedTools.push(tu.name);
          content = JSON.stringify({ deferred: true, job_id: id, status: 'queued', message: `Started this as a background job (it runs for a few minutes). The result will be posted to this thread automatically when it finishes. Tell the user you've kicked it off and will follow up here shortly. Do NOT wait, and do NOT call this tool again for the same request.` });
        } catch (e) {
          safelyCompleteToolExecution(execution?.id, 'failed', e);
          content = JSON.stringify({ error: `could not queue background job: ${e.message}` });
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(content).slice(0, 12000) });
        continue;
      }
      try {
        const exec = executors[tu.name];
        if (!exec) throw new Error(`unknown tool ${tu.name}`);
        const toolWriteStartMinimumMs = Math.max(1000,
          Number(opts.writeStartMinimumByTool?.[tu.name]) || writeStartMinimumMs);
        const availableForTool = remaining() - finalizationReserveMs;
        if (availableForTool <= 0 || (writeCapable && availableForTool < toolWriteStartMinimumMs)) {
          const error = new Error(writeCapable
            ? `not started: ${tu.name} did not have a safe completion window before the interactive deadline`
            : `not started: ${tu.name} would consume the final-answer reserve`);
          error.code = 'interactive_tool_not_started';
          throw error;
        }
        // Never race an already-started write: its connector timeout is the only truthful way to
        // know whether the side effect committed. Reads are safe to cancel and must leave enough
        // of the turn for Claude to synthesize a useful final answer.
        const result = writeCapable
          ? await exec(tu.input || {}, { timeoutMs: Math.min(toolTimeoutMs, availableForTool) })
          : await rejectWithinAbortable(signal => exec(tu.input || {}, {
            signal: operationSignal(signal), timeoutMs: Math.min(toolTimeoutMs, availableForTool),
          }), Math.min(toolTimeoutMs, availableForTool), `${tu.name} tool`);
        const succeeded = !(result && typeof result === 'object' && result.error);
        const uncertainWriteFailure = writeCapable && durableWriteReceipts && !succeeded
          && /abort|timeout|timed out|network|socket|connection reset|hang up/i
            .test(String(result?.error || ''));
        if (!uncertainWriteFailure) {
          safelyCompleteToolExecution(execution?.id, succeeded ? 'succeeded' : 'failed',
            succeeded ? result : result.error);
        }
        if (writeCapable && durableWriteReceipts) {
          await withinDeadline(`${tu.name} outcome receipt`,
            writeReceiptTimeoutMs, () => persistActionReceipt());
        }
        if (succeeded) firedTools.push(tu.name);
        content = JSON.stringify(result);
      } catch (e) {
        const uncertainWriteFailure = writeCapable && durableWriteReceipts
          && /abort|timeout|timed out|network|socket|connection reset|hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT/i
            .test(`${e?.code || ''} ${e?.message || e || ''}`);
        if (!uncertainWriteFailure) safelyCompleteToolExecution(execution?.id, 'failed', e);
        if (writeCapable && durableWriteReceipts) {
          // Once a remote write starts, a timeout cannot prove that it did not commit. Persist the
          // open selection as an uncertainty barrier so a restart will not repeat the side effect.
          await withinDeadline(`${tu.name} failure receipt`,
            writeReceiptTimeoutMs, () => persistActionReceipt()).catch(() => {});
        }
        if (['interactive_deadline_exceeded', 'interactive_tool_not_started'].includes(e.code)) {
          console.warn(`Live tool ${tu.name} contained by the interaction deadline: ${e.message}`);
        }
        content = JSON.stringify({ error: (e.response?.data?.message || e.message || 'tool failed') });
      }
      exactToolResults.set(fingerprint, content);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(content).slice(0, 12000) });
    }
    reqBody.messages.push({ role: 'assistant', content: response.data.content });
    reqBody.messages.push({ role: 'user', content: results });
    if (iters >= maxIters) {
      // Hit the cap mid-chain — force a FINAL text answer with tools off, so she never returns
      // an empty turn (which would post a blank Slack/chat message). Results are already provided.
      const wrap = { ...reqBody }; delete wrap.tools; delete wrap.tool_choice;
      wrap.messages = reqBody.messages.concat([{ role: 'user', content: 'Tool time is exhausted. Give a useful final answer now using the results already returned. If an action did not complete, say what failed and what remains; do not return empty and do not ask the user to repeat the request.' }]);
      try { response = await callProvider(wrap); } catch { /* keep last response */ }
      break;
    }
    try { response = await callProvider(reqBody); }
    catch (error) {
      if (error.code !== 'interactive_deadline_exceeded') throw error;
      break;
    }
  }
  return { response, firedTools, actionExecutionIds };
}

function verifySlackSignature(req) {
  return verifySlackRequest(req).valid;
}

function verifySlackRequest(req) {
  return externalSourceAttestation.verifySlackRequest({ body: req.body, rawBody: req.rawBody,
    timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'],
    signingSecret: process.env.SLACK_SIGNING_SECRET, now: new Date() });
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

// Decide whether Nora should respond to this Slack event.
// She responds if it is a DM, she was mentioned, or it is an active joined thread.
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
  return false;
}

// ---- Slack file inbox ----
// When someone Slacks Nora a file, we download it to a server-side inbox folder and
// create a cowork task. The cowork loop then fetches the file back from us (via the
// authed /admin/inbox endpoint below) and uploads it to the right Drive folder using
// the existing Drive MCP two-hop pattern. Storing locally first means we own the file
// even if Slack later expires its URL, and decouples the (fast) Slack ACK from the
// (slow, mcp-driven) Drive upload.

const INBOX_DIR_VOLUME = path.join(VOLUME_DIR, 'nora-inbox');
const INBOX_DIR_LOCAL = path.join(LOCAL_DATA_DIR, 'nora-inbox');
function getInboxDir() {
  return fs.existsSync(VOLUME_DIR) ? INBOX_DIR_VOLUME : INBOX_DIR_LOCAL;
}
function ensureInboxDir() {
  const dir = getInboxDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

const MAX_INBOX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — covers typical decks/PDFs/images
const MAX_INBOX_FILES_PER_MESSAGE = 5;
const SLACK_FILE_DOWNLOAD_TIMEOUT_MS = 20000;
const SLACK_FILE_BATCH_TIMEOUT_MS = 30000;

// Download a Slack file by url_private_download. We manually follow redirects so the
// Authorization header is preserved across them — axios's default auto-follow strips
// auth on cross-origin redirects (slack.com → files.slack.com etc.), causing Slack to
// respond with a sign-in HTML page instead of the file bytes. After the final response
// we also sanity-check the content-type and first bytes; if Slack served us HTML
// anyway (e.g., missing files:read scope), surface a clear error rather than write
// garbage to disk.
async function downloadSlackFile(downloadUrl, token, maxBytes, { deadlineAt = null } = {}) {
  let url = downloadUrl;
  let lastStatus;
  const terminalAt = deadlineAt || Date.now() + SLACK_FILE_DOWNLOAD_TIMEOUT_MS;
  for (let hop = 0; hop < 6; hop++) {
    const remainingMs = Math.min(SLACK_FILE_DOWNLOAD_TIMEOUT_MS, terminalAt - Date.now());
    if (remainingMs <= 0) throw new Error('Slack file download exceeded 20s total deadline');
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxRedirects: 0,            // we follow them manually so auth is preserved
      maxContentLength: maxBytes,
      timeout: remainingMs,
      validateStatus: s => (s >= 200 && s < 400)
    });
    lastStatus = res.status;
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.location;
      if (!next) throw new Error(`Slack redirected (${res.status}) with no Location header`);
      url = new URL(next, url).toString();
      continue;
    }
    // 2xx — final response
    const body = Buffer.from(res.data);
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    const looksHtml = ct.startsWith('text/html')
      || (body.length >= 5 && body.slice(0, 14).toString('utf8').trimStart().toLowerCase().startsWith('<!doctype html'))
      || (body.length >= 5 && body.slice(0, 6).toString('utf8').toLowerCase() === '<html ')
      || (body.length >= 5 && body.slice(0, 5).toString('utf8').toLowerCase() === '<html');
    if (looksHtml) {
      const preview = body.slice(0, 200).toString('utf8').replace(/\s+/g, ' ');
      throw new Error(`Slack served HTML instead of the file (likely missing files:read scope or no channel access). Preview: ${preview.slice(0, 160)}`);
    }
    return { body, contentType: res.headers['content-type'] || null };
  }
  throw new Error(`Too many redirects (last status ${lastStatus})`);
}

async function handleSlackFiles(event, channel, user, threadTs, queryText, sourceAttestation = null,
  auditInteractionId = null) {
  console.log(`📎 Slack file event from ${user} (channel ${channel}): ${event.files.length} file(s), text="${queryText.slice(0, 80)}"`);
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    console.warn('📎 SLACK_BOT_TOKEN not set — cannot download Slack files');
    await slackConversationAudit.mark(auditInteractionId, {
      handling_status: 'failed', error: 'SLACK_BOT_TOKEN is not configured',
    });
    return;
  }
  ensureInboxDir();
  await slackConversationAudit.mark(auditInteractionId, { handling_status: 'processing_file' });
  const responseTexts = [];
  const responseTimestamps = [];

  // Confirm receipt before any download or model work. File intake is asynchronous from Slack's
  // perspective, but the sender should still see an immediate, provider-independent response.
  const receiptText = 'I see the attachment, pulling it down now.';
  const receiptPost = await axios.post('https://slack.com/api/chat.postMessage', {
    channel, thread_ts: threadTs, text: receiptText
  }, {
    headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
    timeout: SLACK_CONTROL_TIMEOUT_MS,
  }).catch(error => {
    console.warn('Slack file receipt post failed:', error.message);
    return null;
  });
  if (receiptPost?.data?.ok) {
    responseTexts.push(receiptText);
    if (receiptPost.data.ts) responseTimestamps.push(receiptPost.data.ts);
  }

  const savedFiles = [];
  const failedFiles = [];
  const batchDeadlineAt = Date.now() + SLACK_FILE_BATCH_TIMEOUT_MS;
  const files = event.files.slice(0, MAX_INBOX_FILES_PER_MESSAGE);
  if (event.files.length > files.length) {
    for (const f of event.files.slice(files.length)) {
      failedFiles.push({ name: f.name, reason: `message exceeds ${MAX_INBOX_FILES_PER_MESSAGE}-file intake limit` });
    }
  }
  for (const f of files) {
    const downloadUrl = f.url_private_download || f.url_private;
    if (!downloadUrl) {
      console.warn(`📎 File ${f.id} has no download URL; skipping`);
      failedFiles.push({ name: f.name, reason: 'no download URL' });
      continue;
    }
    if (typeof f.size === 'number' && f.size > MAX_INBOX_FILE_BYTES) {
      console.warn(`📎 File ${f.name} is ${(f.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_INBOX_FILE_BYTES / 1024 / 1024}MB limit; skipping`);
      failedFiles.push({ name: f.name, reason: `over ${MAX_INBOX_FILE_BYTES / 1024 / 1024}MB size limit` });
      continue;
    }
    try {
      const { body } = await downloadSlackFile(downloadUrl, slackToken, MAX_INBOX_FILE_BYTES,
        { deadlineAt: batchDeadlineAt });
      const inboxId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const safeName = sanitizeFilename(f.name || f.title || `file-${f.id}`);
      const filename = `${inboxId}__${safeName}`;
      const fullPath = path.join(getInboxDir(), filename);
      await fs.promises.writeFile(fullPath, body);
      console.log(`📎 Saved Slack file to inbox: ${filename} (${body.length} bytes, ${f.mimetype || 'unknown mime'})`);
      savedFiles.push({
        inbox_id: inboxId,
        filename: safeName,
        original_name: f.name || f.title || null,
        mimetype: f.mimetype || null,
        size: body.length,
        slack_file_id: f.id
      });
    } catch (err) {
      const reason = err.message || String(err);
      console.error(`📎 Failed to download file ${f.id} (${f.name}): ${reason}`);
      failedFiles.push({ name: f.name, reason });
    }
  }

  if (savedFiles.length === 0) {
    // Nothing we could save — surface that back to the sender so they don't wait forever.
    const reasons = failedFiles.map(f => `${f.name}: ${f.reason}`).join('; ').slice(0, 400);
    const text = `I saw the file${event.files.length > 1 ? 's' : ''} you sent but couldn't pull ${event.files.length > 1 ? 'any of them' : 'it'} down. Reason: ${reasons}. If the error mentions HTML or sign-in, the bot likely needs the files:read scope (or to be in the channel where the file was originally shared).`;
    let failurePost = null;
    try {
      failurePost = await axios.post('https://slack.com/api/chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text
      }, {
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        timeout: SLACK_CONTROL_TIMEOUT_MS,
      });
    } catch {}
    if (failurePost?.data?.ok) {
      responseTexts.push(text);
      if (failurePost.data.ts) responseTimestamps.push(failurePost.data.ts);
    }
    await slackConversationAudit.mark(auditInteractionId, {
      handling_status: responseTexts.length ? 'delivered' : 'failed',
      response_kind: 'file_intake',
      response_text: responseTexts.join('\n'),
      response_slack_timestamps: responseTimestamps,
      responded: responseTexts.length > 0,
      error: responseTexts.length ? null : reasons || 'Slack file intake failed',
      metadata: { saved_file_count: 0, failed_file_count: failedFiles.length },
    });
    return;
  }

  // Create a single task that captures all files in this message. The action describes
  // what the user actually asked for (or "Handle attachment(s)" if they sent files with
  // no text). The cowork loop reads the detail to know what to do — file to Drive,
  // review, summarize, answer questions about it, or ask for clarification — based on
  // the user's instruction, NOT a hardcoded assumption.
  const fileList = savedFiles.map(f => `- ${f.filename} (${f.mimetype || 'unknown'}, ${(f.size / 1024).toFixed(1)}KB) — inbox_id: ${f.inbox_id}`).join('\n');
  const fileNoun = savedFiles.length > 1 ? `${savedFiles.length} attachments` : `"${savedFiles[0].filename}"`;
  // Compact action — first line of instruction if short, else a generic phrase. The
  // detail field carries the full instruction verbatim so we never lose information.
  let action;
  if (queryText) {
    const firstLine = queryText.split('\n')[0].trim();
    action = firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + '...';
  } else {
    action = `Handle Slack attachment${savedFiles.length > 1 ? 's' : ''} (${fileNoun})`;
  }
  const detail = [
    queryText ? `User asked: "${queryText}"` : 'User sent the file(s) with no accompanying message — ask them in the thread what they want done before acting.',
    '',
    `Attached file${savedFiles.length > 1 ? 's' : ''} (fetch each via GET /admin/inbox/file/{inbox_id} with the API key):`,
    fileList,
    '',
    'Interpret the user request and do what they asked. Could be: file to Drive, review the contents and answer, summarize, flag risks, find specific info, etc. If ambiguous, reply in the original Slack thread and ask before acting. Reply in the thread with the result and DELETE the inbox file(s) once done.'
  ].join('\n');
  const taskId = addTask({
    action,
    detail,
    assignee: 'nora',
    source_channel: `slack:${channel}`,
    source_user: user,
    source_thread_ts: threadTs,
    source_external_id: event.ts,
    source_attestation: sourceAttestation,
    context: `[Slack file upload]\nUser said: ${queryText || '(no text — file only)'}\nFiles: ${savedFiles.map(f => f.filename).join(', ')}`
  });

  // Completion is deterministic: file intake must not depend on a second language-model call.
  const ackText = queryText
    ? `The ${savedFiles.length > 1 ? 'files are' : 'file is'} downloaded and queued. I'll follow up here.`
    : `The ${savedFiles.length > 1 ? 'files are' : 'file is'} downloaded. What would you like me to do with ${savedFiles.length > 1 ? 'them' : 'it'}?`;
  let ackPost = null;
  try {
    ackPost = await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: ackText
    }, {
      headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
      timeout: SLACK_CONTROL_TIMEOUT_MS,
    });
  } catch (err) {
    console.warn('📎 Slack ACK post failed:', err.response?.data || err.message);
  }
  if (ackPost?.data?.ok) {
    responseTexts.push(ackText);
    if (ackPost.data.ts) responseTimestamps.push(ackPost.data.ts);
  }
  await slackConversationAudit.mark(auditInteractionId, {
    handling_status: responseTexts.length ? 'delivered' : 'failed',
    response_kind: 'file_intake',
    response_text: responseTexts.join('\n'),
    response_slack_timestamps: responseTimestamps,
    responded: responseTexts.length > 0,
    error: responseTexts.length ? null : 'Slack file intake acknowledgments were not delivered',
    metadata: { saved_file_count: savedFiles.length, failed_file_count: failedFiles.length,
      queued_task_id: taskId },
  });

  console.log(`📎 Created inbox task ${taskId} for ${savedFiles.length} file(s) — action: "${action}"`);
}

// Inbox endpoints — used by the cowork loop to pull files back out for Drive upload.
// All require the standard NORA_API_KEY auth.
app.get('/admin/inbox', requireAuth, (req, res) => {
  try {
    const dir = getInboxDir();
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs.readdirSync(dir).map(name => {
      const stat = fs.statSync(path.join(dir, name));
      const sep = name.indexOf('__');
      const inboxId = sep > 0 ? name.slice(0, sep) : name;
      const filename = sep > 0 ? name.slice(sep + 2) : name;
      return { inbox_id: inboxId, filename, size: stat.size, created: stat.mtime.toISOString() };
    });
    res.json({ files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/inbox/file/:inboxId', requireAuth, (req, res) => {
  try {
    const dir = getInboxDir();
    const match = fs.readdirSync(dir).find(name => name.startsWith(req.params.inboxId + '__'));
    if (!match) return res.status(404).json({ error: 'not found' });
    const filename = match.slice(match.indexOf('__') + 2);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(path.join(dir, match));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/inbox/file/:inboxId', requireAuth, (req, res) => {
  try {
    const dir = getInboxDir();
    const match = fs.readdirSync(dir).find(name => name.startsWith(req.params.inboxId + '__'));
    if (!match) return res.json({ ok: true, already: true });
    fs.unlinkSync(path.join(dir, match));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Google Drive upload via Nora's OAuth (server-side, supports binary) ----
// The Drive MCP path the cowork loop uses works fine for textContent (markdown, txt)
// but doesn't have a clean way to upload arbitrary binary bytes (PNG, PDF, etc.). So
// for binary files we punt: the cowork loop calls this endpoint with the inbox_id +
// destination folder + filename, and the server does a Drive multipart upload using
// Nora's OAuth refresh token (collected during /calendar/connect, now also scoped
// for drive.file). One round trip, real bytes, no MCP intermediary.

let driveArtifactUploadQueue = Promise.resolve();

function loadDriveArtifactUploads() {
  if (_dbReady) return driveArtifactUpload.normalizeLedger(_cache.driveArtifactUploads);
  if (_cache.driveArtifactUploads) return driveArtifactUpload.normalizeLedger(_cache.driveArtifactUploads);
  try {
    _cache.driveArtifactUploads = driveArtifactUpload.normalizeLedger(
      JSON.parse(fs.readFileSync(DRIVE_ARTIFACT_UPLOADS_PATH, 'utf8')));
  } catch (_) {
    _cache.driveArtifactUploads = driveArtifactUpload.emptyLedger();
  }
  return _cache.driveArtifactUploads;
}

async function saveDriveArtifactUploads(value) {
  const ledger = driveArtifactUpload.pruneLedger(value);
  if (_dbReady) await db.setState('drive_artifact_uploads', ledger);
  else {
    fs.mkdirSync(path.dirname(DRIVE_ARTIFACT_UPLOADS_PATH), { recursive: true });
    fs.writeFileSync(DRIVE_ARTIFACT_UPLOADS_PATH, JSON.stringify(ledger, null, 2));
  }
  _cache.driveArtifactUploads = ledger;
  return ledger;
}

function serializeDriveArtifactUpload(work) {
  const operation = driveArtifactUploadQueue.then(work, work);
  driveArtifactUploadQueue = operation.catch(() => {});
  return operation;
}

// Refresh-token-to-access-token with a tiny in-memory cache to avoid re-minting on
// every call (access tokens last ~1 hour; we conservatively cache for 50 min).
let googleAccessTokenCache = null;
async function getGoogleAccessToken() {
  if (googleAccessTokenCache && Date.now() < googleAccessTokenCache.expiresAt) {
    return googleAccessTokenCache.token;
  }
  const state = loadCalendarState();
  const refreshToken = state?.oauth_refresh_token;
  if (!refreshToken) {
    throw new Error('No Google OAuth refresh token on file. Reconnect Google Calendar from Settings.');
  }
  const r = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: CONNECTOR_AUTH_TIMEOUT_MS,
  });
  if (!r.data?.access_token) {
    throw new Error('Google token refresh failed: ' + JSON.stringify(r.data));
  }
  googleAccessTokenCache = {
    token: r.data.access_token,
    expiresAt: Date.now() + 50 * 60 * 1000
  };
  return r.data.access_token;
}

function nativeCalendarEnabled() {
  const state = loadCalendarState();
  return Boolean(state?.oauth_refresh_token
    && Array.isArray(state.oauth_scopes)
    && state.oauth_scopes.includes('https://www.googleapis.com/auth/calendar.events'));
}

async function driveMultipartUpload({ bytes, name, parentId, mimetype, requestCommitment = null }) {
  const accessToken = await getGoogleAccessToken();
  const boundary = '------NORABOUNDARY' + crypto.randomBytes(8).toString('hex');
  const metadata = JSON.stringify({
    name,
    parents: parentId ? [parentId] : undefined,
    appProperties: requestCommitment ? { noraRequestCommitment: requestCommitment } : undefined,
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimetype || 'application/octet-stream'}\r\n\r\n`, 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--`, 'utf8')
  ]);
  // supportsAllDrives=true is required when uploading into a shared drive folder.
  const r = await axios.post(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,mimeType,parents',
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length
      },
      maxBodyLength: 30 * 1024 * 1024,
      maxContentLength: 30 * 1024 * 1024,
      timeout: GOOGLE_UPLOAD_TIMEOUT_MS,
    }
  );
  return r.data;
}

async function driveFindArtifactByCommitment({ requestCommitment, parentId }) {
  const accessToken = await getGoogleAccessToken();
  const q = `'${parentId}' in parents and trashed = false and appProperties has { key='noraRequestCommitment' and value='${requestCommitment}' }`;
  const r = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      q,
      spaces: 'drive',
      pageSize: 2,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id,name,webViewLink,mimeType,parents)',
    },
    timeout: GOOGLE_CONTROL_TIMEOUT_MS,
  });
  return Array.isArray(r.data?.files) ? r.data.files[0] || null : null;
}

// POST /admin/inbox/file/:inboxId/upload-to-drive
// Body: { parent_folder_id, filename?, mimetype? }
// Uploads the inbox file to Drive and returns { id, webViewLink, name, mimeType }.
// Filename defaults to the original inbox filename; mimetype is auto-detected by Drive
// based on the file extension if omitted.
app.post('/admin/inbox/file/:inboxId/upload-to-drive', requireAuth, async (req, res) => {
  try {
    const { parent_folder_id, filename, mimetype } = req.body || {};
    if (!parent_folder_id) return res.status(400).json({ error: 'parent_folder_id is required' });

    const dir = getInboxDir();
    const match = fs.readdirSync(dir).find(name => name.startsWith(req.params.inboxId + '__'));
    if (!match) return res.status(404).json({ error: 'inbox file not found' });
    const originalName = match.slice(match.indexOf('__') + 2);
    const finalName = (typeof filename === 'string' && filename.trim()) ? filename.trim() : originalName;

    // Light mime guess from extension if caller didn't pass one — Drive can usually
    // figure it out too, but being explicit helps for things like PNGs that we want
    // to land with the right content-type for viewing.
    const ext = (finalName.split('.').pop() || '').toLowerCase();
    const guessedMime = mimetype || ({
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
      json: 'application/json', html: 'text/html',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip'
    })[ext] || 'application/octet-stream';

    const bytes = fs.readFileSync(path.join(dir, match));
    console.log(`📁 Drive upload: ${finalName} (${bytes.length} bytes, ${guessedMime}) → folder ${parent_folder_id}`);
    const driveFile = await driveMultipartUpload({ bytes, name: finalName, parentId: parent_folder_id, mimetype: guessedMime });
    console.log(`📁 Drive upload OK: ${driveFile.id} ${driveFile.webViewLink}`);
    res.json({ ok: true, file: driveFile });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('📁 Drive upload failed:', detail);
    res.status(err.response?.status || 500).json({ error: detail });
  }
});

const _slackWebhookEvents = new Map();
let _slackWebhookEventSequence = 0;
const _slackWebhookHealth = {
  accepted: 0, completed: 0, failures: 0, shutdown_drain_timeouts: 0,
  last_failure: null, recent_failures: [],
};
function trackSlackWebhookEvent(label, work) {
  const id = `slack-event-${++_slackWebhookEventSequence}`;
  const entry = {
    id, label: String(label || 'Slack event').slice(0, 120),
    started_at: Date.now(), promise: null,
  };
  _slackWebhookHealth.accepted += 1;
  const execution = Promise.resolve().then(work);
  const owned = execution.catch(error => {
    const failure = {
      at: new Date().toISOString(),
      label: entry.label,
      error: String(error?.message || error).slice(0, 500),
    };
    _slackWebhookHealth.failures += 1;
    _slackWebhookHealth.last_failure = failure;
    _slackWebhookHealth.recent_failures.push(failure);
    while (_slackWebhookHealth.recent_failures.length > 20) {
      _slackWebhookHealth.recent_failures.shift();
    }
    console.error('Slack handler error:', failure.error);
  }).finally(() => {
    _slackWebhookHealth.completed += 1;
    _slackWebhookEvents.delete(id);
  });
  entry.promise = owned;
  _slackWebhookEvents.set(id, entry);
  return owned;
}
function slackWebhookSnapshot(now = Date.now()) {
  const active = [..._slackWebhookEvents.values()].map(entry => ({
    id: entry.id,
    label: entry.label,
    age_ms: Math.max(0, Number(now) - entry.started_at),
  }));
  return {
    ..._slackWebhookHealth,
    active_count: active.length,
    oldest_active_ms: Math.max(0, ...active.map(entry => entry.age_ms)),
    active,
  };
}
async function drainSlackWebhookEvents({ timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 20000);
  while (true) {
    const pending = [..._slackWebhookEvents.values()].map(entry => entry.promise);
    if (!pending.length) {
      await Promise.resolve();
      if (_slackWebhookEvents.size === 0) return true;
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      _slackWebhookHealth.shutdown_drain_timeouts += 1;
      return false;
    }
    let timer = null;
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      _slackWebhookHealth.shutdown_drain_timeouts += 1;
      return false;
    }
  }
}

app.post('/webhook/slack', async (req, res) => {
  const slackVerification = verifySlackRequest(req);
  if (!slackVerification.valid) return res.sendStatus(401);

  // URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.sendStatus(200);
  const body = req.body;
  const event = body.event;
  const label = event
    ? `${event.type || event.subtype || 'event'}:${event.channel || 'unknown'}`
    : 'empty-event';
  trackSlackWebhookEvent(label,
    () => processSlackWebhookEvent(body, slackVerification.attestation));
});

async function processSlackWebhookEvent(body, sourceAttestation = null) {
  // Cache Nora's bot user ID from authorizations on first event — needed to detect
  // @mentions in raw `message.channels` events (which arrive as type=message, not app_mention)
  if (!noraBotUserId && body.authorizations && body.authorizations[0]) {
    noraBotUserId = body.authorizations[0].user_id;
    console.log('🤖 Resolved Nora bot user ID:', noraBotUserId);
  }

  const event = body.event;
  if (!event) return;

  // Auto-join catch: when someone runs the Zoom (or Meet/Teams) slash command in their DM with
  // Nora, the app posts the meeting link into that DM as a BOT message — which the loop-guard just
  // below would drop. So intercept FIRST: a bot-posted meeting link in a 1:1 DM is an unambiguous
  // "start meeting" signal, so she joins and says so. Scoped tight on purpose: only her own DMs
  // (im), only BOT-posted links (a human typing a link still needs an explicit ask via the
  // nora_join_meeting tool — a pasted link isn't always a join request), never her own posts,
  // deduped so a redelivered event can't double-join.
  if ((event.bot_id || event.subtype === 'bot_message') && event.channel_type === 'im'
      && event.user !== noraBotUserId) {
    const link = extractMeetingUrl(slackMessageAllText(event));
    if (link) {
      console.log(`🎯 Meeting link posted by a bot in a DM (app_id=${event.app_id || '?'}, bot_id=${event.bot_id || '?'}): ${link}`);
      // The Slack request has already been acknowledged, but the event owner must remain alive
      // through Recall bot creation and credential persistence so shutdown can drain it safely.
      await handleSlackAutoJoin(event, link);
    } else if (/zoom|meet|teams|meeting|join/i.test(slackMessageAllText(event))) {
      // Looks meeting-ish but no link parsed — log the shape once so we can tune the extractor.
      console.log('🎯 Bot DM looked meeting-related but no link parsed. Shape:', JSON.stringify({ text: (event.text || '').slice(0, 200), attachments: (event.attachments || []).length, blocks: (event.blocks || []).length }));
    }
    return; // bot messages never fall through to the normal reply path
  }

  // Ignore bot messages (prevent loops, including Nora's own posts)
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Only handle app_mention and message event types
  if (event.type !== 'app_mention' && event.type !== 'message') return;

  // File-share messages arrive with subtype: 'file_share' and a files[] array. We
  // want to handle those, so don't lump them in with the irrelevant subtypes below.
  const hasFiles = Array.isArray(event.files) && event.files.length > 0;
  if (event.subtype && event.subtype !== 'thread_broadcast' && event.subtype !== 'file_share') return;

  const text = event.text || '';
  const channel = event.channel;
  const user = event.user;
  // Where she posts her reply. In a 1:1 DM, reply INLINE in the conversation rather than spawning
  // a thread on every message — threads in a DM are just clutter (John asked for plain replies
  // there). In channels she still threads: the join/staleness/continuation machinery is built on
  // threads and threading is good channel etiquette. Either way honor an explicit thread_ts — if
  // the person replied inside an existing thread, stay in it. (Conversation MEMORY keys off the
  // raw event.thread_ts, not this value, so making DMs inline doesn't touch her continuity.)
  const isDMEvent = event.channel_type === 'im' || event.channel_type === 'mpim';
  const threadTs = event.thread_ts || (isDMEvent ? undefined : event.ts);
  // Strip @mention tags from the text
  const query = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  // Empty text is fine when files are attached — that's a "do something with this file"
  // intent and we route to the file inbox path below. Otherwise still bail.
  if (!query && !hasFiles) return;
  const joinedAuditThread = !!event.thread_ts && isThreadJoined(channel, event.thread_ts);
  const auditInteractionId = shouldAuditSlackInbound(event, { joinedThread: joinedAuditThread })
    ? slackAuditInteractionId(channel, event.ts) : null;
  if (auditInteractionId) {
    await slackConversationAudit.recordInbound({
      interactionId: auditInteractionId,
      slackEventId: body.event_id,
      channelId: channel,
      channelType: event.channel_type,
      threadTs: event.thread_ts || null,
      inboundTs: event.ts,
      userId: user,
      inboundText: query,
      metadata: {
        event_type: event.type,
        event_subtype: event.subtype || null,
        file_count: hasFiles ? event.files.length : 0,
      },
    });
  }
  if (isDMEvent) {
    const handledApproval = await teammateApprovals.handleSlackDecision({
      text: query, rawText: text, user, channel, eventTs: event.ts, attestation: sourceAttestation,
    });
    if (handledApproval) {
      await slackConversationAudit.mark(auditInteractionId, {
        handling_status: 'handled_by_approval_flow', response_kind: 'approval_flow',
      });
      return;
    }
  }
  // File-share path: ONLY in DMs. Without this gate, every file drop in a
  // A channel file drop should not trigger Nora to download and ask what to do with it.
  // File handling is
  // strictly opt-in via DM — if someone wants Nora to do something with a file in a
  // channel, they should DM it to her.
  if (hasFiles) {
    const isDM = event.channel_type === 'im' || event.channel_type === 'mpim';
    if (!isDM) {
      console.log(`📎 Ignoring channel file drop (channel_type=${event.channel_type}, channel=${channel}) — file handling is DM-only`);
      await slackConversationAudit.mark(auditInteractionId, {
        handling_status: 'intentionally_skipped',
        metadata: { reason: 'channel_file_handling_is_dm_only' },
      });
      return;
    }
    await handleSlackFiles(event, channel, user, threadTs, query, sourceAttestation,
      auditInteractionId);
    return;
  }

  // Track every inbound to a joined thread regardless of whether we end up responding.
  // This drives the staleness counter so the thread eventually cools off if Nora isn't being addressed.
  const inJoinedThread = !!event.thread_ts && isThreadJoined(channel, event.thread_ts);
  if (inJoinedThread && event.type === 'message') {
    recordThreadInbound(channel, event.thread_ts);
  }

  // Decide whether to respond at the routing level (DM, mention, or active thread).
  if (!shouldRespond(event)) {
    await slackConversationAudit.mark(auditInteractionId, {
      handling_status: 'intentionally_skipped', metadata: { reason: 'routing_gate' },
    });
    return;
  }

  // For active-thread continuation without a fresh mention, apply a conservative gate.
  const isDM = event.channel_type === 'im' || event.channel_type === 'mpim';
  const isMention = event.type === 'app_mention';

  if (!isDM && !isMention) {
    if (isObviouslyNotForNora(text, noraBotUserId)) {
      console.log(`💬 Slack skip (heuristic): ${query.slice(0, 60)}`);
      await slackConversationAudit.mark(auditInteractionId, {
        handling_status: 'intentionally_skipped', metadata: { reason: 'addressed_to_someone_else' },
      });
      return;
    }
    const sessionKey = slackSessionKey(channel, event.thread_ts, event.channel_type);
    const history = slackSessions[sessionKey] || [];
    const engage = await shouldEngageInThread(history, query);
    if (!engage) {
      console.log(`💬 Slack skip (thread gate): ${query.slice(0, 60)}`);
      await slackConversationAudit.mark(auditInteractionId, {
        handling_status: 'intentionally_skipped', metadata: { reason: 'thread_engagement_gate' },
      });
      return;
    }
  }

  console.log(`💬 Slack [${event.type}/${event.channel_type || '?'}${event.thread_ts ? '/thread' : ''}] from ${user}: ${query.slice(0, 100)}`);

  // Pass the RAW thread_ts (undefined for a top-level message) alongside the coalesced threadTs.
  // The raw one keys the in-memory session; the coalesced one is where we post/fetch the thread.
  await handleSlack(channel, user, query, threadTs, event.channel_type, event.thread_ts, event.ts,
    sourceAttestation);
}

// Thin wrapper: resolve the conversation key and SERIALIZE per key so two near-simultaneous messages
// in the same conversation can't race on the shared in-memory history (read -> await Claude -> push).
// The key is computed here (per channel/thread/user) and passed in so the lock and the body agree on
// exactly one array. Unrelated conversations still run concurrently.
async function handleSlack(channel, user, text, threadTs, channelType, rootThreadTs = undefined,
  triggerTs = undefined, sourceAttestation = null, options = {}) {
  // KEY BY THE RAW thread_ts (undefined for a top-level message) + user. A top-level channel message
  // has no thread_ts, so all of ONE person's sequential top-level messages share the
  // `channel:<id>:<user>` key and her replies ACCUMULATE there — instead of each message spinning up
  // its own `thread:<id>:<ts>` island with empty history (which is what made her lose the thread of a
  // back-and-forth and ask people to re-paste what they'd just said). Per-user scoping also keeps one
  // person's financial replies out of another person's context (see slackSessionKey).
  const sessionKey = slackSessionKey(channel, rootThreadTs, channelType, user);
  const interactionStartedAt = Date.now();
  const inboundVersion = `${triggerTs || interactionStartedAt}:${interactionStartedAt}`;
  latestSlackInboundBySession.set(sessionKey, inboundVersion);
  const interactivePriorityLease = interactivePerformance.beginInteractive('slack');
  const activity = runtimeActivity.begin({ lane: 'conversation', kind: 'slack_response',
    label: 'Replying in Slack',
    detail: 'Preparing a bounded response on the foreground latency-safe path.',
    source: 'slack-handler', meta: { surface: 'slack', interaction_kind: 'explicit_request' } });
  let failed = false;
  try {
    return await withSlackSessionLock(sessionKey, async () => {
      if (options.recoveryGuard === true && threadTs && isThreadJoined(channel, threadTs)) {
        return { status: 'already_handled', channel, thread_ts: threadTs };
      }
      await handleSlackImpl(channel, user, text, threadTs, channelType, rootThreadTs,
        sessionKey, triggerTs, sourceAttestation, interactionStartedAt, options.terminalAt,
        inboundVersion);
      return {
        status: threadTs && isThreadJoined(channel, threadTs) ? 'replied' : 'processed',
        channel, thread_ts: threadTs || null,
      };
    });
  } catch (error) {
    failed = true;
    runtimeActivity.finish(activity.id, { status: 'failed',
      detail: 'The Slack turn ended before the response path reached a clean terminal state.',
      outcome: 'Failure contained to this interaction.' });
    throw error;
  } finally {
    if (latestSlackInboundBySession.get(sessionKey) === inboundVersion) {
      latestSlackInboundBySession.delete(sessionKey);
    }
    if (!failed) runtimeActivity.finish(activity.id, { status: 'completed',
      detail: 'The Slack turn left the foreground response path.',
      outcome: 'Interactive priority released.' });
    interactivePriorityLease.release();
  }
}

async function handleSlackImpl(channel, user, text, threadTs, channelType, rootThreadTs, sessionKey, triggerTs,
  sourceAttestation = null, interactionStartedAt = Date.now(), terminalAtOverride = null,
  inboundVersion = null) {
  const handlerStartedAt = Date.now();
  const latencyStages = { queue_ms: handlerStartedAt - interactionStartedAt };
  let providerStartedAt = null;
  let providerFinishedAt = null;
  let firstDeliveryRecorded = false;
  let requesterName = null;
  const conversationPolicy = slackConversationPolicy(text);
  const boundedTerminalAt = def => boundedSlackTerminalAt(terminalAtOverride, def); // src/surfaces/slack/budget.js
  let slackTerminalAt = boundedTerminalAt(
    interactionStartedAt + (conversationPolicy.attachLiveTools
      ? SLACK_TOOL_TURN_TERMINAL_MS : SLACK_CONVERSATIONAL_TERMINAL_MS));
  const turnRef = triggerTs ? `slack:${channel}:${triggerTs}`
    : `slack:${channel}:turn-${interactionStartedAt}`;
  await slackConversationAudit.mark(turnRef, { handling_status: 'processing' });
  try {
    const key = sessionKey;
    // Session keys intentionally span a conversation, but research receipts and action attestations
    // must bind to one inbound Slack event. Reusing the session key here caused later DM turns to
    // collide with already-closed assignments and earlier claim receipts.
    if (!slackSessions[key]) slackSessions[key] = [];
    const history = slackSessions[key];
    // Stale-session reset: if this conversation has sat idle past the staleness window, drop the
    // accumulated turns before this message so a brand-new (likely different-topic) question isn't
    // answered with hours-old context prepended. Clearing here makes firstContact true below, which
    // triggers a clean channel bootstrap. (Must run BEFORE we push the current message.)
    if (history.length && (Date.now() - (slackSessionTouched[key] || 0)) > SLACK_SESSION_STALE_MS) {
      history.length = 0;
    }
    slackSessionTouched[key] = Date.now();
    // Resolve the Slack user ID to a real name so the model knows who it's replying to
    // by NAME, not by opaque <@U123ABC> mention. Falls back to the user ID if lookup
    // fails — better something than nothing.
    const identityStartedAt = Date.now();
    const requesterIdentity = await settleWithinAbortable(
      signal => getSlackUserIdentity(user, { signal }), 1200, null, 'Slack requester lookup');
    requesterName = requesterIdentity?.name || null;
    latencyStages.identity_ms = Date.now() - identityStartedAt;
    const userLabel = requesterName ? `${requesterName} (Slack: <@${user}>)` : `Slack user <@${user}>`;
    history.push({ role: 'user', content: `[${userLabel}]: ${text}` });
    // THREAD CONTEXT: for channel threads, pull the WHOLE thread from Slack so Nora sees
    // everything said before she was mentioned (her in-memory history only has what she
    // already processed — that's why she kept asking people to repeat themselves). DMs stay
    // on in-memory history (a DM is a flat conversation, not a thread). If the fetch fails
    // (e.g. missing channels:history scope), fall back to in-memory.
    const isDM = channelType === 'im' || channelType === 'mpim';
    const isRealThread = !!rootThreadTs && !isDM; // genuinely posted inside a Slack thread
    // history was just push()ed with the current message, so length 1 == this is the FIRST turn of
    // this conversation session (or the first since a restart) — nothing accumulated yet to lean on.
    const firstContact = history.length <= 1;
    let threadMsgs = null;
    const threadContextStartedAt = Date.now();
    if (isRealThread) {
      // Inside a real thread: pull the whole thread (authoritative — it includes messages posted
      // before she was mentioned AND her own threaded replies, which conversations.replies returns).
      threadMsgs = await settleWithinAbortable(
        signal => fetchSlackThread(channel, threadTs, { signal }),
        1800, null, 'Slack thread context');
    } else if (isDM && firstContact) {
      // A DM has no threads, so continuity came entirely from the in-memory session. Every deploy
      // and restart wipes that, and she then answered the morning's first DM with no idea what was
      // already said. Bootstrap the recent DM the same way a channel gets bootstrapped.
      threadMsgs = await settleWithinAbortable(
        signal => fetchSlackChannelHistory(channel, threadTs, 12, { signal }),
        1800, null, 'Slack direct message context');
    } else if (!isDM && firstContact) {
      // Top-level channel message, first turn of this session: bootstrap with recent channel context
      // so she isn't blind to what was just said before she was looped in. On CONTINUATION we do NOT
      // re-fetch — the accumulated in-memory history below already holds the full back-and-forth
      // INCLUDING her own replies. (conversations.history can't see her replies — they're threaded
      // under each message — so re-fetching every turn would silently drop her side of the convo and
      // she'd think she never answered. Trusting in-memory on continuation is what actually restores
      // continuity.) A 25-message window so the anchoring question survives some channel cross-talk.
      threadMsgs = await settleWithinAbortable(
        signal => fetchSlackChannelHistory(channel, threadTs, 25, { signal }),
        1800, null, 'Slack channel context');
    }
    // Default to the accumulated in-memory history (carries her own replies across turns); only a
    // successful Slack fetch (real thread or first-contact bootstrap) overrides it.
    let claudeMessages = history;
    if (threadMsgs && threadMsgs.length) {
      const built = await settleWithinAbortable(
        signal => buildSlackThreadHistory(threadMsgs, noraBotUserId, { signal }),
        1200, [], 'Slack thread identity enrichment');
      if (built.length) claudeMessages = built;
    }
    latencyStages.thread_context_ms = Date.now() - threadContextStartedAt;

    // SAFETY (eventual consistency): whichever source we used, guarantee the message she's actually
    // replying to is the FINAL user turn. Slack's history/replies APIs lag a few hundred ms, so a
    // just-posted trigger can be missing from a fresh fetch — without this, `built` could omit the
    // very question being asked and she'd say "refresh me on what?" with the answer absent from view.
    // The in-memory `history` always has it (we pushed it above), so we re-append when it's missing.
    {
      const normForMatch = s => (typeof s === 'string' ? s : '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const tnorm = normForMatch(text);
      const probe = tnorm.length >= 6 ? tnorm.slice(-32) : tnorm; // tail dodges leading @mention markup
      const last = claudeMessages[claudeMessages.length - 1];
      const present = !!last && last.role === 'user' && probe.length > 0 && normForMatch(last.content).includes(probe);
      if (!present) {
        claudeMessages = claudeMessages.concat([{ role: 'user', content: `[${userLabel}]: ${text}` }]);
      }
    }

    // On a FIRST-CONTACT bootstrap (we used a Slack fetch, not the in-memory array), persist the
    // channel context she answered against INTO the in-memory history (bounded), so the pre-mention
    // discussion that grounded her first reply survives into later turns instead of being discarded
    // after one answer. Seed from claudeMessages (post-guard, so it ends with the trigger) and not for
    // real threads, which are re-fetched each turn. The assistant reply pushed below
    // then lands right after the trigger.
    if (firstContact && !isRealThread && claudeMessages !== history) {
      const seed = claudeMessages.slice(-15);
      history.length = 0;
      for (const t of seed) history.push(t);
    }

    // URL READING: gather links from the current message + the thread, fetch their real
    // content server-side, and feed it to her. This is what lets her actually read a page
    // someone shares instead of guessing from the link text.
    const urlSet = new Set(extractUrls(text));
    if (threadMsgs) for (const m of threadMsgs) extractUrls(m.text || '').forEach(u => urlSet.add(u));
    const urls = [...urlSet].slice(0, 3);
    let urlBlock = '';
    const linkedContentStartedAt = Date.now();
    if (urls.length) {
      const fetched = (await settleWithinAbortable(signal => Promise.all(urls.map(async u => {
        const c = await fetchUrlText(u, { signal });
        return c ? `URL: ${u}\n${c}` : null;
      })), 2200, [], 'Slack linked-page enrichment')).filter(Boolean);
      if (fetched.length) {
        const linkedText = fetched.join('\n\n---\n\n').slice(0, 800);
        urlBlock = `\n\n[Linked web pages, fetched live]\n${linkedText}\n\nUse this content directly. Retrieve with a live tool if the needed portion was outside this bounded excerpt.`;
      }
    }
    latencyStages.linked_content_ms = Date.now() - linkedContentStartedAt;

    const meetingContext = requesterName ? { source: 'slack', requester: { name: requesterName } } : null;
    // Split the prompt for caching: the operator prompt stays stable while request context remains
    // gets cached; the volatile half + per-recipient financial notices below all go
    // in `tail`, uncached, so the cache stays identical across users.
    // Pass the recent conversation only to select explicitly named local project context.
    const convText = claudeMessages.slice(-12).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const isDirect = true;
    const financialApproved = isFinancialApproved(user);
    const attachLiveTools = conversationPolicy.attachLiveTools;
    // Absolute end-to-end deadline. Context enrichment above already spent part of this budget;
    // preflights, tool calls, fallback retries, and delivery must share what remains.
    slackTerminalAt = boundedTerminalAt(
      interactionStartedAt + (attachLiveTools ? SLACK_TOOL_TURN_TERMINAL_MS : SLACK_CONVERSATIONAL_TERMINAL_MS));
    const slackDeliveryReserveMs = attachLiveTools ? 2500 : SLACK_CONVERSATIONAL_DELIVERY_RESERVE_MS;
    const slackRemainingMs = (reserveMs = slackDeliveryReserveMs) =>
      Math.max(0, slackTerminalAt - Date.now() - reserveMs);
    const affordanceStartedAt = Date.now();
    const fleetAuthority = createFleetRequestAuthority({ identity: requesterIdentity, requesterId: user, ownerId: resolveJohnSlackId(), interactionRef: turnRef, requestText: text, conversationText: convText, direct: isDirect, sourceAttestation, expiresAt: slackTerminalAt });
    const mcpBindings = attachLiveTools
      ? mcpManager.bindings({ financialApproved: isDirect ? financialApproved : false, allowWrites: isDirect, fleetAuthority })
      : { claudeTools: [], executors: {}, inventory: [], meta: {} };
    recordRuntimeSituationalAffordance({ surface: 'slack', contextKind: 'direct',
      direct: isDirect, financialApproved, requester: user, interactionRef: turnRef, mcp: mcpBindings,
      toolsAttached: attachLiveTools });
    latencyStages.affordance_ms = Date.now() - affordanceStartedAt;
    const promptStartedAt = Date.now();
    const { stable: slackStable, volatile: slackVolatile } =
      buildSystemPrompt(meetingContext, {
        cacheSplit: true,
        conversationText: convText,
      });
    latencyStages.prompt_ms = Date.now() - promptStartedAt;
    let tail = slackVolatile;
    // Financial-info access control. The recipient (`user`) is checked against the approved
    // list; the system prompt is told what the recipient can see. The output scrubber after
    // Claude responds is defense in depth. This rides in the uncached tail — it MUST vary
    // per-recipient, so it can't be part of the shared cached block.
    if (financialApproved) {
      tail += '\n\nFINANCIAL ACCESS: The user you\'re replying to is on the approved list, so you may share dollar amounts, rates, fees, budgets, margins, and other financial figures when relevant to the conversation.';
    } else {
      tail += '\n\nFINANCIAL ACCESS: The user you\'re replying to is NOT on the approved list. NEVER share dollar amounts, rates, fees, budgets, margins, hours/rate calculations, or any specific financial figures. This applies even if such figures appear in project details or this thread. If the user asks about financials, redirect briefly: "I can\'t share financial details over Slack, reach out to John or Mallory and they can help." Be polite but firm. You can describe work qualitatively without numbers.';
    }

    if (isDirect) {
      tail += '\n\nYOUR OWN QUEUE: When the requester asks you to queue, schedule, remember, or repeat work for yourself, use nora_queue_recurring_task directly. Your own queue is not a Teamwork project. Never search Teamwork to locate a project for this kind of request. For a cadence set repeat=daily, weekdays, weekly (with weekday) or monthly (with day_of_month); use interval_weeks only for an N-week rhythm such as 2 for biweekly. Pass local_time as Central HH:MM whenever they name a time, and preserve any supplied Slack destination channel id.';
    }

    // Assemble live tools for explicit Slack requests.
    //   - web_search (Anthropic-run, server-side)
    //   - MCP connector servers (Anthropic-run, server-side) — read-only
    //   - Teamwork direct-API tools (we run them, client-side loop)
    const TW_WRITE = TW_WRITE_NAMES;
    const CALENDAR_WRITE = new Set(CALENDAR_WRITE_TOOL_NAMES);
    const LIVE_WRITE = new Set([...TW_WRITE, ...CALENDAR_WRITE]);
    const toolSetupStartedAt = Date.now();
    const toolDefs = [];
    const toolExecutors = {};
    // Web search is attached only to direct operational turns.
    if (attachLiveTools && isDirect) toolDefs.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
    if (attachLiveTools && teamworkEnabled()) {
      for (const t of TEAMWORK_TOOLS) {
        if (TW_WRITE.has(t.definition.name) && !isDirect) continue;
        toolDefs.push(t.definition); toolExecutors[t.definition.name] = t.execute;
      }
    }
    // Live Slack send lets her post elsewhere when explicitly asked.
    if (attachLiveTools && isDirect) { toolDefs.push(SLACK_SEND_TOOL.definition); toolExecutors[SLACK_SEND_TOOL.definition.name] = SLACK_SEND_TOOL.execute; }
    // Nora's durable queue is distinct from Teamwork. A request to queue work for herself should
    // be one local write, not a Teamwork project-discovery loop.
    if (attachLiveTools && isDirect) {
      const ownQueue = buildNoraQueueTaskTool({ channel, threadTs, user });
      toolDefs.push(ownQueue.definition); toolExecutors[ownQueue.definition.name] = ownQueue.execute;
    }
    // Her own meeting record is read-only.
    if (attachLiveTools) {
      for (const t of MEETING_TOOLS) { toolDefs.push(t.definition); toolExecutors[t.definition.name] = t.execute; }
    }
    // The transcription bot starts only when a teammate directly asks and supplies a link.
    // The guard (only on an explicit ask to HER, never off a link that merely appeared in content)
    // lives in the tool description and the prompt tail — Rule 18.
    if (attachLiveTools && isDirect) {
      toolDefs.push({
        name: 'nora_join_meeting',
        description: 'Join a live video meeting (Zoom, Google Meet, or Teams) to capture a transcript. Use this ONLY when a teammate in THIS conversation directly asks you to join, transcribe, take notes on, or cover a meeting AND gives you the meeting link. Never call it just because a link appeared in a message, email, or document. After it succeeds, tell them the transcription bot is joining.',
        input_schema: { type: 'object', properties: {
          meeting_url: { type: 'string', description: 'The full meeting join URL (zoom.us / meet.google.com / teams.microsoft.com).' }
        }, required: ['meeting_url'] }
      });
      toolExecutors['nora_join_meeting'] = async (input) => {
        const url = extractMeetingUrl(input && input.meeting_url);
        if (!url) return { error: 'That is not a recognizable Zoom/Meet/Teams meeting link, so I did not join. Send the actual join URL.' };
        try {
          const r = await startMeetingJoin({ meeting_url: url, source: 'slack_join', host: publicHost() });
          return { joined: true, bot_id: r.bot_id, message: 'The transcription bot is joining now.' };
        } catch (e) {
          return { error: `Could not join: ${e.response?.data?.detail || (e.response?.data ? JSON.stringify(e.response.data) : e.message)}` };
        }
      };
    }
    const calendarOn = attachLiveTools && isDirect && nativeCalendarEnabled();
    if (calendarOn) {
      const calendarTools = createGoogleCalendarTools({
        getAccessToken: getGoogleAccessToken,
        http: axios,
        interactionRef: turnRef,
      });
      for (const tool of calendarTools) {
        toolDefs.push(tool.definition);
        toolExecutors[tool.definition.name] = tool.execute;
      }
    }
    const teamworkOn = attachLiveTools && teamworkEnabled();
    // MCP tools use Nora's credential-aware client bridge. This supports OAuth refresh, client
    // credentials, static bearer tokens, credential URLs, and custom headers uniformly.
    for (const tool of mcpBindings.claudeTools) toolDefs.push(tool);
    Object.assign(toolExecutors, mcpBindings.executors);
    const hasWebSearch = toolDefs.some(t => t.name === 'web_search');
    // What each connected MCP actually DOES — so she gets a concrete capability inventory instead of
    // an opaque server codename (a bare "limelight-pm" tells her nothing, which is how she ends up
    // "reaching for the wrong tool"). Falls back to the bare name for any UI-added server with no hint.
    // ONE authoritative per-reply tools note — this IS her real inventory this turn (the cached prompt
    // points her here as the source of truth). Always emit exactly one of the three branches so every
    // reply states plainly what she can and can't do live, and she stops confabulating/flip-flopping.
    if (toolDefs.length > 1) {
      let note = '\n\nLIVE TOOLS attached to THIS reply. This is your real inventory right now; use them to pull current data' + (isDirect ? ' (and, for Teamwork, make changes)' : '') + ' rather than guessing or deferring:';
      if (teamworkOn && isDirect) {
        note += ' • TEAMWORK: READ (find projects; list tasks filtered by assignee and due date, which is how you answer "what\'s due tomorrow for me/<person>": resolve the person with teamwork_list_people, then teamwork_list_tasks with their id + the date; check how booked someone is over a date range for scheduling, e.g. "how booked is Santi next week", via teamwork_user_workload, or who across the team has room and who is overbooked via teamwork_team_capacity (pass min_free_hours for "who can take a 10h build"); plus milestones, tasklists, people, comments) AND CHANGE (create projects, milestones, task lists, and tasks; update tasks; mark complete/reopen; add comments). For an approved plan containing multiple task lists or tasks, use teamwork_apply_project_plan ONCE instead of creating every item through separate tool calls. Resolve the relevant project and people before writing. Only create/change when clearly asked. If ambiguous, confirm first. After any change, say exactly what you did. You CANNOT delete Teamwork records. For dates, use the [Right now] block to know what "today"/"tomorrow" are.';
      } else if (teamworkOn) {
        note += ' • TEAMWORK (read-only here): find projects, list/get tasks, milestones, tasklists, people, comments. Use it to VERIFY a fact before saying it.';
      }
      if (hasWebSearch) note += ' • WEB_SEARCH: for current/external info you don\'t already have.';
      if (calendarOn) note += ' • GOOGLE_CALENDAR: list current events, check attendee free/busy windows, and create or update meetings immediately. Read availability before booking. Create or change an event only when clearly asked, invite the supplied attendees, and report the verified event details. You CANNOT cancel or delete events.';
      if (isDirect) note += ' • SLACK_SEND_MESSAGE: when someone asks you to send/post a note to another channel or DM a teammate (e.g. "send a heads-up to the PM team"), send it RIGHT NOW with slack_send_message and report what you sent, instead of saying you\'ll queue it for later. Only when clearly asked; confirm the target/wording first if it\'s ambiguous.';
      if (isDirect) note += ' • JOIN_MEETING: if a teammate hands you a Zoom/Meet/Teams link and asks you to transcribe, take notes on, join, or cover a call, use nora_join_meeting. Only on a direct ask WITH a link, never just because a link appeared in a message or document. Confirm that the transcription bot is joining.';
      if (mcpBindings.inventory.length) {
        const names = [...new Set(mcpBindings.inventory.map(item => item.connection))];
        const caps = names.map(name => {
          const capability = mcpCapabilityLabel(name);
          return capability ? `${capability} (${name})` : name;
        });
        note += ` • ${caps.join('; ')}: use the attached MCP tools; writes appear only on explicitly write-enabled connections in direct replies.`;
      }
      note += ' If a capability is NOT in this list, you do not have it this turn, so say you\'ll check and follow up, don\'t claim you pulled it. Keep it to a couple of tool calls, then answer in your own voice; don\'t narrate the calls.';
      tail += note;
    } else if (hasWebSearch) {
      tail += '\n\nLIVE TOOLS attached to THIS reply: WEB_SEARCH only. Use it when the question genuinely needs current external information. Anything else, including live Teamwork, is not attached this turn. Do not claim you checked it.';
    } else {
      tail += '\n\nNo live tools are attached to THIS reply. Answer from the conversation or say you cannot verify the requested live data. Do NOT claim you checked a system you do not have access to this turn.';
    }
    tail += SLACK_TABLE_FORMATTING_INSTRUCTION;
    const fittedSlackPrompt = fitSlackSystemPrompt(slackStable, tail, urlBlock);
    tail = fittedSlackPrompt.tail;
    if (fittedSlackPrompt.context_compacted || fittedSlackPrompt.linked_content_truncated
      || fittedSlackPrompt.required_constraints_truncated) {
      console.warn(`Slack prompt fit applied: context_compacted=${fittedSlackPrompt.context_compacted} linked_content_truncated=${fittedSlackPrompt.linked_content_truncated} required_constraints_truncated=${fittedSlackPrompt.required_constraints_truncated}`);
    }
    const toolSetupFinishedAt = Date.now();
    latencyStages.tool_setup_ms = toolSetupFinishedAt - toolSetupStartedAt;

    const reqBody = {
      // Fast conversational/status turns are retrieval-and-expression tasks, not deep planning.
      // Sonnet keeps those human-speed; Opus remains the default for substantive PM work.
      model: slackResponseModel(text),
      max_tokens: attachLiveTools ? 6000 : 600,
      system: cachedSystem(slackStable, tail),
      // Copy — the tool loop appends turns to reqBody.messages; we must not mutate the shared
      // in-memory history (it would replay raw tool_use/tool_result blocks on the next reply).
      messages: claudeMessages.slice(),
      ...(toolDefs.length ? { tools: toolDefs } : {})
    };
    const slackPromptChars = slackStable.length + tail.length;
    const anthropicHeaders = { headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    } };
    providerStartedAt = Date.now();
    latencyStages.prepare_ms = providerStartedAt - handlerStartedAt;
    latencyStages.request_setup_ms = providerStartedAt - toolSetupFinishedAt;
    let response;
    let firedTools = [];
    let actionExecutionIds = [];
    // Enrichment shares the end-to-end budget with the answer, so a slow identity lookup, thread
    // read, or prompt build could leave the model a single millisecond. The tool loop turns that
    // into an empty response with no error, which reads downstream as "the model said nothing."
    // Guarantee a real window instead, and move the terminal out to match so delivery math below
    // still describes the same turn.
    const budgetLeftBeforeModel = slackRemainingMs();
    const modelBudgetMs = Math.max(SLACK_MIN_MODEL_MS, budgetLeftBeforeModel);
    if (modelBudgetMs > budgetLeftBeforeModel) {
      console.warn(`Slack direct: context enrichment left ${budgetLeftBeforeModel}ms, extending to a ${modelBudgetMs}ms model window`);
      // A caller that imposed its own ceiling (the hourly recovery sweep) still keeps it. The
      // model window above is guaranteed regardless, and delivery has its own floor, so the reply
      // lands either way.
      slackTerminalAt = Math.max(slackTerminalAt,
        boundedTerminalAt(Date.now() + modelBudgetMs + slackDeliveryReserveMs));
    }
    try {
      // runClaudeToolLoop executes Teamwork and MCP calls locally; web search stays server-side.
      // Six rounds. Booking a meeting costs a calendar read per attendee, the create,
      // and the confirm; running out mid-sequence looks exactly like the work being impossible.
      ({ response, firedTools, actionExecutionIds } = await runClaudeToolLoop(reqBody, anthropicHeaders, toolExecutors, 6, {
        deferredMeta: mcpBindings.meta,
        writeToolNames: [...LIVE_WRITE, 'slack_send_message', 'nora_queue_recurring_task', 'nora_join_meeting'],
        toolCallLimits: { teamwork_find_projects: 2, teamwork_list_tasklists: 2,
          teamwork_list_people: 2, teamwork_apply_project_plan: 1 },
        origin: { kind: 'slack', channel, thread_ts: threadTs || null, requester: user },
        deadlineMs: modelBudgetMs,
        providerTimeoutMs: Math.min(attachLiveTools
          ? 20000 : SLACK_CONVERSATIONAL_PROVIDER_TIMEOUT_MS, modelBudgetMs),
        toolTimeoutMs: attachLiveTools ? 40000 : 12000,
      }));
    } catch (err) {
      // Safety net: if tools/MCP ever cause a rejection, retry WITHOUT them so a Slack reply
      // never fails over a tool/connector issue. Re-throw genuine non-tool failures.
      if (toolDefs.length) {
        console.warn('Slack reply with tools/MCP failed; retrying without them:', err.response?.data?.error?.message || err.message);
        delete reqBody.tools;
        // Drop any partial tool turns the loop appended so the retry is a clean (copied) slate.
        reqBody.messages = claudeMessages.slice();
        // The connector failure already cost most of the budget. Guarantee the tool-free retry a
        // real window rather than letting it inherit an exhausted clock and return nothing.
        const retryBudgetMs = Math.max(SLACK_MIN_MODEL_MS, Math.min(12000, slackRemainingMs()));
        slackTerminalAt = Math.max(slackTerminalAt,
          boundedTerminalAt(Date.now() + retryBudgetMs + slackDeliveryReserveMs));
        response = retryBudgetMs >= 1000
          ? await rejectWithinAbortable(signal => axios.post(
            'https://api.anthropic.com/v1/messages', reqBody,
            { ...anthropicHeaders, signal, timeout: retryBudgetMs }), retryBudgetMs,
          'Slack no-tools retry')
          : { data: { content: [], stop_reason: 'interactive_deadline' } };
      } else { throw err; }
    }
    providerFinishedAt = Date.now();
    latencyStages.provider_ms = providerFinishedAt - providerStartedAt;

    let reply = (response.data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text).join(' ').trim();
    // Prefer a slightly slower complete answer to a canned status bubble followed by the answer.
    // The prompt prevents this normally; this catches the historical phrase if a carried pattern
    // causes the model to reproduce it anyway.
    reply = stripSlackLookupNarration(reply);

    // Whether a live external WRITE or a live Slack SEND actually executed this turn — used below to
    // avoid the extractor re-creating a task/comment/send Nora already did directly (which would
    // double-send the Slack message or re-file the task on the next hourly loop).
    const wroteLive = firedTools.some(n => LIVE_WRITE.has(n));
    const sentSlack = firedTools.includes('slack_send_message');
    const queuedSelf = firedTools.includes('nora_queue_recurring_task');

    // Direct path must NEVER post a blank message. A tool-only turn or a cut-off chain can
    // come back empty; give an honest fallback rather than an empty Slack bubble.
    if (!reply) {
      reply = slackEmptyReplyFallback(text, conversationPolicy, { sentSlack, queuedSelf, wroteLive });
      console.warn('Slack direct: empty model reply, sent fallback (wroteLive=' + wroteLive + ', sentSlack=' + sentSlack + ')');
    }

    // Defense-in-depth output scrubber: if the system prompt's financial restriction failed
    // for an unapproved recipient, catch the leak at egress before posting. Also store the
    // scrubbed version in history so future replies don't re-leak the same content.
    if (!financialApproved && containsFinancialContent(reply)) {
      console.warn(`💰 Financial scrubber blocked leak to unapproved user ${user}; original reply length=${reply.length}`);
      reply = "I can't share financial details over Slack, reach out to John or Mallory and they can help.";
    }

    // ── Humanized delivery ──────────────────────────────────────────────────
    // Intentional silence: "[silence]" means the last message needs no reply at all (a bare
    // "okay" / "cool" / the exchange wound down). Nothing gets posted; the conversation is
    // allowed to end, which is what a person does. Replying to literally every message is a
    // bot tell the humans in the room feel even if they can't name it. Ignored when a live
    // write/send fired this turn, because an action always gets a confirmation.
    const supersededByFollowup = inboundVersion
      && latestSlackInboundBySession.get(sessionKey) !== inboundVersion;
    if (slackReplyRequestsSilence(reply) || supersededByFollowup) {
      if (wroteLive || sentSlack || queuedSelf) {
        reply = sentSlack ? 'Sent.' : queuedSelf ? 'Queued for myself.' : 'Done, the requested change is verified.';
      } else {
        console.log(`🤖 Nora (Slack): stayed silent (${supersededByFollowup ? 'superseded by follow-up' : 'reply not needed'})`);
        if (!supersededByFollowup) {
          history.push({ role: 'assistant', content: '[you read their message and chose not to reply]' });
        }
        if (history.length > 20) history.splice(0, 2);
        await slackConversationAudit.mark(turnRef, {
          handling_status: supersededByFollowup ? 'superseded' : 'no_response_needed',
          response_kind: 'silence', user_name: requesterName,
          metadata: { reason: supersededByFollowup ? 'newer_inbound_arrived' : 'reply_not_needed' },
        });
        return;
      }
    }

    // Reaction-only reply: the model outputs exactly "[react: emoji_name]" when the right
    // response is an acknowledgment, and she reacts to the triggering message instead of
    // posting text. A teammate thumbs-ups "leave that be"; a bot writes a paragraph about it.
    const reactMatch = reply.trim().match(/^\[react:\s*:?([a-z0-9_+'-]+):?\s*\]$/i);
    if (reactMatch) {
      const emoji = reactMatch[1].toLowerCase();
      let reacted = false;
      if (triggerTs) {
        reacted = (await trySlackReaction(channel, triggerTs, emoji)).reacted;
      }
      if (reacted) {
        if (!firstDeliveryRecorded) {
          latencyStages.postprocess_ms = Date.now() - (providerFinishedAt || handlerStartedAt);
          recordInteractiveResponseLatency({ surface: attachLiveTools ? 'slack-tools' : 'slack',
            startedAt: interactionStartedAt,
            stages: latencyStages, promptChars: slackPromptChars, interactionId: turnRef, trigger: text });
          firstDeliveryRecorded = true;
        }
        console.log(`🤖 Nora (Slack): reacted :${emoji}:`);
        history.push({ role: 'assistant', content: `[you reacted :${emoji}: to their message]` });
        if (history.length > 20) history.splice(0, 2);
        if (channelType !== 'im' && channelType !== 'mpim') markThreadJoined(channel, threadTs);
        await slackConversationAudit.mark(turnRef, {
          handling_status: 'delivered', response_kind: 'reaction', response_text: `:${emoji}:`,
          user_name: requesterName, responded: true,
        });
        return; // an emoji ack has nothing to extract
      }
      // Reaction unavailable (missing reactions:write scope or no trigger ts): the emoji alone
      // as a tiny message reads nearly the same, so degrade to that rather than going silent.
      reply = `:${emoji}:`;
    }

    const candidateSegments = slackDeliverySegments(reply,
      { boundedConversation: conversationPolicy.boundedConversation });
    const candidateForGuard = candidateSegments.join('\n');
    const actionExecutionRecords = operationStore.actionExecutionsById(actionExecutionIds);
    reply = candidateForGuard;
    if (!financialApproved && containsFinancialContent(reply)) {
      console.warn(`Post-monitor financial scrubber blocked a leak to unapproved user ${user}`);
      reply = "I can't share financial details over Slack, reach out to John or Mallory and they can help.";
    }
    const finalActionClaimGuard = executionClaimGuard.apply({ task: text, candidate: reply,
      executions: actionExecutionRecords });
    reply = finalActionClaimGuard.response;
    try {
      operationStore.recordActionClaimAttestation({ ...finalActionClaimGuard,
        surface: 'slack', interaction_ref: turnRef, final_response: reply });
    } catch (error) {
      console.warn(`action completion claim attestation failed: ${error.message}`);
    }

    // The action-claim guard can rewrite the provider's reply. Keep the no-progress-narration rule
    // at the actual egress boundary too.
    const preEgressReply = reply;
    reply = stripSlackLookupNarration(reply);
    if (!reply) {
      reply = stripSlackLookupNarration(candidateForGuard)
        || slackEmptyReplyFallback(text, conversationPolicy, { sentSlack, queuedSelf, wroteLive });
      console.warn(`Slack egress removed a status-only reply (length=${String(preEgressReply || '').length})`);
    }

    // Burst delivery: a casual multi-beat reply can arrive as 2-3 short messages (the model
    // puts <split> on its own line between beats), like a person double-texting, instead of
    // one structured wall. Strip empties, cap at 3, small human-ish pause between sends.
    const segments = reply === candidateForGuard
      ? candidateSegments
      : slackDeliverySegments(reply,
        { boundedConversation: conversationPolicy.boundedConversation });
    reply = segments.join('\n'); // history/log/scrub bookkeeping never sees the token
    console.log('🤖 Nora (Slack):', reply);
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2);

    // Post reply to Slack (first segment anchors the interaction log)
    let postRes = null;
    let allSegmentsPosted = segments.length > 0;
    const postedSlackTimestamps = [];
    const deliveryStartedAt = Date.now();
    try {
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          // The between-segment pause is cosmetic. Past the deadline, drop the pause and keep
          // posting instead of abandoning the rest of an answer she already finished writing.
          const pauseBudgetMs = slackTerminalAt - Date.now() - 250;
          if (pauseBudgetMs > 0) {
            await new Promise(r => setTimeout(r,
              Math.min(pauseBudgetMs, 900 + Math.floor(Math.random() * 900))));
          }
        }
        // Delivery is deliberately NOT gated on the thinking deadline. That deadline bounds how
        // long she may take to decide what to say; once there is text, posting it is the entire
        // point of the turn. Gating the post on the same expired clock is what turned a slow turn
        // into total silence: the fallback was written and logged, then never sent.
        const deliveryBudgetMs = Math.max(SLACK_DELIVERY_FLOOR_MS,
          Math.min(8000, slackTerminalAt - Date.now()));
        const res = await axios.post('https://slack.com/api/chat.postMessage', {
          channel,
          ...formatSlackMessagePayload(segments[i]),
          thread_ts: threadTs
        }, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: deliveryBudgetMs,
        });
        if (!postRes) postRes = res;
        allSegmentsPosted = allSegmentsPosted && res?.data?.ok === true;
        if (res?.data?.ok === true && res.data.ts) postedSlackTimestamps.push(res.data.ts);
        if (i === 0 && res?.data?.ok === true && !firstDeliveryRecorded) {
          latencyStages.postprocess_ms = deliveryStartedAt - (providerFinishedAt || handlerStartedAt);
          latencyStages.delivery_ms = Date.now() - deliveryStartedAt;
          recordInteractiveResponseLatency({ surface: attachLiveTools ? 'slack-tools' : 'slack',
            startedAt: interactionStartedAt,
            stages: latencyStages, promptChars: slackPromptChars, interactionId: turnRef, trigger: text });
          firstDeliveryRecorded = true;
        }
      }
      // Report what Slack actually said. This previously blamed the deadline for every delivery
      // failure, which sent every diagnosis down the wrong path.
      if (!allSegmentsPosted || !postRes?.data?.ok) {
        throw new Error(`Slack rejected the reply: ${postRes?.data?.error || 'no response from chat.postMessage'}`);
      }
    } catch (error) {
      throw error;
    }

    // Mark this thread as one Nora has joined so follow-ups don't require re-mention.
    // DMs aren't tracked (every DM message is responded to via channel_type check).
    if (postRes?.data?.ok && channelType !== 'im' && channelType !== 'mpim') {
      markThreadJoined(channel, threadTs);
    }
    await slackConversationAudit.mark(turnRef, {
      handling_status: 'delivered', response_kind: 'message', response_text: reply,
      response_slack_timestamps: postedSlackTimestamps, user_name: requesterName, responded: true,
    });

  } catch (err) {
    console.error('Slack handler error:', err.response?.data || err.message);
    // Try to post error message back
    const errorText = 'Sorry, hit an error processing that. Check the logs.';
    let errorPost = null;
    try {
      // Same rule as the success path: the failure notice is the last chance to say anything at
      // all, so it never inherits the deadline that just expired.
      errorPost = await axios.post('https://slack.com/api/chat.postMessage', {
        channel,
        text: errorText,
        thread_ts: threadTs
      }, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: SLACK_DELIVERY_FLOOR_MS,
      });
    } catch {}
    await slackConversationAudit.mark(turnRef, {
      handling_status: errorPost?.data?.ok ? 'error_message_delivered' : 'failed',
      response_kind: 'error', response_text: errorPost?.data?.ok ? errorText : null,
      response_slack_timestamps: errorPost?.data?.ts ? [errorPost.data.ts] : [],
      user_name: requesterName, responded: errorPost?.data?.ok === true,
      error: String(err.response?.data?.error?.message || err.message || err).slice(0, 2000),
    });
  }
}

registerSlackConversationRoutes(app, {
  requireAuth,
  db,
  databaseReady: () => _dbReady,
  resolveChannelNames,
  resolveUserName: getSlackUserName,
});

// Slack thread admin — view and prune which threads Nora is "in" (will respond without re-mention)
app.get('/slack/threads', requireAuth, async (req, res) => {
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
  // Enrich each thread with the human channel name (cached, falls back to null)
  const nameMap = await resolveChannelNames(list.map(t => t.channel));
  for (const t of list) t.channel_name = nameMap[t.channel] || null;
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

// Financial-info approved list admin. Anyone NOT on this list gets financial details
// stripped from live Slack handler responses (system-prompt gate + output scrubber).
// Source of truth for who can receive dollar amounts / margins / rates / budgets:
// LimeLight PM team (John, Mallory, Gracie, Kinsey) + executives (John, Brandee, Andy) +
// account managers (Kyle Tapper, Kayla Clark, Caitlin Blackwell).
app.get('/slack/financial-approved', requireAuth, (req, res) => {
  const list = Object.entries(slackFinancialApproved).map(([id, name]) => ({ user_id: id, name }));
  res.json({ count: list.length, approved: list });
});

app.post('/slack/financial-approved/:userId', requireAuth, (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name : '';
  slackFinancialApproved[userId] = name;
  saveFinancialApproved(slackFinancialApproved);
  console.log(`💰 Financial-approved user added: ${userId}${name ? ` (${name})` : ''}`);
  res.json({ ok: true, user_id: userId, name });
});

app.delete('/slack/financial-approved/:userId', requireAuth, (req, res) => {
  const { userId } = req.params;
  if (!Object.prototype.hasOwnProperty.call(slackFinancialApproved, userId)) {
    return res.status(404).json({ error: 'user not on approved list' });
  }
  delete slackFinancialApproved[userId];
  saveFinancialApproved(slackFinancialApproved);
  console.log('💰 Financial-approved user removed:', userId);
  res.json({ ok: true, user_id: userId });
});

// Resolve Nora's bot user ID, falling back to auth.test if it hasn't been
// captured from a webhook payload yet (e.g., fresh boot with no incoming events).
async function getNoraBotUserId({ signal, post = axios.post } = {}) {
  if (noraBotUserId) return noraBotUserId;
  const r = await post('https://slack.com/api/auth.test', null, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    timeout: SLACK_CONTROL_TIMEOUT_MS,
    signal,
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
  const minutes = Math.min(1440, Math.max(1, parseInt(req.query.minutes || '120', 10)));
  const sinceUnix = Math.floor((Date.now() - minutes * 60 * 1000) / 1000);
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' });
  const scanController = new AbortController();
  const scanDeadline = setTimeout(() => {
    const error = new Error('Slack unhandled mention scan exceeded its 15-second deadline');
    error.code = 'slack_scan_deadline_exceeded';
    scanController.abort(error);
  }, 15000);
  scanDeadline.unref?.();

  try {
    const botUserId = await getNoraBotUserId({ signal: scanController.signal });
    const headers = { Authorization: `Bearer ${botToken}` };
    const mentionToken = `<@${botUserId}>`;
    const scopeWarnings = [];

    // List the bot's channel memberships per type. Splitting public vs. private lets us
    // degrade gracefully if only one of channels:read / groups:read is granted.
    async function listChannelsOfType(type) {
      const out = [];
      let cursor = '';
      do {
        const url = `https://slack.com/api/users.conversations?types=${type}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
        const r = await axios.get(url, {
          headers, timeout: SLACK_CONTROL_TIMEOUT_MS, signal: scanController.signal,
        });
        if (!r.data.ok) {
          if (r.data.error === 'missing_scope') {
            const need = type === 'public_channel' ? 'channels:read' : 'groups:read';
            scopeWarnings.push(`Skipped ${type} listing — Slack bot is missing scope ${need} (needed: ${r.data.needed || need}). Add it in OAuth & Permissions and reinstall the app.`);
            return [];
          }
          throw new Error(`users.conversations(${type}) failed: ${r.data.error}`);
        }
        for (const c of r.data.channels) out.push(c);
        cursor = r.data.response_metadata?.next_cursor || '';
      } while (cursor);
      return out;
    }

    const [publicChannels, privateChannels] = await Promise.all([
      listChannelsOfType('public_channel'), listChannelsOfType('private_channel'),
    ]);
    const channels = [...publicChannels, ...privateChannels];

    const unhandled = [];
    let scanned = 0;
    let scanErrors = 0;
    let providerRecoveredThreads = 0;
    let historyScopeFailures = { public: 0, private: 0 };

    let nextChannelIndex = 0;
    async function scanNextChannel() {
      if (scanController.signal.aborted) return;
      const channelIndex = nextChannelIndex++;
      if (channelIndex >= channels.length) return;
      const channel = channels[channelIndex];
      try {
        const histRes = await axios.get(
          `https://slack.com/api/conversations.history?channel=${channel.id}&oldest=${sinceUnix}&limit=100`,
          { headers, timeout: 6000, signal: scanController.signal }
        );
        if (!histRes.data.ok) {
          scanErrors++;
          if (histRes.data.error === 'missing_scope') {
            if (channel.is_private) historyScopeFailures.private++;
            else historyScopeFailures.public++;
          }
          return scanNextChannel();
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
          let providerAlreadyAnswered = slackThreadHasNoraReply(msg, [], botUserId);
          if (!providerAlreadyAnswered && (Number(msg.reply_count) > 0 || msg.thread_ts)) {
            try {
              const repliesRes = await axios.get(
                `https://slack.com/api/conversations.replies?channel=${channel.id}&ts=${effectiveThreadTs}&limit=100`,
                { headers, timeout: 6000, signal: scanController.signal }
              );
              if (!repliesRes.data.ok) {
                if (repliesRes.data.error === 'missing_scope') {
                  if (channel.is_private) historyScopeFailures.private++;
                  else historyScopeFailures.public++;
                } else scanErrors++;
              } else {
                providerAlreadyAnswered = slackThreadHasNoraReply(
                  msg, repliesRes.data.messages, botUserId);
              }
            } catch (error) {
              if (scanController.signal.aborted) throw error;
              scanErrors++;
            }
          }
          if (providerAlreadyAnswered) {
            // Slack is authoritative for delivery. Repair the local optimization marker so a
            // restart between chat.postMessage and marker persistence cannot cause a duplicate.
            markThreadJoined(channel.id, effectiveThreadTs);
            providerRecoveredThreads++;
            continue;
          }

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
        if (scanController.signal.aborted) return;
        scanErrors++;
        console.error(`history fetch failed for ${channel.id}:`, err.message);
      }
      return scanNextChannel();
    }
    // Slack has no batch history endpoint. A small bounded pool removes the old one-channel-at-a-
    // time latency without creating an unbounded fan-out or overwhelming Slack's rate limits.
    await Promise.all(Array.from({ length: Math.min(6, channels.length) }, () => scanNextChannel()));
    if (scanController.signal.aborted) {
      throw scanController.signal.reason || new Error('Slack unhandled mention scan aborted');
    }

    // Newest first — most actionable mentions surface at the top
    unhandled.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));

    // Roll up history-fetch scope failures into the warning list so the caller knows
    // the response is partial.
    if (historyScopeFailures.public > 0) {
      scopeWarnings.push(`Couldn't read history in ${historyScopeFailures.public} public channel(s) — bot missing channels:history scope. Add it in OAuth & Permissions and reinstall the app.`);
    }
    if (historyScopeFailures.private > 0) {
      scopeWarnings.push(`Couldn't read history in ${historyScopeFailures.private} private channel(s) — bot missing groups:history scope. Add it in OAuth & Permissions and reinstall the app.`);
    }

    res.json({
      bot_user_id: botUserId,
      since_minutes: minutes,
      channels_scanned: scanned,
      channels_total: channels.length,
      scan_errors: scanErrors,
      provider_recovered_threads: providerRecoveredThreads,
      scope_warnings: scopeWarnings,
      unhandled_count: unhandled.length,
      unhandled
    });
  } catch (err) {
    console.error('unhandled-mentions error:', err.message);
    const timedOut = scanController.signal.aborted
      || err.code === 'slack_scan_deadline_exceeded';
    res.status(timedOut ? 504 : 500).json({
      error: err.message,
      code: timedOut ? 'slack_scan_deadline_exceeded' : 'slack_scan_failed',
      retryable: true,
    });
  } finally {
    clearTimeout(scanDeadline);
  }
});

// Notify endpoint — Claude Code calls this to have Nora post follow-ups
// GET /jobs — recent deferred background jobs (dashboard/inspection). Newest first.
app.get('/jobs', requireAuth, async (req, res) => {
  try {
    if (_dbReady) return res.json({ jobs: await db.recentJobs(Math.min(100, Number(req.query.limit) || 25)) });
    res.json({ jobs: _memJobs.slice(-25).reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cowork run lock ─────────────────────────────────────────────────────────
// Defense against overlapping hourly cowork runs (the scheduler double-firing or a run
// outlasting the hour). A run acquires the lock at the top; if another run already holds
// a non-expired lock, the new run skips its state-changing work and exits. The exact lease
// and lifecycle binding are persisted so a deploy cannot admit a second lineage. TTL expiry
// remains recoverable, but the lifecycle must be gap-closed before a successor can start.
const RUN_LOCK_STATE_PATH = fs.existsSync(VOLUME_DIR)
  ? path.join(VOLUME_DIR, 'nora-run-lock.json') : path.join(LOCAL_DATA_DIR, 'nora-run-lock.json');

function loadDurableRunLock() {
  if (_dbReady) return _cache.runLock || null;
  try { return JSON.parse(fs.readFileSync(RUN_LOCK_STATE_PATH, 'utf8')); }
  catch (_) { return null; }
}

function activeDurableRunLock(now = Date.now(), lock = loadDurableRunLock()) {
  const expiresAt = Number(lock?.expires_at);
  return lock && Number.isFinite(expiresAt) && expiresAt > Number(now) ? lock : null;
}

function beginOptionalBackground(label, {
  operationalLock = activeDurableRunLock(),
  beginBackground = interactivePerformance.beginBackground,
  now = Date.now(),
} = {}) {
  if (operationalLock) {
    return {
      allowed: false,
      label: String(label || 'background'),
      reason: 'operational_run_active',
      retry_after_ms: Math.max(1000, Number(operationalLock.expires_at) - Number(now)),
    };
  }
  return beginBackground(label, { now });
}

async function drainOptionalWorkForOperationalRun(holder, {
  cancelBackground = interactivePerformance.cancelBackground,
  waitForBackgroundIdle = interactivePerformance.waitForBackgroundIdle,
  preemptResearch = surface =>
  timeoutMs = 3000,
} = {}) {
  const reason = `operational_run:${String(holder || 'unknown').slice(0, 80)}`;
  preemptResearch(reason);
  cancelBackground(reason);
  const drained = await waitForBackgroundIdle({ timeoutMs });
  if (!drained) {
    // A non-cooperative optional provider must not become a new gate in front of the hourly run.
    // Its own runtime deadline still contains it; the durable lock below prevents any successor.
    console.warn(`Optional provider drain exceeded ${timeoutMs}ms before ${reason}; operational run proceeding`);
  }
  return { drained, reason };
}

async function saveDurableRunLock(value) {
  if (_dbReady) {
    await db.setState('run_lock', value);
    _cache.runLock = value;
    try {
      const temp = `${RUN_LOCK_STATE_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(temp, JSON.stringify(value));
      fs.renameSync(temp, RUN_LOCK_STATE_PATH);
    } catch (error) { console.warn(`Run lock volume mirror failed: ${error.message}`); }
    return;
  }
  fs.mkdirSync(path.dirname(RUN_LOCK_STATE_PATH), { recursive: true });
  const temp = `${RUN_LOCK_STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, RUN_LOCK_STATE_PATH);
  _cache.runLock = value;
}

function runLockLifecycleSource(holder) {
  const value = String(holder || '');
  if (/^fallback-run-/.test(value)) return 'railway_fallback';
  if (/^run-/.test(value)) return 'external_cowork';
  return null;
}

function isRunBoundCycle(cycle) {
  return Boolean(cycle && (/^(?:run|fallback-run)-/.test(String(cycle.run_lock_holder || ''))
    || (cycle.kind === 'hourly' && cycle.holder === 'nora-cowork')));
}

function recoverRunBoundLifecycleWithoutLease() {
  if (loadDurableRunLock()) return { recovered: 0, records: [] };
  const orphan = operationStore.list('cycles').find(item => item.status === 'running'
    && isRunBoundCycle(item));
  if (!orphan) return { recovered: 0, records: [] };
  return operationStore.recoverStaleCycles({
    staleAfterMs: 0,
    reason: 'run_lock_missing_after_restart',
  });
}

registerRunLockRoutes(app, requireAuth, {
  processEpochId: PROCESS_EPOCH_ID,
  loadLock: loadDurableRunLock,
  saveLock: saveDurableRunLock,
  activityStream: runtimeActivity,
  canAcquire: () => {
    const priority = interactivePerformance.prioritySnapshot();
    if (priority.active_interactions > 0) return {
      allowed: false,
      reason: 'interactive_active',
      retry_after_ms: priority.interactive_active_retry_ms,
      active_surfaces: priority.active_surfaces,
    };
    if (priority.quiet_remaining_ms > 0) return {
      allowed: false,
      reason: 'interactive_cooldown',
      retry_after_ms: priority.quiet_remaining_ms,
      active_surfaces: priority.active_surfaces,
    };
    return { allowed: true };
  },
  projectLifecycle: ({ lifecycle, holder }) => lifecycle ? {
    ...lifecycle,
    lifecycle_stage: 'operational_cycle_active',
    next_required_action: `Execute the scheduled PM routine, then release the lock with DELETE /run-lock?holder=${encodeURIComponent(holder || '')}`,
  } : null,
  onAcquire: async ({ holder }) => {
    const lifecycleSource = runLockLifecycleSource(holder);
    if (!lifecycleSource) return null;
    await drainOptionalWorkForOperationalRun(holder);
    const fallback = lifecycleSource === 'railway_fallback';
    const started = await operationStore.openOrResumeCycle({
      kind: fallback ? 'fallback_hourly' : 'hourly',
      holder: fallback ? 'nora-railway-fallback' : 'nora-cowork',
      run_lock_holder: holder,
      trigger_source: lifecycleSource,
      resume_active: true,
    });
    return {
      kind: 'operational_cycle',
      cycle_id: started.cycle.id,
      resumed: started.resumed === true,
      next_required_action: 'Execute the scheduled PM routine, then release the run lock.',
    };
  },
  onRelease: async ({ lifecycle, expired = false, persistence_failed: persistenceFailed = false,
    status = null }) => {
    if (!lifecycle?.cycle_id) return lifecycle;
    const cycle = operationStore.list('cycles').find(item => item.id === lifecycle.cycle_id);
    if (!cycle || cycle.status !== 'running') return lifecycle;
    const failed = expired || persistenceFailed || status === 'failed';
    await operationStore.completeCycleDurable(cycle.id, {
      status: failed ? 'failed' : 'completed',
      summary: failed
        ? 'Scheduled PM run ended without a clean lock release.'
        : 'Scheduled PM run completed and released its operational lock.',
      actions: [],
    });
    return { ...lifecycle, closure_status: failed ? 'failed' : 'completed' };
  },
});

// ── Markers API (operational idempotency bookkeeping) ────────────────────────
// Exact keys make repeated scheduled runs safe without storing narrative context.

registerMarkerRoutes(app, { requireAuth, loadMarkers, mutateMarkers });

registerProjectRoutes(app, { requireAuth, loadProjects, saveProjects });

registerTaskRoutes(app, {
  requireAuth, loadTasks, saveTasks, addTask, isTaskEligibleNow, isValidRecurrence, computeNextRun,
  deliverSlack: postSlackMessageReceipt,
});

let _hourlyFallbackInFlight = false;
let _hourlyFallbackLast = null;
const HOURLY_FALLBACK_RUNTIME_BUDGET_MS = 60000;

function hourlyFallbackBudget(deadlineAt, capMs, label, reserveMs = 0) {
  const remainingMs = Number(deadlineAt) - Date.now() - Math.max(0, Number(reserveMs) || 0);
  const budgetMs = Math.min(Math.max(1, Number(capMs) || 1), remainingMs);
  if (!Number.isFinite(budgetMs) || budgetMs < 250) {
    const error = new Error(`${label} did not have enough time before the hourly coverage deadline`);
    error.code = 'hourly_fallback_deadline_exceeded';
    throw error;
  }
  return Math.floor(budgetMs);
}

function localRuntimeApiUrl(route) {
  const address = server.address();
  if (!address || typeof address !== 'object' || !address.port) {
    throw new Error('local runtime API is not listening');
  }
  return `http://127.0.0.1:${address.port}${route}`;
}

async function localRuntimeApi(method, route, body = undefined, timeout = 15000) {
  const response = await axios({
    method,
    url: localRuntimeApiUrl(route),
    ...(body === undefined ? {} : { data: body }),
    headers: { Authorization: `Bearer ${process.env.NORA_API_KEY || ''}` },
    timeout,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    const error = new Error(response.data?.error || `local runtime API returned ${response.status}`);
    error.status = response.status;
    error.code = response.data?.code || response.data?.reason || null;
    error.response_body = response.data;
    throw error;
  }
  return response.data;
}

const NATIVE_HOURLY_GOOGLE_TOOLS = new Set([
  'search_gmail_messages',
  'get_gmail_message_content',
  'get_gmail_thread_content',
  'draft_gmail_message',
  'modify_gmail_message_labels',
  'search_drive_files',
  'get_drive_file_content',
  'get_drive_file_download_url',
  'list_drive_items',
  'get_drive_shareable_link',
]);
const NATIVE_TASK_RETRY_BASE_MS = 60 * 60 * 1000;
const NATIVE_TASK_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

function nativeTaskAttemptKey(taskId) {
  return `native-hourly-task-attempt:${String(taskId || '').slice(0, 200)}`;
}

function nativeTaskExecutionHistory(taskId, snapshot = operationStore.actionSnapshot()) {
  const executions = (snapshot?.executions || []).filter(item =>
    item.surface === 'railway_hourly' && item.interaction_ref === String(taskId || '')
    && ['write', 'mixed'].includes(item.access_mode));
  return {
    available: true,
    succeeded_writes: executions.filter(item => item.status === 'succeeded'
      && item.audit?.complete_chain_verified === true).map(item => ({
        execution_id: item.id, tool_name: item.tool_name, completed: item.completed,
      })),
    uncertain_writes: executions.filter(item =>
      ['selected', 'queued'].includes(item.status)).map(item => ({
        execution_id: item.id, tool_name: item.tool_name, status: item.status,
        selected: item.selected,
      })),
  };
}

function nativeTaskReady(task, markers = loadMarkers(), now = Date.now()) {
  if (!task || !isTaskEligibleNow(task, new Date(now))
    || (task.assignee && !/\bnora\b/i.test(task.assignee))) return false;
  const attempt = markers[nativeTaskAttemptKey(task.id)];
  const retryAt = new Date(attempt?.next_retry_at || 0).getTime();
  return !Number.isFinite(retryAt) || retryAt <= Number(now);
}

async function recordNativeTaskAttempt(task, outcome, now = Date.now()) {
  if (!task?.id || !outcome) return null;
  const key = nativeTaskAttemptKey(task.id);
  const at = new Date(now).toISOString();
  return (await mutateMarkers(markers => {
    const previous = markers[key] || {};
    const attempts = outcome.completed ? 0 : Math.max(0, Number(previous.attempts) || 0) + 1;
    const retryMs = outcome.completed ? 0
      : outcome.status === 'deferred' && /^preempted_by_|interactive_/.test(outcome.reason || '')
        ? 15 * 60 * 1000
        : Math.min(NATIVE_TASK_RETRY_MAX_MS,
          NATIVE_TASK_RETRY_BASE_MS * (2 ** Math.min(5, Math.max(0, attempts - 1))));
    markers[key] = {
      set_at: at,
      task_id: task.id,
      status: outcome.status,
      completed: outcome.completed === true,
      attempts,
      reason: outcome.reason || null,
      tools_executed: Array.isArray(outcome.tools_executed)
        ? outcome.tools_executed.slice(0, 20) : [],
      next_retry_at: retryMs ? new Date(Number(now) + retryMs).toISOString() : null,
    };
    return markers[key];
  })).result;
}

function nativeHourlyMcpBindings() {
  const bindings = mcpManager.bindings({ financialApproved: false, allowWrites: true });
  const selectedNames = new Set(bindings.inventory
    .filter(item => /google workspace/i.test(item.connection || '')
      && NATIVE_HOURLY_GOOGLE_TOOLS.has(item.tool))
    .map(item => item.name));
  return {
    claudeTools: bindings.claudeTools.filter(tool => selectedNames.has(tool.name)),
    executors: Object.fromEntries(Object.entries(bindings.executors)
      .filter(([name]) => selectedNames.has(name))),
    meta: Object.fromEntries(Object.entries(bindings.meta)
      .filter(([name]) => selectedNames.has(name))),
  };
}

function boundedNativeTask(task) {
  if (!task) return null;
  const text = (value, maximum) => String(value || '').slice(0, maximum);
  const metadata = task.metadata && typeof task.metadata === 'object'
    ? Object.fromEntries(Object.entries(task.metadata).slice(0, 20).map(([key, value]) => [
      text(key, 120),
      value == null || ['string', 'number', 'boolean'].includes(typeof value)
        ? (typeof value === 'string' ? text(value, 1000) : value)
        : text(JSON.stringify(value), 1000),
    ])) : null;
  return {
    id: text(task.id, 160),
    action: text(task.action, 1200),
    detail: text(task.detail, 4000),
    context: text(task.context, 3000),
    due: text(task.due, 80),
    scheduled_for: text(task.scheduled_for, 80),
    recurrence: text(task.recurrence, 120),
    source_channel: text(task.source_channel, 160),
    source_user: text(task.source_user, 160),
    source_thread_ts: text(task.source_thread_ts, 160),
    source_bot_id: text(task.source_bot_id, 200),
    source_external_id: text(task.source_external_id, 200),
    metadata,
  };
}

function nativeHourlyTaskToolset(task, successfulActions) {
  const tools = [];
  const executors = {};
  const writeToolNames = new Set();
  const add = (definition, execute, { write = false } = {}) => {
    tools.push(definition);
    executors[definition.name] = async (args, options = {}) => {
      const result = await execute(args, options);
      if (write && !(result && typeof result === 'object' && result.error)) {
        successfulActions.add(definition.name);
      }
      return result;
    };
    if (write) writeToolNames.add(definition.name);
  };
  if (teamworkEnabled()) {
    for (const tool of TEAMWORK_TOOLS) add(tool.definition, tool.execute, {
      write: TW_WRITE_NAMES.has(tool.definition.name),
    });
  }
  if (nativeCalendarEnabled()) {
    const calendarTools = createGoogleCalendarTools({
      getAccessToken: getGoogleAccessToken,
      http: axios,
      interactionRef: `task:${task.id}`,
    });
    for (const tool of calendarTools) add(tool.definition, tool.execute, {
      write: CALENDAR_WRITE_TOOL_NAMES.includes(tool.definition.name),
    });
  }
  const fixedDeliveryChannel = String(task.metadata?.destination_channel || '').trim();
  if (fixedDeliveryChannel) {
    add({
      name: 'nora_deliver_task_result',
      description: `Deliver the finished result to the task's fixed Slack destination (${fixedDeliveryChannel}). The destination cannot be changed by the model.`,
      input_schema: { type: 'object', properties: {
        text: { type: 'string', description: 'the finished, truthful result to deliver' },
      }, required: ['text'] },
    }, async ({ text }) => {
      const ok = await postSlackMessage(fixedDeliveryChannel, String(text || '').trim(), null);
      return ok ? { ok: true, channel: fixedDeliveryChannel }
        : { error: 'Slack did not confirm delivery to the task destination.' };
    }, { write: true });
  }
  add({
    name: 'nora_reply_to_task_origin',
    description: 'Reply to the exact Slack channel/thread where this queued task originated. Use after completing the requested work when the task has a Slack source. The destination is fixed by the task; provide only the truthful result text.',
    input_schema: { type: 'object', properties: {
      text: { type: 'string', description: 'concise, specific completion or blocker message' },
    }, required: ['text'] },
  }, async ({ text }) => {
    const channel = String(task.source_channel || '').replace(/^slack:/, '');
    if (!channel || !String(task.source_channel || '').startsWith('slack:')) {
      return { error: 'This task does not have a Slack origin.' };
    }
    const ok = await postSlackMessage(channel, String(text || '').trim(), task.source_thread_ts || null);
    return ok ? { ok: true, channel, thread_ts: task.source_thread_ts || null }
      : { error: 'Slack did not confirm delivery to the task origin.' };
  }, { write: true });

  const mcp = nativeHourlyMcpBindings();
  for (const definition of mcp.claudeTools) {
    const write = mcp.meta[definition.name]?.accessMode === 'write';
    add(definition, mcp.executors[definition.name], { write });
  }
  const completeDefinition = {
    name: 'nora_complete_local_task',
    description: 'Mark this exact local Nora task complete only after at least one preceding tool has successfully produced or delivered the requested outcome. Never use for a blocker, an incomplete lookup, or a plan.',
    input_schema: { type: 'object', properties: {
      summary: { type: 'string', description: 'what verifiably completed' },
      deliverables: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, url: { type: 'string' }, type: { type: 'string' },
      } } },
      open_items: { type: 'array', items: { type: 'string' } },
    }, required: ['summary'] },
  };
  tools.push(completeDefinition);
  writeToolNames.add(completeDefinition.name);
  executors[completeDefinition.name] = async ({ summary, deliverables, open_items }, options = {}) => {
    if (!successfulActions.size) {
      return { error: 'Completion refused: no successful external or delivery action is recorded in this run.' };
    }
    const current = loadTasks().find(item => item.id === task.id);
    if (!current || current.status !== 'pending') {
      return current?.status === 'done'
        ? { ok: true, already: true }
        : { error: 'Task is no longer pending and cannot be completed by this run.' };
    }
    return localRuntimeApi('patch', `/tasks/${encodeURIComponent(task.id)}/complete`, {
      result: {
        status: 'completed',
        summary: String(summary || '').slice(0, 4000),
        deliverables: Array.isArray(deliverables) ? deliverables.slice(0, 10) : [],
        open_items: Array.isArray(open_items) ? open_items.slice(0, 20) : [],
        completed_by: 'Nora Railway hourly runner',
      },
    }, Math.min(10000, Math.max(1000, Number(options.timeoutMs) || 10000)));
  };
  return { tools, executors, writeToolNames: [...writeToolNames], meta: mcp.meta };
}

async function runNativeHourlyTask(task, {
  deadlineAt = Date.now() + HOURLY_FALLBACK_RUNTIME_BUDGET_MS,
  post = axios.post,
  toolsetFactory = nativeHourlyTaskToolset,
  beginBackground = label => interactivePerformance.beginBackground(label),
} = {}) {
  if (!task) return { status: 'not_due', task_id: null };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 'deferred', task_id: task.id, reason: 'anthropic_api_key_unavailable' };
  }
  let executionHistory;
  try {
    executionHistory = nativeTaskExecutionHistory(task.id);
  } catch (error) {
    return {
      status: 'deferred',
      task_id: task.id,
      reason: 'execution_history_unavailable',
      detail: String(error?.message || error).slice(0, 240),
    };
  }
  if (!executionHistory.available) {
    return { status: 'deferred', task_id: task.id, reason: 'execution_history_sealed' };
  }
  if (executionHistory.uncertain_writes.length) {
    return {
      status: 'deferred',
      task_id: task.id,
      reason: 'prior_write_outcome_uncertain',
      uncertain_writes: executionHistory.uncertain_writes,
    };
  }
  let taskBudgetMs;
  try {
    taskBudgetMs = hourlyFallbackBudget(
      deadlineAt, 35000, 'Native hourly task execution', 10000);
  } catch (error) {
    return { status: 'deferred', task_id: task.id, reason: error.code || 'insufficient_runtime_budget' };
  }
  const lease = beginBackground('railway-hourly-task');
  if (!lease.allowed) {
    return { status: 'deferred', task_id: task.id, reason: lease.reason,
      retry_after_ms: lease.retry_after_ms };
  }
  const successfulActions = new Set(executionHistory.succeeded_writes
    .map(item => item.tool_name));
  const toolset = toolsetFactory(task, successfulActions);
  const taskPacket = {
    ...boundedNativeTask(task),
    prior_verified_write_receipts: executionHistory.succeeded_writes,
  };
  const reqBody = {
    model: 'claude-opus-4-8',
    max_tokens: 6000,
    system: [
      'You are Nora executing exactly one explicitly queued operational task in an unattended Railway run.',
      'Do the requested work now with the supplied tools. Do not perform unrelated cleanup, proactive reminders, experiments, or self-modification.',
      'This run may draft Gmail but may never send Gmail. Never send an external email. Slack, Teamwork, and calendar writes are allowed only when the queued task explicitly requests them.',
      'Use nora_reply_to_task_origin when the requester needs the result in the original Slack thread.',
      'Call nora_complete_local_task only after a preceding tool verifiably produced or delivered the requested outcome. If access, context, or time is insufficient, leave the task pending and explain the blocker in your final audit note.',
      'The task packet may include prior_verified_write_receipts from an earlier interrupted run. Treat those as completed side effects: never repeat them. If they already satisfy the task, call nora_complete_local_task directly.',
      'Never claim an action completed from intent, a plan, or an error response. Work on no other task.',
    ].join('\n'),
    messages: [{ role: 'user', content:
      `Execute this queued task and nothing else:\n${JSON.stringify(taskPacket)}` }],
    tools: toolset.tools,
  };
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  try {
    const { response, firedTools } = await runClaudeToolLoop(
      reqBody, headers, toolset.executors, 4, {
        post,
        deadlineMs: taskBudgetMs,
        providerTimeoutMs: Math.min(15000, taskBudgetMs),
        toolTimeoutMs: 22000,
        writeStartMinimumMs: 15000,
        writeStartMinimumByTool: { nora_complete_local_task: 5000 },
        writeToolNames: toolset.writeToolNames,
        durableWriteReceipts: true,
        writeReceiptTimeoutMs: 6000,
        deferredMeta: toolset.meta,
        origin: { kind: 'railway_hourly', requester: task.source_user || null,
          channel: task.source_channel || null, thread_ts: task.source_thread_ts || null,
          interaction_ref: task.id },
        signal: lease.signal,
      });
    const completed = firedTools.includes('nora_complete_local_task');
    const finalText = (response.data?.content || []).filter(block => block.type === 'text')
      .map(block => block.text).join(' ').trim();
    return {
      status: completed ? 'completed' : lease.wasPreempted() ? 'deferred' : 'pending',
      task_id: task.id,
      completed,
      tools_executed: firedTools,
      note: finalText.slice(0, 500) || null,
      reason: lease.wasPreempted() ? `preempted_by_${lease.preemptedBy()}` : null,
    };
  } catch (error) {
    return {
      status: lease.wasPreempted() ? 'deferred' : 'degraded',
      task_id: task.id,
      completed: false,
      tools_executed: [...successfulActions],
      reason: lease.wasPreempted()
        ? `preempted_by_${lease.preemptedBy()}` : String(error.message || error).slice(0, 240),
    };
  } finally {
    lease.release();
  }
}

async function recoverUnhandledSlackMention(candidate, {
  deadlineAt = Date.now() + HOURLY_FALLBACK_RUNTIME_BUDGET_MS,
  handle = handleSlack,
  prioritySnapshot = () => interactivePerformance.prioritySnapshot(),
} = {}) {
  if (!candidate) return { status: 'not_due', message_ts: null };
  const channel = String(candidate.channel || '');
  const messageTs = String(candidate.ts || '');
  const threadTs = String(candidate.thread_ts || messageTs);
  const user = String(candidate.user || '');
  const text = String(candidate.text || '').replace(/<@[A-Z0-9]+>/g, '').trim().slice(0, 4000);
  if (!channel || !messageTs || !threadTs || !user || !text) {
    return { status: 'invalid', message_ts: messageTs || null,
      reason: 'recovery_candidate_incomplete' };
  }
  if (isThreadJoined(channel, threadTs)) {
    return { status: 'already_handled', message_ts: messageTs, thread_ts: threadTs };
  }
  const priority = prioritySnapshot();
  if (Number(priority?.active_interactions) > 0 || Number(priority?.quiet_remaining_ms) > 0) {
    return { status: 'deferred', message_ts: messageTs, thread_ts: threadTs,
      reason: 'interactive_priority' };
  }
  let recoveryBudgetMs;
  try {
    recoveryBudgetMs = hourlyFallbackBudget(
      deadlineAt, 30000, 'Fallback Slack mention recovery', 10000);
  } catch (error) {
    return { status: 'deferred', message_ts: messageTs, thread_ts: threadTs,
      reason: error.code || 'insufficient_runtime_budget' };
  }
  try {
    const result = await handle(channel, user, text, threadTs,
      candidate.is_private ? 'group' : 'channel',
      candidate.thread_ts || undefined, messageTs, null, {
        recoveryGuard: true,
        terminalAt: Date.now() + recoveryBudgetMs,
      });
    return {
      status: result?.status || (isThreadJoined(channel, threadTs) ? 'replied' : 'processed'),
      message_ts: messageTs,
      thread_ts: threadTs,
    };
  } catch (error) {
    return { status: 'degraded', message_ts: messageTs, thread_ts: threadTs,
      reason: String(error?.message || error).slice(0, 240) };
  }
}

async function checkExplicitScheduledWork({
  deadlineAt = Date.now() + HOURLY_FALLBACK_RUNTIME_BUDGET_MS,
  privateResult = null,
} = {}) {
  const now = new Date();
  const internalDue = loadTasks().filter(task => isTaskEligibleNow(task, now)
    && (!task.assignee || /\bnora\b/i.test(task.assignee)));
  const result = {
    checked_at: now.toISOString(),
    mode: 'explicit_work_only',
    internal_queue: { due_count: internalDue.length },
    slack: { status: process.env.SLACK_BOT_TOKEN ? 'not_checked' : 'not_configured',
      unhandled_count: null },
  };
  if (!process.env.SLACK_BOT_TOKEN) return result;
  try {
    const slackBudgetMs = hourlyFallbackBudget(
      deadlineAt, 16000, 'Missed explicit Slack request check', 5000);
    const slack = await localRuntimeApi('get',
      '/slack/unhandled-mentions?minutes=120', undefined, slackBudgetMs);
    if (privateResult && typeof privateResult === 'object' && slack.unhandled?.length) {
      const candidate = slack.unhandled[0];
      privateResult.slack_candidate = {
        channel: String(candidate.channel || '').slice(0, 160),
        is_private: candidate.is_private === true,
        ts: String(candidate.ts || '').slice(0, 80),
        thread_ts: candidate.thread_ts ? String(candidate.thread_ts).slice(0, 80) : null,
        user: String(candidate.user || '').slice(0, 160),
        text: String(candidate.text || '').slice(0, 4000),
      };
    }
    result.slack = {
      status: slack.scope_warnings?.length || slack.scan_errors ? 'partial' : 'checked',
      unhandled_count: Number(slack.unhandled_count) || 0,
      channels_scanned: Number(slack.channels_scanned) || 0,
      channels_total: Number(slack.channels_total) || 0,
      provider_recovered_threads: Number(slack.provider_recovered_threads) || 0,
      scope_warning_count: slack.scope_warnings?.length || 0,
      scan_errors: Number(slack.scan_errors) || 0,
    };
  } catch (error) {
    result.slack = {
      status: 'degraded', unhandled_count: null,
      error: String(error.message || error).slice(0, 240),
    };
  }
  return result;
}
async function runHourlyFallbackRuntime({ trigger = 'scheduler' } = {}) {
  const primaryHealth = hourlyLifecycleHealth(operationStore.list('cycles'));
  const durableLock = loadDurableRunLock();
  const decision = hourlyFallbackDecision({
    cycles: operationStore.list('cycles'), primaryHealth,
    lock: durableLock && Number(durableLock.expires_at) > Date.now()
      ? { locked: true, holder: durableLock.holder } : { locked: false },
    interactive: interactivePerformance.prioritySnapshot(),
    admission: processResources.backgroundAdmission(),
    inFlight: _hourlyFallbackInFlight,
  });
  if (!decision.due) return decision;
  if (!process.env.NORA_API_KEY) return { ...decision, due: false, reason: 'api_key_unavailable' };
  _hourlyFallbackInFlight = true;
  const holder = `fallback-run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let cycleId = null;
  let lockAcquired = false;
  const deadlineAt = Date.now() + HOURLY_FALLBACK_RUNTIME_BUDGET_MS;
  const activity = runtimeActivity.begin({
    lane: 'work', kind: 'scheduled_task_recovery',
    label: 'Checking explicit scheduled work',
    detail: 'The primary scheduler is late; Railway may recover one direct Slack request or execute one due local task.',
    source: 'railway-fallback', meta: { trigger, primary_state: primaryHealth.state },
  });
  const startedAt = Date.now();
  try {
    const acquireBudgetMs = hourlyFallbackBudget(
      deadlineAt, 10000, 'Fallback run-lock acquisition', 45000);
    const acquired = await localRuntimeApi('post', '/run-lock', {
      holder, ttl_seconds: 300,
    }, acquireBudgetMs);
    if (!acquired.acquired) {
      runtimeActivity.finish(activity.id, { status: 'deferred',
        detail: 'Another scheduled run acquired the lock first.',
        outcome: 'No duplicate fallback work was started.' });
      return { ...decision, due: false, reason: acquired.reason || 'lock_not_acquired' };
    }
    lockAcquired = true;
    cycleId = acquired.lifecycle?.cycle_id || null;
    const privateSweep = {};
    const check = await checkExplicitScheduledWork({ deadlineAt, privateResult: privateSweep });
    check.slack_recovery = await recoverUnhandledSlackMention(
      privateSweep.slack_candidate, { deadlineAt });
    const attemptMarkers = loadMarkers();
    const taskLaneAvailable = ['not_due', 'already_handled', 'invalid']
      .includes(check.slack_recovery.status);
    const eligibleTask = taskLaneAvailable
      ? loadTasks().find(task => nativeTaskReady(task, attemptMarkers, Date.now())) || null
      : null;
    check.task_execution = await runNativeHourlyTask(eligibleTask, { deadlineAt });
    if (eligibleTask) {
      check.task_execution.retry = await recordNativeTaskAttempt(
        eligibleTask, check.task_execution);
    }
    const summary = [
      `Railway checked ${check.internal_queue.due_count} explicit due local task(s)`,
      `Slack request recovery ${check.slack_recovery.status}`,
      `local task execution ${check.task_execution.status}${check.task_execution.task_id
        ? ` (${check.task_execution.task_id})` : ''}`,
    ].join('; ') + '.';
    const releaseBudgetMs = hourlyFallbackBudget(
      deadlineAt, 10000, 'Fallback run-lock release');
    await localRuntimeApi('delete', `/run-lock?holder=${encodeURIComponent(holder)}`,
      undefined, releaseBudgetMs);
    lockAcquired = false;
    _hourlyFallbackLast = {
      status: 'completed', trigger, holder, cycle_id: cycleId,
      started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt, check,
    };
    runtimeActivity.finish(activity.id, { status: 'completed',
      detail: summary,
      outcome: 'Only explicit requested or scheduled work was considered.',
      meta: { cycle_id: cycleId, mode: 'explicit_work_only' } });
    return { ...decision, ran: true, ..._hourlyFallbackLast };
  } catch (error) {
    console.error(`Railway hourly fallback failed: ${error.message}`);
    if (lockAcquired) {
      try {
        await localRuntimeApi('delete',
          `/run-lock?holder=${encodeURIComponent(holder)}&status=failed`, undefined, 10000);
        lockAcquired = false;
      } catch (releaseError) {
        console.error(`Railway fallback lock cleanup failed: ${releaseError.message}`);
      }
    }
    _hourlyFallbackLast = {
      status: 'failed', trigger, holder, cycle_id: cycleId,
      started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      error: String(error.message || error).slice(0, 500),
    };
    runtimeActivity.finish(activity.id, { status: 'failed',
      detail: 'The bounded fallback stopped without performing external writes.',
      outcome: 'Failure recorded; the shared lock was released or left to expire safely.' });
    return { ...decision, ran: true, ..._hourlyFallbackLast };
  } finally {
    _hourlyFallbackInFlight = false;
  }
}

registerRuntimeActivityRoutes(app, {
  requireAuth,
  requireDashboardAuth,
  stream: runtimeActivity,
  getRunLock: loadDurableRunLock,
  getContextSnapshot: () => ({
    hourly_lifecycle: hourlyLifecycleHealth(operationStore.list('cycles')),
    hourly_fallback: { in_flight: _hourlyFallbackInFlight, last: _hourlyFallbackLast },
  }),
});

// POST /admin/drive/upload-artifact
// Raw, bounded binary upload for artifacts Nora creates during unattended work. The
// request commitment is also written into Drive appProperties, so a retry can recover
// a provider success that happened just before a worker or server interruption.
app.post('/admin/drive/upload-artifact', requireAuth,
  express.raw({ type: 'application/octet-stream', limit: driveArtifactUpload.MAX_ARTIFACT_BYTES }),
  async (req, res) => {
    let prepared;
    try {
      prepared = driveArtifactUpload.prepareArtifactRequest({
        bytes: req.body,
        idempotencyKey: req.get('Idempotency-Key'),
        filename: req.get('X-Nora-Filename'),
        parentFolderId: req.get('X-Nora-Drive-Folder-Id'),
        mimetype: req.get('X-Nora-Mimetype'),
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      const result = await serializeDriveArtifactUpload(async () => {
        let ledger = loadDriveArtifactUploads();
        let record = ledger.records.find(item => item.idempotency_key === prepared.idempotency_key);
        const priorState = record?.state || null;
        if (record && record.request_commitment !== prepared.request_commitment) {
          return { status: 409, body: { error: 'idempotency key is already bound to different artifact bytes or destination' } };
        }
        if (record?.state === 'completed') {
          const audit = driveArtifactUpload.auditReceipt(record.receipt);
          if (!audit.valid) {
            return { status: 500, body: { error: `stored upload receipt failed integrity: ${audit.reason}` } };
          }
          return { status: 200, body: { ok: true, replayed: true, file: record.receipt.file, receipt: record.receipt } };
        }

        const now = new Date().toISOString();
        if (!record) {
          record = {
            idempotency_key: prepared.idempotency_key,
            request: prepared.request,
            request_commitment: prepared.request_commitment,
            state: 'pending',
            attempts: 1,
            created_at: now,
            updated_at: now,
          };
          ledger = { ...ledger, records: [...ledger.records, record] };
          await saveDriveArtifactUploads(ledger);
        } else if (record.state === 'retryable') {
          record = { ...record, state: 'pending', attempts: Number(record.attempts || 0) + 1,
            updated_at: now, last_error: null };
          ledger = { ...ledger, records: ledger.records.map(item =>
            item.idempotency_key === record.idempotency_key ? record : item) };
          await saveDriveArtifactUploads(ledger);
        }

        let existing;
        try {
          existing = await driveFindArtifactByCommitment({
            requestCommitment: prepared.request_commitment,
            parentId: prepared.request.parent_folder_id,
          });
        } catch (error) {
          const detail = error.response?.data || error.message;
          record = { ...record, state: 'retryable', last_error: detail, updated_at: new Date().toISOString() };
          await saveDriveArtifactUploads({ ...ledger, records: ledger.records.map(item =>
            item.idempotency_key === record.idempotency_key ? record : item) });
          throw error;
        }

        // A pending record can only survive a process interruption. If Drive has no
        // committed file for it, do not silently create a possible duplicate.
        if (!existing && priorState === 'pending') {
          return { status: 409, body: { error: 'prior upload outcome is unresolved; no duplicate was created',
            idempotency_key: prepared.idempotency_key, request_commitment: prepared.request_commitment } };
        }

        let driveFile = existing;
        if (!driveFile) {
          try {
            driveFile = await driveMultipartUpload({
              bytes: req.body,
              name: prepared.request.filename,
              parentId: prepared.request.parent_folder_id,
              mimetype: prepared.request.mimetype,
              requestCommitment: prepared.request_commitment,
            });
          } catch (error) {
            const detail = error.response?.data || error.message;
            record = { ...record, state: 'retryable', last_error: detail, updated_at: new Date().toISOString() };
            await saveDriveArtifactUploads({ ...ledger, records: ledger.records.map(item =>
              item.idempotency_key === record.idempotency_key ? record : item) });
            throw error;
          }
        }

        const receipt = driveArtifactUpload.createReceipt(prepared, driveFile,
          { recovered: Boolean(existing) });
        record = { ...record, state: 'completed', receipt, updated_at: receipt.completed_at };
        await saveDriveArtifactUploads({ ...ledger, records: ledger.records.map(item =>
          item.idempotency_key === record.idempotency_key ? record : item) });
        return { status: 200, body: { ok: true, replayed: Boolean(existing), file: receipt.file, receipt } };
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error('Drive artifact upload failed:', detail);
      return res.status(error.response?.status || 503).json({ error: detail });
    }
  });

app.get('/admin/drive/upload-artifact-status', requireAuth, (req, res) => {
  let key;
  try {
    key = driveArtifactUpload.validateIdempotencyKey(req.query.idempotency_key);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const record = loadDriveArtifactUploads().records.find(item => item.idempotency_key === key);
    if (!record) return res.status(404).json({ error: 'upload record not found' });
    const audit = record.receipt ? driveArtifactUpload.auditReceipt(record.receipt) : null;
    return res.json({ ...record, receipt_audit: audit });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Cancel/remove a Recall bot regardless of state. leave_call is for bots already in
// flight (status ready/joining/in_call); scheduled-but-not-started bots return
// 'cannot_command_unstarted_bot' on leave_call and need a DELETE on the bot record.
// Try leave_call first, fall back to DELETE if that error fires.
async function cancelRecallBot(botId) {
  const authHeader = { Authorization: `Token ${process.env.RECALL_API_KEY}` };
  try {
    await axios.post(`${RECALL_BASE}/bot/${botId}/leave_call/`, {}, {
      headers: authHeader, timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
    return { method: 'leave_call' };
  } catch (err) {
    if (err.response?.status === 404) return { method: 'already_absent' };
    const code = err.response?.data?.code;
    const isUnstarted = code === 'cannot_command_unstarted_bot';
    if (!isUnstarted) throw err;
    // Bot hasn't started yet — DELETE removes the scheduled record entirely.
    try {
      await axios.delete(`${RECALL_BASE}/bot/${botId}/`, {
        headers: authHeader, timeout: RECALL_CONTROL_TIMEOUT_MS,
      });
    } catch (deleteError) {
      if (deleteError.response?.status === 404) return { method: 'already_absent' };
      throw deleteError;
    }
    return { method: 'delete' };
  }
}

// Recall's bot list/get endpoints sometimes return meeting_url as a plain string and
// sometimes as a structured object (Zoom in particular: { meeting_id, meeting_password,
// platform }). The dashboard needs a string to display and our duplicate-detection
// needs a stable key to group on. Normalize to a string here.
function normalizeMeetingUrl(mu) {
  if (mu == null) return null;
  if (typeof mu === 'string') return mu;
  if (typeof mu === 'object') {
    if (typeof mu.link === 'string') return mu.link;
    if (typeof mu.url === 'string') return mu.url;
    if (typeof mu.meeting_url === 'string') return mu.meeting_url;
    const platform = mu.platform || 'meeting';
    if (typeof mu.meeting_id === 'string' || typeof mu.meeting_id === 'number') {
      return `${platform}:${mu.meeting_id}`;
    }
    // Last resort — at least it won't render as "[object Object]"
    try { return JSON.stringify(mu); } catch { return String(mu); }
  }
  return String(mu);
}

// ── Live MCP connections (UI-managed) ───────────────────────────────────────
// CRUD, OAuth, and connection testing for live MCP servers. Secrets and raw endpoints never
// return to the browser; GET exposes only a redacted URL hint, status, and cached tool catalog.
app.get('/admin/mcp', requireAuth, (req, res) => {
  try { res.json({ connections: mcpManager.list() }); }
  catch (error) { res.status(500).json({ error: `MCP credential store is unavailable: ${error.message}` }); }
});
app.post('/admin/mcp', requireAuth, requireOperatorAuth, async (req, res) => {
  try {
    const connection = await mcpManager.create(req.body || {});
    console.log(`🔌 MCP connection added: ${connection.name} (${connection.auth_type})`);
    res.json({ ok: true, connection });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/admin/mcp/:id', requireAuth, requireOperatorAuth, async (req, res) => {
  try {
    const connection = await mcpManager.update(req.params.id, req.body || {});
    if (!connection) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, connection });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/admin/mcp/:id', requireAuth, requireOperatorAuth, async (req, res) => {
  const removed = await mcpManager.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  console.log(`🔌 MCP connection removed: ${removed.name}`);
  res.json({ ok: true });
});
app.post('/admin/mcp/:id/test', requireAuth, requireOperatorAuth, async (req, res) => {
  try { res.json({ ok: true, connection: await mcpManager.testConnection(req.params.id) }); }
  catch (error) { res.status(400).json({ error: error.message, connection: mcpManager.list().find(item => item.id === req.params.id) || null }); }
});
app.post('/admin/mcp/:id/oauth/start', requireAuth, requireOperatorAuth, async (req, res) => {
  try {
    const callbackBase = (process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` || `https://${req.get('host')}`).replace(/\/$/, '');
    const callbackUrl = `${callbackBase}/admin/mcp/oauth/callback`;
    res.json({ ok: true, authorize_url: await mcpManager.startOAuth(req.params.id, callbackUrl) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/admin/mcp/oauth/callback', async (req, res) => {
  if (req.query.error) return res.redirect(`/?mcp_error=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
  if (!req.query.state || !req.query.code) return res.status(400).send('Missing OAuth state or code');
  try {
    const id = await mcpManager.finishOAuth({ state: String(req.query.state), code: String(req.query.code) });
    try { await mcpManager.testConnection(id); } catch {}
    res.redirect('/?mcp_connected=1');
  } catch (error) { res.redirect(`/?mcp_error=${encodeURIComponent(error.message)}`); }
});

// List bots that are currently active (ready, joining, or in a call). Used by the
// Admin UI to show what meetings Nora is in / on her way to, with a kick button.
app.get('/admin/active-bots', requireAuth, async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const s of ['ready', 'joining_call', 'in_call_not_recording', 'in_call_recording']) {
      params.append('status', s);
    }
    const r = await axios.get(`${RECALL_BASE}/bot/?${params.toString()}`, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
      timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
    // Recall paginates; for our scale the first page is more than enough. Slim the
    // shape down to what the UI actually needs.
    const raw = Array.isArray(r.data?.results) ? r.data.results : Array.isArray(r.data) ? r.data : [];
    const bots = raw.map(b => {
      const latest = Array.isArray(b.status_changes) && b.status_changes.length
        ? b.status_changes[b.status_changes.length - 1]
        : null;
      return {
        id: b.id,
        bot_name: b.bot_name || 'Nora',
        meeting_url: normalizeMeetingUrl(b.meeting_url),
        status: latest?.code || b.status || 'unknown',
        status_at: latest?.created_at || null,
        join_at: b.join_at || null
      };
    });
    res.json({ count: bots.length, bots });
  } catch (err) {
    console.error('Active bots fetch failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Read-only production prompt accounting. It renders the current cached state without a
// provider call, trial enrollment, broadcast receipt, affordance receipt, or prompt content.
app.get('/admin/prompt-envelope', requireAuth, (req, res) => {
  const surface = 'slack';
  const meetingContext = { source: surface, requester: { name: 'Envelope diagnostic' } };
  const situationalAffordanceFrame = { surface, context_kind: 'diagnostic', capabilities: [], constraints: [] };
  const prompt = buildSystemPrompt(meetingContext, {
    cacheSplit: true,
    conversationText: String(req.query.query || 'current work status and priorities').slice(0, 500),
    contextTrialsEnabled: false,
    latencyCritical: true,
    sideEffectFree: true,
    exemplarsAvailable: surface === 'slack',
    diagnosticLocalExemplars: surface === 'slack',
    situationalAffordanceFrame,
  });
  const linkedContentReserve = surface === 'slack' ? 1650 : 0;
  const projectedLinkedTotal = prompt.diagnostics.total_chars + linkedContentReserve;
  res.json({ ...prompt.diagnostics, linked_content_reserve_chars: linkedContentReserve,
    projected_linked_total_chars: projectedLinkedTotal,
    projected_linked_within_budget: !prompt.diagnostics.budget_chars
      || projectedLinkedTotal <= prompt.diagnostics.budget_chars,
    content_returned: false, provider_called: false, persistent_state_mutated: false });
});

// List bots scheduled to join in the future. The calendar auto-join queue lives here
// — bots that Recall has queued for a future join_at but haven't fired yet. Useful for
// spotting duplicate schedules (two bots queued for the same meeting) BEFORE they
// both fire, so you can remove one with the existing /admin/bots/:id/leave path.
app.get('/admin/scheduled-bots', requireAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    // 60 days is generous — covers any realistic recurring-meeting horizon while
    // keeping the response from including stale scheduled bots that never fired.
    const horizonIso = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams();
    params.append('join_at_after', nowIso);
    params.append('join_at_before', horizonIso);

    const r = await axios.get(`${RECALL_BASE}/bot/?${params.toString()}`, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
      timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
    const raw = Array.isArray(r.data?.results) ? r.data.results : Array.isArray(r.data) ? r.data : [];
    const bots = raw.map(b => {
      const latest = Array.isArray(b.status_changes) && b.status_changes.length
        ? b.status_changes[b.status_changes.length - 1] : null;
      return {
        id: b.id,
        bot_name: b.bot_name || 'Nora',
        meeting_url: normalizeMeetingUrl(b.meeting_url),
        status: latest?.code || b.status || 'scheduled',
        join_at: b.join_at || null
      };
    });
    // Sort by join_at ascending — soonest first.
    bots.sort((a, b) => (a.join_at || '').localeCompare(b.join_at || ''));

    // Flag duplicates: bots with the same meeting_url that fire within an hour of each
    // other. Same meeting + close in time = the schedule glitch the user wants to spot.
    const groups = {};
    for (const b of bots) {
      if (!b.meeting_url) continue;
      const key = b.meeting_url;
      groups[key] = groups[key] || [];
      groups[key].push(b);
    }
    const duplicateBotIds = new Set();
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const t1 = new Date(list[i].join_at || 0).getTime();
          const t2 = new Date(list[j].join_at || 0).getTime();
          if (Math.abs(t1 - t2) <= 60 * 60 * 1000) {
            duplicateBotIds.add(list[i].id);
            duplicateBotIds.add(list[j].id);
          }
        }
      }
    }
    for (const b of bots) {
      b.is_duplicate = duplicateBotIds.has(b.id);
    }
    res.json({ count: bots.length, bots, duplicate_count: duplicateBotIds.size });
  } catch (err) {
    console.error('Scheduled bots fetch failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Bulk-remove duplicate scheduled bots. Re-fetches the scheduled list, groups by
// meeting_url, walks each group's bots in join_at order, and for any sub-cluster of
// bots whose join_at values are within an hour of each other keeps the earliest and
// calls leave_call on the rest. Idempotent in practice — running it twice in a row
// returns 0 removed the second time.
app.post('/admin/scheduled-bots/dedupe', requireAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const horizonIso = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams();
    params.append('join_at_after', nowIso);
    params.append('join_at_before', horizonIso);

    const listRes = await axios.get(`${RECALL_BASE}/bot/?${params.toString()}`, {
      headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` },
      timeout: RECALL_CONTROL_TIMEOUT_MS,
    });
    const raw = Array.isArray(listRes.data?.results) ? listRes.data.results : Array.isArray(listRes.data) ? listRes.data : [];
    const bots = raw
      .map(b => ({ id: b.id, meeting_url: normalizeMeetingUrl(b.meeting_url), join_at: b.join_at || null }))
      .filter(b => b.meeting_url && b.join_at);

    // Group by meeting_url, then walk each group looking for within-hour clusters.
    const groups = {};
    for (const b of bots) {
      groups[b.meeting_url] = groups[b.meeting_url] || [];
      groups[b.meeting_url].push(b);
    }
    const toRemove = [];
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue;
      list.sort((a, b) => {
        const cmp = (a.join_at || '').localeCompare(b.join_at || '');
        return cmp !== 0 ? cmp : (a.id || '').localeCompare(b.id || '');
      });
      let cluster = [list[0]];
      const flushCluster = () => {
        if (cluster.length > 1) toRemove.push(...cluster.slice(1).map(b => b.id));
      };
      for (let i = 1; i < list.length; i++) {
        const dt = new Date(list[i].join_at).getTime() - new Date(cluster[cluster.length - 1].join_at).getTime();
        if (dt <= 60 * 60 * 1000) {
          cluster.push(list[i]);
        } else {
          flushCluster();
          cluster = [list[i]];
        }
      }
      flushCluster();
    }

    if (toRemove.length === 0) {
      return res.json({ ok: true, removed: 0, removed_bot_ids: [], failed: [] });
    }

    // Series, not parallel — keeps the request rate civil to Recall and the failure
    // signal cleaner if anything goes sideways mid-batch.
    const removed = [];
    const failed = [];
    for (const botId of toRemove) {
      try {
        const { method } = await cancelRecallBot(botId);
        removed.push(botId);
        if (method === 'delete') console.log(`👥 Dedupe: deleted unstarted bot ${botId}`);
      } catch (err) {
        failed.push({ id: botId, error: err.response?.data || err.message });
      }
    }
    console.log(`👥 Scheduled-bot dedupe: removed ${removed.length}/${toRemove.length} (failed ${failed.length})`);
    res.json({ ok: true, removed: removed.length, removed_bot_ids: removed, failed });
  } catch (err) {
    console.error('Scheduled-bot dedupe failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Remove a Recall bot — works for both in-flight (leave_call) and scheduled
// (DELETE) bots. The cancelRecallBot helper handles the fallback automatically.
app.post('/admin/bots/:id/leave', requireAuth, async (req, res) => {
  const botId = req.params.id;
  try {
    const { method } = await cancelRecallBot(botId);
    console.log(`👋 Admin removed bot ${botId} via ${method}`);
    delete sessions[botId];
    res.json({ ok: true, method });
  } catch (err) {
    console.error(`Bot cancel failed for ${botId}:`, err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Teamwork: update a task's workflow stage by task ID and stage name
// List Slack channels Nora's bot is a member of. Uses the bot token to call
// users.conversations on Slack — that's the only auth identity that returns *bot*
// memberships rather than the caller's. Public + private channels; one page (200)
// is plenty for typical workspaces, but surface the next_cursor if there's more.
app.get('/admin/slack/bot-channels', requireAuth, async (req, res) => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' });
  try {
    const r = await axios.get('https://slack.com/api/users.conversations', {
      headers: { Authorization: `Bearer ${token}` },
      params: { types: 'public_channel,private_channel', limit: 200, exclude_archived: true },
      timeout: SLACK_CONTROL_TIMEOUT_MS,
    });
    if (!r.data?.ok) return res.status(502).json({ error: r.data?.error || 'slack api error' });
    const channels = (r.data.channels || []).map(c => ({
      id: c.id,
      name: c.name,
      is_private: !!c.is_private,
      is_archived: !!c.is_archived,
      num_members: c.num_members ?? null,
      topic: c.topic?.value || null
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      count: channels.length,
      channels,
      next_cursor: r.data.response_metadata?.next_cursor || null
    });
  } catch (err) {
    console.error('Bot channels fetch failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Team capacity lookup for an explicit request. Same logic as the teamwork_team_capacity tool.
// Query: start, end (YYYY-MM-DD),
// optional min_free (hours), optional user_ids (comma list).
app.get('/teamwork/team-capacity', requireAuth, async (req, res) => {
  if (!teamworkEnabled()) return res.status(500).json({ error: 'TEAMWORK_API_KEY and TEAMWORK_BASE_URL must be set' });
  const { start, end, min_free, user_ids } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) are required' });
  try {
    const out = await teamworkTeamCapacity({ start_date: start, end_date: end, min_free_hours: min_free, user_ids });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.message || e.message || 'teamwork workload fetch failed' });
  }
});

const teamworkTaskProjectCache = new Map();
const teamworkProjectStageCache = new Map();
async function cachedConnectorValue(cache, key, ttlMs, load) {
  const now = Date.now();
  const prior = cache.get(key);
  if (prior?.value && prior.expires_at > now) return prior.value;
  if (prior?.in_flight) return prior.in_flight;
  const inFlight = Promise.resolve().then(load).then(value => {
    cache.set(key, { value, expires_at: Date.now() + ttlMs, in_flight: null });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  }).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { value: prior?.value || null, expires_at: prior?.expires_at || 0, in_flight: inFlight });
  return inFlight;
}

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
    const projectId = await cachedConnectorValue(teamworkTaskProjectCache, String(taskId),
      15 * 60 * 1000, async () => {
        const taskRes = await axios.get(`${twBase}/tasks/${taskId}.json`, { headers: twHeaders,
          timeout: 8000 });
        const taskData = taskRes.data;
        const todoItem = taskData?.['todo-item'] || taskData?.task;
        return todoItem?.['project-id'] || todoItem?.project?.id || todoItem?.projectId || null;
      });
    if (!projectId) return res.status(404).json({ error: 'could not determine project for task' });

    // 2. Workflow topology is shared by every task in a project and changes rarely. Cache it,
    // single-flight concurrent misses, and fetch the workflows' stage lists in parallel.
    const stageDirectory = await cachedConnectorValue(teamworkProjectStageCache, String(projectId),
      15 * 60 * 1000, async () => {
        const wfRes = await axios.get(`${twBase}/projects/api/v3/projects/${projectId}/workflows.json`,
          { headers: twHeaders, timeout: 8000 });
        const workflows = wfRes.data?.workflows || [];
        const stageLists = await Promise.all(workflows.map(async wf => {
          const stagesRes = await axios.get(`${twBase}/projects/api/v3/workflows/${wf.id}/stages.json`,
            { headers: twHeaders, timeout: 8000 });
          return (stagesRes.data?.stages || []).map(item => ({ workflowId: wf.id, stageId: item.id,
            name: String(item.name || '') }));
        }));
        return Object.fromEntries(stageLists.flat().filter(item => item.name)
          .map(item => [item.name.toLowerCase(), item]));
      });
    const target = stageDirectory[String(stage).toLowerCase()] || null;
    if (!target) return res.status(404).json({ error: `stage "${stage}" not found in any workflow for this project` });

    // 4. Move the task to the target stage
    await axios.post(
      `${twBase}/projects/api/v3/workflows/${target.workflowId}/stages/${target.stageId}/tasks.json`,
      { taskIds: [parseInt(taskId, 10)] },
      { headers: twHeaders, timeout: 8000 }
    );

    console.log(`✅ Teamwork task ${taskId} moved to stage "${stage}"`);
    res.json({ ok: true, taskId, stage, workflowId: target.workflowId, stageId: target.stageId });
  } catch (err) {
    console.error('Teamwork stage update error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ── Transcript persistence: Postgres when _dbReady, else JSON file on the volume ──
// The old per-utterance full-file rewrite (worst fit for flat files) becomes a serialized
// upsert of the transcript jsonb. Reads/edits go through these helpers so both modes work.
const _transcriptCheckpointTimers = new Map();
const _transcriptCheckpointPending = new Map();
const _transcriptCheckpointInFlight = new Map();
const _transcriptCheckpointAttempts = new Map();
const _transcriptPersistedCounts = new Map();
// Checkpoints that gave up, kept inspectable instead of living only in a log line.
const _transcriptCheckpointStalled = new Map();
// Mirror a durable-side edit into the live session; transcript-checkpoint.js explains why.
function reconcileTranscriptSessionAfterEdit(botId, durableLength, mutate) {
  if (sessions[botId]?.transcript) mutate(sessions[botId].transcript);
  _transcriptPersistedCounts.set(botId, durableLength);
  _transcriptCheckpointStalled.delete(botId);
  _transcriptCheckpointAttempts.delete(botId);
}
let _transcriptCheckpointsClosing = false;
const ensureMeetingTranscriptHydrated = createMeetingTranscriptHydrator({
  getTranscript: getTranscriptDoc,
  persistedCounts: _transcriptPersistedCounts,
});

function armTranscriptCheckpoint(botId, delayMs = 1000) {
  if (_transcriptCheckpointsClosing || _transcriptCheckpointTimers.has(botId)
    || _transcriptCheckpointInFlight.has(botId) || _transcriptCheckpointStalled.has(botId)
    || !_transcriptCheckpointPending.has(botId)) return;
  const timer = setTimeout(() => {
    _transcriptCheckpointTimers.delete(botId);
    if (_transcriptCheckpointInFlight.has(botId)) return;
    const pending = _transcriptCheckpointPending.get(botId);
    _transcriptCheckpointPending.delete(botId);
    if (!pending) return;
    const operation = saveTranscriptDoc(botId, pending.transcript, pending.ended, {
      incremental: true,
    }).then(() => {
      _transcriptCheckpointAttempts.delete(botId);
      _transcriptCheckpointStalled.delete(botId);
      if (pending.ended) {
        // Cache freshness is separately owned and bounded during shutdown. It must never extend
        // the critical transcript-durability checkpoint.
        refreshRecentMeetingsCache().catch(() => {});
      }
      const newer = _transcriptCheckpointPending.get(botId);
      if (pending.ended && newer && !newer.ended) {
        _transcriptCheckpointPending.set(botId, { ...newer, ended: pending.ended });
      }
      if (pending.ended && !newer && sessions[botId]?.cleanupAfterTranscriptSave) {
        delete sessions[botId];
        _transcriptPersistedCounts.delete(botId);
      }
    }).catch(error => {
      const attempt = (_transcriptCheckpointAttempts.get(botId) || 0) + 1;
      _transcriptCheckpointAttempts.set(botId, attempt);
      const plan = checkpointRetryPlan(attempt, error);
      const newer = _transcriptCheckpointPending.get(botId);
      if (plan.retry) {
        console.error(`Transcript checkpoint failed (retry ${attempt}):`, error.message);
        _transcriptCheckpointPending.set(botId, {
          transcript: sessions[botId]?.transcript || newer?.transcript || pending.transcript,
          ended: newer?.ended || pending.ended || null,
        });
      } else {
        // Stop the loop and say it once: retrying this cannot converge.
        _transcriptCheckpointPending.delete(botId);
        const report = abandonedCheckpointReport({ botId, attempt, error, plan,
          inMemoryUtterances: sessions[botId]?.transcript?.length ?? null });
        _transcriptCheckpointStalled.set(botId, report.record);
        console.error(report.message);
      }
      throw error;
    }).finally(() => {
      if (_transcriptCheckpointInFlight.get(botId) === operation) {
        _transcriptCheckpointInFlight.delete(botId);
      }
      if (_transcriptCheckpointPending.has(botId) && !_transcriptCheckpointsClosing) {
        const attempt = _transcriptCheckpointAttempts.get(botId) || 0;
        armTranscriptCheckpoint(botId, attempt ? retryDelayMs(attempt) : 1000);
      }
    });
    _transcriptCheckpointInFlight.set(botId, operation);
    // The in-flight map owns this rejection for retry/drain purposes.
    operation.catch(() => {});
  }, Math.max(1, Number(delayMs) || 1000));
  timer.unref?.();
  _transcriptCheckpointTimers.set(botId, timer);
}

function queueTranscriptCheckpoint(botId, transcript, { ended = null, delayMs = 1000 } = {}) {
  if (_transcriptCheckpointStalled.has(botId)) return false;
  const prior = _transcriptCheckpointPending.get(botId);
  _transcriptCheckpointPending.set(botId, {
    transcript,
    ended: ended || prior?.ended || null,
  });
  armTranscriptCheckpoint(botId, delayMs);
  return true;
}

function scheduleTranscriptCheckpoint(botId, transcript) {
  queueTranscriptCheckpoint(botId, transcript);
}
async function saveTranscriptDoc(botId, transcript, ended, { incremental = false } = {}) {
  if (ended) {
    const timer = _transcriptCheckpointTimers.get(botId);
    if (timer) clearTimeout(timer);
    _transcriptCheckpointTimers.delete(botId);
    _transcriptCheckpointPending.delete(botId);
  }
  const session = sessions[botId] || { transcript: Array.isArray(transcript) ? transcript : [] };
  if (incremental) await ensureMeetingTranscriptHydrated(botId, session);
  if (_dbReady) {
    return _writeThrough('transcript:' + botId, () => incremental
      ? appendLiveTranscript({ botId, session, transcript, ended, db,
        persistedCounts: _transcriptPersistedCounts, transcriptStartsWith,
        hydrate: ensureMeetingTranscriptHydrated })
      : db.upsertTranscript(botId, ended || null, transcript || []), { strict: true });
  }
  const durableTranscript = incremental ? session.transcript : (transcript || []);
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : LOCAL_DATA_DIR;
  try { fs.writeFileSync(path.join(dir, `transcript-${botId}.json`), JSON.stringify({ bot_id: botId, ended: ended || null, transcript: durableTranscript }, null, 2)); }
  catch (e) { console.warn('transcript write failed:', e.message); }
}

async function drainTranscriptCheckpoints() {
  _transcriptCheckpointsClosing = true;
  while (true) {
    for (const timer of _transcriptCheckpointTimers.values()) clearTimeout(timer);
    _transcriptCheckpointTimers.clear();
    const active = [..._transcriptCheckpointInFlight.values()];
    if (active.length) await Promise.allSettled(active);
    const rawPending = [..._transcriptCheckpointPending.entries()];
    _transcriptCheckpointPending.clear();
    for (const [botId, pending] of rawPending) {
      await saveTranscriptDoc(botId, pending.transcript, pending.ended, {
        incremental: true,
      });
    }
    if (_transcriptCheckpointInFlight.size === 0
      && _transcriptCheckpointPending.size === 0) break;
  }
}

async function getTranscriptDoc(botId) {
  if (_dbReady) {
    const r = await db.getTranscript(botId);
    return r ? { bot_id: r.bot_id, ended: r.ended, transcript: r.transcript || [] } : null;
  }
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : LOCAL_DATA_DIR;
  const fp = path.join(dir, `transcript-${botId}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
// Both storage paths go through describeTranscript so they agree on liveness; see the module.
async function listTranscriptDocs() {
  if (_dbReady) {
    const rows = await db.listTranscripts();
    return rows.map(r => describeTranscript({ bot_id: r.bot_id, ended: r.ended,
      last_utterance_at: r.last_utterance_at || null,
      url: `/transcripts/${r.bot_id}`, utterance_count: r.utterance_count }));
  }
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : LOCAL_DATA_DIR;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('transcript-') && f.endsWith('.json')); } catch { return []; }
  return files.map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const lastUtterance = d.transcript?.at(-1);
      return describeTranscript({ bot_id: d.bot_id, ended: d.ended || null,
        last_utterance_at: lastUtterance?.timestamp || lastUtterance?.time || null,
        file: f, url: `/transcripts/${d.bot_id}`,
        utterance_count: d.transcript ? d.transcript.length : 0 });
    } catch { return null; }
  }).filter(Boolean);
}
async function deleteTranscriptDoc(botId) {
  if (_dbReady) return db.deleteTranscript(botId);
  const dir = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : LOCAL_DATA_DIR;
  const fp = path.join(dir, `transcript-${botId}.json`);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

// ── Meeting self-awareness ──────────────────────────────────────────────────
// Her transcripts hold every meeting she's attended, but nothing bridged them into her live
// conversational awareness: asked "you were on some meetings yesterday?", she checked her
// activity log (marker notes), found nothing, and flatly denied attending calls she had filed
// transcripts for the same day. This cache summarizes the last 7 days of transcripts (who was
// there, when, whether it was filed) for injection into every prompt, refreshed on boot, on a
// timer, and when a meeting ends. buildSystemPrompt is sync, hence a cache and not a query.
let _recentMeetingsCache = [];
let _recentMeetingsRefreshInFlight = null;
const RECENT_MEETINGS_READ_CONCURRENCY = 3;
const _recentMeetingsRefreshHealth = {
  requested: 0, coalesced: 0, completed: 0, failures: 0, consecutive_failures: 0,
  last_started_at: null, last_completed_at: null, last_error: null, last_error_at: null,
};
async function mapWithBoundedConcurrency(items, concurrency, mapper) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(values.length,
    Math.max(1, Number(concurrency) || 1)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(item => item.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}
function refreshRecentMeetingsCache() {
  _recentMeetingsRefreshHealth.requested += 1;
  if (_recentMeetingsRefreshInFlight) {
    _recentMeetingsRefreshHealth.coalesced += 1;
    return _recentMeetingsRefreshInFlight;
  }
  if (_dbReady && typeof db.backgroundAllowed === 'function' && !db.backgroundAllowed()) {
    return Promise.resolve(false);
  }
  const startedAt = Date.now();
  _recentMeetingsRefreshHealth.last_started_at = new Date(startedAt).toISOString();
  const operation = (async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const list = (await listTranscriptDocs())
      .filter(t => !t.in_progress && t.ended && new Date(t.ended).getTime() >= cutoff)
      .slice(0, 12);
    const markers = loadMarkers();
    const out = await mapWithBoundedConcurrency(list, RECENT_MEETINGS_READ_CONCURRENCY, async r => {
      let speakers = [];
      try {
        const doc = await getTranscriptDoc(r.bot_id);
        if (doc) {
          speakers = [...new Set((doc.transcript || [])
            .map(u => u.speaker)
            .filter(s => s && !/^(Nora|Screen share|Participant)/i.test(s)))].slice(0, 6);
        }
      } catch { /* speakers stay empty; the row still counts */ }
      const filed = (markers[`filed-transcript:${r.bot_id}`]) || null;
      const skipped = (markers[`skipped-transcript:${r.bot_id}`]) || null;
      return {
        bot_id: r.bot_id,
        ended: r.ended,
        utterances: r.utterance_count,
        speakers,
        client: filed && filed.client ? filed.client : null,
        skipped: skipped ? (skipped.reason || 'skipped') : null
      };
    });
    _recentMeetingsCache = out;
    _recentMeetingsRefreshHealth.completed += 1;
    _recentMeetingsRefreshHealth.consecutive_failures = 0;
    _recentMeetingsRefreshHealth.last_completed_at = new Date().toISOString();
    _recentMeetingsRefreshHealth.last_error = null;
    _recentMeetingsRefreshHealth.last_error_at = null;
    return true;
  })().catch(error => {
    _recentMeetingsRefreshHealth.failures += 1;
    _recentMeetingsRefreshHealth.consecutive_failures += 1;
    _recentMeetingsRefreshHealth.last_error = String(error?.message || error).slice(0, 500);
    _recentMeetingsRefreshHealth.last_error_at = new Date().toISOString();
    console.warn('recent-meetings cache refresh failed:', error.message);
    throw error;
  }).finally(() => {
    if (_recentMeetingsRefreshInFlight === operation) _recentMeetingsRefreshInFlight = null;
  });
  _recentMeetingsRefreshInFlight = operation;
  return operation;
}
function recentMeetingsRefreshSnapshot(now = Date.now()) {
  const startedAt = _recentMeetingsRefreshInFlight
    ? new Date(_recentMeetingsRefreshHealth.last_started_at || 0).getTime() : 0;
  return {
    ..._recentMeetingsRefreshHealth,
    in_flight: Boolean(_recentMeetingsRefreshInFlight),
    active_ms: startedAt > 0 ? Math.max(0, Number(now) - startedAt) : 0,
    transcript_read_concurrency: RECENT_MEETINGS_READ_CONCURRENCY,
    cached_meetings: _recentMeetingsCache.length,
  };
}

const recallTranscriptRecovery = createRecallTranscriptRecoveryRuntime({
  get: axios.get, recallBase: RECALL_BASE, apiKey: process.env.RECALL_API_KEY,
  controlTimeoutMs: RECALL_CONTROL_TIMEOUT_MS,
  listTranscripts: listTranscriptDocs,
  getTranscript: getTranscriptDoc,
  saveTranscript: saveTranscriptDoc, sessions,
  checkpointStalled: _transcriptCheckpointStalled,
  checkpointAttempts: _transcriptCheckpointAttempts,
  persistedCounts: _transcriptPersistedCounts,
  refreshRecentMeetings: refreshRecentMeetingsCache,
  enqueuePostProcessing: () => {},
});

async function drainRecentMeetingsRefresh({ timeoutMs = 10000 } = {}) {
  const active = _recentMeetingsRefreshInFlight;
  if (!active) return true;
  let timer = null;
  const settled = await Promise.race([
    Promise.resolve(active).then(() => true, () => true),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 10000));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

// Live tools let Slack requests consult Nora's saved meeting record.
// Read-only; the adjacent flaw to the awareness gap: even knowing she attended, she couldn't
// say what was discussed without these.
const MEETING_TOOLS = [
  {
    definition: {
      name: 'nora_list_meetings',
      description: "List meetings Nora attended, from her saved transcripts, newest first. Use when someone asks about her meetings or calls ('you were on some meetings yesterday?'). Returns bot_id (for nora_read_transcript), when it ended, who spoke, and where it was filed.",
      input_schema: { type: 'object', properties: { days: { type: 'number', description: 'How many days back to look (default 14, max 60)' } } }
    },
    execute: async (args) => {
      const days = Math.min(Math.max(Number(args && args.days) || 14, 1), 60);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const list = (await listTranscriptDocs()).filter(t => !t.in_progress && t.ended && new Date(t.ended).getTime() >= cutoff).slice(0, 25);
      const markers = loadMarkers();
      const rows = [];
      for (const r of list) {
        let speakers = [];
        try {
          const doc = await getTranscriptDoc(r.bot_id);
          if (doc) speakers = [...new Set((doc.transcript || []).map(u => u.speaker).filter(s => s && !/^(Nora|Screen share|Participant)/i.test(s)))].slice(0, 8);
        } catch {}
        const filed = markers[`filed-transcript:${r.bot_id}`] || null;
        rows.push({ bot_id: r.bot_id, ended: r.ended, utterances: r.utterance_count, speakers, filed_for: filed && filed.client ? filed.client : null });
      }
      return { meetings: rows, note: rows.length ? undefined : `no transcripts in the last ${days} days` };
    }
  },
  {
    definition: {
      name: 'nora_read_transcript',
      description: "Read one of Nora's meeting transcripts by bot_id (get ids from nora_list_meetings). Optional search returns only matching lines with surrounding context. Use to answer what was discussed, decided, or promised in a meeting she attended.",
      input_schema: { type: 'object', properties: { bot_id: { type: 'string' }, search: { type: 'string', description: 'Optional term; returns matching lines with 2 lines of context' } }, required: ['bot_id'] }
    },
    execute: async (args) => {
      const doc = await getTranscriptDoc(String(args.bot_id || ''));
      if (!doc) return { error: 'no transcript with that bot_id' };
      const lines = (doc.transcript || []).map(u => `[${u.speaker}]: ${u.text}`);
      let out = lines;
      if (args.search && String(args.search).trim()) {
        const q = String(args.search).toLowerCase();
        const keep = new Set();
        lines.forEach((l, i) => { if (l.toLowerCase().includes(q)) { for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j); } });
        out = [...keep].sort((a, b) => a - b).map(i => lines[i]);
        if (!out.length) return { ended: doc.ended, total_lines: lines.length, note: 'no lines matched that search' };
      }
      const text = out.join('\n');
      return { ended: doc.ended, total_lines: lines.length, transcript: text.length > 14000 ? text.slice(0, 14000) + '\n[truncated]' : text };
    }
  }
];

// Transcript API — list and retrieve saved meeting transcripts
// ?status=ended is what the filing flow must use. Default stays "all" for existing callers.
app.get('/transcripts', requireAuth, async (req, res) => {
  try {
    const list = filterTranscriptsByStatus(await listTranscriptDocs(), req.query.status);
    res.json(sortTranscriptsNewestFirst(list));
  } catch { res.json([]); }
});

app.get('/transcripts/:botId', requireAuth, async (req, res) => {
  try {
    const data = await getTranscriptDoc(req.params.botId);
    if (!data) return res.status(404).json({ error: 'transcript not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/transcripts/:botId', requireAuth, async (req, res) => {
  try {
    const data = await getTranscriptDoc(req.params.botId);
    if (!data) return res.status(404).json({ error: 'transcript not found' });
    await deleteTranscriptDoc(req.params.botId);
    console.log('🗑️ Transcript deleted:', req.params.botId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/transcripts/:botId/utterances/:index', requireAuth, async (req, res) => {
  try {
    const data = await getTranscriptDoc(req.params.botId);
    if (!data) return res.status(404).json({ error: 'transcript not found' });
    const idx = parseInt(req.params.index);
    if (idx < 0 || idx >= data.transcript.length) return res.status(404).json({ error: 'utterance index out of range' });
    const { speaker, text } = req.body;
    if (speaker !== undefined) data.transcript[idx].speaker = speaker;
    if (text !== undefined) data.transcript[idx].text = text;
    await saveTranscriptDoc(req.params.botId, data.transcript, data.ended);
    reconcileTranscriptSessionAfterEdit(req.params.botId, data.transcript.length,
      session => applyUtteranceEditToSession(session, idx, { speaker, text }));
    console.log('✏️ Transcript utterance updated:', req.params.botId, 'index', idx);
    res.json({ ok: true, utterance: data.transcript[idx] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/transcripts/:botId/utterances/:index', requireAuth, async (req, res) => {
  try {
    const data = await getTranscriptDoc(req.params.botId);
    if (!data) return res.status(404).json({ error: 'transcript not found' });
    const idx = parseInt(req.params.index);
    if (idx < 0 || idx >= data.transcript.length) return res.status(404).json({ error: 'utterance index out of range' });
    const removed = data.transcript.splice(idx, 1);
    await saveTranscriptDoc(req.params.botId, data.transcript, data.ended);
    reconcileTranscriptSessionAfterEdit(req.params.botId, data.transcript.length,
      session => applyUtteranceDeleteToSession(session, idx));
    console.log('🗑️ Transcript utterance deleted:', req.params.botId, 'index', idx, removed[0].text.slice(0, 50));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function backfillTranscriptDates() {
  if (_dbReady) return;
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

// Runtime lifecycle is explicit so tests can import the exact Express app without opening a
// socket or starting background work. Running `node server.js` still starts everything exactly
// as before. NORA_DATA_DIR and background:false give tests isolated persistence and deterministic
// shutdown without changing production defaults.
let _startPromise = null;
const _runtimeIntervals = [];
const _startupBackgroundTasks = new Map();
const _startupBackgroundTaskFailures = [];
let _startupBackgroundTaskSequence = 0;
const _recurringJobs = createRecurringJobRegistry({
  onError: (name, error) =>
    console.warn(`Recurring runtime job ${name} failed:`, error.message),
  onNonCooperativeTimeout: (name, error) => {
    console.error(`Recurring runtime job ${name} remained stuck after cancellation; restarting cleanly`);
    _processRecovery.requestShutdown(`recurring_job_stuck:${name}`, { fatal: true, error });
  },
  onQuarantine: (name, error) => console.error(quarantineMessage(name, error)),
});
function scheduleRecurringRuntimeJob(name, intervalMs, work, options = {}) {
  const handle = _recurringJobs.register(name, intervalMs, work, options);
  _runtimeIntervals.push(handle);
  return handle;
}
function startupBackgroundTaskSnapshot(now = Date.now()) {
  const active = [..._startupBackgroundTasks.values()].map(task => ({
    label: task.label,
    started_at: new Date(task.started_at).toISOString(),
    age_ms: Math.max(0, Number(now) - task.started_at),
  }));
  return {
    active_count: active.length,
    active,
    recent_failures: _startupBackgroundTaskFailures.filter(item =>
      Number(now) - new Date(item.at).getTime() <= 15 * 60 * 1000),
  };
}
async function drainStartupBackgroundTasks({ timeoutMs = 10000 } = {}) {
  const pending = [..._startupBackgroundTasks.values()].map(task => task.promise);
  if (!pending.length) return true;
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 10000));
    timer.unref?.();
  });
  const settled = Promise.allSettled(pending).then(() => true);
  const drained = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return drained;
}
function backgroundWorkSnapshot() {
  return {
    transcript_checkpoints: {
      pending: _transcriptCheckpointPending.size + _transcriptCheckpointInFlight.size,
      scheduled: _transcriptCheckpointTimers.size,
      transcript_pending: _transcriptCheckpointPending.size,
      transcript_in_flight: _transcriptCheckpointInFlight.size,
      retrying: _transcriptCheckpointAttempts.size,
      maximum_retry_attempt: Math.max(0, ..._transcriptCheckpointAttempts.values()),
      closing: _transcriptCheckpointsClosing,
    },
    slack_webhook_events: slackWebhookSnapshot(),
    acknowledged_meeting_work: acknowledgedMeetingWorkSnapshot(),
    recent_meetings_cache: recentMeetingsRefreshSnapshot(),
    recurring_jobs: _recurringJobs.snapshot(),
    startup_tasks: startupBackgroundTaskSnapshot(),
  };
}
function scheduleStartupBackgroundTask(label, delayMs, fn, deferrals = 0) {
  if (_serviceReadiness.phase === 'draining') return;
  const timer = setTimeout(() => {
    const timerIndex = _runtimeIntervals.indexOf(timer);
    if (timerIndex >= 0) _runtimeIntervals.splice(timerIndex, 1);
    if (_serviceReadiness.phase === 'draining') return;
    const admission = processResources.backgroundAdmission();
    if (!admission.allowed) {
      if (deferrals === 0) console.warn(`${label} deferred for ${admission.reason}`);
      scheduleStartupBackgroundTask(label, admission.retry_after_ms || 30000, fn, deferrals + 1);
      return;
    }
    const id = `startup-${++_startupBackgroundTaskSequence}`;
    const startedAt = Date.now();
    const execution = Promise.resolve().then(fn);
    _startupBackgroundTasks.set(id, { label, started_at: startedAt, promise: execution });
    execution
      .catch(error => {
        _startupBackgroundTaskFailures.push({
          label, at: new Date().toISOString(),
          error: String(error?.message || error || 'startup task failed').slice(0, 300),
        });
        if (_startupBackgroundTaskFailures.length > 12) _startupBackgroundTaskFailures.shift();
        console.error(`${label} failed:`, error.message);
      })
      .finally(() => _startupBackgroundTasks.delete(id));
  }, delayMs);
  timer.unref?.();
  _runtimeIntervals.push(timer);
}

function closeRuntimeIntervals() {
  for (const timer of _runtimeIntervals.splice(0)) {
    if (typeof timer?.close === 'function') timer.close();
    else clearInterval(timer);
  }
}

async function completePostListenStartup(background) {
  setServiceReadiness('startup_reconciliation');
  console.log('Startup phase: post-listen schema and continuity warmup');
  console.log('Startup phase: operational safety store init');
  await operationStore.init();
  const unleasedRunRecovery = recoverRunBoundLifecycleWithoutLease();
  const staleCycleRecovery = unleasedRunRecovery.recovered
    ? unleasedRunRecovery : operationStore.recoverStaleCycles({ reason: 'startup_recovery' });
  const restoredRunLock = loadDurableRunLock();
  if (restoredRunLock && Number(restoredRunLock.expires_at) > Date.now()) {
    runtimeActivity.begin({ id: `hourly:${restoredRunLock.holder}`, lane: 'work', kind: 'hourly_run',
      label: 'Restoring an active hourly run',
      detail: 'The durable operational lease survived this server restart.',
      source: 'startup-recovery', meta: { phase: 'orientation' } });
  }
  await operationStore.persistStrict();
  if (staleCycleRecovery.recovered) {
    console.warn(`Recorded ${staleCycleRecovery.recovered} unleased, legacy, or stale operation cycle(s) as explicit continuity gaps`);
  }
  try { await mcpManager.migrate(); }
  catch (error) { console.error('MCP credential migration failed; MCP connections will remain unavailable:', error.message); }
  await teammateApprovals.hydrate();
  // A run lock can open a cycle immediately after the port becomes reachable. Finish the first
  // authoritative substrate observation soon after listening so that restart and persistence
  // scoring do not depend on a long startup race.
  processResources.start();
  if (background) {
    scheduleStartupBackgroundTask('startup transcript date backfill', 8000, () => backfillTranscriptDates());
    scheduleRecurringRuntimeJob('recent-meetings-refresh', 10 * 60 * 1000,
      refreshRecentMeetingsCache, { initialDelayMs: 12000, timeoutMs: 30000 });
    scheduleRecurringRuntimeJob('recall-transcript-recovery', 5 * 60 * 1000,
      () => recallTranscriptRecovery.reconcile(), {
        initialDelayMs: 60000, timeoutMs: 120000,
      });
    scheduleRecurringRuntimeJob('operational-recovery-cycle', 5 * 60 * 1000,
      async ({ run_number: runNumber }) => {
      const trigger = runNumber === 1 ? 'startup' : 'five-minute-scheduler';
      const failures = [];
      try { await runHourlyFallbackRuntime({ trigger }); }
      catch (error) {
        failures.push(error);
        console.error('Hourly fallback check failed:', error.message);
      }
      if (failures.length) {
        throw new AggregateError(failures, `${failures.length} recurring runtime lane(s) failed`);
      }
    }, { initialDelayMs: 20000, timeoutMs: 60000 });
    scheduleStartupBackgroundTask('startup deferred job worker', 5000, () => startJobWorker()); // deferred-tool background jobs (ImageGen etc.)
  }
  setServiceReadiness('ready', { ready: true });
  console.log('Startup phase: post-listen warmup complete');
}

async function start(options = {}) {
  if (_startPromise) return _startPromise;
  _transcriptCheckpointsClosing = false;
  const background = options.background !== undefined ? options.background : process.env.NORA_TEST_MODE !== '1';
  const port = options.port !== undefined ? options.port : (process.env.PORT || 3000);
  _startPromise = (async () => {
    setServiceReadiness('persistence_initialization');
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    // Bring Postgres up (migrate + hydrate) BEFORE accepting requests, so no handler ever
    // reads a half-hydrated cache. DB failure preserves the existing JSON fallback.
    await initPersistence();
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });
    const address = server.address();
    console.log(`Nora server running on port ${typeof address === 'object' ? address.port : port}`);
    if (options.waitForReady === true || process.env.NORA_TEST_MODE === '1') {
      try { await completePostListenStartup(background); }
      catch (error) { setServiceReadiness('startup_failed', { error }); throw error; }
    } else {
      scheduleStartupBackgroundTask('post-listen startup warmup', 250, async () => {
        try { await completePostListenStartup(background); }
        catch (error) { setServiceReadiness('startup_failed', { error }); throw error; }
      });
    }
    return server;
  })();
  return _startPromise;
}

async function stop() {
  setServiceReadiness('draining');
  // Optional inference is safe to preempt, but it must reach its finally/release boundary before
  // the final persistence flush and database close. Otherwise a provider response can arrive
  // during shutdown and mutate state after the last durable snapshot.
  interactivePerformance.cancelBackground('service_shutdown');
  const backgroundDrained = await interactivePerformance.waitForBackgroundIdle({ timeoutMs: 10000 });
  if (!backgroundDrained) {
    console.warn('Background provider drain exceeded 10000ms; continuing bounded shutdown');
  }
  processResources.close();
  closeRuntimeIntervals();
  const recurringJobsDrained = await _recurringJobs.drain({ timeoutMs: 10000 });
  if (!recurringJobsDrained) {
    console.warn('Recurring runtime job drain exceeded 10000ms; continuing bounded shutdown');
  }
  const deferredWorkerDrained = _jobWorkerLoop
    ? await _jobWorkerLoop.drain({ timeoutMs: 10000 }) : true;
  if (!deferredWorkerDrained) {
    console.warn('Deferred connector worker drain exceeded 10000ms; its restart outcome will be marked uncertain');
  }
  _jobWorkerLoop = null;
  const startupTasksDrained = await drainStartupBackgroundTasks({ timeoutMs: 10000 });
  if (!startupTasksDrained) {
    console.warn('Startup background task drain exceeded 10000ms; continuing bounded shutdown');
  }
  // A startup owner that was already settling when shutdown began may have attempted to register
  // a follow-up timer. The draining guard prevents new registrations; this second sweep closes any
  // handle that crossed the first sweep's boundary before that guard was observed.
  closeRuntimeIntervals();
  const closeServer = server.listening
    ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  server.closeIdleConnections?.();
  const boundedServerClose = new Promise(resolve => {
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 20000);
    forceTimer.unref?.();
    closeServer.then(() => { clearTimeout(forceTimer); resolve(); });
  });
  // First stop ingress and let every already-acknowledged Slack/meeting callback reach its
  // terminal state. Those callbacks are allowed to enqueue a final transcript checkpoint.
  // Draining transcripts before them created a race where a callback could add work behind the
  // completed drain and lose its final lines during the restart.
  const [, slackWebhookDrain, meetingWebhookDrain] = await Promise.allSettled([
    boundedServerClose,
    drainSlackWebhookEvents({ timeoutMs: 20000 }),
    drainAcknowledgedMeetingWork({ timeoutMs: 20000 }),
  ]);
  if (slackWebhookDrain.status === 'rejected' || slackWebhookDrain.value !== true) {
    console.warn('Slack webhook event drain exceeded 20000ms; continuing bounded shutdown');
  }
  if (meetingWebhookDrain.status === 'rejected' || meetingWebhookDrain.value !== true) {
    console.warn('Acknowledged meeting work drain exceeded 20000ms; continuing bounded shutdown');
  }
  const transcriptDrain = await drainTranscriptCheckpoints().then(() => null, error => error);
  const [persistenceDrain, recentMeetingsDrain] = await Promise.allSettled([
    operationStore.persistStrict(),
    drainRecentMeetingsRefresh({ timeoutMs: 10000 }),
  ]);
  if (recentMeetingsDrain.status === 'rejected' || recentMeetingsDrain.value !== true) {
    console.warn('Recent-meetings cache refresh drain exceeded 10000ms; continuing bounded shutdown');
  }
  const writeThroughDrained = await _writeThroughQueue.drain({ timeoutMs: 10000 });
  if (!writeThroughDrained) {
    console.warn('Database write-through drain exceeded 10000ms; continuing bounded shutdown');
  }
  await db.close().catch(() => {});
  _startPromise = null;
  if (transcriptDrain) throw transcriptDrain;
  if (persistenceDrain.status === 'rejected') throw persistenceDrain.reason;
}

const _processRecovery = createProcessRecovery({
  stop,
  beforeStop: state => setServiceReadiness(state.fatal ? 'fatal_recovery' : 'draining', {
    error: state.error?.message || null,
  }),
});

module.exports = {
  app,
  server,
  start,
  stop,
  __test: {
    computeNextRun,
    isValidRecurrence,
    isTaskEligibleNow,
    buildNoraQueueTaskTool,
    runClaudeToolLoop,
    containsFinancialContent,
    runtimeSituationalCapabilities,
    SLACK_CONVERSATIONAL_TERMINAL_MS,
    SLACK_CONVERSATIONAL_DELIVERY_RESERVE_MS,
    SLACK_MIN_MODEL_MS,
    SLACK_DELIVERY_FLOOR_MS,
    isLightweightSocialSlackMessage,
    slackConversationPolicy,
    slackEmptyReplyFallback,
    slackResponseModel,
    stripSlackLookupNarration,
    transcriptStartsWith,
    slackThreadHasNoraReply,
    activeDurableRunLock,
    beginOptionalBackground,
    drainOptionalWorkForOperationalRun,
    hourlyFallbackBudget,
    deferredJobWorkerAdmission,
    boundedNativeTask,
    nativeTaskAttemptKey,
    nativeTaskExecutionHistory,
    nativeTaskReady,
    recordNativeTaskAttempt,
    nativeHourlyTaskToolset,
    runNativeHourlyTask,
    recoverUnhandledSlackMention,
    checkExplicitScheduledWork,
    compileInteractivePersona,
    fitSlackSystemPrompt,
    settleWithin,
    settleWithinAbortable,
    trySlackReaction,
    resetSlackReactionCapabilityForTest,
    normalizeMeetingUrl,
    sanitizeFilename,
    isRunBoundCycle,
    backgroundWorkSnapshot,
    scheduleStartupBackgroundTask,
    startupBackgroundTaskSnapshot,
    drainStartupBackgroundTasks,
    processResources,
    relativeDayLabel,
    buildBotConfig,
    buildSystemPrompt,
    verifySlackRequest,
    verifySlackSignature,
    operationStore,
    trackSlackWebhookEvent,
    slackWebhookSnapshot,
    drainSlackWebhookEvents,
    beginAcknowledgedMeetingWork,
    acknowledgedMeetingWorkSnapshot,
    drainAcknowledgedMeetingWork,
    mapWithBoundedConcurrency,
    recentMeetingsRefreshSnapshot,
    drainRecentMeetingsRefresh,
  },
};

if (require.main === module) {
  _processRecovery.install(process);
  start().catch((err) => {
    _processRecovery.requestShutdown('startup_failure', { fatal: true, error: err });
  });
}
