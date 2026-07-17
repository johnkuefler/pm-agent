const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const interactivePerformance = require('../../src/intelligence/interactive-performance');

test('dashboard summary stays compact and advances with store mutations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-dashboard-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'),
    db: {},
    isDbReady: () => false,
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  await store.init();

  const initialRevision = store.snapshotRevision();
  const initial = store.dashboardIntelligenceSummary();
  assert.equal(initial.revision, initialRevision);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 15000, 'summary must stay small enough for first paint');
  assert.equal(Object.keys(initial.brain).length, 16);
  assert.equal(initial.cognition.reflection.dream_idea_seeds, 0);
  assert.equal(initial.cognition.reflection.dream_insight_reflection_attempts, 0);
  assert.equal(initial.cognition.reflection.dream_insight_candidates, 0);
  assert.equal(initial.cognition.reflection.cycle_self_correction_attempts, 0);
  assert.equal(initial.cognition.reflection.replay_verified_cycle_self_corrections, 0);
  for (const metric of Object.values(initial.brain)) {
    assert.ok(metric.level >= 0 && metric.level <= 1);
    assert.equal(typeof metric.evidence, 'string');
  }

  const commitment = store.addCommitment({ what: 'Return a compact dashboard quickly', owner: 'Nora' });
  store.refreshCognition({});
  const cycle = store.startCycle({ id: 'dashboard-evidence-cycle', holder: 'nora' });
  store.preregisterCycleSelfForecast(cycle.cycle.id, {
    predicted_action_types: ['review'], surprise_probability: 0.2, control_at_close: 0.7,
    confidence: 0.6, rationale: 'The compact dashboard needs one bounded evidence review.',
    evidence: [{ type: 'intelligence_cycle', id: cycle.cycle.id }],
  });
  store.completeCycle(cycle.cycle.id, {
    summary: 'Verified the compact dashboard evidence projection.',
    actions: [{ type: 'review', id: 'dashboard-review' }],
  });
  const intention = store.recordAgencyIntention({
    action: 'Verify the dashboard projection', intended_outcome: 'The evidence counts match the ledgers',
    origin: 'delegated', authority_basis: 'read-only test verification', confidence: 0.8,
    control_prediction: { confidence: 0.3, source: 'projection without verification' },
    evidence: [{ type: 'test', id: 'dashboard-summary' }],
  });
  store.resolveAgencyIntention(intention.id, {
    outcome: 'achieved', causal_attribution: 'contributed',
    observed: 'The dashboard summary exposed the terminal experience and scored forecast.',
    evidence: [{ type: 'test', id: 'dashboard-summary-result' }],
  });
  store.recordTrace({ channel: 'meeting', action: 'response_latency', decision: 'within_budget',
    outcome: { ...interactivePerformance.assess('realtime', 1400), stages: {} } });
  assert.ok(store.snapshotRevision() > initialRevision);
  const updated = store.dashboardIntelligenceSummary();
  assert.ok(Buffer.byteLength(JSON.stringify(updated)) < 15000, 'evidence-rich summary must remain compact');
  assert.equal(updated.overview.commitments.open, 1);
  assert.equal(updated.brain.commitments.available, true);
  assert.ok(updated.brain.commitments.level > 0);
  assert.match(updated.brain.experience.evidence, /1\/1 functional moments terminal/);
  assert.equal(updated.brain.experience.available, true);
  assert.match(updated.brain.forecasting.evidence, /1 scored cycle self-forecasts/);
  assert.equal(updated.brain.forecasting.available, true);
  assert.match(updated.brain['self-model'].evidence, /1 behavioral revisions/);
  assert.equal(updated.brain['self-model'].available, true);
  assert.match(updated.brain.agency.evidence, /1 resolved intentions/);
  store.updateCommitment(commitment.id, { status: 'fulfilled' });
  const fulfilled = store.dashboardIntelligenceSummary();
  assert.ok(Buffer.byteLength(JSON.stringify(fulfilled)) < 15000, 'fulfilled history must not bloat first paint');
  assert.equal(fulfilled.brain.commitments.available, true);
  assert.match(fulfilled.brain.commitments.evidence, /0 open and 1 fulfilled promises/);
  assert.equal(updated.brain.responsiveness.available, true);
  assert.equal(updated.cognition.responsiveness.surfaces.realtime.p95_ms, 1400);
  assert.equal(updated.cognition.responsiveness.continuity_projection_audit.protocol_version, 1);
  assert.equal(typeof updated.cognition.responsiveness.continuity_projection_audit.cache_hits, 'number');
});
