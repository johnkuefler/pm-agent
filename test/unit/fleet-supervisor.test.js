'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emptyState,
  decodeToolResult,
  operationalObservation,
  eventObservation,
  learningSummary,
  reconcileState,
  interruptionMessage,
  createFleetSupervisor,
} = require('../../src/fleet/supervisor');

const AT = new Date('2026-08-08T18:00:00.000Z');

function fleetSnapshot(observations, agents = []) {
  return {
    fleet: { generated_at: AT.toISOString(), total: agents.length, counts: {}, needs_attention: [] },
    learning: { total: 0, proposed: 0, held: 0, adopted: 0, promoted: 0, closure_rate: 0 },
    agents,
    observations,
  };
}

test('decodes JSON from an MCP text result', () => {
  assert.deepEqual(decodeToolResult({ content: [{ type: 'text', text: '{"ok":true}' }] }), { ok: true });
});

test('the first Fleet scan establishes a silent baseline', () => {
  const observation = operationalObservation({
    slug: 'site-agent', client: 'Site', status: 'stuck', detail: 'Run is silent.',
  }, AT);
  const result = reconcileState(emptyState(AT), fleetSnapshot([observation]), { now: AT, notify: true });
  assert.equal(result.baseline, true);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.state.incidents[0].status, 'open');
  assert.equal(result.state.quiet.baseline_suppressions, 1);
});

test('repeated evidence merges into one incident without becoming material again', () => {
  const firstAt = new Date('2026-08-08T18:00:00.000Z');
  const secondAt = new Date('2026-08-08T18:15:00.000Z');
  const first = operationalObservation({ slug: 'site-agent', client: 'Site', status: 'blocked', detail: 'Credential expired.' }, firstAt);
  let result = reconcileState(emptyState(firstAt), fleetSnapshot([first]), { now: firstAt, notify: true });
  const repeated = operationalObservation({ slug: 'site-agent', client: 'Site', status: 'blocked', detail: 'Credential expired.' }, secondAt);
  result = reconcileState(result.state, fleetSnapshot([repeated]), { now: secondAt, notify: true });
  assert.equal(result.state.incidents.length, 1);
  assert.equal(result.state.incidents[0].occurrences, 2);
  assert.equal(result.material.length, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.state.quiet.unchanged_suppressions, 1);
});

test('a material escalation can become one human interruption candidate', () => {
  const firstAt = new Date('2026-08-08T18:00:00.000Z');
  const secondAt = new Date('2026-08-08T18:15:00.000Z');
  let result = reconcileState(emptyState(firstAt), fleetSnapshot([
    operationalObservation({ slug: 'site-agent', client: 'Site', status: 'overdue', detail: 'One tick late.' }, firstAt),
  ]), { now: firstAt, notify: true });
  result = reconcileState(result.state, fleetSnapshot([
    operationalObservation({ slug: 'site-agent', client: 'Site', status: 'stuck', detail: 'The open run has gone silent.' }, secondAt),
  ]), { now: secondAt, notify: true });
  assert.equal(result.state.incidents.length, 1);
  assert.equal(result.state.incidents[0].severity, 'critical');
  assert.equal(result.material.length, 1);
  assert.equal(result.candidates.length, 1);
});

test('a recovered operational incident closes without a notification candidate', () => {
  let result = reconcileState(emptyState(AT), fleetSnapshot([
    operationalObservation({ slug: 'site-agent', client: 'Site', status: 'stuck', detail: 'Run is silent.' }, AT),
  ]), { now: AT, notify: true });
  const recoveredAt = new Date('2026-08-08T18:30:00.000Z');
  result = reconcileState(result.state, fleetSnapshot([], [{
    slug: 'site-agent', status: 'healthy', lastRunAt: recoveredAt.toISOString(),
    run: { status: 'ok', startedAt: recoveredAt.toISOString() },
  }]), { now: recoveredAt, notify: true });
  assert.equal(result.state.incidents[0].status, 'resolved');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.state.quiet.recoveries_closed_silently, 1);
});

test('an event incident remains open until a later successful run provides recovery evidence', () => {
  const event = eventObservation({
    id: 'event-1', slug: 'qa-agent', client: 'QA', type: 'blocked', severity: 'warn',
    message: 'Required guard is unset and needs human repair.', occurredAt: AT.toISOString(),
  }, AT);
  let result = reconcileState(emptyState(AT), fleetSnapshot([event], [{
    slug: 'qa-agent', status: 'healthy', lastRunAt: AT.toISOString(),
    run: { status: 'ok', startedAt: AT.toISOString() },
  }]), { now: AT, notify: true });
  const nextAt = new Date('2026-08-08T18:15:00.000Z');
  result = reconcileState(result.state, fleetSnapshot([], [{
    slug: 'qa-agent', status: 'healthy', lastRunAt: nextAt.toISOString(),
    run: { status: 'ok', startedAt: nextAt.toISOString() },
  }]), { now: nextAt, notify: true });
  assert.equal(result.state.incidents[0].status, 'resolved');
});

test('learning summary distinguishes accumulation from adopted behavior', () => {
  assert.deepEqual(learningSummary([
    { status: 'proposed', total: 83 }, { status: 'held', total: 316 },
    { status: 'adopted', total: 0 }, { status: 'promoted', total: 0 },
    { status: 'superseded', total: 1 },
  ]), {
    total: 400, proposed: 83, held: 316, adopted: 0, promoted: 0,
    rejected: 0, superseded: 1, closure_rate: 0,
  });
});

test('the interruption message groups incidents into one quiet-management notice', () => {
  const message = interruptionMessage([
    { client: 'One', agent_slug: 'one', title: 'Credential expired.' },
    { client: 'Two', agent_slug: 'two', title: 'Runner is stuck.' },
  ]);
  assert.match(message, /Fleet needs attention on 2 incidents/);
  assert.match(message, /stay quiet unless something materially changes/);
});

test('scheduled supervision sends only after baseline and uses the shared budget once', async () => {
  let clock = new Date('2026-08-08T18:00:00.000Z');
  let status = 'overdue';
  let saved = null;
  let spent = 0;
  const messages = [];
  const tools = [
    { name: 'fleet_status', allowed: true }, { name: 'agent_detail', allowed: true },
    { name: 'list_agent_runs', allowed: true }, { name: 'list_agents', allowed: true },
    { name: 'recent_activity', allowed: true }, { name: 'list_learnings', allowed: true },
  ];
  const manager = {
    list: () => [{ id: 'fleet', name: 'Fleet', status: 'connected', enabled: true, tools }],
    callTool: async (id, tool, args) => {
      if (tool === 'fleet_status') return { generatedAt: clock.toISOString(), total: 1, counts: { [status]: 1 }, needsAttention: ['a'], agents: [{ slug: 'a', client: 'A', status, detail: `${status} now`, overdueSince: '2026-08-08T10:00:00.000Z' }] };
      if (tool === 'list_agents') return { agents: [{ slug: 'a', client: 'A', runnerReady: true, configWarnings: [] }] };
      if (tool === 'recent_activity') return { events: [] };
      if (tool === 'list_learnings') return { total: args.status === 'held' ? 2 : 0 };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  const supervisor = createFleetSupervisor({
    mcpManager: manager,
    loadState: async () => saved,
    saveState: async state => { saved = structuredClone(state); },
    now: () => clock,
    getInterruptionBudget: () => ({ limit: 1, spent, remaining: 1 - spent }),
    spendInterruption: () => { spent += 1; return { allowed: true, limit: 1, spent, remaining: 1 - spent }; },
    notifyHuman: async message => { messages.push(message); return true; },
  });
  const baseline = await supervisor.scan({ notify: true });
  assert.equal(baseline.scan.baseline, true);
  assert.equal(messages.length, 0);

  clock = new Date('2026-08-08T18:15:00.000Z');
  status = 'stuck';
  const escalation = await supervisor.scan({ notify: true });
  assert.equal(escalation.scan.candidates, 1);
  assert.equal(messages.length, 1);
  assert.equal(spent, 0, 'critical incidents bypass the daily slot');

  clock = new Date('2026-08-08T18:30:00.000Z');
  await supervisor.scan({ notify: true });
  assert.equal(messages.length, 1, 'unchanged critical evidence stays silent');
});
