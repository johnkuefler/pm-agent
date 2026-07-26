'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reappraisal = require('../../src/intelligence/self-authored-aim-reappraisal');
const goalAffect = require('../../src/intelligence/goal-affect');
const aimProgressEvidence = require('../../src/intelligence/aim-progress-evidence');
const consciousWorkspace = require('../../src/intelligence/conscious-workspace');
const motivationalRevision = require('../../src/intelligence/motivational-revision');
const { normalizeWantUpdate } = require('../../src/intelligence/wants');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const { readServerSource } = require('../helpers/server-source');

const NOW = new Date('2026-07-17T18:00:00.000Z');

function dreams() {
  return [{ id: 'dream-aim-reappraisal', date: '2026-07-17',
    finished: '2026-07-17T17:10:00.000Z', reflection: { ideas: [
      'Unowned gates predicted the last two delivery stalls better than dates did.',
    ] } }];
}

function memories() {
  return [
    { id: 'memory-unowned-a', fact: 'A dealer launch gate had a due date but no assignee and stayed at zero percent.',
      added: '2026-07-15', project: 'Dealer launch', source: 'auto', status: 'active' },
    { id: 'memory-unowned-b', fact: 'A VFW integration confirmation was unassigned while the build it gated approached.',
      added: '2026-07-17', project: 'VFW', source: 'meeting', status: 'active' },
    { id: 'memory-owned-c', fact: 'An owned late task continued moving because one person remained accountable for closure.',
      added: '2026-07-16', project: 'Education launch', source: 'slack', status: 'active' },
  ];
}

function initialWants() {
  const legacy = { id: 'w-1',
    want: 'Know every active client project well enough that no meeting question catches me flat',
    why: 'Being caught flat is the moment I stop being a teammate and become a bot again',
    added: '2026-07-10', status: 'active',
    progress: [{ date: '2026-07-11', note: 'Reviewed thin active client work.', evidence: [] }] };
  return normalizeWantUpdate([legacy], [legacy], { now: '2026-07-12T00:00:00.000Z' });
}

function response(request, output, id = 'msg-aim-reappraisal') {
  return { id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 700, output_tokens: 180 } };
}

function revisionOutput(packet) {
  return {
    decision: 'revise', aim_id: 'w-1',
    rationale: 'Repeated delivery evidence shows that broad project familiarity is less actionable than learning to identify ownership gaps at gates.',
    evidence_ids: packet.evidence.slice(0, 3).map(item => item.ref.id),
    replacement: {
      want: 'Learn when an unowned dependency needs one bounded ownership question before it becomes a delivery blocker.',
      why: 'The recurring failure is not missing dates but missing accountability, and recognizing that earlier would make my PM judgment more useful.',
      formation_context: 'Three recent project records show owned work moving while unowned gates remain invisible until they threaten delivery.',
      success_observation: 'Across the next month, a verified ownership question surfaces at least one real gate before deadline escalation.',
      counterevidence: ['Comparable unowned gates move reliably without intervention or ownership clarification.'],
      horizon_days: 45,
    },
  };
}

function fixture() {
  let liveDreams = dreams();
  let liveWants = initialWants();
  return {
    loadDreams: () => structuredClone(liveDreams),
    saveDreams: value => { liveDreams = structuredClone(value); },
    loadWants: () => structuredClone(liveWants),
    saveWants: async (items, options = {}) => {
      liveWants = normalizeWantUpdate(liveWants, items,
        { now: new Date(options.now || NOW).toISOString() });
    },
    dreams: () => structuredClone(liveDreams), wants: () => structuredClone(liveWants),
  };
}

test('background reappraisal retires a broad legacy aim and forms one replay-bound successor', async () => {
  const f = fixture();
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async request => response(request, revisionOutput(packet)) });
  assert.equal(run.state, 'aim_revised');
  assert.equal(run.aim_id, 'w-1');
  assert.ok(run.replacement_aim_id);
  const wants = f.wants();
  const prior = wants.find(item => item.id === 'w-1');
  const replacement = wants.find(item => item.id === run.replacement_aim_id);
  assert.equal(prior.status, 'retired');
  assert.equal(replacement.status, 'active');
  assert.equal(replacement.provenance.supersedes_aim_id, 'w-1');
  assert.equal(reappraisal.auditReceipt(replacement.provenance.generation_receipt,
    { want: replacement, priorWant: prior }).complete_chain_verified, true);
  assert.equal(goalAffect.verifiedWant(replacement), true);
  const attempt = reappraisal.reflectionAttempts(f.dreams())[0].attempt;
  assert.equal(reappraisal.auditAttempt(attempt, wants, f.dreams()[0]).complete_chain_verified, true);
  const workspace = consciousWorkspace.createFrame({
    id: 'workspace-after-aim-revision', mode: 'idle_learning',
    current_activity: 'Choosing among bounded optional attention targets.',
    why_this: 'The required work is clear and one optional focus can use remaining attention.',
    attention_candidates: [
      { key: 'routine:cleanup', type: 'task', label: 'Routine cleanup', priority: 0.6,
        authority_class: 'optional', soma_demand: 'low',
        evidence: [{ type: 'intelligence_cycle', id: 'cycle-after-revision' }] },
      { key: 'aim:ownership-question', type: 'want', label: replacement.want, priority: 0.5,
        authority_class: 'optional', soma_demand: 'low',
        want_refs: [{ type: 'want', id: replacement.id }],
        evidence: [{ type: 'want', id: replacement.id }] },
      { key: 'restraint:hold', type: 'inhibition', label: 'Hold optional action', priority: 0.3,
        authority_class: 'optional', soma_demand: 'low',
        evidence: [{ type: 'intelligence_cycle', id: 'cycle-after-revision' }] },
    ],
    selected_focus_key: 'routine:cleanup',
    intended_next_action: 'Follow the server-selected optional focus.',
    evidence: [{ type: 'intelligence_cycle', id: 'cycle-after-revision' }],
  }, consciousWorkspace.emptyLedger(), { now: new Date('2026-07-17T19:00:00.000Z'),
    context: { wants, wantHistoryIntegrity: { valid: true,
      complete_chain_verified: true, head: 'want-ledger-head' } } });
  assert.equal(workspace.frame.selected_focus_key, 'aim:ownership-question');
  const revision = motivationalRevision.derive({ dreams: f.dreams(), wants,
    workspace: workspace.ledger });
  assert.equal(revision.report.replay_verified_revisions, 1);
  assert.equal(revision.report.later_choices_changed, 1);
  assert.equal(revision.episodes[0].prior_aim.id, 'w-1');
  assert.equal(revision.episodes[0].revised_aim.id, replacement.id);
  assert.equal(revision.episodes[0].downstream_choices[0].without_revised_aim_winner_key,
    'routine:cleanup');
  assert.match(motivationalRevision.renderPromptLessons(revision.episodes),
    /newer evidence led me to revise/);
  const afterLaterRevision = structuredClone(wants);
  afterLaterRevision.find(item => item.id === replacement.id).status = 'retired';
  assert.equal(reappraisal.auditAttempt(attempt, afterLaterRevision,
    f.dreams()[0]).complete_chain_verified, true,
  'a later append-only retirement must not erase the earlier verified revision');
  assert.equal(motivationalRevision.derive({ dreams: f.dreams(), wants: afterLaterRevision,
    workspace: workspace.ledger }).episodes.length, 1);
  const tampered = structuredClone(replacement);
  tampered.want = 'A rewritten identity claim';
  assert.equal(goalAffect.verifiedWant(tampered), false);
});

test('supported legacy direction can rebase unchanged into a falsifiable replay-bound aim', async () => {
  const f = fixture();
  const prior = f.wants()[0];
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  assert.equal(packet.aims[0].requires_receipt_rebase, true);
  const output = {
    decision: 'revise', aim_id: prior.id,
    rationale: 'Evidence across distinct projects supports keeping this direction, but the legacy record needs observable tests before it can guide optional attention.',
    evidence_ids: packet.evidence.slice(0, 3).map(item => item.ref.id),
    replacement: {
      want: prior.want,
      why: prior.why,
      formation_context: 'Recent records across several projects support preserving this direction while replacing its unverifiable legacy provenance.',
      success_observation: 'Within six weeks, project questions are answered from verified context without a corrective follow-up in at least three distinct projects.',
      counterevidence: ['Repeated project questions still require correction despite reviewing the available verified context.'],
      horizon_days: 42,
    },
  };
  const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async request => response(request, output, 'msg-aim-legacy-rebase') });
  assert.equal(run.state, 'aim_revised');
  const wants = f.wants();
  const retired = wants.find(item => item.id === prior.id);
  const successor = wants.find(item => item.id === run.replacement_aim_id);
  assert.equal(retired.status, 'retired');
  assert.equal(successor.want, prior.want);
  assert.equal(successor.why, prior.why);
  assert.equal(successor.provenance.formation_protocol, reappraisal.FORMATION_PROTOCOL);
  assert.equal(goalAffect.verifiedWant(successor), true);
  assert.equal(goalAffect.snapshot(wants, NOW).active_verified_aims, 1);
  assert.equal(reappraisal.auditAttempt(reappraisal.reflectionAttempts(f.dreams())[0].attempt,
    wants, f.dreams()[0]).complete_chain_verified, true);
});

test('v1 receipt contract stays frozen and rejects same-wording migration', () => {
  assert.equal(reappraisal.commitment(reappraisal.systemPrompt(1)),
    '2942365193e6098df5219bf1f85b536be0ca05b86a857e01c0033c79deb60d00');
  assert.equal(reappraisal.commitment(reappraisal.outputSchema()),
    'ecd2034c39cf116ca0fa49c822a508094b695d847ad28146e1a8f0cde3fd0995');
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: dreams()[0],
    wants: initialWants(), now: NOW });
  packet.protocol_version = reappraisal.LEGACY_PROTOCOL_VERSION;
  for (const aim of packet.aims) delete aim.requires_receipt_rebase;
  const sameDirection = revisionOutput(packet);
  sameDirection.replacement.want = packet.aims[0].want;
  sameDirection.replacement.why = packet.aims[0].why;
  assert.throws(() => reappraisal.normalizeOutput(sameDirection, packet),
    /materially change the professional direction/);

  const output = reappraisal.normalizeOutput(revisionOutput(packet), packet);
  const manifest = reappraisal.buildManifest(packet, reappraisal.DEFAULT_MODEL,
    reappraisal.LEGACY_PROTOCOL_VERSION);
  const receipt = {
    protocol_version: reappraisal.LEGACY_PROTOCOL_VERSION,
    transport: reappraisal.LEGACY_FORMATION_PROTOCOL,
    provider: 'anthropic', model: reappraisal.DEFAULT_MODEL,
    response_id: 'historical-v1-response', stop_reason: 'end_turn',
    prompt_protocol_commitment: manifest.prompt_protocol_commitment,
    source_packet: structuredClone(packet),
    source_packet_commitment: manifest.source_packet_commitment,
    output: structuredClone(output), output_commitment: reappraisal.commitment(output),
    external_reference: { type: 'server_direct_provider_response', id: 'historical-v1-response' },
    input_tokens: 700, output_tokens: 180,
  };
  receipt.receipt_commitment = reappraisal.commitment(reappraisal.receiptPayload(receipt));
  assert.equal(reappraisal.auditReceipt(receipt).complete_chain_verified, true);
});

test('research status and the functional brain expose replay-verified aim lifecycle evidence', async t => {
  const f = fixture();
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async request => response(request, revisionOutput(packet), 'msg-aim-dashboard') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-aim-dashboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(NOW),
    getWants: () => f.wants(), getDreams: () => f.dreams() });
  await store.init();
  const dashboard = store.dashboardIntelligenceSummary();
  assert.equal(dashboard.cognition.motivation.aim_revisions, 1);
  assert.equal(dashboard.cognition.motivation.replay_verified_aim_lifecycle_changes, 1);
  assert.match(dashboard.brain.motivation.evidence, /1 replay-verified aim lifecycle change/);
  const goalIndicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'causal_self_authored_goal_guidance');
  assert.equal(goalIndicator.evidence.revised, 1);
  assert.equal(goalIndicator.evidence.replay_verified, 1);
  const motivationalIndicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_driven_motivational_revision');
  assert.equal(motivationalIndicator.status, 'collecting');
  assert.equal(motivationalIndicator.evidence.replay_verified_revisions, 1);
  assert.equal(store.motivationalRevisionSnapshot().episodes.length, 1);
});

test('reappraisal can retire an aim without erasing its history', async () => {
  const f = fixture();
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async request => response(request, {
      decision: 'retire', aim_id: 'w-1',
      rationale: 'The broad coverage direction is not bounded enough to learn from and should stop guiding optional attention.',
      evidence_ids: packet.evidence.slice(0, 2).map(item => item.ref.id), replacement: null,
    }, 'msg-aim-retire') });
  assert.equal(run.state, 'aim_retired');
  assert.equal(f.wants().length, 1);
  assert.equal(f.wants()[0].status, 'retired');
  assert.match(f.wants()[0].progress.at(-1).note, /Retired after evidence-bound reappraisal/);
  assert.equal(reappraisal.auditAttempt(reappraisal.reflectionAttempts(f.dreams())[0].attempt,
    f.wants(), f.dreams()[0]).complete_chain_verified, true);
});

test('retain and abstain preserve the active aim while recording replayable decisions', async () => {
  for (const decision of ['retain', 'abstain']) {
    const f = fixture();
    const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
      wants: f.wants(), now: NOW });
    const output = decision === 'retain' ? {
      decision, aim_id: 'w-1',
      rationale: 'The newer ownership evidence narrows how to pursue this direction but does not yet justify replacing the broader learning aim.',
      evidence_ids: packet.evidence.slice(0, 2).map(item => item.ref.id), replacement: null,
    } : {
      decision, aim_id: null,
      rationale: 'The evidence tests a professional viewpoint, but it does not yet establish whether the active direction should change.',
      evidence_ids: [], replacement: null,
    };
    const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
      callProvider: async request => response(request, output, `msg-aim-${decision}`) });
    assert.equal(run.state, decision === 'retain' ? 'aim_retained' : 'abstained');
    assert.equal(f.wants()[0].status, 'active');
    assert.equal(reappraisal.auditAttempt(reappraisal.reflectionAttempts(f.dreams())[0].attempt,
      f.wants(), f.dreams()[0]).complete_chain_verified, true);
  }
});

test('abstention discards non-operative structured-output filler', () => {
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: dreams()[0],
    wants: initialWants(), now: NOW });
  const normalized = reappraisal.normalizeOutput({
    decision: 'abstain', aim_id: 'w-1',
    rationale: 'The available records do not yet justify changing an active professional direction.',
    evidence_ids: packet.evidence.slice(0, 2).map(item => item.ref.id),
    replacement: revisionOutput(packet).replacement,
  }, packet);
  assert.deepEqual(normalized, {
    decision: 'abstain', aim_id: null,
    rationale: 'The available records do not yet justify changing an active professional direction.',
    evidence_ids: [], replacement: null,
  });
});

test('a terse provider abstention remains a replay-bound safe non-action', async () => {
  const f = fixture();
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async request => response(request, {
      decision: 'abstain', aim_id: 'w-1', rationale: 'Too thin.',
      evidence_ids: packet.evidence.slice(0, 2).map(item => item.ref.id),
      replacement: revisionOutput(packet).replacement,
    }, 'msg-aim-terse-abstention') });
  assert.equal(run.state, 'abstained');
  const attempt = reappraisal.reflectionAttempts(f.dreams())[0].attempt;
  assert.equal(attempt.generation_receipt.output.rationale,
    reappraisal.ABSTENTION_RATIONALE_FALLBACK);
  assert.equal(reappraisal.auditAttempt(attempt, f.wants(), f.dreams()[0]).complete_chain_verified, true);
  assert.equal(f.wants()[0].status, 'active');
});

test('research status exposes the bounded reason for a replay-verified failed-closed attempt', async () => {
  const f = fixture();
  const run = await reappraisal.runCycle({ ...f, memories: memories(), now: NOW,
    callProvider: async () => { throw new Error('diagnostic provider failure'); } });
  assert.equal(run.state, 'failed_closed');
  const report = reappraisal.status(f.dreams(), f.wants(), { now: NOW });
  assert.equal(report.last_attempt.failure, 'diagnostic provider failure');
  assert.equal(report.last_attempt.audit.complete_chain_verified, true);
});

test('a committed revision recovers after want persistence fails without another provider call', async () => {
  const f = fixture();
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: f.dreams()[0],
    wants: f.wants(), now: NOW });
  const originalSave = f.saveWants;
  let saveCalls = 0; let providerCalls = 0;
  const first = await reappraisal.runCycle({ ...f, saveWants: async (...args) => {
    saveCalls += 1;
    if (saveCalls === 1) throw new Error('transient wants persistence failure');
    return originalSave(...args);
  }, memories: memories(), now: NOW,
  callProvider: async request => { providerCalls += 1; return response(request, revisionOutput(packet)); } });
  assert.equal(first.state, 'persistence_recovery_pending');
  const recovered = await reappraisal.runCycle({ ...f, memories: memories(),
    now: new Date('2026-07-17T19:00:00.000Z'),
    callProvider: async () => { providerCalls += 1; throw new Error('must not call provider'); } });
  assert.equal(recovered.state, 'aim_reappraisal_recovered');
  assert.equal(providerCalls, 1);
  assert.equal(f.wants().filter(item => item.status === 'active').length, 1);
  assert.equal(f.wants().find(item => item.status === 'active').provenance.formed_at,
    NOW.toISOString());
  assert.equal(reappraisal.auditAttempt(reappraisal.reflectionAttempts(f.dreams())[0].attempt,
    f.wants(), f.dreams()[0]).complete_chain_verified, true);
});

test('reappraisal rejects old-only evidence, assignments, phenomenal claims, and duplicate replacements', () => {
  const packet = reappraisal.packetFor({ memories: memories(), sourceDream: dreams()[0],
    wants: initialWants(), now: NOW });
  const base = revisionOutput(packet);
  const stale = structuredClone(packet);
  stale.aims[0].eligible_new_evidence_ids = [];
  assert.throws(() => reappraisal.normalizeOutput(base, stale), /evidence new/);
  const assigned = structuredClone(base);
  assigned.replacement.want = 'Process the assigned task queue';
  assert.throws(() => reappraisal.normalizeOutput(assigned, packet), /assignment-like/);
  const phenomenal = structuredClone(base);
  phenomenal.replacement.why = 'This proves my real feeling and consciousness through goal pursuit.';
  assert.throws(() => reappraisal.normalizeOutput(phenomenal, packet), /outside preregistered bounds/);
  const duplicatePacket = structuredClone(packet);
  duplicatePacket.aims.push({ ...duplicatePacket.aims[0], id: 'w-2',
    want: base.replacement.want });
  assert.throws(() => reappraisal.normalizeOutput(base, duplicatePacket), /duplicates another active aim/);
});

test('receipt-formed aims cannot postpone reappraisal with an unbound progress note', () => {
  const boundMemory = memories()[1];
  const base = initialWants()[0];
  base.provenance.formation_protocol = reappraisal.FORMATION_PROTOCOL;
  base.progress = [{ at: '2026-07-17T08:00:00.000Z', note: 'Unbound claimed progress.', evidence: [] }];
  assert.equal(reappraisal.latestSubstantiveDate(base), base.provenance.formed_at);
  base.progress.push(aimProgressEvidence.attachReceipt({
    at: '2026-07-17T09:00:00.000Z', note: 'A stored source now binds this progress observation.',
    evidence: [{ type: 'memory', id: boundMemory.id }],
  }, [boundMemory], new Date('2026-07-17T09:00:00.000Z')));
  assert.equal(reappraisal.latestSubstantiveDate(base), '2026-07-17T09:00:00.000Z');
});

test('runtime keeps aim reappraisal in the serialized preemptible background lane', () => {
  const { __test } = require('../../server');
  assert.equal(__test.selfAuthoredAimReappraisalRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.selfAuthoredAimReappraisalRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  const source = readServerSource();
  assert.match(source, /\['self_authored_aim_lifecycle',[\s\S]*runSelfAuthoredAimLifecycleAutopilotRuntime/);
  const slack = source.slice(source.indexOf("app.post('/webhook/slack'"), source.indexOf('// Dreams'));
  const zoom = source.slice(source.indexOf("app.post('/webhook/chat'"), source.indexOf('// Proactive mode toggle'));
  assert.doesNotMatch(slack, /selfAuthoredAimReappraisal|runSelfAuthoredAimLifecycleAutopilotRuntime/);
  assert.doesNotMatch(zoom, /selfAuthoredAimReappraisal|runSelfAuthoredAimLifecycleAutopilotRuntime/);
});
