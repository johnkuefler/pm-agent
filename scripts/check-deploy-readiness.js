'use strict';

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const REQUIRED_ROUTINE_MARKERS = Object.freeze([
  '# Nora scheduled PM routine',
  '## 2. Execute due scheduled tasks',
  '## 3. Maintain project plans',
  '## 4. Maintain calendars',
  '## 5. Process meetings',
  '## 7. Close',
]);

function assessRoutineContract(routine = {}) {
  const content = typeof routine.content === 'string' ? routine.content : '';
  const missingMarkers = REQUIRED_ROUTINE_MARKERS.filter(marker => !content.includes(marker));
  const orderedSteps = REQUIRED_ROUTINE_MARKERS.map(marker => content.indexOf(marker));
  const stepOrderValid = orderedSteps.every(index => index >= 0)
    && orderedSteps.every((index, position) => position === 0 || index > orderedSteps[position - 1]);
  return { valid: Boolean(content) && missingMarkers.length === 0 && stepOrderValid,
    missing_markers: missingMarkers, step_order_valid: stepOrderValid,
    updated_at: routine.updated_at || null, updated_by: routine.updated_by || null };
}

// Waiting only helps when the thing you are waiting for can finish.
//
// Almost every blocker here means "durable work is in flight, do not yank the process out from
// under it", and that clears on its own within seconds. Runtime reliability is different: it is a
// health verdict, not a unit of work. A write lane that is failing repeatedly will still be failing
// in an hour, because nothing in the retry path repairs it.
//
// Treating those two the same deadlocked production for four days. A transcript diverged from its
// durable prefix, the checkpoint retried without a ceiling, the instance reported an unresolved
// persistence failure, and this gate refused every deploy from then on. The retry ceiling that
// fixes it was sitting in the build being refused. The gate was working exactly as written and
// that is precisely why it could not be recovered from: it had made the cure unreachable.
//
// So a wedged lane no longer blocks. It is reported loudly and the deploy proceeds, because
// restarting the process is the remedy for a wedged lane rather than a risk to it. Genuine
// in-flight work still blocks, which is the property this gate exists to protect.
const WEDGED_RETRY_ATTEMPTS = 10;

// The same mistake in a third costume, and this one caught the deploy that fixed it.
//
// These two signals are p95 verdicts about the build that is currently running: its replies are
// slower than budget, or its prompt is larger than budget. Neither can improve while that build is
// the one serving, so the only thing that can clear them is a deploy, and blocking on them means
// the correction can never ship. That is what happened to the build carrying corrected Slack
// budgets: the gate read the old build's failing measurements and refused the fix for them.
//
// The distinction that matters here is not severity, it is direction. A signal about work that
// would be destroyed by a restart is a reason to wait. A signal about the quality of the code being
// replaced is an argument for deploying, not against it. Anything measured stays visible in the
// output either way.
const OUTGOING_BUILD_QUALITY_SIGNALS = new Set([
  'interactive_latency_failing',
  'interactive_prompt_failing',
]);

// Post-interaction extraction is optional and preemptible, but an item can be
// stranded before it ever starts when the shared background lease stays busy.
// Recent or active work still blocks. Only a queue that has been idle for at
// least five minutes, with nothing busy or in flight, is known not to be work a
// restart can interrupt.
const POST_INTERACTION_WEDGED_MIN_AGE_MS = 5 * 60 * 1000;

function postInteractionWorkWedged(postInteraction = {}) {
  const queued = Math.max(0, Number(postInteraction.queued) || 0);
  const oldestAgeMs = Math.max(0, Number(postInteraction.oldest_queued_age_ms) || 0);
  return queued > 0
    && postInteraction.busy !== true
    && postInteraction.in_flight !== true
    && oldestAgeMs >= POST_INTERACTION_WEDGED_MIN_AGE_MS;
}

function transcriptCheckpointsWedged(checkpoints = {}) {
  const attempts = Math.max(0, Number(checkpoints.maximum_retry_attempt) || 0);
  const retrying = Math.max(0, Number(checkpoints.retrying) || 0);
  // The bounded retry gives up after six attempts (two for an unresolvable divergence), so anything
  // past this is a lane that is not going to recover on its own no matter how long the gate waits.
  return retrying > 0 && attempts >= WEDGED_RETRY_ATTEMPTS;
}

function assessDeployReadiness({ lock = {}, activeBots = {}, routine = null,
  runtimePerformance = null } = {}) {
  const blockers = [];
  // Conditions that would once have blocked forever. Surfaced, never silent, but not a veto.
  const wedged = [];
  if (lock.locked) blockers.push({ kind: 'run_lock', holder: lock.holder || null,
    cycle_id: lock.lifecycle?.cycle_id || null, cycle_status: lock.lifecycle?.cycle_status || null });
  if (lock.expired_lease_pending_recovery) {
    blockers.push({ kind: 'run_recovery_pending' });
  }
  const bots = Array.isArray(activeBots.bots) ? activeBots.bots : [];
  if (Number(activeBots.count) > 0 || bots.length > 0) {
    blockers.push({ kind: 'active_meeting', count: Math.max(Number(activeBots.count) || 0, bots.length),
      bots: bots.map(item => ({ id: item.id || null, status: item.status || null,
        meeting_url: item.meeting_url || null })) });
  }
  if (routine) {
    const contract = assessRoutineContract(routine);
    if (!contract.valid) blockers.push({ kind: 'routine_contract', ...contract });
  }
  if (runtimePerformance) {
    const priority = runtimePerformance.interactive_priority || {};
    const activeInteractions = Math.max(0, Number(priority.active_interactions) || 0);
    const activeSurfaces = priority.active_surfaces && typeof priority.active_surfaces === 'object'
      ? priority.active_surfaces : {};
    if (activeInteractions > 0 || Object.values(activeSurfaces).some(value => Number(value) > 0)) {
      blockers.push({ kind: 'interactive_work_in_flight', active_interactions: activeInteractions,
        active_surfaces: activeSurfaces });
    }
    const quietRemainingMs = Math.max(0, Number(priority.quiet_remaining_ms) || 0);
    if (quietRemainingMs > 0) {
      blockers.push({ kind: 'interactive_quiet_window', quiet_remaining_ms: quietRemainingMs,
        last_interactive_surface: priority.last_interactive_surface || null });
    }
    // Optional background work is preemptible and drains during shutdown. Human interactions,
    // run lifecycles, meetings, and durable writes remain blockers.
    const checkpointLane = runtimePerformance.background_work?.transcript_checkpoints || {};
    const laneWedged = transcriptCheckpointsWedged(checkpointLane);
    if (runtimePerformance.reliability?.status === 'action_required') {
      const signals = Array.isArray(runtimePerformance.reliability.action_required)
        ? runtimePerformance.reliability.action_required : [];
      const entry = { kind: 'runtime_reliability', status: 'action_required', signals };
      // A reliability verdict driven by a wedged write lane describes a stuck process, not work in
      // progress. Deploying replaces that process, so it is the fix rather than the hazard.
      if (laneWedged) {
        wedged.push({ ...entry, reason: 'a write lane is retrying past its ceiling and will not '
          + 'recover without a restart; deploying is the remedy',
          maximum_retry_attempt: Math.max(0, Number(checkpointLane.maximum_retry_attempt) || 0) });
      } else if (signals.length && signals.every(signal => OUTGOING_BUILD_QUALITY_SIGNALS.has(signal?.code))) {
        // Every signal is a measurement of the build being replaced, so none of them argue for
        // waiting. A mixed verdict still blocks on whatever else is in it.
        wedged.push({ ...entry, reason: 'every signal measures the build being replaced, and a '
          + 'deploy is the only thing that can change them' });
      } else blockers.push(entry);
    }
    const postInteraction = runtimePerformance.background_work?.post_interaction || {};
    const queued = Math.max(0, Number(postInteraction.queued) || 0);
    if (queued > 0 || postInteraction.busy === true) {
      const entry = { kind: 'post_interaction_work_pending', queued,
        busy: postInteraction.busy === true, next: postInteraction.next || null };
      if (postInteractionWorkWedged(postInteraction)) {
        wedged.push({ ...entry,
          reason: 'optional post-interaction work has not started for at least five minutes; '
            + 'there is no active work to interrupt and restarting clears the stranded queue',
          oldest_queued_age_ms: Math.max(0, Number(postInteraction.oldest_queued_age_ms) || 0) });
      } else blockers.push(entry);
    }
    const pendingCheckpoints = Math.max(0, Number(checkpointLane.pending) || 0);
    const scheduledCheckpoints = Math.max(0, Number(checkpointLane.scheduled) || 0);
    if (pendingCheckpoints > 0 || scheduledCheckpoints > 0) {
      const entry = { kind: 'transcript_checkpoint_pending', pending: pendingCheckpoints,
        scheduled: scheduledCheckpoints };
      // The same stuck checkpoint also shows up here. Waiting for it is waiting for a write that
      // has already refused itself thousands of times.
      if (laneWedged) {
        wedged.push({ ...entry, reason: 'this checkpoint has exceeded its retry ceiling and is not '
          + 'converging; the pending count will not fall on its own',
          maximum_retry_attempt: Math.max(0, Number(checkpointLane.maximum_retry_attempt) || 0) });
      } else blockers.push(entry);
    }
    const persistence = runtimePerformance.persistence || {};
    const persistencePending = Math.max(0, Number(persistence.pending_revisions) || 0);
    const strictWaiters = Math.max(0, Number(persistence.strict_waiters) || 0);
    if (persistencePending > 0 || strictWaiters > 0 || persistence.flush_running === true
      || persistence.cycle_open?.in_flight === true) {
      blockers.push({ kind: 'persistence_work_pending', pending_revisions: persistencePending,
        strict_waiters: strictWaiters, flush_running: persistence.flush_running === true,
        cycle_open_in_flight: persistence.cycle_open?.in_flight === true });
    }
    const entityWrites = runtimePerformance.entity_writes || {};
    const entityWritesPending = Math.max(0, Number(entityWrites.pending) || 0);
    const entityWritesInFlight = Math.max(0, Number(entityWrites.in_flight) || 0);
    if (entityWritesPending > 0 || entityWritesInFlight > 0) {
      blockers.push({ kind: 'entity_write_pending', pending: entityWritesPending,
        in_flight: entityWritesInFlight });
    }
  }
  // `wedged` deliberately does not affect readiness. It must stay in the output so a deploy that
  // proceeded past a stuck lane is visible afterwards rather than looking like an ordinary one.
  return { ready: blockers.length === 0, blockers, wedged };
}

async function fetchJson(path, { baseUrl, apiKey, fetchImpl, timeoutMs = 30000 }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${path} readiness probe failed before response: ${error.message}`);
  }
  if (!response.ok) throw new Error(`${path} readiness probe failed with HTTP ${response.status}`);
  return response.json();
}

async function checkDeployReadiness({
  baseUrl = process.env.NORA_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.NORA_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('NORA_API_KEY is required for the deployment readiness check');
  if (typeof fetchImpl !== 'function') throw new Error('deployment readiness check requires fetch');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const probes = await Promise.allSettled([
    fetchJson('/run-lock', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/admin/active-bots', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/routine', { baseUrl: normalizedBase, apiKey, fetchImpl, timeoutMs: 90000 }),
    fetchJson('/runtime/performance', { baseUrl: normalizedBase, apiKey, fetchImpl }),
  ]);

  // Everything this gate protects is work happening inside a running instance. When there is no
  // instance answering at all there is no run to interrupt, no meeting to cut off, and no write to
  // lose, so refusing the deploy protects nothing and simply keeps the service down.
  //
  // That is not hypothetical. Clearing a jammed deploy queue took the running instance with it, and
  // the next deploy would have been blocked by a readiness check that could not reach the service it
  // was trying to restore. A gate that cannot pass during an outage cannot recover from one.
  //
  // A partial failure stays fail-closed. Some probes answering and others not means the instance is
  // alive and possibly mid-work, which is exactly when caution is warranted.
  if (probes.every(probe => probe.status === 'rejected')) {
    return { ready: true, blockers: [], wedged: [{ kind: 'service_unreachable',
      reason: 'no probe reached the service, so there is no in-flight work to protect and deploying '
        + 'is the only way back up',
      probe_errors: probes.map(probe => String(probe.reason?.message || probe.reason)).slice(0, 6) }],
    checked_at: new Date().toISOString(), base_url: normalizedBase };
  }
  const failed = probes.find(probe => probe.status === 'rejected');
  if (failed) throw failed.reason;
  const [lock, activeBots, routine, runtimePerformance] = probes.map(probe => probe.value);
  return { ...assessDeployReadiness({ lock, activeBots, routine, runtimePerformance }),
    checked_at: new Date().toISOString(),
    base_url: normalizedBase };
}

async function main() {
  try {
    const result = await checkDeployReadiness();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A deploy that stepped over a wedged lane says so on the way past. Silence here is how a
    // recovering deploy becomes indistinguishable from an ordinary healthy one.
    for (const item of result.wedged || []) {
      process.stderr.write(`Proceeding past a wedged runtime condition (${item.kind}): ${item.reason}\n`);
    }
    if (!result.ready) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Deployment readiness failed closed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // Railway runs this as a one-shot pre-deploy container. Node's fetch implementation may retain
  // pooled keep-alive handles after every probe has completed, so setting exitCode alone can leave
  // the deployment in BUILDING indefinitely. All output is synchronously written above; exit only
  // after main has reached its explicit ready/not-ready terminal state.
  main().then(() => process.exit(process.exitCode || 0));
}

module.exports = { DEFAULT_BASE_URL, REQUIRED_ROUTINE_MARKERS, WEDGED_RETRY_ATTEMPTS,
  POST_INTERACTION_WEDGED_MIN_AGE_MS, transcriptCheckpointsWedged,
  postInteractionWorkWedged, assessRoutineContract,
  assessDeployReadiness, checkDeployReadiness };
