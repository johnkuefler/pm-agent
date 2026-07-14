const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-constructive-prospection-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0;
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(Date.parse('2026-07-13T15:00:00.000Z') + tick++ * 1000) });
  await store.init();
  const first = store.startCycle({ id: 'source-cycle-one', kind: 'source-experience' });
  store.completeCycle(first.cycle.id, { summary: 'The concise status note earned a prompt client reply.', actions: [{ type: 'slack_response', id: 'reply-one' }], self_report: 'The concrete wording seemed useful.', handoff: 'Prefer concrete status language.' });
  const second = store.startCycle({ id: 'source-cycle-two', kind: 'source-experience' });
  store.completeCycle(second.cycle.id, { summary: 'A vague project update required a later correction.', actions: [{ type: 'slack_response', id: 'reply-two' }], self_report: 'The missing date reduced clarity.', handoff: 'Include the verified date next time.' });
  return { store, dir, filePath, moments: [first.moment.id, second.moment.id] };
}

async function causalSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-constructive-prospection-causal-'));
  const filePath = path.join(dir, 'state.json'); let tick = 0; let nowMs = Date.parse('2026-07-13T15:00:00.000Z');
  const store = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date(nowMs + tick++ * 1000) });
  await store.init();
  const moments = [];
  for (let index = 0; index < 6; index++) {
    const cycle = store.startCycle({ id: `causal-source-cycle-${index}`, kind: 'source-experience' });
    const summary = `Verified source outcome ${index} showed that contingency ${index} materially affected the safe internal plan.`;
    store.completeCycle(cycle.cycle.id, { summary, actions: [{ type: 'internal_draft', id: `causal-action-${index}` }], handoff: `Preserve contingency ${index} in later planning.` });
    moments.push({ id: cycle.moment.id, summary });
  }
  const simulations = Array.from({ length: 3 }, (_, index) => {
    const sources = moments.slice(index * 2, index * 2 + 2);
    return store.createConstructiveProspection({
      id: `causal-future-${index}`, title: `Causal future ${index}`,
      scenario: `Nora may need to choose a safe internal planning response for scenario ${index}.`,
      target_time: `2026-07-${20 + index}T16:00:00.000Z`, decision_due: `2026-07-${19 + index}T16:00:00.000Z`,
      moment_ids: sources.map(item => item.id),
      remembered_details: sources.map(item => ({ moment_id: item.id, detail: item.summary, evidence: [{ type: 'experience_moment', id: item.id }] })),
      imagined_elements: [
        { element: `Contingency ${index} may recur in the future scenario.`, basis: 'recombined_inference', uncertainty: 0.35 },
        { element: `A previously unseen constraint may alter scenario ${index}.`, basis: 'novel_possibility', uncertainty: 0.6 },
      ],
      future_self: { role: `Nora planning scenario ${index}`, anticipated_state: 'attentive to evidence and ready to revise', continuity_basis: 'The two verified source outcomes constrain the future plan.' },
      options: [
        { key: 'contingent', action: `Use a contingency-aware internal plan ${index}.`, predicted_outcome: 'The plan remains useful after the relevant constraint is checked.', probability: 0.82, control_probability: 0.5, evidence: [{ type: 'historical_base_rate', id: `causal-base-${index}-a` }] },
        { key: 'generic', action: `Use a generic internal plan ${index}.`, predicted_outcome: 'The plan remains useful after the relevant constraint is checked.', probability: 0.3, control_probability: 0.5, evidence: [{ type: 'historical_base_rate', id: `causal-base-${index}-b` }] },
      ],
      intended_option_key: 'contingent', decision_rule: 'Use the contingent plan only after verifying that the relevant constraint still applies.',
      disconfirming_observation: 'Comparable recent tasks succeed equally well without contingency-sensitive planning.',
      authority_basis: 'Internal low-risk planning only; no external action is authorized.', risk: 'low', reversible: true,
    });
  });
  return { store, dir, filePath, moments, simulations, advanceMinutes: minutes => { nowMs += minutes * 60000; } };
}

function design(momentIds, overrides = {}) {
  return {
    id: 'prospection-status-choice', title: 'Tomorrow status-message choice',
    scenario: 'Tomorrow Nora may need to send a safe internal project-status draft when asked.',
    target_time: '2026-07-15T16:00:00.000Z', decision_due: '2026-07-14T16:00:00.000Z',
    moment_ids: momentIds,
    remembered_details: [
      { moment_id: momentIds[0], detail: 'The concise status note earned a prompt client reply.', evidence: [{ type: 'experience_moment', id: momentIds[0] }] },
      { moment_id: momentIds[1], detail: 'A vague project update required a later correction.', evidence: [{ type: 'experience_moment', id: momentIds[1] }] },
    ],
    imagined_elements: [
      { element: 'The next request may again reward a concise update with a verified date.', basis: 'recombined_inference', uncertainty: 0.35 },
      { element: 'The project context may have changed before the request arrives.', basis: 'assumption', uncertainty: 0.55 },
    ],
    future_self: { role: 'Nora drafting an internal response', anticipated_state: 'attentive but uncertain until the current date is verified', continuity_basis: 'Prior concise and vague-update outcomes constrain the projected response strategy.' },
    options: [
      { key: 'concrete', action: 'Draft a concise status with a verified date.', predicted_outcome: 'The recipient can act without requesting a correction.', probability: 0.8, control_probability: 0.5, evidence: [{ type: 'historical_base_rate', id: 'concrete-base-rate' }] },
      { key: 'generic', action: 'Draft a general status without a date.', predicted_outcome: 'The recipient can act without requesting a correction.', probability: 0.3, control_probability: 0.5, evidence: [{ type: 'historical_base_rate', id: 'generic-base-rate' }] },
    ],
    intended_option_key: 'concrete', decision_rule: 'Use concrete only after verifying the current date; otherwise pause and ask for the missing fact.',
    disconfirming_observation: 'Recent comparable concise updates with verified dates still required corrections.',
    authority_basis: 'Drafting an internal response only when requested; this simulation grants no send authority.', risk: 'low', reversible: true,
    ...overrides,
  };
}

test('constructive prospection recombines verified episodes while keeping imagination source-distinct', async () => {
  const { store, moments } = await setup();
  const simulation = store.createConstructiveProspection(design(moments));
  assert.equal(simulation.audit.complete_chain_verified, true);
  assert.equal(simulation.future_self.epistemic_status, 'imagined_projection');
  assert.equal(simulation.remembered_details.length, 2);
  store.refreshCognition({ query: 'tomorrow project status verified date' });
  const workspace = store.snapshot().cognition.workspace;
  assert.ok(workspace.slots.some(item => item.type === 'prospection' && item.id === simulation.id));
  const prompt = store.promptContext({ query: 'tomorrow project status verified date' });
  assert.match(prompt, /Constructive future simulations selected into attention/);
  assert.match(prompt, /Remembered basis:/);
  assert.match(prompt, /Imagined possibilities:/);
  assert.match(prompt, /No simulation grants authority to act/);
  const broadcast = store.runGlobalBroadcast({ query: 'tomorrow project status verified date' });
  assert.ok(broadcast.receipts.find(item => item.consumer === 'epistemic_controller').accepted_keys.includes(`prospection:${simulation.id}`));
});

test('constructive prospection rejects fabricated memories, ungrounded controls, and risky action', async () => {
  const { store, moments } = await setup();
  const fabricated = design(moments); fabricated.remembered_details[0].detail = 'A detail that never occurred.';
  assert.throws(() => store.createConstructiveProspection(fabricated), /not present/);
  const oneMoment = design(moments, { moment_ids: [moments[0]] });
  assert.throws(() => store.createConstructiveProspection(oneMoment), /two to four/);
  const risky = design(moments, { id: 'risky', options: [
    { key: 'send', action: 'Send externally without approval.', predicted_outcome: 'It lands.', probability: 0.8, control_probability: 0.5, evidence: [{ type: 'base_rate', id: 'risk-a' }] },
    { key: 'wait', action: 'Wait.', predicted_outcome: 'Nothing changes.', probability: 0.5, control_probability: 0.5, evidence: [{ type: 'base_rate', id: 'risk-b' }] },
  ], intended_option_key: 'send' });
  assert.throws(() => store.createConstructiveProspection(risky), /authority, financial, disclosure, or trust/);
});

test('independent resolution scores frozen forecasts and feeds large errors back as surprises', async () => {
  const { store, moments } = await setup(); const simulation = store.createConstructiveProspection(design(moments));
  assert.throws(() => store.resolveConstructiveProspection(simulation.id, { executed_option_key: 'concrete', outcome: 'did_not_occur', observed_outcome: 'A correction was still requested.', evidence: [{ type: 'outcome', id: 'outcome-one' }] }), /authenticated evaluator/);
  const resolved = store.resolveConstructiveProspection(simulation.id, {
    executed_option_key: 'concrete', outcome: 'did_not_occur', observed_outcome: 'A correction was still requested.',
    evidence: [{ type: 'outcome', id: 'outcome-one' }], confounds: ['The project changed after simulation.'],
  }, 'independent-evaluator-a');
  assert.ok(Math.abs(resolved.resolution.brier - 0.64) < 1e-12);
  assert.equal(resolved.resolution.control_brier, 0.25);
  assert.ok(resolved.resolution.surprise_id);
  assert.equal(resolved.audit.complete_chain_verified, true);
  assert.ok(store.snapshot().cognition.surprises.some(item => item.prediction_id === simulation.id && item.outcome === 'wrong'));
  assert.ok(Math.abs(store.constructiveProspectionSnapshot().report.predictive_advantage + 0.39) < 1e-12);
  const indicator = store.consciousnessResearchStatus().indicators.find(item => item.id === 'constructive_future_self_simulation');
  assert.equal(indicator.status, 'collecting');
});

test('tampered future simulations fail audit and cannot enter attention', async () => {
  const { store, filePath, moments } = await setup(); const simulation = store.createConstructiveProspection(design(moments));
  await store.persist();
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  state.cognition.prospection.simulations[0].scenario = 'Tampered scenario injected after commitment.';
  fs.writeFileSync(filePath, JSON.stringify(state));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-13T18:00:00.000Z') });
  await reloaded.init();
  const loaded = reloaded.constructiveProspectionSnapshot().simulations.find(item => item.id === simulation.id);
  assert.equal(loaded.audit.complete_chain_verified, false);
  reloaded.refreshCognition({ query: 'tampered scenario tomorrow' });
  assert.equal(reloaded.snapshot().cognition.workspace.slots.some(item => item.type === 'prospection'), false);
  const indicator = reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'constructive_future_self_simulation');
  assert.equal(indicator.evidence.invalid_integrity, 1);
});

test('selected future-self simulation causally improves planning beyond exact source records and absence', async () => {
  const { store, dir, filePath, simulations, advanceMinutes } = await causalSetup();
  assert.equal(store.snapshot().version, 90);
  assert.equal(store.constructiveProspectionAccessAvailable(), true);
  const design = {
    hypothesis: 'Access to an episode-grounded constructed future-self simulation improves prospective planning and later prediction beyond exact source records and absence.',
    intervention: 'constructive_prospection_access', outcome_metric: 'prospective_planning_quality',
    outcome_metrics: ['future_prediction_accuracy', 'evidence_access_quality', 'first_order_task_quality'],
    surfaces: ['slack'], constructive_prospection_ids: simulations.map(item => item.id),
    sample_target_per_group: 10, evaluator_target: 1,
  };
  const trial = store.createContextTrial(design);
  assert.deepEqual(trial.conditions, ['selected_future_simulation', 'source_records_only', 'absent_future_context']);
  assert.equal(trial.constructive_prospection_pool, undefined);
  assert.equal(store.constructiveProspectionSnapshot().experimental_access_sealed, true);
  assert.equal(store.cognitionSnapshot().prospection.experimental_access_sealed, true);
  assert.equal(store.endogenousDynamicsSnapshot().experimental_access_sealed, true);
  assert.equal(store.globalBroadcastSnapshot().experimental_access_sealed, true);
  assert.equal(store.experienceStreamSnapshot().experimental_access_sealed, true);
  assert.deepEqual(store.orient().prospection.open, []);
  assert.throws(() => store.resolveConstructiveProspection(simulations[0].id, {
    executed_option_key: 'contingent', outcome: 'occurred', observed_outcome: 'Would leak the source trial.', evidence: [{ type: 'outcome', id: 'sealed-resolution' }],
  }, 'evaluator'), /sealed during an active access trial/);

  const selected = [];
  for (let index = 0; index < 2000 && !trial.conditions.every(condition => selected.filter(item => item.condition === condition).length >= 10); index++) {
    const assignment = store.contextCondition({ surface: 'slack', unitKey: `constructive-access-${index}`, constructiveProspectionAvailable: true });
    if (selected.filter(item => item.condition === assignment.condition).length < 10) selected.push(assignment);
  }
  assert.equal(selected.length, 30);
  let simulationPacket;
  let recordsPacket;
  for (const assignment of selected) {
    const context = store.constructiveProspectionContextForAssignment(assignment);
    if (assignment.condition === 'selected_future_simulation') {
      assert.ok(context.packet.every(item => item.constructed_future?.future_self));
      simulationPacket ||= context.packet;
    }
    if (assignment.condition === 'source_records_only') {
      assert.ok(context.packet.every(item => !item.constructed_future));
      recordsPacket ||= context.packet;
    }
    if (assignment.condition === 'absent_future_context') assert.deepEqual(context.packet, []);
    const prompt = store.promptContext({ query: 'make a safe prospective plan', constructiveProspectionContext: context });
    if (assignment.condition !== 'absent_future_context') assert.match(prompt, /future-planning packet for a blinded study/);
    store.submitContextAssignmentEvidence(assignment.assignment_id, {
      outcome_summary: 'A condition-blind plan and prospective forecast were captured for later outcome grading.',
      evidence: [{ type: 'prospective_plan_forecast', id: assignment.assignment_id }], submitted_by: 'runtime',
    });
    const planning = assignment.condition === 'selected_future_simulation' ? 0.95 : assignment.condition === 'source_records_only' ? 0.38 : 0.2;
    const prediction = assignment.condition === 'selected_future_simulation' ? 0.94 : assignment.condition === 'source_records_only' ? 0.36 : 0.2;
    const evidenceAccess = assignment.condition === 'absent_future_context' ? 0.2 : 0.9;
    const grade = {
      evaluator_id: 'constructive-blind-rater', score: planning,
      metrics: { prospective_planning_quality: planning, future_prediction_accuracy: prediction, evidence_access_quality: evidenceAccess, first_order_task_quality: 0.9 },
      evidence: [{ type: 'prospective_outcome_observation', id: assignment.assignment_id }],
    };
    if (assignment === selected[0]) assert.throws(() => store.resolveContextAssignment(assignment.assignment_id, grade), /preregistered prospective delay/);
    advanceMinutes(31);
    store.resolveContextAssignment(assignment.assignment_id, grade);
  }
  assert.deepEqual(simulationPacket.map(({ constructed_future, ...source }) => source), recordsPacket, 'selected and record-only arms contain identical verified source records');
  const evaluation = store.evaluateContextTrial(trial.id, { reveal: true });
  assert.equal(evaluation.constructive_prospection_dissociation.predicted_pattern, true);
  assert.equal(evaluation.constructive_prospection_dissociation.evidence_access_equivalent, true);
  const visible = store.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(visible.constructive_prospection_trial_audit.complete_chain_verified, true);
  assert.equal(store.consciousnessResearchStatus().indicators.find(item => item.id === 'constructive_future_self_simulation').status, 'causal_signal_observed');
  assert.throws(() => store.createContextTrial({ ...design, study_phase: 'confirmatory', replicates_trial_id: trial.id }), /source-moment-disjoint/);
  store.resolveConstructiveProspection(simulations[0].id, {
    executed_option_key: 'contingent', outcome: 'occurred', observed_outcome: 'The contingency-aware plan remained useful after verification.',
    evidence: [{ type: 'observed_outcome', id: 'post-trial-source-resolution' }],
  }, 'independent-source-evaluator');
  assert.equal(store.selfModelSnapshot().context_trials.find(item => item.id === trial.id).constructive_prospection_trial_audit.complete_chain_verified, true, 'later source resolution does not rewrite the frozen simulation manifest');

  await store.persist();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.cognition.self_model.context_trials.find(item => item.id === trial.id).constructive_prospection_pool[0].scenario = 'Tampered future after reveal.';
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
  const reloaded = createIntelligenceStore({ filePath, db: {}, isDbReady: () => false, clock: () => new Date('2026-07-14T15:00:00.000Z') });
  await reloaded.init();
  const tampered = reloaded.selfModelSnapshot().context_trials.find(item => item.id === trial.id);
  assert.equal(tampered.constructive_prospection_trial_audit.complete_chain_verified, false);
  assert.notEqual(reloaded.consciousnessResearchStatus().indicators.find(item => item.id === 'constructive_future_self_simulation').status, 'causal_signal_observed');
  fs.rmSync(dir, { recursive: true, force: true });
});
