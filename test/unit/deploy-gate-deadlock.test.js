const test = require('node:test');
const assert = require('node:assert/strict');

const { assessDeployReadiness, transcriptCheckpointsWedged,
  WEDGED_RETRY_ATTEMPTS } = require('../../scripts/check-deploy-readiness');

// The state production was actually in: a transcript diverged from its durable prefix, the
// checkpoint retried without a ceiling, and the reliability verdict went to action_required.
// This gate then refused every deploy for four days, including the one carrying the retry ceiling
// that fixes it.
const WEDGED_RUNTIME = {
  reliability: {
    status: 'action_required',
    action_required: [
      { code: 'entity_persistence_failure', message: 'At least one durable entity write lane has an unresolved failure.' },
      { attempts: 8376, message: 'At least one meeting transcript is repeatedly failing its durable checkpoint.' },
    ],
  },
  background_work: {
    transcript_checkpoints: { pending: 1, scheduled: 1, retrying: 1, maximum_retry_attempt: 8376 },
  },
};

test('a wedged write lane no longer blocks the deploy that would fix it', () => {
  const result = assessDeployReadiness({ runtimePerformance: WEDGED_RUNTIME });
  assert.equal(result.ready, true, 'waiting cannot help; the lane will still be failing in an hour');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.wedged.length, 2, 'both the reliability verdict and the pending checkpoint');
});

test('stepping past a wedged lane is recorded, never silent', () => {
  const { wedged } = assessDeployReadiness({ runtimePerformance: WEDGED_RUNTIME });
  for (const item of wedged) {
    assert.ok(item.reason, `${item.kind} must explain why it was allowed past`);
    assert.equal(item.maximum_retry_attempt, 8376);
  }
  assert.deepEqual(wedged.map(item => item.kind).sort(),
    ['runtime_reliability', 'transcript_checkpoint_pending']);
});

// The property the gate exists to protect. A checkpoint that is genuinely mid-write has not
// exhausted anything yet, and yanking the process out from under it loses the write.
test('a checkpoint that is actually in flight still blocks', () => {
  const result = assessDeployReadiness({
    runtimePerformance: {
      reliability: { status: 'healthy', action_required: [] },
      background_work: { transcript_checkpoints: { pending: 1, scheduled: 1, retrying: 0, maximum_retry_attempt: 0 } },
    },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(b => b.kind), ['transcript_checkpoint_pending']);
  assert.deepEqual(result.wedged, []);
});

test('a lane retrying but not yet past its ceiling still blocks', () => {
  const result = assessDeployReadiness({
    runtimePerformance: {
      reliability: { status: 'action_required', action_required: [{ code: 'transient' }] },
      background_work: {
        transcript_checkpoints: { pending: 1, scheduled: 0, retrying: 1, maximum_retry_attempt: WEDGED_RETRY_ATTEMPTS - 1 },
      },
    },
  });
  assert.equal(result.ready, false, 'a retry that may still converge is real in-flight work');
  assert.deepEqual(result.blockers.map(b => b.kind).sort(),
    ['runtime_reliability', 'transcript_checkpoint_pending']);
});

test('the wedged test needs both an active retry and an exhausted ceiling', () => {
  assert.equal(WEDGED_RETRY_ATTEMPTS, 6, 'the deploy gate must match the transcript retry ceiling');
  assert.equal(transcriptCheckpointsWedged({ retrying: 1, maximum_retry_attempt: 8376 }), true);
  assert.equal(transcriptCheckpointsWedged({ retrying: 0, maximum_retry_attempt: 8376 }), false,
    'a high-water mark with nothing retrying is history, not a stuck lane');
  assert.equal(transcriptCheckpointsWedged({ retrying: 1, maximum_retry_attempt: 2 }), false);
  assert.equal(transcriptCheckpointsWedged({}), false);
});

// Everything else this gate protects is genuinely transient and must keep blocking. A wedged write
// lane is not a licence to deploy through a live meeting or an open run lock.
test('the escape hatch does not widen to unrelated blockers', () => {
  const result = assessDeployReadiness({
    lock: { locked: true, holder: 'cowork' },
    activeBots: { count: 1, bots: [{ id: 'bot-1', status: 'in_call' }] },
    runtimePerformance: WEDGED_RUNTIME,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(b => b.kind).sort(), ['active_meeting', 'run_lock']);
  assert.equal(result.wedged.length, 2, 'the wedged lane is still reported alongside');
});

test('a healthy runtime is unchanged by any of this', () => {
  const result = assessDeployReadiness({
    runtimePerformance: {
      reliability: { status: 'healthy', action_required: [] },
      background_work: { transcript_checkpoints: { pending: 0, scheduled: 0, retrying: 0, maximum_retry_attempt: 0 } },
    },
  });
  assert.deepEqual(result, { ready: true, blockers: [], wedged: [] });
});

// The outage version of the same trap. Clearing a jammed deploy queue took the running instance
// with it, and the next deploy would have been refused by a readiness check that could not reach
// the service it was trying to restore.
test('an unreachable service does not block the deploy that restores it', async () => {
  const { checkDeployReadiness } = require('../../scripts/check-deploy-readiness');
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  const result = await checkDeployReadiness({ apiKey: 'k', fetchImpl: down });
  assert.equal(result.ready, true, 'no instance means no in-flight work to protect');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.wedged[0].kind, 'service_unreachable');
  assert.ok(result.wedged[0].probe_errors.length > 0, 'the outage must be recorded, not glossed');
});

// A half-answering instance is alive and possibly mid-write, which is exactly when caution matters.
test('a partially reachable service still fails closed', async () => {
  const { checkDeployReadiness } = require('../../scripts/check-deploy-readiness');
  let call = 0;
  const flaky = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({}) };
    throw new Error('connect ECONNREFUSED');
  };
  await assert.rejects(checkDeployReadiness({ apiKey: 'k', fetchImpl: flaky }));
});

// Third costume, same mistake, and this time it caught the deploy that fixed it.
//
// interactive_latency_failing and interactive_prompt_failing are p95 verdicts about the build that
// is currently running. Neither can improve while that build is the one serving, so a deploy is the
// only thing that can clear them. Production reported exactly this pair and refused the build
// carrying corrected Slack budgets, which is the correction for that pair.
//
// The distinction is direction, not severity: a signal about work a restart would destroy is a
// reason to wait, a signal about the quality of the code being replaced is an argument for going.
const MEASUREMENT_ONLY_RUNTIME = {
  reliability: {
    status: 'action_required',
    action_required: [
      { code: 'interactive_latency_failing', message: 'A human-facing response surface is failing its measured latency gate.' },
      { code: 'interactive_prompt_failing', message: 'A human-facing response surface is exceeding its prompt-size gate.' },
    ],
  },
  background_work: { transcript_checkpoints: {} },
  requests: {},
};

test('a failing latency or prompt gate does not block the deploy that retunes it', () => {
  const result = assessDeployReadiness({ runtimePerformance: MEASUREMENT_ONLY_RUNTIME });
  assert.equal(result.ready, true,
    'the only way to fix a p95 over budget is to ship different code; blocking on it is circular');
  assert.equal(result.blockers.length, 0);
  assert.equal(result.wedged.length, 1, 'the verdict still has to be visible on the way past');
  assert.match(result.wedged[0].reason, /measures the build being replaced/);
});

test('a measurement verdict mixed with real work still blocks on the work', () => {
  const mixed = {
    ...MEASUREMENT_ONLY_RUNTIME,
    reliability: {
      status: 'action_required',
      action_required: [
        { code: 'interactive_prompt_failing', message: 'prompt over budget' },
        { code: 'entity_persistence_failure', message: 'a durable write lane has an unresolved failure' },
      ],
    },
  };
  const result = assessDeployReadiness({ runtimePerformance: mixed });
  assert.equal(result.ready, false,
    'the escape hatch applies only when every signal describes the outgoing build');
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].kind, 'runtime_reliability');
});

test('an empty action_required list is not treated as an all-clear to step past', () => {
  // Defensive: a verdict claiming action_required with no signals is malformed, not permission.
  const result = assessDeployReadiness({
    runtimePerformance: { ...MEASUREMENT_ONLY_RUNTIME,
      reliability: { status: 'action_required', action_required: [] } },
  });
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].kind, 'runtime_reliability');
});
