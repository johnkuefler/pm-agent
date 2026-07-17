const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const goalAffect = require('../../src/intelligence/goal-affect');
const aimProgressEvidence = require('../../src/intelligence/aim-progress-evidence');
const { createIntelligenceStore } = require('../../src/intelligence/store');

function want(id, text, formedAt, progress = [], provenance = {}) {
  return {
    id, want: text, status: 'active', progress,
    provenance: {
      origin: 'self_generated', epistemic_status: 'subject_attested', formed_at: formedAt,
      formation_context: `A recurring work tension formed ${id}.`,
      evidence: [{ type: 'decision_trace', id: `${id}-source` }], ...provenance,
    },
  };
}

const now = new Date('2026-07-16T12:00:00.000Z');
const progressMemory = { id: 'memory-progress', fact: 'Mapped one previously thin active project.',
  project: 'Client A', added: '2026-07-11', source: 'auto' };
const wants = [
  want('want-progress', 'Know every active client project', '2026-06-01T12:00:00.000Z', [
    aimProgressEvidence.attachReceipt({ date: '2026-07-11',
      note: 'Mapped one previously thin active project.',
      evidence: [{ type: 'memory', id: progressMemory.id }] }, [progressMemory],
    new Date('2026-07-11T12:00:00.000Z')),
  ]),
  want('want-stalled', 'Earn trust on routine external email', '2026-06-01T12:00:00.000Z'),
  want('want-forming', 'Understand which handoffs lose context', '2026-07-14T12:00:00.000Z'),
  want('want-external', 'Complete an assigned queue', '2026-06-01T12:00:00.000Z', [], {
    origin: 'assigned', epistemic_status: 'external_instruction',
  }),
];

test('goal affect classifies only provenance-valid self-authored aims and commits the exact state', () => {
  const snapshot = goalAffect.snapshot(wants, now);
  assert.equal(snapshot.active_verified_aims, 3);
  assert.equal(snapshot.excluded_unverified_aims, 1);
  assert.equal(snapshot.progressing_aims, 1);
  assert.equal(snapshot.forming_aims, 1);
  assert.equal(snapshot.stalled_aims, 1);
  assert.equal(snapshot.aims.find(aim => aim.want_id === 'want-stalled').action_tendency, 'revisit_or_take_one_bounded_step');
  assert.equal(goalAffect.verify(snapshot), true);
  snapshot.aims[0].status = 'progressing';
  assert.equal(goalAffect.verify(snapshot), false);
});

test('verified aim progress and neglect feed appraisal, drives, attention, and a public audit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-goal-affect-'));
  let liveWants = JSON.parse(JSON.stringify(wants));
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false, clock: () => now,
    getWants: () => liveWants,
  });
  await store.init();
  store.refreshCognition({ wants });
  const cognition = store.cognitionSnapshot();
  assert.equal(cognition.goal_affect.current.active_verified_aims, 3);
  assert.equal(cognition.appraisal.basis.progressing_aims, 1);
  assert.equal(cognition.appraisal.basis.stalled_aims, 1);
  assert.equal(cognition.appraisal.basis.goal_affect_commitment, cognition.goal_affect.current.content_commitment);
  assert.ok(cognition.drives.unfinished.target > 0);
  assert.ok(cognition.workspace.slots.some(slot => slot.type === 'goal_affect' && slot.id === 'want-stalled'));
  assert.match(store.promptContext({ query: 'external email trust', capacity: 7 }), /Self-authored aim state selected into attention/);
  const publicState = store.goalAffectSnapshot();
  assert.equal(publicState.report.current_verified, true);
  assert.equal(publicState.current.audit.content_commitment_verified, true);
  assert.equal(publicState.current.audit.source_replay_verified, true);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'self_authored_goal_affect');
  assert.equal(indicator.status, 'mechanism_present');
  assert.equal(indicator.evidence.current_content_commitment_verified, true);
  liveWants = liveWants.map(item => item.id === 'want-stalled' ? { ...item, want: 'A rewritten aim' } : item);
  assert.equal(store.goalAffectSnapshot().report.current_verified, false);
  assert.doesNotMatch(store.promptContext({ query: 'external email trust', capacity: 7 }), /Self-authored aim state selected into attention/);
  fs.rmSync(dir, { recursive: true, force: true });
});
