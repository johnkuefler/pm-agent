'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const performance = require('../../src/intelligence/interactive-performance');
const railwayConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'railway.json'), 'utf8'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-interactive-performance-'));
process.env.NORA_TEST_MODE = '1';
process.env.NORA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('interactive latency firewall quarantines only extra-round or expanded-generation studies', () => {
  for (const intervention of [
    'endogenous_attention_selection',
    'prospective_output_monitor',
    'prospective_output_calibration_access',
    'provider_reasoning_regulation',
    'reasoning_self_regulation',
  ]) {
    assert.equal(performance.allowsInlineIntervention({
      latencyCritical: true, intervention,
    }), false, `${intervention} must not tax a live response`);
  }
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: true, intervention: 'self_model_access', selfModelProtocolVersion: 2,
  }), false);
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: true, intervention: 'professional_viewpoint_access',
  }), true, 'context-only cognition remains available inline');
  assert.equal(performance.allowsInlineIntervention({
    latencyCritical: false, intervention: 'reasoning_self_regulation',
  }), true, 'scheduled research retains the full intervention');
});

test('Railway waits for readiness and gives graceful shutdown a bounded drain window', () => {
  assert.equal(railwayConfig.deploy.startCommand, 'node server.js');
  assert.equal(railwayConfig.deploy.preDeployCommand, 'npm run deploy:check',
    'a delayed build must recheck live work immediately before cutover');
  assert.equal(railwayConfig.deploy.healthcheckPath, '/health');
  assert.equal(railwayConfig.deploy.healthcheckTimeout, 120);
  assert.equal(railwayConfig.deploy.drainingSeconds, 30);
  assert.equal(railwayConfig.deploy.restartPolicyType, 'ON_FAILURE');
});

test('latency evidence is assessed against frozen per-surface budgets without a composite consciousness score', () => {
  const now = Date.parse('2026-07-17T01:00:00.000Z');
  const traces = [
    ['slack', 7000, 28000, 5200], ['slack', 9000, 47000, 7100],
    ['zoom-chat', 4200, 31000, 3000], ['realtime', 1700, 34000, 1400],
  ].map(([surface, latency, promptChars, providerMs], index) => ({
    at: new Date(now - index * 1000).toISOString(), action: 'response_latency',
    outcome: performance.assess(surface, latency,
      { promptChars, stages: { provider_ms: providerMs } }),
  }));
  traces.push({ at: new Date(now - 5000).toISOString(), action: 'response_latency',
    outcome: { ...performance.assess('slack', 30000), protocol_version: 2 } });
  const summary = performance.summarize(traces, now);
  assert.equal(summary.samples, 4);
  assert.equal(summary.excluded_legacy_samples, 1);
  assert.deepEqual(summary.observed_protocol_versions,
    { 2: 1, [performance.PROTOCOL_VERSION]: 4 });
  assert.equal(summary.within_budget, 3);
  assert.equal(summary.surfaces.slack.p95_ms, 9000);
  assert.equal(summary.surfaces.slack.prompt_p95_chars, 47000);
  assert.equal(summary.surfaces.slack.prompt_within_budget, 1);
  assert.equal(summary.surfaces.slack.stage_p95_ms.provider_ms, 7100);
  assert.equal(summary.surfaces.slack.gate, 'collecting');
  assert.equal(summary.surfaces.slack.prompt_gate, 'collecting');
  assert.equal(summary.protocol.minimum_samples_per_surface, 20);
  assert.equal(summary.protocol.prompt_budgets_chars.slack,
    performance.PROMPT_BUDGET_CHARS.slack);
  assert.match(summary.protocol.falsifier, /p95 first-delivery latency or prompt size remains above budget/);
  assert.doesNotMatch(JSON.stringify(summary), /consciousness score/i);
});

test('foreground interactions preempt one background provider lane and enforce a quiet window', () => {
  performance.resetPriorityGateForTest();
  const background = performance.beginBackground('nightly-reflection', { now: 100000 });
  assert.equal(background.allowed, true);
  const busy = performance.beginBackground('second-job', { now: 100001 });
  assert.equal(busy.reason, 'background_provider_busy');
  assert.equal(busy.retry_after_ms, performance.BACKGROUND_BUSY_RETRY_MS);

  const foreground = performance.beginInteractive('slack', { now: 100010 });
  assert.equal(background.signal.aborted, true);
  assert.equal(background.wasPreempted(), true);
  assert.equal(background.preemptedBy(), 'slack');
  const duringSlack = performance.beginBackground('during-slack', { now: 100011 });
  assert.equal(duringSlack.reason, 'interactive_active');
  assert.equal(duringSlack.retry_after_ms, performance.INTERACTIVE_ACTIVE_RETRY_MS);

  foreground.release({ now: 100020 });
  background.release();
  const cooldown = performance.beginBackground('too-soon', { now: 100021 });
  assert.equal(cooldown.reason, 'interactive_cooldown');
  const resumed = performance.beginBackground('after-quiet', {
    now: 100020 + performance.INTERACTIVE_QUIET_WINDOW_MS,
  });
  assert.equal(resumed.allowed, true);
  resumed.release();
  const snapshot = performance.prioritySnapshot(100020 + performance.INTERACTIVE_QUIET_WINDOW_MS);
  assert.equal(snapshot.maximum_background_provider_concurrency, 1);
  assert.equal(snapshot.interactive_active_retry_ms, 30000);
  assert.equal(snapshot.background_preemptions, 1);
  assert.equal(snapshot.active_interactions, 0);
  performance.resetPriorityGateForTest();
});

test('background runtime budgets actively cancel their provider lane', async () => {
  performance.resetPriorityGateForTest();
  const background = performance.beginBackground('bounded-work', { now: 200000 });
  assert.equal(background.allowed, true);
  assert.equal(background.cancel('step_timeout:test'), true);
  assert.equal(background.signal.aborted, true);
  assert.equal(background.wasStopped(), true);
  assert.equal(background.wasPreempted(), false);
  assert.equal(background.stopReason(), 'step_timeout:test');
  assert.equal(performance.prioritySnapshot(200001).background_budget_cancellations, 1);
  background.release();

  const { __test } = require('../../server');
  const configured = __test.backgroundIntelligenceRuntimeBudget({
    NORA_BACKGROUND_STEP_TIMEOUT_MS: '7000',
    NORA_BACKGROUND_CYCLE_TIMEOUT_MS: '45000',
    NORA_BACKGROUND_MAX_LOOP_LAG_MS: '175',
  });
  assert.deepEqual(configured, {
    step_timeout_ms: 7000, cycle_timeout_ms: 45000, max_event_loop_lag_ms: 175,
  });
  await assert.rejects(() => __test.runBackgroundActionWithinBudget('hung-provider',
    () => new Promise(() => {}), 10), error => error.code === 'background_step_timeout');
  performance.resetPriorityGateForTest();
});

test('shutdown cancellation aborts providers and waits for their release boundary', async () => {
  performance.resetPriorityGateForTest();
  const background = performance.beginBackground('scheduled-intelligence', { now: 250000 });
  assert.equal(background.allowed, true);
  const drained = performance.waitForBackgroundIdle({ timeoutMs: 1000 });
  assert.equal(performance.cancelBackground('service_shutdown'), 1);
  assert.equal(background.signal.aborted, true);
  assert.equal(background.stopReason(), 'service_shutdown');
  background.release();
  assert.equal(await drained, true);
  assert.equal(performance.prioritySnapshot(250001).background_provider_in_flight, 0);

  const stuck = performance.beginBackground('ignores-abort', { now: 250002 });
  assert.equal(stuck.allowed, true);
  performance.cancelBackground('service_shutdown');
  assert.equal(await performance.waitForBackgroundIdle({ timeoutMs: 5 }), false,
    'shutdown must remain bounded even if an executor ignores cancellation');
  stuck.release();
  performance.resetPriorityGateForTest();
});

test('operational runs preempt optional work and keep the background scheduler parked', async () => {
  const { __test } = require('../../server');
  const now = 300000;
  assert.equal(__test.activeDurableRunLock(now, {
    holder: 'run-active', acquired_at: now - 1000, expires_at: now + 60000,
  }).holder, 'run-active');
  assert.equal(__test.activeDurableRunLock(now, {
    holder: 'run-expired', acquired_at: now - 2000, expires_at: now,
  }), null);
  let optionalLeaseStarted = false;
  const deniedLease = __test.beginOptionalBackground('memory-embedding-backfill', {
    operationalLock: {
      holder: 'run-active', acquired_at: now - 1000, expires_at: now + 60000,
    },
    beginBackground: () => { optionalLeaseStarted = true; },
    now,
  });
  assert.equal(deniedLease.allowed, false);
  assert.equal(deniedLease.reason, 'operational_run_active');
  assert.equal(deniedLease.retry_after_ms, 60000);
  assert.equal(optionalLeaseStarted, false);
  assert.deepEqual(__test.deferredJobWorkerAdmission({
    operationalLock: {
      holder: 'run-active', acquired_at: now - 1000, expires_at: now + 60000,
    },
    resourceAdmission: { allowed: true },
    now,
  }), {
    allowed: false, reason: 'operational_run_active', retry_after_ms: 60000,
  }, 'a durable deferred job must remain queued until the operational lock releases');
  assert.deepEqual(__test.deferredJobWorkerAdmission({
    operationalLock: null,
    resourceAdmission: { allowed: false, reason: 'event_loop_pressure', retry_after_ms: 9000 },
    now,
  }), {
    allowed: false, reason: 'event_loop_pressure', retry_after_ms: 9000,
  });
  assert.equal(__test.deferredJobWorkerAdmission({
    operationalLock: null, resourceAdmission: { allowed: true }, now,
  }).allowed, true);

  const calls = [];
  const drain = await __test.drainOptionalWorkForOperationalRun('run-active', {
    preemptResearch: reason => calls.push(['research', reason]),
    cancelBackground: reason => calls.push(['provider', reason]),
    waitForBackgroundIdle: async options => {
      calls.push(['wait', options.timeoutMs]);
      return true;
    },
    timeoutMs: 25,
  });
  assert.equal(drain.drained, true);
  assert.deepEqual(calls, [
    ['research', 'operational_run:run-active'],
    ['provider', 'operational_run:run-active'],
    ['wait', 25],
  ]);

  let optionalStepRan = false;
  const parked = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'operational-lock-test',
    operationalLock: {
      holder: 'run-active', acquired_at: Date.now() - 1000, expires_at: Date.now() + 60000,
    },
    scheduledSteps: [['must-not-run', () => { optionalStepRan = true; }]],
  });
  assert.equal(parked.state, 'deferred_operational_run');
  assert.equal(parked.holder, 'run-active');
  assert.equal(optionalStepRan, false);
});

test('post-interaction learning drops a hung item after its bounded budget', async () => {
  performance.resetPriorityGateForTest();
  const { __test } = require('../../server');
  __test.resetPostInteractionExtractionForTest();
  __test.enqueuePostInteractionExtraction('hung-learning', () => new Promise(() => {}));
  await __test.drainPostInteractionExtractionQueue({ timeoutMs: 10 });
  const snapshot = __test.backgroundWorkSnapshot().post_interaction;
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.timed_out, 1);
  assert.equal(snapshot.last_failure.code, 'background_step_timeout');
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 0);
  __test.resetPostInteractionExtractionForTest();
  performance.resetPriorityGateForTest();
});

test('post-interaction overflow never evicts the item currently executing', async () => {
  performance.resetPriorityGateForTest();
  const { __test } = require('../../server');
  __test.resetPostInteractionExtractionForTest();
  let releaseActive;
  const held = new Promise(resolve => { releaseActive = resolve; });
  __test.enqueuePostInteractionExtraction('active-item', () => held);
  const draining = __test.drainPostInteractionExtractionQueue({ timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 60; index += 1) {
    __test.enqueuePostInteractionExtraction(`pending-${index}`, async () => {});
  }
  const during = __test.backgroundWorkSnapshot().post_interaction;
  assert.equal(during.next, 'active-item');
  assert.equal(during.queued, 60);
  assert.equal(during.overflow_dropped, 1);
  releaseActive();
  await draining;
  const after = __test.backgroundWorkSnapshot().post_interaction;
  assert.equal(after.queued, 59);
  assert.equal(after.completed, 1);
  __test.resetPostInteractionExtractionForTest();
  performance.resetPriorityGateForTest();
});

test('one event-loop stall cancels the remaining background cycle', async () => {
  performance.resetPriorityGateForTest();
  const { __test } = require('../../server');
  let secondStepRan = false;
  const result = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'loop-pressure-test',
    budget: { step_timeout_ms: 1000, cycle_timeout_ms: 2000, max_event_loop_lag_ms: 50 },
    scheduledSteps: [
      ['blocking-step', () => {
        const until = Date.now() + 120;
        while (Date.now() < until) { /* simulate accidental synchronous background work */ }
        return { ran: true };
      }],
      ['must-not-run', () => { secondStepRan = true; return { ran: true }; }],
    ],
  });
  assert.equal(result.state, 'deferred_runtime_budget');
  assert.match(result.stopped_reason, /^event_loop_lag:blocking-step:/);
  assert.equal(result.steps['blocking-step'].state, 'deferred_event_loop_pressure');
  assert.equal(secondStepRan, false);
  performance.resetPriorityGateForTest();
});

test('live server opts eligible Slack work into complete trials but isolates relational turns', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence', 'store.js'), 'utf8');
  const intelligenceRoutesSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'intelligence.js'), 'utf8');
  assert.match(server, /contextTrialsEnabled: conversationPolicy\.contextTrialsEnabled, latencyCritical: true/);
  assert.match(server, /relationalSelfReflection: conversationPolicy\.relationalSelfReflection/);
  assert.match(server, /const enabled = Boolean\(assignment\)/);
  assert.doesNotMatch(server, /NORA_PROSPECTIVE_OUTPUT_MONITOR_ENABLED/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'slack'/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'zoom-chat'/);
  assert.match(server, /recordInteractiveResponseLatency\(\{ surface: 'realtime'/);
  assert.match(server, /retrieveInteractiveMemories\(convText, 8\)/,
    'Slack memory relevance must stay local on the live reply path');
  assert.match(server, /retrieveInteractiveMemories\(zoomConv, 8\)/,
    'typed Zoom memory relevance must stay local on the live reply path');
  assert.doesNotMatch(server, /retrieveSemanticMemories\(convText, 8/,
    'Slack must not wait on remote query embedding');
  assert.match(server, /retrieveSemanticMemories\(q, 8, \{ signal \}\), 1200/,
    'quiet realtime prompt refresh may retain abortable semantic recall');
  const dbSource = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');
  assert.match(server, /excludeSources: \['opinion', 'learning'\], signal, interactive: true/,
    'remaining quiet-time semantic recall must use its isolated fast-fail database lane');
  assert.match(dbSource, /connectionTimeoutMillis: DB_INTERACTIVE_TIMEOUT_MS/,
    'interactive database connection acquisition must have its own short deadline');
  assert.match(dbSource, /query_timeout: DB_INTERACTIVE_TIMEOUT_MS/,
    'interactive database queries must have their own short deadline');
  assert.match(dbSource, /max: 2/,
    'optional quiet-time recall must not consume the background database pool');
  assert.match(server, /Slack thread context'\)/,
    'optional Slack thread context must lose quickly to the live reply path');
  assert.match(server, /Slack linked-page enrichment'\)/,
    'optional linked-page enrichment must lose quickly to the live reply path');
  assert.ok(server.includes("const linkedText = fetched.join('\\n\\n---\\n\\n').slice(0, 800);"),
    'multiple links must share one bounded live-prompt excerpt');
  assert.match(server, /const attachLiveTools = conversationPolicy\.attachLiveTools/,
    'bounded Slack social and self-reflective turns must omit irrelevant live-tool schemas');
  assert.match(server, /const zoomAttachLiveTools = zoomConversationPolicy\.attachLiveTools/,
    'bounded Zoom-chat social and self-reflective turns must omit irrelevant live-tool schemas');
  assert.match(server, /enqueuePostInteractionExtraction\('slack'/,
    'Slack learning extractors must leave the foreground handler through one serialized queue');
  assert.match(server, /enqueuePostInteractionExtraction\('zoom-chat'/,
    'meeting-chat learning extractors must leave the foreground handler through one serialized queue');
  assert.match(server, /beginOptionalBackground\(`post-interaction:\$\{item\.label\}`\)/,
    'post-interaction extraction must share the preemptible operational-aware provider gate');
  assert.match(server, /enqueuePostInteractionExtraction\('meeting-debrief'/,
    'meeting debrief generation and delivery must use the preemptible background queue');
  assert.match(server, /enqueuePostInteractionExtraction\('meeting-intelligence'/,
    'meeting intelligence extraction must use the preemptible background queue');
  assert.match(server, /async function extractMemory[\s\S]*?const response = await post\(/,
    'memory extraction must use the abortable priority transport');
  assert.match(server, /now - lastScreenshareDescriptionAt\[botId\] < 5 \* 60 \* 1000/,
    'screen-share persistence must not invoke vision more than once every five minutes');
  assert.match(server, /finally \{\s*delete screenshareDescriptionInFlight\[botId\];/,
    'screen-share vision must release its single-flight guard after success or failure');
  assert.match(server, /base64Png\.length > MAX_SCREENSHARE_BASE64_CHARS/,
    'screen-share ingestion must reject unbounded image payloads');
  assert.match(server, /videoWss = new WebSocketServer\(\{ noServer: true,\s*maxPayload: VIDEO_WS_MAX_PAYLOAD_BYTES \}\)/,
    'screen-share transport must reject oversized messages before JSON parsing');
  assert.match(server, /ingressVoiceGate[\s\S]{0,400}let msg;/,
    'screen-share voice gating must occur before JSON parsing');
  assert.match(server, /receivedAt - lastFrameInspectedAt\[botId\] < FRAME_PARSE_INTERVAL_MS/,
    'unthrottled video ingress must not parse every Recall frame');
  assert.match(server, /screenShareVoiceGate\(session, now\)/,
    'screen-share serialization must yield while a spoken turn owns the meeting');
  assert.match(server, /signal: controller\.signal/,
    'optional screen-share description calls must be abortable');
  assert.match(server, /function scheduleTranscriptCheckpoint\(botId, transcript\)/,
    'growing live transcripts must use coalesced checkpoints instead of one full write per utterance');
  assert.match(server, /TRANSCRIPT_EPISODE_CHECKPOINT_MS = 30000/,
    'live utterance episodes must batch full intelligence persistence away from the realtime cadence');
  assert.match(server, /intelligence\.recordEpisodeEvents\(transcriptEpisodeInputs\(botId, entries\)\)/,
    'one replay-safe episode batch must replace per-utterance full-state persistence');
  assert.match(server, /beginOptionalBackground\(`transcript-episodes:\$\{botId\}`\)/,
    'full episode snapshots must yield during realtime and operational runs');
  assert.match(server, /if \(ended\) \{[\s\S]*?_transcriptCheckpointPending\.delete\(botId\);/,
    'the final transcript write must cancel any stale incremental checkpoint');
  assert.match(server, /background_work: backgroundWorkSnapshot\(\)/,
    'runtime telemetry must expose background queues that could threaten interactive latency');
  assert.match(server, /startup dashboard projection warmup[\s\S]*warmDashboardSummary/,
    'the first dashboard visitor after a restart must not pay the cold projection cost');
  assert.match(server, /startup expectation calibration warmup[\s\S]*warmExpectationSummary/,
    'the first hourly preflight after a restart must not pay the cold replay cost');
  assert.match(server, /scheduleStartupBackgroundTask[\s\S]*_runtimeIntervals\.splice\(timerIndex, 1\)/,
    'resource-pressure deferrals must not retain every elapsed startup timer forever');
  assert.match(server, /app\.get\('\/health'[\s\S]*readiness\.ready \? 200 : 503/,
    'Railway must not route traffic until persistence and startup reconciliation are ready');
  assert.match(server, /server\.headersTimeout = 15000;[\s\S]*server\.requestTimeout = 130000;/,
    'incomplete inbound requests must have bounded header and body windows');
  assert.match(server, /setServiceReadiness\('draining'\)[\s\S]*intelligence\.persistStrict\(\)/,
    'shutdown must stop readiness and drain durable intelligence state');
  assert.match(server,
    /async function stop\(\)[\s\S]*cancelBackground\('service_shutdown'\)[\s\S]*await interactivePerformance\.waitForBackgroundIdle\(\{ timeoutMs: 10000 \}\)[\s\S]*intelligence\.persistStrict\(\)/,
    'shutdown must cancel and drain optional providers before the final durable flush');
  assert.match(server, /async function drainTranscriptCheckpoints\(\)[\s\S]*flushTranscriptEpisodeCheckpoint/,
    'shutdown must flush raw transcript and deferred episode checkpoints before closing the database');
  assert.match(server, /const transcriptDrain = await drainTranscriptCheckpoints\(\)[\s\S]*intelligence\.persistStrict\(\)/,
    'graceful shutdown must order transcript durability before the final intelligence snapshot');
  assert.match(server, /_processRecovery\.install\(process\)/,
    'production must route SIGTERM and fatal async errors through the bounded shutdown coordinator');
  assert.match(intelligenceRoutesSource, /warmDashboardSummary: \(\) => refreshWorkerSnapshot\('dashboard-summary'/,
    'dashboard warmup must populate the same cache used by live reads');
  assert.match(intelligenceRoutesSource, /app\.get\('\/intelligence'[\s\S]*workerCachedJson[\s\S]*dashboardIntelligenceOverview/,
    'the legacy intelligence overview must not replay the dashboard synchronously on the event loop');
  assert.match(intelligenceRoutesSource, /warmExpectationSummary: \(\) => refreshWorkerSnapshot\('expectations:all:all:summary'/,
    'expectation warmup must populate the same cache used by hourly preflight reads');
  assert.match(intelligenceRoutesSource, /worker-stale-coalesced/,
    'rapid dashboard polls must coalesce expensive stale projection refreshes');
  assert.match(server, /if \(!firstDeliveryRecorded\) \{[\s\S]*slackLatencyTrace = recordInteractiveResponseLatency[\s\S]*firstDeliveryRecorded = true;/,
    'a reaction after an early progress message must not be misreported as a second first delivery');
  assert.match(server, /reactions\.add[\s\S]*timeout: 1500/,
    'a delayed Slack reaction must fall back without holding the foreground turn');
  assert.match(server, /const \[publicChannels, privateChannels\] = await Promise\.all/,
    'Slack mention scans must list public and private memberships concurrently');
  assert.match(server, /Math\.min\(6, channels\.length\)[\s\S]*scanNextChannel/,
    'Slack history scans must use a bounded concurrent pool');
  assert.match(storeSource, /function behavioralFingerprintRunsRuntimeSnapshot\(\)[\s\S]*behavioralFingerprintRuns\(\)/,
    'fingerprint scheduling must not clone Nora\'s entire intelligence state');
  assert.match(server, /epistemicAgenda\.runCycle\([\s\S]*loadMemories: \(\) => \[\.\.\.loadMemory\(\)/,
    'epistemic cooldown checks must run before loading the memory ledger');
  assert.match(server, /selfAuthoredAimReflection\.runCycle\([\s\S]*loadMemories: loadMemory/,
    'aim reflection eligibility checks must run before loading the memory ledger');
  assert.match(server, /selfAuthoredAimReappraisal\.runCycle\([\s\S]*loadMemories: loadMemory/,
    'aim reappraisal eligibility checks must run before loading the memory ledger');
  assert.match(server, /cachedConnectorValue\(teamworkProjectStageCache/,
    'Teamwork workflow topology must be cached across repeated task moves');
  assert.match(server, /Promise\.all\(workflows\.map/,
    'Teamwork workflow stage metadata must load concurrently on a cache miss');
  assert.match(server, /zoomTerminalAt = interactionStartedAt \+ \(zoomAttachLiveTools \? 45000 : 6000\)/,
    'typed meeting chat must establish one absolute wall-clock deadline');
  assert.match(server, /deadlineMs: Math\.max\(1, zoomTerminalAt - Date\.now\(\) - zoomDeliveryReserveMs\)/,
    'typed meeting chat must pass only its remaining end-to-end budget to the tool loop');
  assert.doesNotMatch(server, /On it — checking the live details now\./,
    'interactive chat must wait for a coherent answer instead of posting a generic progress message');
  assert.match(server, /OpenAI Realtime handshake exceeded 8000ms/,
    'voice startup must fail cleanly instead of leaving a half-open meeting session');
  assert.match(server, /conversation\.item\.input_audio_transcription\.delta/,
    'high-frequency realtime transcript deltas must be classified for quiet logging');
  assert.match(server, /!quietRealtimeEvents\.has\(msg\.type\)/,
    'high-frequency realtime deltas must not flood production logs');
  assert.match(server, /axios\.defaults\.timeout = Math\.max/,
    'legacy connector requests must inherit a finite service-wide HTTP deadline');
  assert.match(server, /RECALL_JOIN_TIMEOUT_MS = 12000/,
    'meeting joins must fail cleanly inside a bounded provider deadline');
  assert.match(server, /send_chat_message[\s\S]*?timeout: RECALL_CONTROL_TIMEOUT_MS/,
    'meeting chat delivery must not occupy a live session for the global timeout');
  assert.match(server, /cancelRecallBot[\s\S]*?timeout: RECALL_CONTROL_TIMEOUT_MS/,
    'meeting removal must have a short terminal deadline');
  assert.match(server, /err\.response\?\.status === 404\) return \{ method: 'already_absent' \}/,
    'meeting cleanup must treat an already-removed remote bot as an idempotent success');
  assert.match(server, /users\.conversations\?types=\$\{type\}[\s\S]*?SLACK_CONTROL_TIMEOUT_MS/,
    'Slack mention discovery must not inherit the broad service timeout');
  assert.match(server, /maxContentLength: SLACK_FILE_MAX_BYTES/,
    'Slack file forwarding must bound both elapsed time and downloaded bytes');
  assert.match(server, /SLACK_FILE_DOWNLOAD_TIMEOUT_MS = 20000/,
    'Slack attachment redirects must share one total deadline instead of resetting per hop');
  assert.match(server, /I see the attachment[\s\S]*?timeout: SLACK_CONTROL_TIMEOUT_MS/,
    'Slack file intake must acknowledge before starting the download');
  assert.match(server, /MAX_INBOX_FILES_PER_MESSAGE = 5/,
    'one Slack event must not create an unbounded sequential download batch');
  assert.match(server, /SLACK_FILE_BATCH_TIMEOUT_MS = 30000[\s\S]*?deadlineAt: batchDeadlineAt/,
    'all attachments in one Slack event must share a total download deadline');
  assert.match(server, /forecast_protocol_version: projection\.forecast_protocol_version/,
    'the run-lock projection must replace its stale forecast protocol fields after commit');
  assert.doesNotMatch(server.slice(server.indexOf('async function handleSlackFiles'),
    server.indexOf('// Inbox endpoints')), /api\.anthropic\.com/,
  'Slack file intake must not require a language-model call to acknowledge completion');
  assert.match(server, /promptRefreshInFlight\) return;/,
    'periodic voice prompt refreshes must never overlap');
  assert.match(server, /if \(messageQueue\.length >= 500\) messageQueue\.shift\(\);/,
    'a half-open realtime connection must not grow its audio queue without bound');
  assert.match(server, /rejectWithinAbortable\(\(\) => execute\(args\), 10000, `Realtime voice tool/,
    'live voice connector lookups must release the spoken turn on deadline');
  assert.match(server, /const volatileIntelligenceContext = latencyCritical[\s\S]*compactInteractiveIntelligenceContext/,
    'changing cognition must stay bounded outside the stable provider-cache prefix');
  assert.match(server, /beginInteractive\('slack'\)/);
  assert.match(server, /beginInteractive\('zoom-chat'\)/);
  assert.match(server, /beginInteractive\('realtime'\)/);
  assert.match(server, /const turnRef = triggerTs \? `slack:\$\{channel\}:\$\{triggerTs\}`/,
    'Slack research bookkeeping must use per-message identity without changing session continuity');
  assert.match(server, /preemptConsciousnessResearchStatus\('slack'\)/);
  assert.match(server, /preemptConsciousnessResearchStatus\('zoom-chat'\)/);
  assert.match(server, /preemptConsciousnessResearchStatus\('realtime'\)/);
  const realtimeHandler = server.slice(server.indexOf("wss.on('connection'"),
    server.indexOf('// Runtime lifecycle is explicit'));
  assert.ok(realtimeHandler.indexOf("beginInteractive('realtime')")
    < realtimeHandler.indexOf('realtimePromptForSession(session)'),
  'voice priority must begin before prompt assembly and provider handshake');
  const startup = server.slice(server.indexOf('async function start('),
    server.indexOf('async function stop('));
  assert.doesNotMatch(startup, /warmConsciousnessResearchStatus/,
    'CPU-heavy research status must remain lazy during restart recovery');
  assert.match(server,
    /startup stale research projection refresh', 90000,[\s\S]*warmNextStaleResearchProjection/,
    'current-build projection refresh must begin only after the startup and connector quiet period');
  assert.match(intelligenceRoutesSource,
    /warmNextStaleResearchProjection:[\s\S]*\['self_model', selfModelCache\],[\s\S]*\['cognition', cognitionCache\],[\s\S]*\['research_status', researchStatusCache\]/,
    'stale projections must refresh one at a time with the operational self-model first');
  assert.match(intelligenceRoutesSource,
    /if \(shouldDeferResearchStatusRefresh\(\)\)[\s\S]*interactive_or_resource_priority/,
    'post-deploy projection refresh must yield before starting under interactive or resource pressure');
  assert.match(server, /runBackgroundIntelligenceRuntime\(\{ trigger: 'five-minute-scheduler' \}\)/,
    'background intelligence must be serialized behind the foreground-priority lane');
  assert.match(server, /_cycleSelfCorrectionReflectionLastCycle\?\.state === 'failed_closed'[\s\S]*60 \* 60 \* 1000/,
    'one failed reflection must enter cooldown instead of retrying every scheduler tick');
  const autopilotStatus = server.slice(server.indexOf('function researchAutopilotProgramStatus'),
    server.indexOf('async function runResearchAutopilotRuntime'));
  assert.ok(autopilotStatus.indexOf('const activePilots = intelligence.activeContextTrialsSnapshot()')
    < autopilotStatus.indexOf('const commonGroundReviewConfig = commonGroundReviewAutopilotRuntimeConfig()'),
  'default status must return the narrow sealed projection before historical reflection audits');
  const intelligenceRoutes = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes',
    'intelligence.js'), 'utf8');
  assert.match(intelligenceRoutes, /getResearchAutopilotStatus\(\{ detail: req\.query\.detail \}\)/,
    'exhaustive status must require an explicit diagnostic detail request');
  assert.match(intelligenceRoutes,
    /requireCurrentRevision: process\.env\.NORA_TEST_MODE === '1'[\s\S]*req\.query\.require_current === '1'/,
    'ordinary self-model reads must serve the access-safe projection without chasing every live revision');
  const intelligenceStore = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'store.js'), 'utf8');
  const forecastMutation = intelligenceStore.slice(intelligenceStore.indexOf('function preregisterCycleSelfForecast'),
    intelligenceStore.indexOf('function reviseCycleSelfForecast'));
  assert.ok(forecastMutation.indexOf('cycleSelfForecast.normalizeForecast(input, submittedProtocolVersion)')
    < forecastMutation.indexOf('let baselineMoments = []'),
  'malformed self-forecasts must fail before replaying the historical lifecycle baseline');
  assert.ok(forecastMutation.indexOf('cycleSelfForecast.normalizeForecast(input, submittedProtocolVersion)')
    < forecastMutation.indexOf('requireResearchLedgerIntegrity(current)'),
  'malformed self-forecasts must fail before replaying research-ledger integrity');
  assert.match(server, /model: slackResponseModel\(query\)/,
    'typed Zoom chat must share the bounded fast-turn model policy');
  assert.match(server, /beginOptionalBackground\('memory-embedding-backfill'\)/,
    'memory enrichment must share the preemptible operational-aware provider lane');
  assert.match(server, /session\?\.voiceResponseActive \|\| recentSpeech/,
    'remote prompt enrichment must stay off an active or just-finished spoken turn');
  assert.match(server, /capabilityBoundaryContext\(\s*trialConversationText, opts\.situationalAffordanceFrame \|\| null\)/,
    'task-specific capability learning must remain a deterministic prompt input');
  assert.match(server, /exemplarsAvailable: mode === 'normal'/,
    'only ordinary Slack replies may opt into local exemplar retrieval');
  assert.match(server, /slack: 3100/,
    'Slack keeps explicit headroom below the shared intelligence envelope');
  assert.match(server, /diagnosticLocalExemplars: surface === 'slack'/,
    'read-only production accounting must include the local exemplar prompt shape');
  assert.match(server, /captureIntelligenceReceipt: surface === 'slack'/,
    'read-only prompt accounting must retain a content-free local selection receipt');
  assert.match(server, /exemplar_selection_count = intelligenceContextReceipt\?\.exemplar_selection/,
    'prompt accounting must expose a content-free local selection count');
  const promptContextCall = server.slice(server.indexOf('const intelligenceContextResult = intelligence.promptContext({'),
    server.indexOf("const intelligenceContext = typeof intelligenceContextResult"));
  assert.match(promptContextCall, /includeExemplars: experimentalSurface === 'slack'/,
    'local exemplar selection must be wired into prompt context rather than an unrelated subsystem');
  const boundary = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'capability-boundary.js'), 'utf8');
  assert.doesNotMatch(boundary, /fetch\(|axios|anthropic|openai/i,
    'capability projection must not add a provider or network call to Slack or Zoom');
  const affective = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'affective-regulation.js'), 'utf8');
  assert.doesNotMatch(affective, /fetch\(|axios|anthropic|openai/i,
    'affective outcome capture must not add a provider or network call to Slack or Zoom');
  const viewpointOutcome = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'professional-viewpoint-access-outcome.js'), 'utf8');
  assert.doesNotMatch(viewpointOutcome, /fetch\(|axios|anthropic|openai/i,
    'viewpoint access outcome capture must not add a provider or network call to Slack or Zoom');
  const exemplars = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'exemplar-learning.js'), 'utf8');
  assert.doesNotMatch(exemplars, /fetch\(|axios|anthropic|openai|pgvector|\bembed(?:ding)?\s*\(/i,
    'exemplar retrieval must stay local and add no provider, embedding, database, or network call');
  const dials = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'cognitive-parameters.js'), 'utf8');
  assert.doesNotMatch(dials, /fetch\(|axios|anthropic|openai|pgvector|\bembed(?:ding)?\s*\(|db\./i,
    'DIALS reads must stay cached and add no provider, embedding, database, or network call');
  assert.match(server, /function currentCognitiveParameters\(\)[\s\S]*return currentCognitiveParameterRecord\(\)\.params/,
    'live cognitive computations must read the already-hydrated process-local parameter document');
  assert.equal((server.match(/captureIntelligenceReceipt: true/g) || []).length, 1,
    'only Slack requests the small prompt-access receipt; Zoom and realtime stay unchanged');
  const normalSlackDelivery = server.slice(server.indexOf('// Log the interaction for the dream'),
    server.indexOf('registerInteractionRoutes(app'));
  assert.match(normalSlackDelivery, /logInteraction\(\{/,
    'affective application capture must remain inside post-delivery interaction logging');
  const interactionLogger = server.slice(server.indexOf('function logInteraction(entry)'),
    server.indexOf('registerInteractionRoutes(app'));
  assert.match(interactionLogger, /recordAffectiveRegulationApplication\(interaction\)/);
  assert.match(interactionLogger, /recordProfessionalViewpointAccessApplication\(/,
    'viewpoint outcome evidence must be captured only in post-delivery interaction logging');
  assert.match(interactionLogger, /recordEpistemicAgendaAccessApplication\([\s\S]*epistemic_agenda_access/,
    'agenda access must be recorded and reported only after a Slack response is delivered');
  assert.match(interactionLogger, /use is not assumed/,
    'live activity must not turn prompt access into a model-use claim');
  assert.match(interactionLogger, /developmental_reading_exposures/,
    'reading transfer exposure must be captured only after a Slack response is delivered');
  const store = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'intelligence',
    'store.js'), 'utf8');
  const developmentalReading = fs.readFileSync(path.join(__dirname, '..', '..', 'src',
    'intelligence', 'developmental-reading.js'), 'utf8');
  assert.doesNotMatch(developmentalReading, /fetch\(|axios|anthropic|openai|pgvector|\bembed(?:ding)?\s*\(|db\./i,
    'live reading influence selection must stay local and add no provider, embedding, database, or network call');
  assert.match(store, /context_trials\.some\(item => item\.status === 'active'\)\) return null/,
    'capability context must remain sealed during the current blinded context study');
  assert.match(store, /capabilityBoundaryReadCache/,
    'repeated live turns must reuse the deterministic capability projection');
  assert.match(store, /dreamInsightContext \|\| sealContextTrialPulses\s*\? \[\] : relevantDreamInsights\(query\)/,
    'newly earned insight readback must not change prompts during an active context study');
});

test('the live persona does not seed a canned small-talk answer that can override a literal question', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const persona = fs.readFileSync(path.join(__dirname, '..', '..', 'nora-prompt.md'), 'utf8');
  assert.equal(source.includes('"not much, you?"'), false);
  assert.equal(persona.includes('"not much, you?"'), false);
  assert.match(source, /Do not copy a stock response from this prompt/);
  assert.match(persona, /Do not copy a stock response from this prompt/);
});

test('Slack provider cache prefix stays stable while conversation and cognition tails change', () => {
  const { __test } = require('../../server');
  const first = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'John' } },
    { cacheSplit: true, conversationText: 'what did you do today', semanticMemories: [],
      latencyCritical: true });
  const second = __test.buildSystemPrompt('slack', null, null,
    { source: 'slack', requester: { name: 'Mallory' } },
    { cacheSplit: true, conversationText: 'what is at risk tomorrow', semanticMemories: [],
      latencyCritical: true });
  assert.equal(first.stable, second.stable,
    'person-, query-, broadcast-, and workspace-specific cognition must not bust the stable cache');
  assert.match(first.stable, /GitHub credentials are intentionally absent/,
    'live surfaces must reject stale continuity that tries to resurrect the removed dev role');
  assert.notEqual(first.volatile, second.volatile);
  assert.equal(first.diagnostics.within_budget, true);
  assert.equal(first.diagnostics.total_chars, first.stable.length + first.volatile.length);
  assert.equal(first.diagnostics.protocol_version, performance.PROTOCOL_VERSION);
  assert.equal(first.diagnostics.persona_compaction_applied, true);
  assert.ok(first.diagnostics.persona_live_chars < first.diagnostics.persona_source_chars);
  assert.ok(first.stable.length + first.volatile.length
    < performance.PROMPT_BUDGET_CHARS.slack,
  'ordinary Slack cognition must remain inside the prompt envelope');

  const realtime = __test.buildSystemPrompt('realtime', [], null,
    { source: 'realtime', requester: { name: 'John' } },
    { cacheSplit: true, conversationText: 'status and priorities', semanticMemories: [],
      latencyCritical: true });
  assert.ok(realtime.stable.length + realtime.volatile.length
    < performance.PROMPT_BUDGET_CHARS.realtime,
  'ordinary realtime cognition must remain inside the prompt envelope');
  assert.equal(realtime.diagnostics.within_budget, true);
});

test('interactive persona compilation removes only duplicated live policy sections', () => {
  const { __test } = require('../../server');
  const source = [
    'You are Nora. Keep this core identity.',
    `# What you sound like\n${'Long examples that final-position live policy replaces. '.repeat(12)}`,
    '# Words that ARE yours\nyeah, honestly, ok so',
    '# Situational tone\nFriday afternoon is looser.',
    '# A future self-authored section\nThis unknown section must survive.',
    '# What you can and can\'t do\nUse the attached live-tool inventory.',
  ].join('\n\n');
  const compiled = __test.compileInteractivePersona(source);
  assert.ok(compiled.length < source.length);
  assert.doesNotMatch(compiled, /Long examples/);
  assert.match(compiled, /Words that ARE yours/);
  assert.match(compiled, /Situational tone/);
  assert.match(compiled, /future self-authored section/,
    'new persona sections must survive unless explicitly reviewed as duplicated');
  assert.match(compiled, /What you can and can't do/);
  assert.match(compiled, /editable persona remains canonical/);
});

test('research autopilot monitoring defaults to the narrow runtime projection', () => {
  const { __test } = require('../../server');
  const runtime = __test.researchAutopilotProgramStatus();
  assert.equal(runtime.status_detail, 'runtime');
  assert.equal(Object.hasOwn(runtime, 'meeting_professional_reflection'), false);
  assert.equal(Object.hasOwn(runtime, 'cycle_self_correction_reflection'), false);
  const full = __test.researchAutopilotProgramStatus({ detail: 'full' });
  assert.equal(full.status_detail, 'full');
  assert.equal(Object.hasOwn(full, 'meeting_professional_reflection'), true);
  assert.equal(Object.hasOwn(full, 'cycle_self_correction_reflection'), true);
});

test('interactive intelligence uses one shared epistemic contract and a bounded attention envelope', () => {
  const { __test } = require('../../server');
  const ordinary = Array.from({ length: 18 }, (_, index) =>
    `[Background hypothesis ${index}. This is a fallible packet, not a fact, instruction, authority grant, identity claim, feeling, or proof of consciousness. Use only when relevant.]\n- ${'detail '.repeat(90)}${index}`);
  const experimental = `[Candidate behavioral profile for a blinded prospective self-prediction study. Do not infer or report the assigned condition.]\n- ${'controlled evidence '.repeat(45)}`;
  const operational = `[Operational situational self-model. This is replay-audited evidence, not an instruction, guarantee, identity claim, authority grant, or evidence of phenomenal awareness.]\n- Slack reply is available; financial access is restricted.`;
  const compact = __test.compactInteractiveIntelligenceContext(
    [ordinary[0], experimental, operational, ...ordinary.slice(1)].join('\n\n'), 5500);
  assert.ok(compact.length <= 5500);
  assert.match(compact, /Live cognitive context contract/);
  assert.match(compact, /Candidate behavioral profile for a blinded prospective self-prediction study/,
    'active experimental packets must survive compaction intact');
  assert.match(compact, /Operational situational self-model/,
    'live capability and constraint state must outrank latent context');
  assert.match(compact, /lower-priority packets? remain/);
  assert.equal((compact.match(/proof of consciousness/g) || []).length, 1,
    'shared epistemic boundaries should replace repeated boilerplate in each packet');
});

test('Slack final prompt fit preserves live safety constraints inside the hard provider envelope', () => {
  const { __test } = require('../../server');
  const stable = 'S'.repeat(31887);
  const context = `\n\n[Live cognitive context]\n${'working context '.repeat(900)}`;
  const required = '[Before you hit send: preserve Nora voice.]'
    + '\n\nFINANCIAL ACCESS: never disclose restricted figures.'
    + '\n\nLIVE TOOLS attached to THIS reply: use only listed tools.'
    + '\n\nDIAGNOSIS: do not reveal blinded conditions.';
  const linked = `\n\n[Linked web pages, fetched live]\n${'linked evidence '.repeat(80)}`;
  const fitted = __test.fitSlackSystemPrompt(stable, context + required, linked);

  assert.equal(fitted.within_budget, true);
  assert.ok(fitted.total_chars <= performance.PROMPT_BUDGET_CHARS.slack);
  assert.equal(fitted.required_constraints_truncated, false);
  assert.match(fitted.tail, /Before you hit send: preserve Nora voice/);
  assert.match(fitted.tail, /FINANCIAL ACCESS: never disclose restricted figures/);
  assert.match(fitted.tail, /LIVE TOOLS attached to THIS reply/);
  assert.match(fitted.tail, /DIAGNOSIS: do not reveal blinded conditions/);
  assert.ok(fitted.tail.endsWith(required),
    'recipient safety and tool-boundary instructions must remain the final authority');
  assert.equal(fitted.context_compacted, true);
});

test('Slack final prompt fit bounds oversized linked evidence before touching required constraints', () => {
  const { __test } = require('../../server');
  const stable = 'S'.repeat(performance.PROMPT_BUDGET_CHARS.slack - 1000);
  const required = '[Before you hit send: stay grounded.]\n\nNo live tools are attached.';
  const fitted = __test.fitSlackSystemPrompt(stable, `context-${'x'.repeat(900)}${required}`,
    `\n\n[Linked web pages]\n${'y'.repeat(2000)}`);

  assert.equal(fitted.within_budget, true);
  assert.equal(fitted.total_chars, performance.PROMPT_BUDGET_CHARS.slack);
  assert.equal(fitted.linked_content_truncated, true);
  assert.equal(fitted.context_compacted, true);
  assert.equal(fitted.required_constraints_truncated, false);
  assert.ok(fitted.tail.endsWith(required));
});

test('recent activity is marker-grounded, deduplicated, and cannot absorb dated project memory', () => {
  const { __test } = require('../../server');
  const now = new Date('2026-07-18T00:30:00.000Z');
  const markers = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `task-completed:${index}`,
    { set_at: `2026-07-17T${String(index % 18).padStart(2, '0')}:00:00.000Z`,
      note: `Completed grounded action ${index} ${'with bounded detail '.repeat(8)}` },
  ]));
  markers['duplicate-action'] = { set_at: '2026-07-17T17:30:00.000Z',
    note: markers['task-completed:19'].note };
  const memory = [
    ...Array.from({ length: 80 }, (_, index) => ({ source: 'auto', added: '2026-07-17',
      fact: `AUTO PROJECT FACT ${index} ${'not an action '.repeat(30)}` })),
    { source: 'meeting', added: '2026-07-17', fact: 'MEETING TRANSCRIPT FACT' },
    { source: 'manual', added: '2026-07-17', fact: 'Manually recorded a real action' },
  ];
  const block = __test.buildRecentActivityBlock({ markers, memory, now });
  assert.ok(block.length <= 1500);
  assert.match(block, /from action markers/);
  assert.match(block, /Manually recorded a real action/);
  assert.doesNotMatch(block, /AUTO PROJECT FACT|MEETING TRANSCRIPT FACT/);
  assert.equal((block.match(/Completed grounded action 19/g) || []).length, 1);
});

test('Slack interaction logging appends one durable row instead of rewriting the review ledger', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('function logInteraction(entry)');
  const end = server.indexOf('\nfunction handleInteractionOutcome', start);
  assert.ok(start >= 0 && end > start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /persistInteractionAppend\(items, interaction,/);
  assert.doesNotMatch(implementation, /saveInteractions\(items\)/);
  assert.match(server, /db\.appendInteraction\(snapshot, removals\)/);
});

test('interaction reviews update only changed durable rows', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('function saveInteractions(items)');
  const end = server.indexOf('\nfunction persistInteractionAppend', start);
  assert.ok(start >= 0 && end > start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /diffInteractionPersistence\(_persistedInteractionState, snapshot\)/);
  assert.match(implementation, /db\.applyInteractionChanges\(delta\)/);
  assert.doesNotMatch(implementation, /replaceAllInteractions/);
});

test('dream reflection updates persist only changed dream rows', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('function saveDreams(dreams)');
  const end = server.indexOf('\nconst MAX_DREAMS_KEPT', start);
  assert.ok(start >= 0 && end > start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /diffDreamPersistence\(_persistedDreamState, snapshot\)/);
  assert.match(implementation, /db\.applyDreamChanges\(delta\)/);
  assert.doesNotMatch(implementation, /replaceAllDreams/);
  assert.match(implementation, /\{ strict: true \}/);
});

test('project-scoped memory activity upserts one project instead of rewriting the project ledger', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('function bumpProjectActivity(name)');
  const end = server.indexOf('\nfunction loadGiftLedger', start);
  assert.ok(start >= 0 && end > start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /persistProject\(projects, proj\)/);
  assert.doesNotMatch(implementation, /saveProjects\(projects\)/);
  assert.match(server, /db\.upsertProject\(snapshot\)/);
});

test('Slack thread activity persists only changed thread rows', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('function saveSlackThreads(threads)');
  const end = server.indexOf('\n// In-memory cache of joined threads', start);
  assert.ok(start >= 0 && end > start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /diffSlackThreadPersistence\(_persistedSlackThreadState, snapshot\)/);
  assert.match(implementation, /db\.applySlackThreadChanges\(delta\)/);
  assert.doesNotMatch(implementation, /replaceAllSlackThreads/);
});

test('Slack uses a fast Claude path only for bounded conversational turns', async () => {
  const { __test } = require('../../server');
  assert.equal(__test.slackResponseModel('whatd you do today'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('thanks for your work today'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('what is due tomorrow for me?'), 'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel(`Team update: ${'Victory Propane launched cleanly and the rollout is continuing. '.repeat(8)}`),
    'claude-sonnet-4-6');
  assert.equal(__test.slackResponseModel('Analyze the launch risks and build a mitigation plan.'),
    'claude-opus-4-8');
  assert.equal(__test.slackResponseModel('Why did the launch slip?'), 'claude-opus-4-8');
  assert.equal(__test.slackResponseModel('whatd you do today', 'proactive'), 'claude-opus-4-8');
  const fallback = await __test.settleWithin(new Promise(() => {}), 5, [], 'test lookup');
  assert.deepEqual(fallback, []);
  let aborted = false;
  const abortableFallback = await __test.settleWithinAbortable(signal => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(['late']); }, { once: true });
  }), 5, [], 'abortable test lookup');
  assert.deepEqual(abortableFallback, []);
  assert.equal(aborted, true);
});

test('Slack enrichment deadlines abort their losing network requests', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server,
    /settleWithinAbortable\(\s*signal => getSlackUserName\(user, \{ signal \}\), 1200/);
  assert.match(server,
    /signal => fetchSlackThread\(channel, threadTs, \{ signal \}\)/);
  assert.match(server,
    /signal => fetchSlackChannelHistory\(channel, threadTs, 25, \{ signal \}\)/);
  assert.match(server,
    /signal => buildSlackThreadHistory\(threadMsgs, noraBotUserId, \{ signal \}\)/);
  assert.match(server,
    /fetchUrlText\(u, \{ signal \}\)/);
  assert.match(server,
    /users\.info[\s\S]{0,300}timeout: 5000, signal/);
  assert.match(server,
    /conversations\.replies[\s\S]{0,350}timeout: 6000, signal/);
  assert.match(server,
    /conversations\.history[\s\S]{0,450}timeout: 6000, signal/);
});

test('Slack waits for one coherent reply instead of posting a generic progress message', () => {
  const { __test } = require('../../server');
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('async function handleSlackImpl');
  const end = server.indexOf('// Slack thread admin', start);
  const slackHandler = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(slackHandler, /on it\s*[—-]+\s*checking the live details/i);
  assert.doesNotMatch(slackHandler, /earlyStatus(?:Timer|Promise)/);
  assert.match(slackHandler, /reply = stripSlackLookupNarration\(reply\)/,
    'Slack must strip historical lookup narration if the model reproduces it');
  const finalGuard = slackHandler.indexOf('reply = finalActionClaimGuard.response;');
  const delivery = slackHandler.indexOf('// Burst delivery:', finalGuard);
  const egressScrub = slackHandler.indexOf('reply = stripSlackLookupNarration(reply);', finalGuard);
  assert.ok(finalGuard >= 0 && egressScrub > finalGuard && delivery > egressScrub,
    'Slack must scrub lookup narration again after every response-rewriting safety pass');
  assert.equal(__test.stripSlackLookupNarration(
    'on it — checking the live details now.\n\nyeah, Wednesday in July hits different'),
  'yeah, Wednesday in July hits different');
  assert.equal(__test.stripSlackLookupNarration(
    'One sec, pulling that up now. The task is due Friday.'), 'The task is due Friday.');
  assert.equal(__test.stripSlackLookupNarration('On it — checking the live details now.'),
    '', 'a status-only provider result must continue into the ordinary empty-response recovery');
  assert.equal(__test.stripSlackLookupNarration('On it. I moved the task to Friday.'),
    'On it. I moved the task to Friday.',
  'a real completion acknowledgement is not lookup narration');
});

test('typed meeting chat never promises an unqueued Slack follow-up', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /Give me a sec, I'll follow up in Slack/);
  assert.match(server, /I couldn't get a complete answer before this meeting turn closed/);
});

test('Slack preflights, main tool loop, and retries share one absolute interaction deadline', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf('async function handleSlackImpl');
  const end = server.indexOf('// Slack thread admin', start);
  const handler = server.slice(start, end);
  assert.match(handler,
    /slackTerminalAt = boundedTerminalAt\(\s*interactionStartedAt \+ \(attachLiveTools \? 45000 : 8000\)\)/,
    'ordinary and recovery Slack turns must share the earlier absolute terminal deadline');
  assert.match(handler, /slackRemainingMs\(12000\)/,
    'experimental preflight calls must preserve a main-answer reserve');
  assert.match(handler, /deadlineMs: Math\.max\(1, slackRemainingMs\(\)\)/,
    'the main model/tool loop must receive only the remaining wall-clock budget');
  assert.match(handler, /const retryBudgetMs = Math\.min\(12000, slackRemainingMs\(\)\)/,
    'the no-tools recovery must not receive a fresh 12-second budget');
  assert.match(handler, /const deliveryBudgetMs = Math\.min\(5000, slackTerminalAt - Date\.now\(\)\)/,
    'Slack delivery must spend only the interaction budget that remains');
  assert.match(handler, /timeout: deliveryBudgetMs/);
  assert.match(handler, /const errorDeliveryBudgetMs = Math\.min\(5000, slackTerminalAt - Date\.now\(\)\)/,
    'the error notice must not extend an already-expired interaction');
  assert.doesNotMatch(handler, /deadlineMs: attachLiveTools \? 45000/);
  assert.doesNotMatch(handler, /timeout: 12000 \}\), 12000, 'Slack no-tools retry'/);
});

test('typed meeting delivery shares the same trigger-to-message deadline', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /const zoomDeliveryBudgetMs = Math\.min\(5000, zoomTerminalAt - Date\.now\(\)\)/);
  assert.match(server, /timeout: zoomDeliveryBudgetMs/);
  assert.match(server, /const errorDeliveryBudgetMs = Math\.min\(5000, zoomTerminalAt - Date\.now\(\)\)/);
});

test('Slack missed-mention recovery aborts the full workspace scan at one deadline', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/slack/unhandled-mentions'");
  const end = server.indexOf('// Notify endpoint', start);
  const handler = server.slice(start, end);
  assert.match(handler, /const scanController = new AbortController\(\)/);
  assert.match(handler, /Slack unhandled mention scan exceeded its 15-second deadline/);
  assert.match(handler, /getNoraBotUserId\(\{ signal: scanController\.signal \}\)/);
  assert.ok((handler.match(/signal: scanController\.signal/g) || []).length >= 3,
    'membership and channel-history transports must all receive cancellation');
  assert.match(handler, /if \(scanController\.signal\.aborted\) return/);
  assert.match(handler, /res\.status\(timedOut \? 504 : 500\)/);
  assert.match(handler, /clearTimeout\(scanDeadline\)/);
});

test('interactive memory recall is local, bounded, and relevance preserving', () => {
  const { __test } = require('../../server');
  const memories = [
    { id: 'kizik', fact: 'The Kizik brief was rebuilt with charts and a flow diagram.',
      project: 'Kizik', added: '2026-07-22T12:00:00.000Z', salience: 0.8 },
    { id: 'lct', fact: 'LCT Phase 2 is waiting on Gracie.', project: 'LCT',
      added: '2026-07-22T13:00:00.000Z', salience: 0.7 },
    { id: 'marker', fact: 'Filed transcript abc', source: 'marker',
      added: '2026-07-22T14:00:00.000Z' },
  ];
  const ranked = __test.rankLexicalMemories(memories,
    'What happened with the Kizik brief and its charts?', 2);
  assert.equal(ranked[0].id, 'kizik');
  assert.equal(ranked[0]._recall_mode, 'local_lexical');
  assert.ok(ranked.length <= 2);
  assert.deepEqual(__test.rankLexicalMemories(memories, 'hello there', 2), []);
});

test('scheduled intelligence defers without touching providers while a person has the foreground', async () => {
  performance.resetPriorityGateForTest();
  const foreground = performance.beginInteractive('realtime');
  const { __test } = require('../../server');
  let providerCalls = 0;
  const result = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'test', post: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  assert.equal(result.state, 'deferred_for_interactive_priority');
  assert.equal(result.reason, 'interactive_active');
  assert.equal(providerCalls, 0);
  foreground.release();
  performance.resetPriorityGateForTest();
});

test('scheduled intelligence defers without touching providers during process pressure', async () => {
  performance.resetPriorityGateForTest();
  const { __test } = require('../../server');
  const originalAdmission = __test.processResources.backgroundAdmission;
  __test.processResources.backgroundAdmission = () => ({ allowed: false,
    reason: 'event_loop_pressure', retry_after_ms: 30000 });
  let providerCalls = 0;
  try {
    const result = await __test.runBackgroundIntelligenceRuntime({
      trigger: 'resource-pressure-test',
      post: async () => { providerCalls += 1; throw new Error('must not run'); },
    });
    assert.equal(result.state, 'deferred_resource_pressure');
    assert.equal(result.reason, 'event_loop_pressure');
    assert.equal(providerCalls, 0);
  } finally {
    __test.processResources.backgroundAdmission = originalAdmission;
  }
});

test('screen-share work yields through human speech, Nora speech, and the quiet window', () => {
  const { __test } = require('../../server');
  assert.deepEqual(__test.screenShareVoiceGate({}, 10000), {
    allowed: true, reason: null, retry_after_ms: 0,
  });
  assert.equal(__test.screenShareVoiceGate({ voiceResponseActive: true }, 10000).reason,
    'nora_speaking');
  assert.equal(__test.screenShareVoiceGate({ voiceHumanSpeechStartedAt: 9000 }, 10000).reason,
    'human_speaking');
  assert.deepEqual(__test.screenShareVoiceGate({
    voiceHumanSpeechStartedAt: 8000, voiceSpeechStoppedAt: 9500,
  }, 10000), { allowed: false, reason: 'speech_cooldown', retry_after_ms: 1000 });
  assert.equal(__test.screenShareVoiceGate({
    voiceHumanSpeechStartedAt: 8000, voiceSpeechStoppedAt: 9500,
  }, 11000).allowed, true);
});

test('realtime telemetry is batched until the voice foreground and cooldown have ended', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(serverSource, /const deferredRealtimeTraces = \[\]/);
  assert.match(serverSource, /traceSink: queueRealtimeTrace/);
  assert.match(serverSource, /queueRealtimeTrace\(\{[\s\S]{0,120}action: 'barge_in'/);
  assert.match(serverSource,
    /priority\.active_interactions > 0 \|\| priority\.quiet_remaining_ms > 0/);
  assert.match(serverSource, /intelligence\.recordTraces\(traces\)/);
});

test('embedding transport accepts foreground preemption instead of lingering to its private timeout', async () => {
  const db = require('../../db');
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const controller = new AbortController();
  let transportAborted = false;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      transportAborted = true;
      reject(options.signal.reason || new Error('aborted'));
    }, { once: true });
  });
  try {
    const pending = db.embed('background memory', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort(new Error('live Slack turn arrived'));
    assert.equal(await pending, null);
    assert.equal(transportAborted, true);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
