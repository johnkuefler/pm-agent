'use strict';

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const REQUIRED_ROUTINE_MARKERS = Object.freeze([
  '## Step 0.5: Start the Intelligence Cycle',
  '## Step 0.7: EXPECT',
  '## Step 0.75: Consume the Subject Research Inbox',
  'DIALS phase two is a blinded causal measurement',
]);

function assessRoutineContract(routine = {}) {
  const content = typeof routine.content === 'string' ? routine.content : '';
  const missingMarkers = REQUIRED_ROUTINE_MARKERS.filter(marker => !content.includes(marker));
  const orderedSteps = REQUIRED_ROUTINE_MARKERS.slice(0, 3).map(marker => content.indexOf(marker));
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

function transcriptCheckpointsWedged(checkpoints = {}) {
  const attempts = Math.max(0, Number(checkpoints.maximum_retry_attempt) || 0);
  const retrying = Math.max(0, Number(checkpoints.retrying) || 0);
  // The bounded retry gives up after six attempts (two for an unresolvable divergence), so anything
  // past this is a lane that is not going to recover on its own no matter how long the gate waits.
  return retrying > 0 && attempts >= WEDGED_RETRY_ATTEMPTS;
}

function assessDeployReadiness({ lock = {}, activeBots = {}, routine = null,
  researchAutopilot = null, behavioralFingerprints = null, runtimePerformance = null } = {}) {
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
  if (researchAutopilot) {
    const priority = researchAutopilot.interactive_priority || {};
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
    // Scheduled intelligence is explicitly preemptible, is cancelled and drained by the shutdown
    // coordinator before final persistence, and retries on the next scheduler pass. Blocking on
    // this lane made deployability depend on catching a tiny idle gap between recurring background
    // cycles. Human interactions, run lifecycles, meetings, and durable writes remain blockers.
  }
  if (behavioralFingerprints) {
    const activeRuns = Array.isArray(behavioralFingerprints.runs)
      ? behavioralFingerprints.runs.filter(run => run.status === 'active') : [];
    const activeCount = Math.max(Number(behavioralFingerprints.report?.active) || 0,
      activeRuns.length);
    if (activeCount > 0) {
      blockers.push({ kind: 'build_bound_behavioral_fingerprint', count: activeCount,
        run_ids: activeRuns.map(run => run.id).filter(Boolean) });
    }
  }
  if (runtimePerformance) {
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
      } else blockers.push(entry);
    }
    const postInteraction = runtimePerformance.background_work?.post_interaction || {};
    const queued = Math.max(0, Number(postInteraction.queued) || 0);
    if (queued > 0 || postInteraction.busy === true) {
      blockers.push({ kind: 'post_interaction_work_pending', queued,
        busy: postInteraction.busy === true, next: postInteraction.next || null });
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
  const [lock, activeBots, routine, researchAutopilot, behavioralFingerprints,
    runtimePerformance] = await Promise.all([
    fetchJson('/run-lock', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/admin/active-bots', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/routine', { baseUrl: normalizedBase, apiKey, fetchImpl, timeoutMs: 90000 }),
    fetchJson('/consciousness-research/autopilot', {
      baseUrl: normalizedBase, apiKey, fetchImpl, timeoutMs: 90000,
    }),
    fetchJson('/self-model/fingerprints', {
      baseUrl: normalizedBase, apiKey, fetchImpl, timeoutMs: 90000,
    }),
    fetchJson('/runtime/performance', { baseUrl: normalizedBase, apiKey, fetchImpl }),
  ]);
  return { ...assessDeployReadiness({ lock, activeBots, routine, researchAutopilot,
    behavioralFingerprints, runtimePerformance }),
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
  transcriptCheckpointsWedged, assessRoutineContract,
  assessDeployReadiness, checkDeployReadiness };
