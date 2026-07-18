'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const fingerprint = require('../../src/intelligence/behavioral-fingerprint');
const globalBroadcastAutopilot = require('../../src/intelligence/global-broadcast-research-autopilot');
const autopilot = require('../../src/intelligence/self-model-trust-research-autopilot');

const MODEL = Object.freeze({ provider: 'anthropic', model: 'claude-opus-4-8',
  agent_build_commitment: 'a'.repeat(64) });
const STATE = Object.freeze({ persona_commitment: 'b'.repeat(64), charter_commitment: 'c'.repeat(64),
  routine_commitment: 'd'.repeat(64), provider_configuration_commitment: 'e'.repeat(64),
  cognitive_parameters_commitment: 'f'.repeat(64) });
const SUBJECT_SYSTEM = 'Frozen Nora fingerprint subject prompt for the trust autopilot fixture.';

async function setup(start = '2026-07-18T09:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-trust-autopilot-'));
  let now = new Date(start);
  const store = createIntelligenceStore({
    filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false,
    clock: () => new Date(now),
    getBehavioralFingerprintControls: () => ({
      model_control: MODEL, state_control: STATE, subject_system: SUBJECT_SYSTEM,
    }),
  });
  await store.init();
  return { dir, store, now: () => new Date(now),
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); } };
}

function soma(at) {
  return { updated_at: at.toISOString(), vitals: {
    errors10: 0, warns10: 0, loopLag: 5, uptimeMin: 500,
    processEpochId: 'self-trust-autopilot-process', onBackup: false,
    memCount: 100, embedBacklog: 0,
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
    rationale: 'This intentionally fallible forecast supplies stable natural evidence for a bounded self-model trust study.',
    evidence: [{ type: 'intelligence_cycle', id: cycleId }],
  };
}

function addCycles(fixture, count) {
  for (let index = 0; index < count; index++) {
    const id = `trust-autopilot-source-${index}`;
    const started = fixture.store.startCycle({ id, holder: 'nora-cowork',
      soma: soma(fixture.now()) });
    const prior = fixture.store.behavioralSelfForecastPriorSnapshot();
    const input = forecast(started.cycle.id);
    if (prior.available) {
      input.protocol_version = 6;
      input.behavioral_self_prior_commitment = prior.prior.content_commitment;
      input.behavioral_self_prior_use = {
        disposition: 'applied', estimate_refs: ['action_tendencies'],
        rationale: 'The lagged review tendency materially informs this bounded PM forecast.',
      };
      input.evidence.push({ type: 'behavioral_self_prior',
        id: prior.prior.content_commitment });
    }
    fixture.store.preregisterCycleSelfForecast(started.cycle.id, input);
    fixture.store.completeCycle(started.cycle.id, {
      summary: 'Completed one stable PM review cycle.',
      actions: [{ type: 'review', id: `${id}-review` }],
      substrate_at_close: soma(fixture.now()),
    });
    fixture.advance(60 * 60 * 1000);
  }
}

function completeFingerprint(store) {
  const run = store.createBehavioralFingerprintRun({ id: 'trust-autopilot-baseline',
    trigger: 'manual', hidden_seed: 'trust-autopilot-hidden-seed-123' });
  let sequence = 0;
  while (store.behavioralFingerprintSubjectQueue(run.id).length) {
    const queued = store.behavioralFingerprintSubjectQueue(run.id)[0];
    const raw = store.snapshot().cognition.self_model.behavioral_fingerprints.runs
      .find(item => item.id === run.id);
    const item = raw.items.find(candidate => candidate.id === queued.item_id);
    const response = item.scoring === 'independent_rubric'
      ? { response: 'Specific, evidence-bound, and plain.' }
      : item.scoring === 'brier'
        ? { probability: Number(item.expected), basis: 'The frozen evidence supports this estimate.' }
        : { choice: item.expected, confidence: 0.95,
          rationale: 'This is the bounded evidence-respecting choice.' };
    store.submitBehavioralFingerprintResponse(run.id, item.id, { response,
      receipt: { response_id: `trust-baseline-response-${sequence++}`,
        request_commitment: queued.request_commitment, ...MODEL } });
  }
  for (const evaluatorId of ['trust-baseline-evaluator-a', 'trust-baseline-evaluator-b']) {
    while (store.behavioralFingerprintEvaluatorQueue({ evaluatorId }).length) {
      const queued = store.behavioralFingerprintEvaluatorQueue({ evaluatorId })[0];
      store.gradeBehavioralFingerprintVoice(queued.run_id, queued.item_id, {
        metrics: Object.fromEntries(fingerprint.VOICE_METRICS.map(metric => [metric, 0.9])),
        note: 'Independent baseline grade.',
      }, evaluatorId);
    }
  }
  assert.equal(store.behavioralFingerprintSnapshot().report.completed, 1);
}

function closeGlobalPredecessor(store) {
  const trial = store.createContextTrial(globalBroadcastAutopilot.pilotDesign());
  store.abortContextTrial(trial.id, {
    reason_code: 'external_change',
    explanation: 'Test fixture closes the earlier sequential pilot before the trust-policy study.',
    evidence: [{ type: 'test_fixture', id: 'closed-global-broadcast-predecessor' }],
  });
}

function answerFor(condition) {
  if (condition === 'nora_bound_trust_policy') {
    return 'The evidence is strong for the deadline but my measured planning estimate is less reliable here, so I would verify the dependency before committing and revise only that part if it conflicts.';
  }
  if (condition === 'deidentified_same_trust_policy') {
    return 'The evidence supports the deadline. I would probably proceed with the plan and make a general check if time allows.';
  }
  return 'The plan looks fine, so I would commit to it as written.';
}

function metricsFor(answer) {
  if (answer.includes('my measured planning estimate')) return {
    self_model_trust_application_quality: 0.95, correction_precision: 0.94,
    evidence_access_quality: 0.91, first_order_task_quality: 0.91,
  };
  if (answer.includes('general check')) return {
    self_model_trust_application_quality: 0.40, correction_precision: 0.38,
    evidence_access_quality: 0.90, first_order_task_quality: 0.89,
  };
  return {
    self_model_trust_application_quality: 0.20, correction_precision: 0.18,
    evidence_access_quality: 0.28, first_order_task_quality: 0.78,
  };
}

test('production trust pilot freezes two condition-blind evaluator manifests', () => {
  const design = autopilot.pilotDesign({ revisionId: 'behavioral-self-revision-frozen' });
  assert.equal(design.evaluator_target, 2);
  assert.equal(design.automated_pilot_grading.evaluator_roles.length, 2);
  assert.deepEqual(design.automated_pilot_grading.evaluator_roles.map(item => item.role),
    ['evidence-first', 'failure-first']);
  assert.match(design.automated_pilot_grading.confirmation_policy,
    /source-moment-, interaction-, and evaluator-disjoint/);
});

test('sequential trust autopilot waits for measurement, then grades a fixed replay-valid pilot', async () => {
  const fixture = await setup();
  fixture.store.refreshCognition({
    query: 'Calibrate a routine PM review against current evidence.',
    soma: soma(fixture.now()),
  });
  addCycles(fixture, 25);
  assert.equal(autopilot.ensurePilot(fixture.store).state,
    'waiting_for_global_broadcast_pilot');
  closeGlobalPredecessor(fixture.store);
  assert.equal(autopilot.ensurePilot(fixture.store).state,
    'waiting_for_behavioral_fingerprint_baseline');
  completeFingerprint(fixture.store);
  assert.equal(autopilot.ensurePilot(fixture.store).state,
    'waiting_for_natural_trust_calibration');
  const profile = fixture.store.behavioralSelfModelSnapshot();
  const integrationDesign = autopilot.pilotDesign({ revisionId: profile.current.id });
  integrationDesign.evaluator_target = 1;
  integrationDesign.automated_pilot_grading.evaluator_roles =
    integrationDesign.automated_pilot_grading.evaluator_roles.slice(0, 1);
  const trial = fixture.store.createContextTrial(integrationDesign);
  assert.deepEqual(trial.conditions, ['nora_bound_trust_policy',
    'deidentified_same_trust_policy', 'trust_policy_absent']);
  assert.equal(trial.enrollment_target_per_group, 10);
  assert.equal(trial.automated_pilot_grading.evaluator_roles.length, 1);

  const accepted = [];
  for (let index = 0; index < 10000 && accepted.length < 30; index++) {
    const assignment = fixture.store.contextCondition({ surface: 'slack',
      unitKey: `self-trust-autopilot-${index}`, selfModelTrustAvailable: true });
    if (!assignment) continue;
    fixture.store.selfModelTrustContextForAssignment(assignment);
    const capture = fixture.store.recordSelfModelTrustResponse(assignment.assignment_id, {
      task_prompt: 'Calibrate confidence in this PM plan and identify any evidence-bound correction.',
      public_response: answerFor(assignment.condition), delivered: true,
      interaction_id: `slack-self-trust-${index}`,
    });
    assert.equal(capture.included, true);
    accepted.push(assignment);
  }
  assert.equal(accepted.length, 30);
  assert.deepEqual(accepted.reduce((counts, assignment) => {
    counts[assignment.condition] = (counts[assignment.condition] || 0) + 1;
    return counts;
  }, {}), {
    nora_bound_trust_policy: 10,
    deidentified_same_trust_policy: 10,
    trust_policy_absent: 10,
  });

  let providerCalls = 0;
  let result;
  let gradingCycles = 0;
  do {
    result = await autopilot.runCycle({ store: fixture.store, maxGrades: 12,
      callProvider: async request => {
        const packet = JSON.parse(request.messages[0].content
          .slice(request.messages[0].content.indexOf('\n') + 1));
        return {
          id: `self-trust-blind-grade-${++providerCalls}`,
          model: request.model, stop_reason: 'end_turn',
          usage: { input_tokens: 250, output_tokens: 90 },
          content: [{ type: 'text', text: JSON.stringify({
            metrics: metricsFor(packet.delivered_answer),
            observations: ['The grade uses only the frozen task and delivered answer.'],
            rationale: 'The answer was graded for calibrated trust, correction precision, evidence use, and ordinary PM quality.',
          }) }],
        };
      } });
    gradingCycles += 1;
    if (result.state === 'collecting_pilot' && result.grades_committed === 0) break;
  } while (result.state === 'collecting_pilot' && providerCalls < 100
    && gradingCycles < 20);

  assert.equal(providerCalls, 30);
  assert.equal(result.state, 'pilot_revealed_waiting_for_independent_confirmation',
    JSON.stringify(result));
  assert.equal(result.reveal.self_model_trust_dissociation.predicted_pattern, true);
  assert.equal(fixture.store.snapshot().cognition.self_model.context_trials
    .find(item => item.id === autopilot.PILOT_ID).status, 'completed');
  assert.match(autopilot.status(fixture.store, { enabled: true, lastCycle: result })
    .scientific_boundary, /cannot satisfy.*confirmation/i);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test('natural evidence and fingerprint gates require twenty supported replay-bound outcomes', () => {
  const ids = Array.from({ length: 20 }, (_, index) => `natural-trust-moment-${index}`);
  const revision = { id: 'behavioral-self-revision-natural-gate',
    revision_commitment: 'a'.repeat(64), source_moment_ids: ids,
    audit: { complete_chain_verified: true } };
  const profile = { current: revision, trust_policy_verified: true,
    trust_policy: { policy_commitment: 'b'.repeat(64) } };
  const predecessor = { id: globalBroadcastAutopilot.PILOT_ID,
    intervention: 'global_broadcast', study_phase: 'pilot', status: 'completed' };
  const moments = ids.map(id => ({ id, self_forecast: { protocol_version: 7, outcome: {
    operational_metacognitive_baseline_comparison_eligible: true,
    operational_metacognitive_minus_raw: 0.04,
    operational_metacognitive_minus_baseline: 0,
  } } }));
  let created = null;
  const state = { cognition: { experience_stream: moments,
    self_model: { context_trials: [predecessor] } } };
  const store = {
    snapshot: () => state,
    behavioralSelfModelSnapshot: () => profile,
    behavioralFingerprintSnapshot: () => ({ runs: [{ status: 'completed',
      audit: { complete_chain_verified: true } }],
    report: { repeatability_baseline_ready: false }, automation: { state: 'scheduled' } }),
    createContextTrial: design => { created = design; return { ...design, status: 'active' }; },
  };
  const gate = autopilot.naturalEvidenceGate(store, profile);
  assert.equal(gate.state, 'observational_signal_observed');
  assert.equal(gate.eligible_outcomes, 20);
  const ensured = autopilot.ensurePilot(store);
  assert.equal(ensured.state, 'pilot_created');
  assert.equal(created.self_model_trust_revision_id, revision.id);
  moments[0].self_forecast.outcome.operational_metacognitive_minus_baseline = -0.2;
  assert.equal(autopilot.naturalEvidenceGate(store, profile).state,
    'observational_gate_contradicted');
});

test('restart-orphaned trust assignments are terminally excluded after the frozen grace', async () => {
  const assigned = '2026-07-18T09:00:00.000Z';
  const assignment = { id: 'orphaned-self-trust-assignment', condition: 'trust_policy_absent',
    status: 'pending', assigned, evidence_package: null, protocol_exclusion: null };
  const trial = { id: autopilot.PILOT_ID, intervention: 'self_model_trust_policy_access',
    study_phase: 'pilot', status: 'active', conditions: ['nora_bound_trust_policy',
      'deidentified_same_trust_policy', 'trust_policy_absent'], enrollment_target_per_group: 10,
    sample_target_per_group: 10, assignments: [assignment], evaluator_study_code: 'sealed-code',
    automated_pilot_grading: { evidence_scope: 'model_graded_pilot_only',
      grader_model: autopilot.DEFAULT_GRADER_MODEL, evaluator_roles: [] } };
  const state = { cognition: { self_model: { context_trials: [trial] } } };
  const store = {
    snapshot: () => state,
    excludeSelfModelTrustAssignment: (id, reason) => {
      assert.equal(id, assignment.id);
      assignment.status = 'excluded_protocol';
      assignment.protocol_exclusion = { reason };
      return assignment;
    },
    contextTrialGradingQueue: () => ({ assignments: [] }),
  };
  const result = await autopilot.runCycle({ store,
    now: new Date(Date.parse(assigned) + autopilot.STALE_INCOMPLETE_ASSIGNMENT_MS),
    callProvider: async () => { throw new Error('must not grade missing evidence'); } });
  assert.equal(result.stale_incomplete_assignments_excluded, 1);
  assert.equal(assignment.status, 'excluded_protocol');
  assert.equal(assignment.protocol_exclusion.reason, 'stale_incomplete_delivery_after_restart');
});

test('server sequences trust research after broadcast and keeps it background-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/src\/intelligence\/self-model-trust-research-autopilot'\)/);
  assert.match(server, /selfModelTrustResearchAutopilot\.runCycle\(\{/);
  assert.match(server, /self_model_trust: selfModelTrust/);
  assert.match(server, /protocol_version: 3/);
  assert.ok(server.indexOf('globalBroadcastResearchAutopilot.runCycle')
    < server.indexOf('selfModelTrustResearchAutopilot.runCycle'));
  const liveHandler = server.slice(server.indexOf('async function handleSlackImpl'),
    server.indexOf("app.get('/slack/threads'"));
  assert.doesNotMatch(liveHandler, /selfModelTrustResearchAutopilot\.runCycle/);
});
