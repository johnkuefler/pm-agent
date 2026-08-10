'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecutiveFirewallRuntime,
  teamworkCandidateExecutiveGate } = require('../../src/executive/runtime');

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

test('Teamwork template text cannot manufacture executive decisions', async t => {
  assert.equal(teamworkCandidateExecutiveGate({ title: 'LE - Client review revisions',
    description: 'Note anything out of scope before pushing back to the client.' }), null);
  assert.equal(teamworkCandidateExecutiveGate({ title: 'Approve scope change for launch' }), 'scope');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-executive-teamwork-gates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projects = [{ key: '1621783', pm: 'Mallory', decision_state: { candidates: [{
    id: '40272393', title: 'LE - Client review revisions',
    description: 'Note anything out of scope before pushing back to the client.',
    assignees: ['Lydia Murphy'], evidence_ref: 'teamwork:task:40272393',
  }, {
    id: '40279999', title: 'Approve scope change for launch',
    description: 'A named change order needs an executive decision.',
    assignees: ['Mallory'], evidence_ref: 'teamwork:task:40279999',
  }] } }];
  const runtime = createExecutiveFirewallRuntime({
    dataDirectory: directory, databaseReady: () => false,
    writeThrough: async (_key, operation) => operation(),
    intelligence: { initiativeStatus: () => ({ remaining: 0 }), spendInitiative: () => null },
    resolveOwner: () => 'UJOHN', postMessage: async () => true,
    loadProjectControl: () => ({ projects, risks: [] }), loadFleetSupervisor: async () => null,
  });
  await runtime.hydrate();
  await runtime.intake({ source: 'teamwork_decision', source_ref: '40272393',
    project_key: '1621783', severity: 'medium', summary: 'LE - Client review revisions',
    detail: 'Note anything out of scope before pushing back to the client.', owner: 'Lydia Murphy',
    executive_gate: 'scope', requires_executive: true,
    decision_packet: { question: 'LE - Client review revisions',
      recommendation: 'Accept the project owner recommendation unless it crosses the named executive gate.',
      consequence: 'Template task text', options: ['Approve', 'Override', 'Defer'],
      evidence: [{ type: 'teamwork_decision_candidate', ref: 'teamwork:task:40272393' }] },
    evidence: [{ type: 'teamwork_decision_candidate', ref: 'teamwork:task:40272393' }],
  });

  const reconciliation = await runtime.reconcileSources({ now: new Date('2026-08-09T16:00:00.000Z') });
  const state = runtime.snapshot();
  const falsePositive = state.state.cases.find(item => item.source_ref === '40272393');
  const genuineGate = state.state.cases.find(item => item.source_ref === '40279999');
  assert.equal(falsePositive.state, 'dismissed');
  assert.match(falsePositive.dismissal_reason, /did not establish/);
  assert.equal(genuineGate.state, 'resolving');
  assert.equal(genuineGate.requires_executive, true);
  assert.equal(genuineGate.decision_packet, null);
  assert.match(genuineGate.next_action, /owner recommendation/);
  assert.equal(state.metrics.decisions_ready, 0);
  assert.equal(reconciliation.reconciliation.dismissed_teamwork_false_positives, 1);
});

test('project risk nouns do not create a John obligation without a concrete decision', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-executive-project-risks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = new Date('2026-08-10T15:00:00.000Z');
  const risks = [{
    id: 'risk-rate', project_key: 'project-1', status: 'open', severity: 'medium',
    title: 'Retainer bill rate mismatch', impact: 'The budget language needs PM investigation.',
    owner: 'Mallory', next_action: 'Verify the estimate and rate card.',
    evidence: [{ type: 'project_risk', ref: 'risk-rate' }],
  }, {
    id: 'risk-scope', project_key: 'project-1', status: 'open', severity: 'high',
    title: 'Launch recovery needs a scope choice',
    decision_needed: 'Approve the proposed scope change for launch recovery.',
    impact: 'The launch date otherwise moves.', owner: 'Mallory',
    next_action: 'Approve the bounded recovery scope.',
    evidence: [{ type: 'project_risk', ref: 'risk-scope' }],
  }];
  const runtime = createExecutiveFirewallRuntime({
    dataDirectory: directory, databaseReady: () => false,
    writeThrough: async (_key, operation) => operation(),
    intelligence: { initiativeStatus: () => ({ remaining: 0 }), spendInitiative: () => null },
    resolveOwner: () => 'UJOHN', postMessage: async () => true,
    loadProjectControl: () => ({ projects: [{ key: 'project-1', pm: 'Mallory' }], risks }),
    loadFleetSupervisor: async () => null,
  });
  await runtime.hydrate();
  await runtime.reconcileSources({ now });
  const state = runtime.snapshot().state;
  const ordinary = state.cases.find(item => item.source_ref === 'risk-rate');
  const decision = state.cases.find(item => item.source_ref === 'risk-scope');
  assert.equal(ordinary.requires_executive, false);
  assert.equal(ordinary.decision_packet, null);
  assert.equal(ordinary.state, 'resolving');
  assert.equal(decision.requires_executive, true);
  assert.equal(decision.state, 'decision_ready');
  assert.match(decision.decision_packet.question, /scope change/);
  assert.equal(runtime.snapshot().metrics.unpacketized_executive, 0);
});
