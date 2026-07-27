'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const performance = require('../../src/intelligence/interactive-performance');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-background-fairness-'));
process.env.NORA_TEST_MODE = '1';
process.env.NORA_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_PUBLIC_URL;

const { __test } = require('../../server');

test.beforeEach(() => {
  performance.resetPriorityGateForTest();
  __test.resetBackgroundIntelligenceStepCursorsForTest();
});

test.afterEach(() => {
  performance.resetPriorityGateForTest();
  __test.resetBackgroundIntelligenceStepCursorsForTest();
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function injectedSteps(names, actionForName) {
  return names.map(name => [name, signal => actionForName(name, signal)]);
}

test('repeated first-step timeouts rotate every injected step into first position', async () => {
  const names = ['research', 'reflection', 'reading', 'play'];
  const firstAttempts = [];

  for (let pass = 0; pass < names.length; pass += 1) {
    let settleTimedOutStep;
    const result = await __test.runBackgroundIntelligenceRuntime({
      trigger: `timeout-pass-${pass}`,
      budget: {
        step_timeout_ms: 8,
        cycle_timeout_ms: 100,
        max_event_loop_lag_ms: 1000,
      },
      scheduledSteps: injectedSteps(names, () => new Promise(resolve => {
        settleTimedOutStep = resolve;
      })),
    });

    firstAttempts.push(result.attempted_step_order[0]);
    assert.equal(result.state, 'deferred_runtime_budget');
    assert.equal(result.start_cursor, pass);
    assert.equal(result.next_cursor, (pass + 1) % names.length);
    assert.equal(result.start_step, names[pass]);
    assert.equal(result.next_step, names[(pass + 1) % names.length]);
    assert.deepEqual(result.attempted_step_order, [names[pass]]);
    assert.equal(result.cursor_persistence, 'process_memory_only');
    assert.equal(result.quarantined_step.name, names[pass]);
    settleTimedOutStep();
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepEqual(firstAttempts, names,
    'no later research, reflection, reading, or play step may starve behind an early timeout');
});

test('a non-cooperative timed-out step keeps the cycle fence until it actually settles', async () => {
  let settleAction;
  const first = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'non-cooperative-timeout',
    budget: {
      step_timeout_ms: 8,
      cycle_timeout_ms: 100,
      max_event_loop_lag_ms: 1000,
    },
    scheduledSteps: injectedSteps(['research'], () => new Promise(resolve => {
      settleAction = resolve;
    })),
  });

  assert.equal(first.state, 'deferred_runtime_budget');
  assert.equal(first.quarantined_step.name, 'research');
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 1);

  const overlapping = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'must-not-overlap',
    budget: {
      step_timeout_ms: 20,
      cycle_timeout_ms: 100,
      max_event_loop_lag_ms: 1000,
    },
    scheduledSteps: [['play', () => ({ ran: true })]],
  });
  assert.equal(overlapping.state, 'in_flight');

  settleAction();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 0);
});

test('a permanently non-cooperative step escalates to process recovery without releasing its fence', async () => {
  let settleAction;
  let resolveEscalation;
  const escalation = new Promise(resolve => { resolveEscalation = resolve; });
  const escalations = [];
  const result = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'non-cooperative-restart-test',
    budget: {
      step_timeout_ms: 8,
      cycle_timeout_ms: 100,
      max_event_loop_lag_ms: 1000,
    },
    quarantineGraceMs: 15,
    onQuarantineExpired: (name, error) => {
      escalations.push({ name, error });
      resolveEscalation();
    },
    scheduledSteps: injectedSteps(['research'], () => new Promise(resolve => {
      settleAction = resolve;
    })),
  });

  await Promise.race([
    escalation,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('quarantine watchdog did not escalate')), 250)),
  ]);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].name, 'research');
  assert.equal(escalations[0].error.code, 'background_step_noncooperative_timeout');
  assert.equal(result.quarantined_step.state, 'restart_requested');
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 1,
    'fatal recovery must not permit overlapping background state mutation');

  const overlapping = await __test.runBackgroundIntelligenceRuntime({
    trigger: 'still-fenced-after-escalation',
    scheduledSteps: [['play', () => ({ ran: true })]],
  });
  assert.equal(overlapping.state, 'in_flight');

  settleAction();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 0);
});

test('ordinary step failures do not pin the rotating cursor', async () => {
  const names = ['research', 'reflection', 'reading', 'play'];
  const firstAttempts = [];

  for (let pass = 0; pass < names.length; pass += 1) {
    const result = await __test.runBackgroundIntelligenceRuntime({
      trigger: `failure-pass-${pass}`,
      budget: {
        step_timeout_ms: 100,
        cycle_timeout_ms: 1000,
        max_event_loop_lag_ms: 1000,
      },
      scheduledSteps: injectedSteps(names, name => {
        const error = new Error(`${name} failed`);
        error.code = 'injected_failure';
        throw error;
      }),
    });

    firstAttempts.push(result.attempted_step_order[0]);
    assert.equal(result.state, 'completed',
      'an ordinary action failure is recorded but does not cancel the remaining pass');
    assert.equal(result.start_cursor, pass);
    assert.equal(result.next_cursor, (pass + 1) % names.length);
    assert.equal(result.attempted_step_order.length, names.length);
    assert.ok(names.every(name => result.steps[name].state === 'failed'));
  }

  assert.deepEqual(firstAttempts, names);
});

test('owner abort promptly cancels the optional lease and stops the cycle', async () => {
  const owner = new AbortController();
  let observedLeaseSignal = null;
  let releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  let settleResearch;
  let laterStepRan = false;

  const running = __test.runBackgroundIntelligenceRuntime({
    trigger: 'owner-abort-test',
    signal: owner.signal,
    budget: {
      step_timeout_ms: 5000,
      cycle_timeout_ms: 10000,
      max_event_loop_lag_ms: 1000,
    },
    scheduledSteps: [
      ['research', signal => {
        observedLeaseSignal = signal;
        releaseStarted();
        return new Promise(resolve => { settleResearch = resolve; });
      }],
      ['play', () => {
        laterStepRan = true;
        return { ran: true };
      }],
    ],
  });

  await started;
  const abortedAt = Date.now();
  owner.abort(new Error('recurring owner timed out'));
  let guard = null;
  const result = await Promise.race([
    running,
    new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('background cycle ignored owner abort')), 250);
    }),
  ]);
  clearTimeout(guard);

  assert.ok(Date.now() - abortedAt < 250);
  assert.equal(observedLeaseSignal.aborted, true);
  assert.equal(result.state, 'deferred_runtime_budget');
  assert.equal(result.stopped_reason, 'owner_abort');
  assert.deepEqual(result.attempted_step_order, ['research']);
  assert.equal(result.steps.research.code, 'background_step_aborted');
  assert.equal(laterStepRan, false);
  assert.equal(result.quarantined_step.name, 'research');
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 1);
  settleResearch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(performance.prioritySnapshot().background_provider_in_flight, 0);
});

test('recurring owner deadline clamps the optional cycle after operational work', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const budget = __test.backgroundIntelligenceBudgetForOwner(
    new Date(now + 60000).toISOString(),
    {
      now,
      ownerReserveMs: 5000,
      budget: {
        step_timeout_ms: 90000,
        cycle_timeout_ms: 180000,
        max_event_loop_lag_ms: 250,
      },
    },
  );
  assert.deepEqual(budget, {
    step_timeout_ms: 55000,
    cycle_timeout_ms: 55000,
    max_event_loop_lag_ms: 250,
  });
  assert.equal(__test.backgroundIntelligenceRuntimeBudget({}).cycle_timeout_ms, 50000);

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const scheduler = source.slice(
    source.indexOf("scheduleRecurringRuntimeJob('operational-and-intelligence-cycle'"),
    source.indexOf("scheduleRecurringRuntimeJob('stale-research-projection-refresh'"));
  assert.match(scheduler,
    /async \(\{ run_number: runNumber, signal, deadline_at: deadlineAt \}\)/);
  assert.match(scheduler, /backgroundIntelligenceBudgetForOwner\(deadlineAt\)/);
  assert.match(scheduler,
    /runBackgroundIntelligenceRuntime\(\{[\s\S]*?trigger, signal, budget: backgroundBudget/);
});
