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
