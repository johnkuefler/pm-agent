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
  for (const metric of Object.values(initial.brain)) {
    assert.ok(metric.level >= 0 && metric.level <= 1);
    assert.equal(typeof metric.evidence, 'string');
  }

  store.addCommitment({ what: 'Return a compact dashboard quickly', owner: 'Nora' });
  store.recordTrace({ channel: 'meeting', action: 'response_latency', decision: 'within_budget',
    outcome: { ...interactivePerformance.assess('realtime', 1400), stages: {} } });
  assert.ok(store.snapshotRevision() > initialRevision);
  const updated = store.dashboardIntelligenceSummary();
  assert.equal(updated.overview.commitments.open, 1);
  assert.equal(updated.brain.commitments.available, true);
  assert.ok(updated.brain.commitments.level > 0);
  assert.equal(updated.brain.responsiveness.available, true);
  assert.equal(updated.cognition.responsiveness.surfaces.realtime.p95_ms, 1400);
});
