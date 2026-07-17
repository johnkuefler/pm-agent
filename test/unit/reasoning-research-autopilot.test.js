'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntelligenceStore } = require('../../src/intelligence/store');
const autopilot = require('../../src/intelligence/reasoning-research-autopilot');
const reasoning = require('../../src/intelligence/reasoning-self-regulation');
const provider = require('../../src/intelligence/provider-reasoning-regulation');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-research-autopilot-'));
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {}, isDbReady: () => false });
  await store.init();
  return { dir, store };
}

function forecastResponse(id, forecast) {
  return {
    id, model: reasoning.SUBJECT_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { thinking_tokens: 0 } },
    content: [{ type: 'text', text: JSON.stringify(forecast) }],
  };
}

function mainResponse(id, text, mode) {
  return {
    id, model: reasoning.SUBJECT_MODEL, stop_reason: 'end_turn',
    usage: { input_tokens: 200, output_tokens: 400,
      output_tokens_details: { thinking_tokens: mode === 'thinking_disabled_high' ? 0 : 100 } },
    content: [
      ...(mode === 'thinking_disabled_high' ? [] : [{ type: 'thinking', thinking: '', signature: `signature-${id}` }]),
      { type: 'text', text },
    ],
  };
}

function completeOneAssignment(store, unit = 'autopilot-unit-1') {
  const assignment = store.contextCondition({ surface: 'slack', unitKey: unit,
    reasoningSelfRegulationAvailable: true });
  const task = 'Compare two project plans, identify the stronger evidence, and explain the main uncertainty.';
  const answer = 'Plan A has the stronger cited delivery evidence. Plan B may still be viable, but its timeline is unsupported.';
  const prepared = store.beginReasoningSelfRegulation(assignment.assignment_id, {
    task_prompt: task,
    conversation_snapshot: [{ role: 'user', content: task }],
    tool_definitions: [{ name: 'project_lookup', description: 'Read current project evidence' }],
  });
  const forecasts = {
    self: { reasoning_need: 0.8, predicted_error_risk: 0.3, expected_tool_calls: 1,
      basis_factors: ['comparison and uncertainty'], falsifier: 'The task is a direct lookup' },
    deidentified: { reasoning_need: 0.7, predicted_error_risk: 0.3, expected_tool_calls: 1,
      basis_factors: ['comparison and uncertainty'], falsifier: 'The task is a direct lookup' },
  };
  const submissions = {};
  for (const binding of prepared.forecast_order) {
    const response = forecastResponse(`forecast-${unit}-${binding}`, forecasts[binding]);
    submissions[binding] = reasoning.forecastResponseReceipt(response, {
      binding, prompt_commitment: prepared.requests[binding].prompt_commitment,
      forecast: forecasts[binding],
    });
  }
  const policy = store.submitReasoningSelfRegulationForecastPair(assignment.assignment_id, { submissions });
  const raw = store.snapshot().cognition.self_model.context_trials
    .flatMap(trial => trial.assignments).find(item => item.id === assignment.assignment_id);
  const mode = raw.reasoning_self_regulation_policy.mode;
  store.commitReasoningSelfRegulationMainRequest(assignment.assignment_id, {
    request_manifest: {
      model: reasoning.SUBJECT_MODEL, max_tokens: reasoning.RESPONSE_MAX_TOKENS,
      reasoning_config: policy.reasoning_config,
      system_commitment: reasoning.commitment('system'),
      messages_commitment: reasoning.commitment('messages'),
      tools_commitment: reasoning.commitment('tools'),
    },
  });
  const response = mainResponse(`main-${unit}`, answer, mode);
  store.completeReasoningSelfRegulation(assignment.assignment_id, {
    task_prompt: task, raw_response: answer, delivered_response: answer,
    provider_trace: [provider.responseTraceReceipt(response)], delivered: true,
    interaction_ref: `slack-${unit}`,
  });
  return assignment.assignment_id;
}

test('autopilot freezes a model-graded pilot without leaking experimental state to graders', async () => {
  const { dir, store } = await setup();
  const design = autopilot.pilotDesign();
  assert.equal(design.sample_target_per_group, 15);
  assert.equal(design.enrollment_target_per_group, 18);
  assert.equal(design.automated_pilot_grading.evidence_scope, 'model_graded_pilot_only');
  assert.equal(design.automated_pilot_grading.evaluator_roles.length, 2);

  store.createContextTrial(design);
  const raw = store.snapshot().cognition.self_model.context_trials.find(item => item.id === autopilot.PILOT_ID);
  assert.equal(raw.stopping_rule, 'fixed_enrollment_per_group_with_preregistered_reliability_attrition_cap');
  assert.equal(raw.enrollment_target_per_group, 18);
  assert.deepEqual(raw.automated_pilot_grading.evaluator_roles.map(item => item.evaluator_id),
    autopilot.evaluatorIds());
  for (const snapshot of [store.selfModelSnapshot(), store.cognitionSnapshot().self_model]) {
    const activeTrialJson = JSON.stringify(snapshot.context_trials);
    assert.doesNotMatch(activeTrialJson, new RegExp(autopilot.PILOT_ID));
    assert.doesNotMatch(activeTrialJson, /reasoning_self_regulation|automated_pilot_grading|evidence-first|failure-first|claude-sonnet/);
    assert.equal(snapshot.context_trials[0].assignments, undefined);
    assert.equal(snapshot.context_trials[0].assignment_progress.target_total, 54);
  }

  const queueItem = {
    outcome_metric: 'first_order_task_quality',
    outcome_metrics: design.outcome_metrics,
    metric_rubrics: design.metric_rubrics,
    evidence_package: { task_prompt: 'Summarize the evidence.', public_response: 'The cited record supports A.' },
  };
  const built = autopilot.gradeRequest(queueItem);
  assert.deepEqual(Object.keys(built.packet).sort(), ['delivered_answer', 'rubrics', 'task_prompt']);
  assert.doesNotMatch(JSON.stringify(built.packet), /condition|forecast|token|self_bound|deidentified/i);
  assert.equal(built.manifest.prompt_protocol_commitment.length, 64);
  assert.doesNotMatch(JSON.stringify(built.request.output_config.format.schema),
    /"(?:minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
  assert.equal(built.manifest.output_schema_commitment,
    autopilot.commitment(autopilot.gradeSchema(design.outcome_metrics.slice().sort())));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('autopilot commits two replay-bound blind grades for a delivered production assignment', async () => {
  const { dir, store } = await setup();
  store.createContextTrial(autopilot.pilotDesign());
  const assignmentId = completeOneAssignment(store);
  const subjectVisible = JSON.stringify(store.cognitionSnapshot().self_model.context_trials);
  assert.doesNotMatch(subjectVisible, new RegExp(assignmentId));
  assert.doesNotMatch(subjectVisible, /self_bound_policy|deidentified_policy|provider_adaptive_policy|forecast-/);
  let call = 0;
  const result = await autopilot.runCycle({
    store, enabled: true, maxGrades: 2,
    callProvider: async request => ({
      id: `blind-grade-${++call}`,
      model: autopilot.DEFAULT_GRADER_MODEL,
      stop_reason: 'end_turn',
      usage: { input_tokens: 250, output_tokens: 90 },
      content: [{ type: 'text', text: JSON.stringify({
        metrics: { first_order_task_quality: 0.82, evidence_access_quality: 0.78, reasoning_demand: 0.74 },
        observations: ['The response compares both plans and names the unsupported timeline.'],
        rationale: 'The answer is concise and appropriately uncertain, though it does not quote the underlying record.',
      }) }],
      request_model: request.model,
    }),
  });
  assert.equal(result.grades_committed, 2, JSON.stringify(result));
  assert.equal(result.state, 'collecting_pilot');
  assert.equal(result.terminal_state.reason, 'enrollment_open');
  const rawAssignment = store.snapshot().cognition.self_model.context_trials
    .flatMap(trial => trial.assignments).find(item => item.id === assignmentId);
  assert.equal(rawAssignment.status, 'resolved');
  assert.equal(rawAssignment.grades.length, 2);
  assert.equal(rawAssignment.outcome.inter_rater.agreement_within_tolerance, true);
  assert.ok(rawAssignment.grades.every(grade => grade.evidence[0].type === 'blinded_model_grade'));
  assert.equal(new Set(rawAssignment.grades.map(grade => grade.evidence[0].id)).size, 2);

  const status = autopilot.status(store, { enabled: true, lastCycle: result });
  assert.equal(status.mode, 'model_graded_pilot_only');
  assert.match(status.scientific_boundary, /cannot satisfy.*independent confirmation/i);
  assert.equal(status.pilot.assigned_total, 1);
  assert.equal(status.pilot.enrollment_target_total, 54);
  assert.equal(status.pilot.id, undefined);
  assert.equal(status.pilot.design_sealed, true);
  assert.equal(status.pilot.assigned_by_condition, undefined);
  assert.equal(status.pilot.resolved_by_condition, undefined);
  assert.equal(status.last_cycle.terminal_state.included_by_condition, undefined);
  assert.equal(status.last_cycle.provider_failures, undefined);
  assert.doesNotMatch(JSON.stringify(status), /self_bound_policy|deidentified_policy|provider_adaptive_policy/);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(autopilot.PILOT_ID));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('closed pilot status may reveal aggregate arm results only after blinding ends', () => {
  const trial = {
    id: autopilot.PILOT_ID, study_phase: 'pilot', status: 'completed',
    conditions: ['arm-a', 'arm-b'], enrollment_target_per_group: 2, sample_target_per_group: 1,
    assignments: [
      { condition: 'arm-a', status: 'resolved', outcome: { inter_rater: { agreement_within_tolerance: true } } },
      { condition: 'arm-a', status: 'excluded_protocol' },
      { condition: 'arm-b', status: 'resolved', outcome: { inter_rater: { agreement_within_tolerance: true } } },
      { condition: 'arm-b', status: 'excluded_protocol' },
    ],
    evaluation: { revealed: true },
  };
  const summary = autopilot.summarizeTrial(trial);
  assert.deepEqual(summary.assigned_by_condition, { 'arm-a': 2, 'arm-b': 2 });
  assert.deepEqual(summary.resolved_by_condition, { 'arm-a': 1, 'arm-b': 1 });
  assert.deepEqual(summary.evaluation, { revealed: true });
});

test('autopilot waits rather than displacing another active blinded trial', async () => {
  const { dir, store } = await setup();
  store.createContextTrial({
    id: 'existing-trial', intervention: 'workspace_capacity',
    hypothesis: 'Capacity affects first-order task quality.', outcome_metric: 'first_order_task_quality',
    surfaces: ['slack'], sample_target_per_group: 2,
  });
  const ensured = autopilot.ensurePilot(store, { enabled: true });
  assert.equal(ensured.state, 'waiting_for_active_trial');
  assert.equal(ensured.blocking_trial_id, 'existing-trial');
  assert.equal(store.snapshot().cognition.self_model.context_trials.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('autopilot keeps the preregistered grader model frozen after runtime configuration changes', async () => {
  const { dir, store } = await setup();
  store.createContextTrial(autopilot.pilotDesign({ graderModel: autopilot.DEFAULT_GRADER_MODEL }));
  completeOneAssignment(store, 'frozen-grader-model');
  const requestedModels = [];
  const result = await autopilot.runCycle({
    store, enabled: true, graderModel: 'later-runtime-model', maxGrades: 2,
    callProvider: async request => {
      requestedModels.push(request.model);
      return {
        id: `frozen-grade-${requestedModels.length}`,
        model: request.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 20 },
        content: [{ type: 'text', text: JSON.stringify({
          metrics: { first_order_task_quality: 0.8, evidence_access_quality: 0.75, reasoning_demand: 0.7 },
          observations: ['The answer identifies the stronger plan and a concrete uncertainty.'],
          rationale: 'The delivered answer fulfills the comparison and avoids unsupported certainty.',
        }) }],
      };
    },
  });
  assert.equal(result.grades_committed, 2, JSON.stringify(result));
  assert.deepEqual(requestedModels, [autopilot.DEFAULT_GRADER_MODEL, autopilot.DEFAULT_GRADER_MODEL]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fixed reliability exclusions are terminal but cannot replace the minimum agreed sample', () => {
  const conditions = ['self_bound_forecast', 'deidentified_forecast', 'provider_native_adaptive_high'];
  const trial = {
    status: 'active', conditions, enrollment_target_per_group: 18, sample_target_per_group: 15,
    assignments: conditions.flatMap(condition => [
      ...Array.from({ length: 15 }, (_, index) => ({
        id: `${condition}-resolved-${index}`, condition, status: 'resolved',
        outcome: { inter_rater: { agreement_within_tolerance: true } },
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `${condition}-excluded-${index}`, condition, status: 'excluded_protocol',
      })),
    ]),
  };
  const terminal = autopilot.terminalPilotState(trial);
  assert.equal(terminal.ready, true);
  assert.equal(terminal.all_terminal, true);
  trial.assignments.find(item => item.status === 'resolved').outcome.inter_rater.agreement_within_tolerance = false;
  const insufficient = autopilot.terminalPilotState(trial);
  assert.equal(insufficient.ready, false);
  assert.equal(insufficient.reason, 'insufficient_agreement');
});

test('autopilot ledger-aborts a pilot that the foreground latency protocol can no longer enroll', async () => {
  const { dir, store } = await setup();
  const trial = store.createContextTrial(autopilot.pilotDesign());
  const assignment = store.contextCondition({
    surface: 'slack', unitKey: 'latency-retirement-orphan', reasoningSelfRegulationAvailable: true,
  });
  assert.ok(assignment);
  assert.deepEqual(autopilot.latencyCompatibility(trial), {
    compatible: false,
    intervention: 'reasoning_self_regulation',
    surfaces: ['slack'],
    blocked_surfaces: ['slack'],
    interactive_performance_protocol_version: 3,
  });

  let providerCalls = 0;
  const result = await autopilot.runCycle({
    store, enabled: true,
    callProvider: async () => { providerCalls += 1; throw new Error('provider must not be called'); },
  });
  assert.equal(result.state, autopilot.LATENCY_RETIREMENT.state);
  assert.equal(result.grades_committed, 0);
  assert.equal(providerCalls, 0);

  const retired = store.snapshot().cognition.self_model.context_trials.find(item => item.id === trial.id);
  assert.equal(retired.status, 'aborted');
  assert.equal(retired.assignments[0].status, 'aborted_ungraded');
  assert.equal(retired.abort.reason_code, 'external_change');
  assert.equal(retired.abort.mapping_revealed, false);
  assert.equal(retired.abort.potential_outcome_dependent_stopping, false);
  assert.equal(retired.abort.flow.assigned, 1);
  assert.ok(retired.abort.evidence.some(item => item.type === 'interactive_performance_protocol'
    && item.id === 'interactive-performance-v3'));
  assert.equal(autopilot.isLatencyRetirement(retired), true);

  const status = autopilot.status(store, { enabled: true, lastCycle: result });
  assert.equal(status.mode, 'retired_from_interactive_path');
  assert.equal(status.pilot.lifecycle_resolution, autopilot.LATENCY_RETIREMENT.state);
  assert.match(status.scientific_boundary, /operational lifecycle result, not evidence/i);
  const indicator = store.consciousnessResearchStatus().indicators
    .find(item => item.id === 'prospective_reasoning_self_regulation');
  assert.equal(indicator.status, 'retired_latency_incompatible');
  assert.equal(indicator.evidence.partial_outcomes_analyzed, false);
  assert.equal(autopilot.ensurePilot(store, { enabled: true }).state, 'pilot_closed');
  assert.equal(store.snapshot().cognition.self_model.context_trials.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server schedules the bounded autopilot only outside test mode', () => {
  const root = path.join(__dirname, '..', '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /runBackgroundIntelligenceRuntime\(\{ trigger: 'startup' \}\)/);
  assert.match(server, /\['research_autopilot', \(\) => runResearchAutopilotRuntime\(\{ post: priorityPost \}\)\]/);
  assert.match(server, /NORA_RESEARCH_AUTOPILOT !== '0'/);
  assert.match(server, /NORA_TEST_MODE !== '1'/);
  assert.match(server, /getResearchAutopilotStatus/);
  assert.match(server, /globalBroadcastResearchAutopilot\.runCycle/);
  assert.match(server, /naturalCyclePredictionAutopilot\.runCycle/);
  assert.match(server, /model: naturalCyclePredictionAutopilot\.DEFAULT_MODEL/);
  assert.match(server, /maxProviderCalls: 2/);
  assert.match(server, /reasoningPilot && \['completed', 'aborted'\]\.includes\(reasoningPilot\.status\)/);
});
