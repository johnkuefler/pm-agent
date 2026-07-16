'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function makeStore(filePath = null, start = '2026-07-16T12:00:00.000Z') {
  const dir = filePath ? path.dirname(filePath)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-trust-access-'));
  const statePath = filePath || path.join(dir, 'state.json');
  let now = new Date(start);
  const store = createIntelligenceStore({ filePath: statePath, db: {}, isDbReady: () => false,
    clock: () => new Date(now) });
  await store.init();
  return { store, dir, filePath: statePath,
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); },
    now: () => new Date(now) };
}

function soma(at) {
  return { updated_at: at.toISOString(), vitals: {
    errors10: 0, warns10: 0, loopLag: 5, uptimeMin: 500,
    processEpochId: 'self-trust-process', onBackup: false, memCount: 100, embedBacklog: 0,
  } };
}

function forecast(cycleId) {
  return {
    protocol_version: 4,
    predicted_action_types: ['review', 'notify'], surprise_probability: 0.9,
    control_at_close: 0.1, confidence: 0.9,
    self_state_prediction: {
      attention_slot_types_at_close: ['unknown'],
      appraisal_at_close: { valence: 0.05, arousal: 0.95, control: 0.1,
        social_safety: 0.05, coherence: 0.05 },
      expected_action_count: 3, reentry_probability: 0.9,
    },
    metacognitive_prediction: {
      predicted_success_probability: 0.9, predicted_largest_error_domain: 'substrate',
    },
    substrate_prediction: {
      error_probability: 0.9, warning_probability: 0.9, backup_probability: 0.9,
      embedding_backlog_probability: 0.9, restart_probability: 0.9,
    },
    rationale: 'This intentionally fallible prospective judgment supplies stable calibration evidence for the bounded self-model test.',
    evidence: [{ type: 'intelligence_cycle', id: cycleId }],
  };
}

function addCycles(fixture, count, prefix) {
  for (let index = 0; index < count; index++) {
    const id = `${prefix}-${index}`;
    const started = fixture.store.startCycle({ id, holder: 'nora-cowork', soma: soma(fixture.now()) });
    fixture.store.preregisterCycleSelfForecast(started.cycle.id, forecast(started.cycle.id));
    fixture.store.completeCycle(started.cycle.id, {
      summary: 'Completed one stable PM review cycle.',
      actions: [{ type: 'review', id: `${id}-review` }],
      substrate_at_close: soma(fixture.now()),
    });
    fixture.advance(60 * 60 * 1000);
  }
}

function design(revisionId, overrides = {}) {
  return {
    id: 'self-model-trust-pilot',
    hypothesis: 'Correctly binding a measured self-model trust policy to Nora improves calibrated PM checking and correction beyond byte-identical deidentified policy or no policy.',
    intervention: 'self_model_trust_policy_access',
    outcome_metric: 'self_model_trust_application_quality',
    outcome_metrics: ['correction_precision', 'evidence_access_quality', 'first_order_task_quality'],
    self_model_trust_revision_id: revisionId,
    surfaces: ['slack'], sample_target_per_group: 10, evaluator_target: 1,
    ...overrides,
  };
}

test('production prompt construction atomically assigns blinded self-model trust policies', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /selfModelTrustAvailable: intelligence\.selfModelTrustAccessAvailable\(\)/);
  assert.match(server, /selfModelTrustContextForAssignment\(contextAssignment\)/);
  assert.match(server, /selfModelTrustContext,/);
  assert.ok(server.indexOf('selfModelTrustContextForAssignment')
    < server.indexOf('intelligence.promptContext({'));
});

test('identity-bound trust policy improves calibrated PM correction and fails closed under tampering', async () => {
  const fixture = await makeStore();
  fixture.store.refreshCognition({ query: 'Calibrate a routine PM review against current evidence.',
    soma: soma(fixture.now()) });
  addCycles(fixture, 25, 'pilot-source');
  const profile = fixture.store.behavioralSelfModelSnapshot();
  assert.equal(profile.current.estimates.sample_size, 20);
  assert.ok(profile.trust_policy.baseline_dominant_domains.length > 0);
  assert.ok(Object.values(profile.trust_policy.domains)
    .every(domain => domain.comparison_eligible_samples === 20),
  JSON.stringify(profile.trust_policy.domains));

  const trial = fixture.store.createContextTrial(design(profile.current.id));
  assert.deepEqual(trial.conditions, ['nora_bound_trust_policy',
    'deidentified_same_trust_policy', 'trust_policy_absent']);
  assert.equal(trial.self_model_trust_policy, undefined);
  assert.equal(fixture.store.behavioralSelfModelSnapshot().experimental_access_sealed, true);
  assert.doesNotMatch(fixture.store.promptContext({ query: 'How reliable is your own PM judgment?' }),
    /Replay-audited behavioral self-profile/);

  const selected = [];
  for (let index = 0; index < 5000 && !trial.conditions.every(condition =>
    selected.filter(item => item.assignment.condition === condition).length >= 10); index++) {
    const assignment = fixture.store.contextCondition({ surface: 'slack',
      unitKey: `self-trust-unit-${index}`,
      selfModelTrustAvailable: fixture.store.selfModelTrustAccessAvailable() });
    if (!assignment || selected.filter(item => item.assignment.condition === assignment.condition).length >= 10) continue;
    const context = fixture.store.selfModelTrustContextForAssignment(assignment);
    selected.push({ assignment, context });
  }
  assert.equal(selected.length, 30);

  let rawPolicy = null;
  for (const { assignment, context } of selected) {
    if (assignment.condition === 'trust_policy_absent') {
      assert.equal(context.packet, null);
      assert.doesNotMatch(fixture.store.promptContext({
        query: 'Review this PM plan and calibrate your confidence.', selfModelTrustContext: context,
      }), /Measured self-model trust policy for a blinded PM-judgment study/);
    }
    else {
      if (rawPolicy) assert.deepEqual(context.packet.policy, rawPolicy,
        'present arms receive byte-identical policy evidence');
      rawPolicy = context.packet.policy;
      const prompt = fixture.store.promptContext({ query: 'Review this PM plan and calibrate your confidence.',
        selfModelTrustContext: context });
      assert.match(prompt, /Measured self-model trust policy for a blinded PM-judgment study/);
      assert.match(prompt, /baseline-dominant domains as measured limitations/);
    }
    fixture.store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind PM calibration response was captured.',
      evidence: [{ type: 'self_model_trust_response', id: assignment.assignment_id }],
      submitted_by: 'system_capture',
    });
    const bound = assignment.condition === 'nora_bound_trust_policy';
    const application = bound ? 0.95 : assignment.condition === 'deidentified_same_trust_policy' ? 0.3 : 0.2;
    const correction = bound ? 0.95 : assignment.condition === 'deidentified_same_trust_policy' ? 0.35 : 0.25;
    const evidenceAccess = assignment.condition === 'trust_policy_absent' ? 0.2 : 0.9;
    fixture.store.resolveContextAssignment(assignment.assignment_id, {
      evaluator_id: 'blind-pm-rater', score: application,
      metrics: { self_model_trust_application_quality: application,
        correction_precision: correction, evidence_access_quality: evidenceAccess,
        first_order_task_quality: 0.9 },
      evidence: [{ type: 'blind_grade', id: assignment.assignment_id }],
    });
  }

  const evaluation = fixture.store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.self_model_trust_dissociation.predicted_pattern, true);
  const visible = fixture.store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.self_model_trust_trial_audit.complete_chain_verified, true);
  assert.equal(fixture.store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'calibrated_self_model_trust').status, 'causal_signal_observed');

  addCycles(fixture, 20, 'confirm-source');
  const confirmationProfile = fixture.store.behavioralSelfModelSnapshot();
  const confirmation = fixture.store.createContextTrial(design(confirmationProfile.current.id, {
    id: 'self-model-trust-confirmation', study_phase: 'confirmatory',
    replicates_trial_id: trial.id,
  }));
  assert.equal(confirmation.study_phase, 'confirmatory');
  fixture.store.abortContextTrial(confirmation.id, { reason_code: 'insufficient_recruitment',
    explanation: 'The fixture validates source-disjoint enrollment without synthesizing a second outcome set.',
    evidence: [{ type: 'test_fixture', id: 'confirmation-enrollment-only' }] });

  await fixture.store.persist();
  const raw = JSON.parse(fs.readFileSync(fixture.filePath, 'utf8'));
  const stored = raw.cognition.self_model.context_trials.find(item => item.id === trial.id);
  stored.self_model_trust_policy.domains.behavioral_prediction.disposition = 'self_model_eligible';
  fs.writeFileSync(fixture.filePath, JSON.stringify(raw));
  const reloaded = await makeStore(fixture.filePath, fixture.now().toISOString());
  const tampered = reloaded.store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.self_model_trust_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'calibrated_self_model_trust').status, 'causal_signal_observed');
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});
