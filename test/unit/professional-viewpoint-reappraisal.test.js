'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reappraisal = require('../../src/intelligence/professional-viewpoint-reappraisal');
const { createIntelligenceStore } = require('../../src/intelligence/store');

const NOW = new Date('2026-07-16T18:00:00.000Z');
const DREAM = { id: 'dream-reappraisal-july-16', date: '2026-07-16',
  started: '2026-07-16T17:00:00.000Z', finished: '2026-07-16T17:10:00.000Z' };

function memories() {
  return [
    { id: 'memory-old-alpha', added: '2026-07-02', project: 'Alpha', source: 'auto', kind: 'fact', status: 'active',
      fact: 'Alpha reserved an integration QA contingency after prior launch defects.' },
    { id: 'memory-old-beta', added: '2026-07-04', project: 'Beta', source: 'auto', kind: 'fact', status: 'active',
      fact: 'Beta planned a dedicated integration QA window before its scheduled launch.' },
    { id: 'memory-new-gamma', added: '2026-07-15', project: 'Gamma', source: 'auto', kind: 'fact', status: 'active',
      fact: 'Gamma launched on schedule without a separate QA contingency after automated integration coverage passed.' },
    { id: 'memory-new-delta', added: '2026-07-16', project: 'Delta', source: 'auto', kind: 'fact', status: 'active',
      fact: 'Delta used continuous integration checks and held schedule without a dedicated launch contingency.' },
  ];
}

function modelResponse(request, output, id = 'msg-viewpoint-reappraisal-1') {
  return {
    id, model: request.model, stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 600, output_tokens: 140 },
  };
}

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-viewpoint-reappraisal-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(NOW) });
  await store.init();
  const formed = store.recordEpistemicPosition({
    proposition_kind: 'professional_viewpoint',
    topic_key: 'delivery.integration-qa-contingency',
    statement: 'Integration-heavy delivery plans need an explicit QA contingency before launch.',
    source_family: 'recent-delivery-observations',
    source_family_evidence: [{ type: 'memory', id: 'memory-old-alpha' },
      { type: 'memory', id: 'memory-old-beta' }],
    owner_type: 'nora_belief', polarity: 'supports', confidence: 0.62,
    evidence: [{ type: 'memory', id: 'memory-old-alpha' }, { type: 'memory', id: 'memory-old-beta' }],
    rationale: 'Two earlier delivery records support keeping a bounded QA contingency prior.',
    recorded_by: 'nora-nightly-reflection',
  });
  return { dir, store, formed };
}

function reviseOutput(viewpointId) {
  return {
    decision: 'revise', viewpoint_id: viewpointId,
    rationale: 'Two newer comparable launches weaken the need for a separate contingency when continuous integration coverage is strong.',
    polarity: 'uncertain', confidence: 0.48,
    falsification_criteria: ['Comparable launches with strong automated integration coverage repeatedly fail without a separate QA contingency.'],
    evidence_ids: ['memory-new-gamma', 'memory-new-delta'],
  };
}

test('background reappraisal revises one current viewpoint append-only with a replay-bound receipt', async t => {
  const { dir, store, formed } = await makeStore();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await reappraisal.runCycle({
    store, memories: memories(), dreams: [DREAM], now: NOW,
    callProvider: async request => modelResponse(request, reviseOutput(formed.id)),
  });
  assert.equal(result.state, 'viewpoint_revised');
  assert.equal(result.provider_calls, 1);
  assert.equal(result.viewpoint_id, formed.id);

  const projection = store.earnedViewpointsSnapshot();
  assert.equal(projection.current_verified, true);
  assert.equal(projection.viewpoints.length, 1);
  assert.equal(projection.viewpoints[0].polarity, 'uncertain');
  assert.equal(projection.viewpoints[0].confidence, 0.48);
  assert.equal(projection.viewpoints[0].revision_count, 1);
  const status = store.professionalViewpointReappraisalSnapshot();
  assert.deepEqual(status.report, { total: 1, retained: 0, revised: 1, retired: 0,
    abstained: 0, replay_verified: 1, replay_verified_lifecycle_changes: 1 });
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints');
  assert.equal(indicator.evidence.subject_reappraisal_revisions, 1);
  assert.equal(indicator.evidence.replay_verified_subject_reappraisals, 1);
  const dashboard = store.dashboardIntelligenceSummary();
  assert.equal(dashboard.cognition.reflection.viewpoint_reappraisals, 1);
  assert.equal(dashboard.cognition.reflection.viewpoint_revisions, 1);
  assert.match(dashboard.brain.reflection.evidence, /1 replay-verified lifecycle changes/);

  const proposition = store.snapshot().cognition.epistemic_ledger.propositions[0];
  const position = proposition.positions.at(-1);
  assert.equal(position.supersedes_position_id, proposition.positions[0].id);
  assert.equal(reappraisal.auditReceipt(position.generation_receipt,
    { proposition, position }).complete_chain_verified, true);
  const tampered = structuredClone(position.generation_receipt);
  tampered.output.confidence = 0.5;
  assert.equal(reappraisal.auditReceipt(tampered, { proposition, position }).complete_chain_verified, false);

  let calls = 0;
  const duplicate = await reappraisal.runCycle({ store, memories: memories(), dreams: [DREAM], now: NOW,
    callProvider: async () => { calls += 1; throw new Error('must not run'); } });
  assert.equal(duplicate.state, 'dream_already_reappraised');
  assert.equal(calls, 0);
});

test('reappraisal can retire a disconfirmed viewpoint without deleting its position history', async t => {
  const { dir, store, formed } = await makeStore();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = {
    decision: 'retire', viewpoint_id: formed.id,
    rationale: 'The newer comparable evidence makes this too broad to carry as a useful current delivery prior.',
    polarity: null, confidence: null, falsification_criteria: [],
    evidence_ids: ['memory-new-gamma', 'memory-new-delta'],
  };
  const result = await reappraisal.runCycle({ store, memories: memories(), dreams: [DREAM], now: NOW,
    callProvider: async request => modelResponse(request, output, 'msg-viewpoint-retire-1') });
  assert.equal(result.state, 'viewpoint_retired');
  assert.equal(store.earnedViewpointsSnapshot().viewpoints.length, 0);
  assert.equal(store.earnedViewpointsSnapshot().report.retired, 1);
  const proposition = store.snapshot().cognition.epistemic_ledger.propositions[0];
  assert.equal(proposition.status, 'retired');
  assert.equal(proposition.positions.length, 1);
  assert.equal(reappraisal.auditReceipt(proposition.retirement.generation_receipt,
    { proposition, retirement: proposition.retirement }).complete_chain_verified, true);
  assert.equal(store.professionalViewpointReappraisalSnapshot().report.replay_verified, 1);
});

test('retain and abstain record bounded outcomes without changing the viewpoint', async t => {
  const first = await makeStore();
  const second = await makeStore();
  t.after(() => {
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(second.dir, { recursive: true, force: true });
  });
  const retained = await reappraisal.runCycle({
    store: first.store, memories: memories(), dreams: [DREAM], now: NOW,
    callProvider: async request => modelResponse(request, {
      decision: 'retain', viewpoint_id: first.formed.id,
      rationale: 'The newer outcomes narrow the scope but do not yet overturn the contingency prior across integration-heavy work.',
      polarity: 'supports', confidence: 0.62,
      falsification_criteria: ['Repeated comparable launches without a contingency would eventually overturn this view.'],
      evidence_ids: ['memory-new-gamma', 'memory-new-delta'],
    }, 'msg-viewpoint-retain-1'),
  });
  assert.equal(retained.state, 'viewpoint_retained');
  assert.equal(first.store.earnedViewpointsSnapshot().viewpoints[0].revision_count, 0);
  assert.equal(first.store.professionalViewpointReappraisalSnapshot().report.retained, 1);

  const abstained = await reappraisal.runCycle({
    store: second.store, memories: memories(), dreams: [DREAM], now: NOW,
    callProvider: async request => modelResponse(request, {
      decision: 'abstain', viewpoint_id: null,
      rationale: 'The evidence does not isolate whether automation or lower integration complexity explains the newer outcomes.',
      polarity: null, confidence: null, falsification_criteria: [], evidence_ids: [],
    }, 'msg-viewpoint-abstain-1'),
  });
  assert.equal(abstained.state, 'abstained');
  assert.equal(second.store.earnedViewpointsSnapshot().viewpoints[0].revision_count, 0);
  assert.equal(second.store.professionalViewpointReappraisalSnapshot().report.abstained, 1);
});

test('reappraisal rejects uncommitted, old-only, and overlarge confidence updates', () => {
  const packet = reappraisal.packetFor({ memories: memories(), dream: DREAM,
    currentViewpoints: [{
      viewpoint_id: 'viewpoint-1', topic_key: 'delivery.integration-qa-contingency',
      statement: 'Integration-heavy delivery plans need an explicit QA contingency before launch.',
      polarity: 'supports', confidence: 0.62, rationale: 'Current rationale',
      updated_at: '2026-07-10T00:00:00.000Z', current_position_id: 'position-1',
      current_position_commitment: 'a'.repeat(64),
      evidence: [{ type: 'memory', id: 'memory-old-alpha' }, { type: 'memory', id: 'memory-old-beta' }],
    }], now: NOW });
  const base = reviseOutput('viewpoint-1');
  assert.throws(() => reappraisal.normalizeOutput({ ...base,
    evidence_ids: ['memory-new-gamma', 'missing-memory'] }, packet), /outside the committed packet/);
  assert.throws(() => reappraisal.normalizeOutput({ ...base,
    evidence_ids: ['memory-old-alpha', 'memory-old-beta'] }, packet), /evidence new to the current position/);
  assert.throws(() => reappraisal.normalizeOutput({ ...base, polarity: 'supports', confidence: 0.4 }, packet),
    /confidence change exceeds/);
  assert.throws(() => reappraisal.normalizeOutput({ ...base, polarity: 'supports', confidence: 0.7,
    evidence_ids: ['memory-old-alpha', 'memory-new-gamma'] }, packet), /increases require at least two new/);
  assert.throws(() => reappraisal.normalizeOutput({ decision: 'retain', viewpoint_id: 'viewpoint-1',
    rationale: 'The newer evidence is relevant but does not justify changing the current position yet.',
    polarity: 'denies', confidence: 0.62, falsification_criteria: [],
    evidence_ids: ['memory-new-gamma', 'memory-new-delta'] }, packet), /cannot contradict/);
  const stalePacket = structuredClone(packet);
  stalePacket.viewpoints[0].updated_at = '2026-07-17T00:00:00.000Z';
  assert.throws(() => reappraisal.normalizeOutput(base, stalePacket), /on or after the current position update/);
});

test('runtime enables reappraisal only in background-capable production mode', () => {
  const { __test } = require('../../server');
  assert.equal(__test.professionalViewpointReappraisalRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
  }).enabled, true);
  assert.equal(__test.professionalViewpointReappraisalRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '1',
  }).enabled, false);
  assert.equal(__test.professionalViewpointReappraisalRuntimeConfig({
    ANTHROPIC_API_KEY: 'configured', NORA_TEST_MODE: '0',
    NORA_PROFESSIONAL_VIEWPOINT_REAPPRAISAL: '0',
  }).enabled, false);

  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.equal((source.match(/runProfessionalViewpointLifecycleAutopilotRuntime\(\)/g) || []).length, 3,
    'viewpoint lifecycle should run only on dream capture, background startup, and the background interval');
  assert.doesNotMatch(source.slice(source.indexOf("app.post('/slack/events'"), source.indexOf('// Dreams')),
    /runProfessionalViewpointLifecycleAutopilotRuntime/,
    'Slack response handling must never invoke viewpoint reappraisal');
});
