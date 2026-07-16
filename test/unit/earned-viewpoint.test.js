'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const earnedViewpoint = require('../../src/intelligence/earned-viewpoint');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-earned-viewpoint-'));
  const filePath = path.join(dir, 'state.json');
  const clock = () => new Date('2026-07-16T14:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock });
  await store.init();
  return { store, dir, filePath };
}

const refs = [
  { type: 'interaction', id: 'interaction-qa-1' },
  { type: 'decision_trace', id: 'trace-qa-2' },
];

function viewpointInput(overrides = {}) {
  return {
    proposition_kind: 'professional_viewpoint',
    topic_key: 'delivery.qa.integration-risk',
    statement: 'Multi-integration delivery plans need an explicit QA contingency before launch.',
    source_family: 'recent-delivery-observations',
    source_family_evidence: refs,
    owner_type: 'nora_belief',
    polarity: 'supports',
    confidence: 0.62,
    evidence: refs,
    rationale: 'Two separate delivery records show late integration findings; a clean comparable launch would weaken this view.',
    recorded_by: 'nora-nightly-reflection',
    ...overrides,
  };
}

test('earned viewpoints require evidence-bound Nora authorship and fail closed under tampering', async () => {
  const { store, dir, filePath } = await makeStore();
  assert.throws(() => store.recordEpistemicPosition(viewpointInput({
    topic_key: 'delivery.qa.one-source', evidence: [refs[0]], source_family_evidence: [refs[0]],
  })), /at least two distinct/);
  assert.throws(() => store.recordEpistemicPosition(viewpointInput({
    topic_key: 'delivery.qa.overconfident', confidence: 0.85,
  })), /confidence 0.7 or below/);
  assert.throws(() => store.recordEpistemicPosition(viewpointInput({
    topic_key: 'delivery.qa.external-author', recorded_by: 'memory-migrator',
  })), /Nora-authored/);
  assert.equal(store.snapshot().cognition.epistemic_ledger.propositions.length, 0,
    'rejected formations must not leave partial propositions in memory');

  const proposition = store.recordEpistemicPosition(viewpointInput());
  const projection = store.earnedViewpointsSnapshot();
  assert.equal(projection.current_verified, true);
  assert.equal(projection.viewpoints.length, 1);
  assert.equal(projection.viewpoints[0].status, 'held');
  assert.equal(projection.viewpoints[0].revision_count, 0);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'evidence_tested_professional_viewpoints');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.eligible_current_viewpoints, 1);
  assert.equal(earnedViewpoint.audit(projection.current,
    store.snapshot().cognition.epistemic_ledger.propositions).complete_chain_verified, true);
  assert.match(store.promptContext({ query: 'How should we plan integration QA?' }), /Earned professional viewpoints/);
  assert.doesNotMatch(store.promptContext({ query: 'Who is attending the brand workshop?' }), /Earned professional viewpoints/);
  assert.doesNotMatch(store.promptContext({ query: '' }), /Earned professional viewpoints/,
    'a viewpoint must not enter cognition without a relevant task signal');
  assert.equal(store.epistemicContextForAssignment(null, 'integration QA').packet.some(item => item.id === proposition.id), false,
    'professional viewpoints use only their dedicated fail-closed prompt route');

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.epistemic_ledger.propositions[0].statement = 'Tampered viewpoint statement.';
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false });
  await reloaded.init();
  assert.equal(reloaded.earnedViewpointsSnapshot().current_verified, false);
  assert.deepEqual(reloaded.earnedViewpointsSnapshot().viewpoints, []);
  assert.doesNotMatch(reloaded.promptContext({ query: 'integration QA' }), /Earned professional viewpoints/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('earned viewpoints revise append-only and retire without deleting their history', async () => {
  const { store, dir } = await makeStore();
  const formed = store.recordEpistemicPosition(viewpointInput());
  const head = formed.positions.find(position => position.owner_type === 'nora_belief');
  assert.throws(() => store.recordEpistemicPosition(viewpointInput({
    polarity: 'uncertain', confidence: 0.45, evidence: [refs[0]], supersedes_position_id: head.id,
  })), /at least two distinct/);
  const revised = store.recordEpistemicPosition(viewpointInput({
    polarity: 'uncertain', confidence: 0.45,
    rationale: 'A clean recent launch weakens the generalization, so this remains an open question.',
    evidence: [refs[0], { type: 'interaction', id: 'interaction-clean-launch-3' }],
    supersedes_position_id: head.id,
  }));
  assert.equal(revised.positions.length, 2);
  let snapshot = store.earnedViewpointsSnapshot();
  assert.equal(snapshot.viewpoints[0].status, 'questioning');
  assert.equal(snapshot.viewpoints[0].revision_count, 1);

  const retired = store.retireEarnedViewpoint(formed.id, {
    rationale: 'The latest comparable launch no longer supports carrying this as a current view.',
    recorded_by: 'nora-nightly-reflection',
    evidence: [{ type: 'interaction', id: 'interaction-clean-launch-3' }],
  });
  assert.equal(retired.status, 'retired');
  assert.equal(retired.positions.length, 2);
  assert.ok(retired.retirement.retirement_commitment);
  snapshot = store.earnedViewpointsSnapshot();
  assert.equal(snapshot.current_verified, true);
  assert.equal(snapshot.viewpoints.length, 0);
  assert.equal(snapshot.report.retired, 1);
  assert.equal(store.snapshot().cognition.epistemic_ledger.propositions[0].positions.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
