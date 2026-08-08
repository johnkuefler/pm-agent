'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecutiveFirewallRuntime } = require('../../src/executive/runtime');

test('dispatcher groups decision packets into one budgeted executive interruption', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-executive-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let spent = 0;
  const messages = [];
  const runtime = createExecutiveFirewallRuntime({
    dataDirectory: directory,
    databaseReady: () => false,
    writeThrough: async (_key, operation) => operation(),
    intelligence: {
      initiativeStatus: scope => ({ scope, limit: 1, spent, remaining: 1 - spent }),
      spendInitiative: scope => {
        spent += 1;
        return { allowed: true, scope, limit: 1, spent, remaining: 1 - spent };
      },
    },
    resolveOwner: () => 'UJOHN',
    postMessage: async (target, message) => {
      messages.push({ target, message });
      return { ts: '123.456' };
    },
    loadProjectControl: () => null,
    loadFleetSupervisor: async () => null,
  });
  await runtime.hydrate();
  for (const suffix of ['one', 'two']) {
    const intake = await runtime.intake({ source: 'test', source_ref: suffix,
      category: 'project_delivery', severity: 'high', summary: `Decision ${suffix}`,
      owner: 'Nora', executive_gate: 'budget', requires_executive: true,
      next_action: 'Prepare the decision packet.',
      evidence: [{ type: 'test', ref: suffix }] });
    await runtime.prepareDecision(intake.case.id, {
      question: `Approve ${suffix}?`, recommendation: 'Approve the bounded option.',
      consequence: 'The project otherwise slips.', options: ['Approve', 'Accept slip'],
      evidence: [{ type: 'test', ref: suffix }], executive_gate: 'budget',
    });
  }
  const result = await runtime.dispatch();
  assert.equal(result.sent, true);
  assert.equal(spent, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /2 decisions/);
  assert.equal(runtime.snapshot().metrics.executive_interruptions, 1);
  assert.equal(runtime.snapshot().metrics.decision_packets_delivered, 2);
  assert.equal((await runtime.dispatch()).reason, 'none');
});

test('Fleet handoff creates owned recovery work without notifying the executive', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-executive-fleet-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createExecutiveFirewallRuntime({
    dataDirectory: directory, databaseReady: () => false,
    writeThrough: async (_key, operation) => operation(),
    intelligence: { initiativeStatus: () => ({ remaining: 1 }), spendInitiative: () => ({ allowed: true }) },
    resolveOwner: () => 'UJOHN', postMessage: async () => { throw new Error('must stay silent'); },
    loadProjectControl: () => null, loadFleetSupervisor: async () => null,
  });
  await runtime.hydrate();
  const handoff = await runtime.ingestFleetCandidates([{ id: 'incident-1', severity: 'critical',
    title: 'Agent runner is stuck', agent_slug: 'site-agent',
    evidence: [{ type: 'fleet_run', ref: 'run-1' }] }]);
  const item = runtime.snapshot().state.cases[0];
  assert.equal(handoff.accepted, true);
  assert.equal(item.authority_class, 'fleet_recovery');
  assert.equal(item.state, 'resolving');
  assert.equal(item.requires_executive, false);
});

test('the first source reconciliation establishes a silent executive baseline', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-executive-baseline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let messages = 0;
  const runtime = createExecutiveFirewallRuntime({
    dataDirectory: directory, databaseReady: () => false,
    writeThrough: async (_key, operation) => operation(),
    intelligence: { initiativeStatus: () => ({ remaining: 1 }),
      spendInitiative: () => ({ allowed: true, remaining: 0 }) },
    resolveOwner: () => 'UJOHN', postMessage: async () => { messages += 1; return true; },
    loadProjectControl: () => null, loadFleetSupervisor: async () => null,
  });
  await runtime.hydrate();
  const intake = await runtime.intake({ source: 'test', source_ref: 'existing',
    severity: 'high', summary: 'Existing budget decision', executive_gate: 'budget',
    requires_executive: true, evidence: [{ type: 'test', ref: 'existing' }] });
  await runtime.prepareDecision(intake.case.id, { question: 'Approve?', recommendation: 'Approve.',
    consequence: 'Work stops.', options: ['Approve'],
    evidence: [{ type: 'test', ref: 'existing' }] });
  const cycle = await runtime.cycle({ notify: true });
  assert.equal(cycle.delivery.reason, 'silent_baseline');
  assert.equal(messages, 0);
  assert.ok(cycle.state.baseline_at);
  assert.equal(cycle.state.quiet.baseline_suppressions, 1);
  assert.equal((await runtime.dispatch()).reason, 'none');
});
