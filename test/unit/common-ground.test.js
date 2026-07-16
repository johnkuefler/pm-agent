'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const commonGround = require('../../src/intelligence/common-ground');
const epistemicLedger = require('../../src/intelligence/epistemic-ledger');

test('common ground requires verified observable uptake and fails closed when source positions change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-common-ground-'));
  let now = new Date('2026-07-16T10:00:00.000Z');
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false, clock: () => new Date(now) });
  await store.init();

  let proposition = store.recordEpistemicPosition({
    topic_key: 'launch.owner', statement: 'Maya owns the launch readiness decision.',
    source_family: 'launch-thread',
    source_family_evidence: [{ type: 'slack_thread', id: 'launch-thread-1' }],
    owner_type: 'nora_belief', polarity: 'supports', confidence: 0.8,
    rationale: 'Nora read the explicit decision-owner assignment in the launch thread.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-nora' }], recorded_by: 'nora-runtime',
  });
  const noraPosition = proposition.positions.find(item => item.owner_type === 'nora_belief');
  proposition = store.recordEpistemicPosition({
    topic_key: 'launch.owner', statement: 'Maya owns the launch readiness decision.',
    owner_type: 'person_belief', subject: 'John', polarity: 'supports', confidence: 0.9,
    rationale: 'John explicitly confirmed Maya as the decision owner.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-john' }], recorded_by: 'nora-runtime',
  });
  let johnPosition = proposition.positions.find(item => item.owner_type === 'person_belief');

  const candidate = store.recordCommonGround({
    proposition_id: proposition.id, person: 'John',
    nora_position_id: noraPosition.id, person_position_id: johnPosition.id,
    acknowledgment_kind: 'accurate_restatement',
    summary: 'John restated that Maya owns the launch readiness decision before asking for her sign-off.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-restatement' }],
    expires_at: '2026-08-15T10:00:00.000Z',
  });
  assert.equal(candidate.status, 'awaiting_independent_review');
  const unverifiedFrame = store.commonGroundFrameForPerson('John', 'Who owns the launch decision?');
  assert.equal(unverifiedFrame.established.length, 0);
  assert.equal(unverifiedFrame.not_established.length, 1);
  assert.equal(store.commonGroundReviewQueue().length, 1);

  now = new Date('2026-07-16T11:00:00.000Z');
  const reviewed = store.reviewCommonGround(candidate.id, {
    outcome: 'verified',
    rationale: 'The cited reply accurately restates the owner and uses it to route the approval.',
    evidence: [{ type: 'independent_review', id: 'launch-owner-review' }],
  }, 'common-ground-reviewer');
  assert.equal(reviewed.audit.final_evidence_eligible, true);
  const frame = store.commonGroundFrameForPerson('John', 'Who owns the launch decision?');
  assert.equal(frame.established.length, 1);
  assert.equal(frame.established[0].relation, 'aligned_position');
  const prompt = store.promptContext({ person: 'John', channel: 'slack',
    query: 'Who owns the launch decision?' });
  assert.match(prompt, /Verified common-ground frame for the current collaborator/);
  assert.match(prompt, /Delivery alone never qualifies|explicit observable uptake/);
  assert.match(prompt, /never means the person is ignorant/);

  now = new Date('2026-07-16T12:00:00.000Z');
  proposition = store.recordEpistemicPosition({
    topic_key: 'launch.owner', statement: 'Maya owns the launch readiness decision.',
    owner_type: 'person_belief', subject: 'John', polarity: 'uncertain', confidence: 0.5,
    rationale: 'John later said the final decision owner may have changed.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-changed' }], recorded_by: 'nora-runtime',
    supersedes_position_id: johnPosition.id,
  });
  johnPosition = proposition.positions.find(item => item.owner_type === 'person_belief'
    && !proposition.positions.some(other => other.supersedes_position_id === item.id));
  assert.equal(store.commonGroundSnapshot({ person: 'John' }).records[0].audit.final_evidence_eligible, false);
  assert.doesNotMatch(store.promptContext({ person: 'John', query: 'Who owns the launch decision?' }),
    /Established aligned position/);

  const replacement = store.recordCommonGround({
    proposition_id: proposition.id, person: 'John',
    nora_position_id: noraPosition.id, person_position_id: johnPosition.id,
    acknowledgment_kind: 'targeted_correction',
    summary: 'John explicitly corrected the earlier shared owner assumption and marked ownership uncertain.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-correction' }],
    expires_at: '2026-08-15T12:00:00.000Z',
  });
  assert.equal(store.commonGroundReviewQueue().some(item => item.id === replacement.id), true);

  proposition = store.recordEpistemicPosition({
    topic_key: 'launch.owner', statement: 'Maya owns the launch readiness decision.',
    owner_type: 'person_belief', subject: 'Maya', polarity: 'supports', confidence: 0.9,
    rationale: 'Maya explicitly acknowledged her launch-readiness decision ownership.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-maya' }], recorded_by: 'nora-runtime',
  });
  const mayaPosition = proposition.positions.find(item => item.owner_type === 'person_belief'
    && item.subject === 'Maya');

  store.createContextTrial({
    id: 'common-ground-seal-control', intervention: 'workspace_capacity',
    hypothesis: 'Workspace capacity affects first-order task quality.',
    outcome_metric: 'first_order_task_quality', surfaces: ['slack'], sample_target_per_group: 2,
  });
  const sealed = store.commonGroundSnapshot({ person: 'John', query: 'launch owner' });
  assert.equal(sealed.experimental_access_sealed, true);
  assert.deepEqual(sealed.records, []);
  assert.equal(store.commonGroundReviewQueue().some(item => item.id === replacement.id), true,
    'independently authenticated review remains outside the subject seal');
  const sealedPeriodCandidate = store.recordCommonGround({
    proposition_id: proposition.id, person: 'Maya',
    nora_position_id: noraPosition.id, person_position_id: mayaPosition.id,
    acknowledgment_kind: 'coordinated_action',
    summary: 'Maya used the shared launch-owner assignment to make the readiness decision in the thread.',
    evidence: [{ type: 'slack_message', id: 'launch-owner-maya-action' }],
    expires_at: '2026-08-15T12:00:00.000Z',
  });
  assert.equal(sealedPeriodCandidate.cognitive_access_sealed_at_formation, true);
  assert.equal(sealedPeriodCandidate.audit.complete_chain_verified, true);
  assert.equal(store.commonGroundReviewQueue().some(item => item.id === sealedPeriodCandidate.id), true,
    'append-only evidence capture remains available to the independent review path');
  assert.equal(store.commonGroundSnapshot({ person: 'Maya', query: 'launch owner' })
    .experimental_access_sealed, true, 'new evidence cannot feed subject cognition during the trial');

  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'interactional_common_ground');
  assert.equal(indicator.status, 'collecting');
  assert.equal(indicator.evidence.captured_while_cognitive_access_sealed, 1);
  assert.equal(indicator.evidence.independently_verified_current, 0,
    'the superseded source position retracts the old record');

  store.abortContextTrial('common-ground-seal-control', {
    reason_code: 'operational_failure',
    explanation: 'The fixture completed the active-study sealing check.',
    evidence: [{ type: 'test_fixture', id: 'common-ground-seal-complete' }],
  });
  await store.persist();
  const raw = store.snapshot();
  const tampered = raw.cognition.common_ground.records.find(item => item.id === replacement.id);
  tampered.summary = 'A rewritten summary attempts to preserve a locally recomputed formation hash.';
  tampered.formation_commitment = epistemicLedger.commitment(commonGround.formationPayload(tampered));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));
  await store.init();
  const tamperedAudit = store.commonGroundSnapshot({ person: 'John' }).records
    .find(item => item.id === replacement.id).audit;
  assert.equal(tamperedAudit.formation_verified, true);
  assert.equal(tamperedAudit.ledger_binding_verified, false);
  assert.equal(tamperedAudit.complete_chain_verified, false);

  fs.rmSync(dir, { recursive: true, force: true });
});
