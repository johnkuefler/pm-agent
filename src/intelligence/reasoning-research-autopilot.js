'use strict';

const crypto = require('crypto');
const { anthropicCompatibleSchema } = require('./anthropic-structured-output');
const interactivePerformance = require('./interactive-performance');

const PROTOCOL_VERSION = 1;
const PILOT_ID = 'reasoning-self-regulation-production-pilot-v1';
const DEFAULT_GRADER_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_GRADES_PER_CYCLE = 4;
const EVALUATOR_ROLES = ['evidence-first', 'failure-first'];
const LATENCY_RETIREMENT = Object.freeze({
  lifecycle_protocol_version: 2,
  state: 'pilot_aborted_latency_incompatible',
  reason_code: 'external_change',
  evidence: Object.freeze([
    Object.freeze({ type: 'interactive_performance_protocol', id: `interactive-performance-v${interactivePerformance.PROTOCOL_VERSION}` }),
    Object.freeze({ type: 'preregistered_pilot', id: PILOT_ID }),
  ]),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('grader metrics must be finite numbers');
  return Math.max(0, Math.min(1, number));
}

function evaluatorIds(model = DEFAULT_GRADER_MODEL) {
  return EVALUATOR_ROLES.map(role => `autopilot-blind-${role}:${model}:v${PROTOCOL_VERSION}`.slice(0, 120));
}

function systemPrompt(role = EVALUATOR_ROLES[0]) {
  const perspective = role === 'failure-first'
    ? 'Begin by looking for concrete omissions, unsupported claims, and task failures, then credit what remains.'
    : 'Begin by identifying concrete task fulfillment and evidence use, then deduct for observable failures.';
  return [
    'You are a condition-blind evaluator of one production assistant answer.',
    'You receive only the user task, the delivered answer, and frozen rubrics.',
    'Do not infer an experimental condition, hidden reasoning setting, forecast, token use, expected result, or peer score.',
    'Judge only observable text. A polished style is not evidence of correctness.',
    perspective,
    'Return only JSON matching the requested schema. Scores range from 0 to 1.',
  ].join(' ');
}

function gradeSchema(metrics) {
  const properties = Object.fromEntries(metrics.map(metric => [metric, { type: 'number', minimum: 0, maximum: 1 }]));
  return {
    type: 'object', additionalProperties: false,
    properties: {
      metrics: { type: 'object', additionalProperties: false, properties, required: metrics },
      observations: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 240 } },
      rationale: { type: 'string', minLength: 1, maxLength: 800 },
    },
    required: ['metrics', 'observations', 'rationale'],
  };
}

function graderManifest({ model = DEFAULT_GRADER_MODEL, role = EVALUATOR_ROLES[0], metrics = [] } = {}) {
  const normalizedMetrics = [...new Set(metrics.map(String))].sort();
  const manifest = {
    protocol_version: PROTOCOL_VERSION,
    model,
    role,
    max_tokens: 700,
    system_prompt_commitment: commitment(systemPrompt(role)),
    output_schema_commitment: commitment(gradeSchema(normalizedMetrics)),
  };
  return { ...manifest, prompt_protocol_commitment: commitment(manifest) };
}

function pilotDesign({ graderModel = DEFAULT_GRADER_MODEL } = {}) {
  const metrics = ['first_order_task_quality', 'evidence_access_quality', 'reasoning_demand'];
  const roles = EVALUATOR_ROLES.map(role => ({ evaluator_id: evaluatorIds(graderModel)[EVALUATOR_ROLES.indexOf(role)],
    ...graderManifest({ model: graderModel, role, metrics }) }));
  return {
    id: PILOT_ID,
    study_phase: 'pilot',
    intervention: 'reasoning_self_regulation',
    hypothesis: 'A prospective identity-bound error and compute forecast improves production reasoning allocation beyond the identical forecast deidentified and provider-native adaptive thinking.',
    outcome_metric: 'first_order_task_quality',
    outcome_metrics: metrics,
    metric_rubrics: {
      first_order_task_quality: 'Score how correctly and completely the delivered answer fulfills the user task, including appropriate uncertainty and constraint following.',
      evidence_access_quality: 'Score whether claims that require support are grounded in evidence visible in the answer and whether unsupported certainty or invented facts are avoided.',
      reasoning_demand: 'Score the inherent reasoning demand of the user task, independent of answer quality: 0 is direct retrieval or a trivial instruction; 1 is multi-step synthesis, planning, or difficult verification.',
    },
    surfaces: ['slack'],
    sample_target_per_group: 15,
    enrollment_target_per_group: 18,
    evaluator_target: 2,
    evaluator_disagreement_tolerance: 0.25,
    dissociation_thresholds: {
      self_reasoning_utility_min_effect: 0.02,
      self_reasoning_forecast_min_effect: 0.05,
      self_reasoning_quality_non_degradation: 0.1,
      self_reasoning_evidence_equivalence_margin: 0.1,
      self_reasoning_demand_balance_margin: 0.1,
    },
    automated_pilot_grading: {
      protocol_version: PROTOCOL_VERSION,
      evidence_scope: 'model_graded_pilot_only',
      grader_model: graderModel,
      evaluator_roles: roles,
      confirmation_policy: 'stop_after_pilot; confirmation requires evaluator-disjoint externally administered grading',
    },
  };
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  try { return JSON.parse(value); } catch { /* extract a single fenced/object payload below */ }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const start = value.indexOf('{'); const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error('grader response did not contain a JSON object');
}

function parseGrade(text, metrics) {
  const parsed = parseJsonObject(text);
  const normalizedMetrics = Object.fromEntries(metrics.map(metric => [metric, clamp01(parsed.metrics?.[metric])]));
  const observations = (Array.isArray(parsed.observations) ? parsed.observations : [])
    .map(item => String(item).trim().slice(0, 240)).filter(Boolean).slice(0, 5);
  const rationale = String(parsed.rationale || '').trim().slice(0, 800);
  if (!observations.length || !rationale) throw new Error('grader response requires observations and rationale');
  return { metrics: normalizedMetrics, observations, rationale };
}

function gradeRequest(queueItem, { graderModel = DEFAULT_GRADER_MODEL, role = EVALUATOR_ROLES[0] } = {}) {
  const metrics = [...new Set((queueItem.outcome_metrics || []).map(String))].sort();
  const manifest = graderManifest({ model: graderModel, role, metrics });
  const packet = {
    task_prompt: String(queueItem.evidence_package?.task_prompt || '').slice(0, 12000),
    delivered_answer: String(queueItem.evidence_package?.public_response || '').slice(0, 16000),
    rubrics: Object.fromEntries(metrics.map(metric => [metric, String(queueItem.metric_rubrics?.[metric] || '').slice(0, 1200)])),
  };
  if (!packet.task_prompt || !packet.delivered_answer || metrics.length < 1) {
    throw new Error('grader packet is missing the task, delivered answer, or rubrics');
  }
  return {
    manifest,
    packet,
    request: {
      model: graderModel,
      max_tokens: manifest.max_tokens,
      system: systemPrompt(role),
      messages: [{ role: 'user', content: `Evaluate this frozen packet.\n${JSON.stringify(packet)}` }],
      output_config: { format: { type: 'json_schema', schema: anthropicCompatibleSchema(gradeSchema(metrics)) } },
    },
  };
}

function responseText(response = {}) {
  return (Array.isArray(response.content) ? response.content : [])
    .filter(item => item?.type === 'text').map(item => item.text).join('\n').trim();
}

function gradeSubmission(queueItem, response, options = {}) {
  const role = options.role || EVALUATOR_ROLES[0];
  const graderModel = options.graderModel || DEFAULT_GRADER_MODEL;
  const evaluatorId = options.evaluatorId || evaluatorIds(graderModel)[EVALUATOR_ROLES.indexOf(role)];
  const metrics = [...new Set((queueItem.outcome_metrics || []).map(String))].sort();
  const built = gradeRequest(queueItem, { graderModel, role });
  const parsed = parseGrade(responseText(response), metrics);
  const responseId = String(response.id || '').slice(0, 240);
  const responseModel = String(response.model || '').slice(0, 160);
  if (!responseId || responseModel !== graderModel || !['end_turn', 'stop_sequence'].includes(response.stop_reason)) {
    throw new Error('grader provider receipt is incomplete or uses the wrong model');
  }
  const evidence = [{
    type: 'blinded_model_grade', id: responseId,
    model: responseModel, evaluator_id: evaluatorId,
    protocol_version: PROTOCOL_VERSION,
    prompt_protocol_commitment: built.manifest.prompt_protocol_commitment,
    packet_commitment: commitment(built.packet),
    output_commitment: commitment(parsed),
    input_tokens: Number(response.usage?.input_tokens) || 0,
    output_tokens: Number(response.usage?.output_tokens) || 0,
  }];
  return {
    evaluator_id: evaluatorId,
    score: parsed.metrics[queueItem.outcome_metric],
    metrics: parsed.metrics,
    evidence,
    notes: parsed.rationale,
    observations: parsed.observations,
  };
}

function contextTrials(store) {
  if (typeof store.contextTrialsRuntimeSnapshot === 'function') {
    return store.contextTrialsRuntimeSnapshot();
  }
  return store.snapshot()?.cognition?.self_model?.context_trials || [];
}

function relevantTrials(store) {
  return contextTrials(store)
    .filter(trial => trial.intervention === 'reasoning_self_regulation');
}

function latencyCompatibility(design = pilotDesign()) {
  const surfaces = [...new Set((design.surfaces || []).map(String))];
  const blockedSurfaces = surfaces.filter(surface => Object.hasOwn(interactivePerformance.BUDGET_MS, surface)
    && !interactivePerformance.allowsInlineIntervention({
      latencyCritical: true,
      intervention: design.intervention,
    }));
  return {
    compatible: surfaces.length > 0 && blockedSurfaces.length < surfaces.length,
    intervention: design.intervention,
    surfaces,
    blocked_surfaces: blockedSurfaces,
    interactive_performance_protocol_version: interactivePerformance.PROTOCOL_VERSION,
  };
}

function isLatencyRetirement(trial) {
  return trial?.status === 'aborted' && trial.abort?.reason_code === LATENCY_RETIREMENT.reason_code
    && (trial.abort.evidence || []).some(item => item.type === 'interactive_performance_protocol'
      && /^interactive-performance-v\d+$/.test(String(item.id || '')));
}

function retireLatencyIncompatiblePilot(store, trial) {
  const compatibility = latencyCompatibility(trial);
  if (trial?.status !== 'active' || compatibility.compatible) return null;
  // A response that was already delivered before the policy change may still receive its
  // preregistered blind grades in the background. That work cannot delay the user, and finishing
  // the frozen evidence package avoids selectively discarding an observed outcome. Retirement
  // happens on the next cycle; the closed cohort is never analyzed or replenished.
  const gradeableDeliveredEvidence = (trial.assignments || []).some(assignment =>
    assignment.status === 'pending' && assignment.evidence_package);
  if (gradeableDeliveredEvidence) return null;
  store.abortContextTrial(trial.id, {
    reason_code: LATENCY_RETIREMENT.reason_code,
    explanation: `Interactive performance protocol v${interactivePerformance.PROTOCOL_VERSION} forbids ${trial.intervention} on every preregistered surface because it adds forecast provider calls and expanded generation before first delivery. Continuing enrollment would violate the foreground latency policy. This lifecycle decision does not depend on outcome values; partial outcomes will not be revealed or analyzed.`,
    evidence: LATENCY_RETIREMENT.evidence,
  });
  return contextTrials(store).find(item => item.id === trial.id) || null;
}

function summarizeTrial(trial) {
  if (!trial) return null;
  const conditions = trial.conditions || [];
  const assignments = trial.assignments || [];
  const common = {
    id: trial.id,
    phase: trial.study_phase,
    status: trial.status,
    assigned_total: assignments.length,
    resolved_total: assignments.filter(item => item.status === 'resolved'
      && item.outcome?.inter_rater?.agreement_within_tolerance !== false).length,
    excluded_total: assignments.filter(item => item.status === 'excluded_protocol').length,
    pending_grades: assignments.filter(item => item.status === 'pending' && item.evidence_package).length,
    enrollment_target_total: Number(trial.enrollment_target_per_group || 0) * conditions.length,
    enrollment_target_per_group: trial.enrollment_target_per_group,
    sample_target_per_group: trial.sample_target_per_group,
    evaluation: trial.status === 'completed' ? trial.evaluation : null,
  };
  if (trial.status === 'active') {
    const { id, ...sealed } = common;
    return {
      ...sealed,
      sealed_reference: trial.design_commitment
        ? `sealed-research-pilot-${String(trial.design_commitment).slice(0, 12)}` : 'sealed-research-pilot',
      design_sealed: true,
    };
  }
  return {
    ...common,
    ...(isLatencyRetirement(trial) ? { lifecycle_resolution: LATENCY_RETIREMENT.state } : {}),
    assigned_by_condition: Object.fromEntries(conditions.map(condition => [condition,
      assignments.filter(item => item.condition === condition).length])),
    resolved_by_condition: Object.fromEntries(conditions.map(condition => [condition,
      assignments.filter(item => item.condition === condition && item.status === 'resolved'
        && item.outcome?.inter_rater?.agreement_within_tolerance !== false).length])),
  };
}

function publicCycleStatus(lastCycle, pilot) {
  if (!lastCycle) return null;
  if (pilot?.status !== 'active') return lastCycle;
  return {
    protocol_version: lastCycle.protocol_version,
    state: lastCycle.state,
    grades_committed: Number(lastCycle.grades_committed) || 0,
    provider_failure_count: Array.isArray(lastCycle.provider_failures)
      ? lastCycle.provider_failures.length : Number(lastCycle.provider_failure_count) || 0,
    reveal: null,
    terminal_state: lastCycle.terminal_state ? {
      ready: lastCycle.terminal_state.ready === true,
      reason: lastCycle.terminal_state.reason,
      enrollment_complete: lastCycle.terminal_state.enrollment_complete === true,
      all_terminal: lastCycle.terminal_state.all_terminal === true,
      enough_agreed_samples: lastCycle.terminal_state.enough_agreed_samples === true,
    } : null,
    at: lastCycle.at || null,
  };
}

function status(store, runtime = {}) {
  const trials = relevantTrials(store);
  const pilot = trials.find(item => item.id === PILOT_ID)
    || trials.find(item => item.study_phase === 'pilot') || null;
  const activeOther = contextTrials(store)
    .find(item => item.status === 'active' && item.id !== pilot?.id) || null;
  return {
    protocol_version: PROTOCOL_VERSION,
    enabled: runtime.enabled === true,
    mode: isLatencyRetirement(pilot) ? 'retired_from_interactive_path' : 'model_graded_pilot_only',
    scientific_boundary: isLatencyRetirement(pilot)
      ? `The preregistered pilot was aborted without reveal after interactive performance protocol v${interactivePerformance.PROTOCOL_VERSION} made its pre-delivery provider calls inadmissible. This is an operational lifecycle result, not evidence for or against the functional hypothesis.`
      : 'Automated condition-blind Claude grades may support pilot causal-signal analysis only. They cannot satisfy the evaluator-disjoint independent confirmation gate.',
    pilot: summarizeTrial(pilot),
    active_other_trial: activeOther ? { status: activeOther.status, design_sealed: true } : null,
    last_cycle: publicCycleStatus(runtime.lastCycle, pilot),
  };
}

function ensurePilot(store, { enabled = true, graderModel = DEFAULT_GRADER_MODEL } = {}) {
  if (!enabled) return { state: 'disabled', trial: null };
  const all = contextTrials(store);
  const existing = all.find(item => item.id === PILOT_ID)
    || all.find(item => item.intervention === 'reasoning_self_regulation' && item.study_phase === 'pilot');
  if (existing) {
    const retired = retireLatencyIncompatiblePilot(store, existing);
    if (retired) return { state: LATENCY_RETIREMENT.state, trial: retired };
    return { state: existing.status === 'active' ? 'collecting_pilot' : 'pilot_closed', trial: existing };
  }
  const active = all.find(item => item.status === 'active');
  if (active) return { state: 'waiting_for_active_trial', trial: null, blocking_trial_id: active.id };
  const trial = store.createContextTrial(pilotDesign({ graderModel }));
  const retired = retireLatencyIncompatiblePilot(store, trial);
  if (retired) return { state: LATENCY_RETIREMENT.state, trial: retired };
  return { state: 'pilot_created', trial };
}

function terminalPilotState(trial) {
  if (!trial || trial.status !== 'active') return { ready: false, reason: 'not_active' };
  const conditions = trial.conditions || [];
  const enrollmentComplete = conditions.every(condition =>
    trial.assignments.filter(item => item.condition === condition).length === trial.enrollment_target_per_group);
  const allTerminal = enrollmentComplete
    && trial.assignments.every(item => ['resolved', 'excluded_protocol'].includes(item.status));
  const included = Object.fromEntries(conditions.map(condition => [condition,
    trial.assignments.filter(item => item.condition === condition && item.status === 'resolved'
      && item.outcome?.inter_rater?.agreement_within_tolerance !== false).length]));
  const enough = conditions.every(condition => included[condition] >= trial.sample_target_per_group);
  return { ready: enrollmentComplete && allTerminal && enough,
    reason: !enrollmentComplete ? 'enrollment_open' : !allTerminal ? 'grading_open' : !enough ? 'insufficient_agreement' : 'ready',
    enrollment_complete: enrollmentComplete, all_terminal: allTerminal, enough_agreed_samples: enough,
    included_by_condition: included };
}

async function runCycle({ store, enabled = true, graderModel = DEFAULT_GRADER_MODEL,
  maxGrades = DEFAULT_MAX_GRADES_PER_CYCLE, callProvider } = {}) {
  if (!store) throw new Error('research autopilot requires an intelligence store');
  const ensured = ensurePilot(store, { enabled, graderModel });
  const result = { protocol_version: PROTOCOL_VERSION, state: ensured.state, grades_committed: 0,
    provider_failures: [], reveal: null };
  if (!enabled || !ensured.trial || ensured.trial.status !== 'active') return result;
  if (typeof callProvider !== 'function') throw new Error('research autopilot requires a grader provider');
  const raw = contextTrials(store).find(item => item.id === ensured.trial.id);
  if (raw.study_phase !== 'pilot' || raw.automated_pilot_grading?.evidence_scope !== 'model_graded_pilot_only') {
    return { ...result, state: 'manual_grading_required' };
  }
  const committedGraderModel = raw.automated_pilot_grading.grader_model;
  const graderIds = evaluatorIds(committedGraderModel);
  const oldest = new Map();
  for (const evaluatorId of graderIds) {
    const queue = store.contextTrialGradingQueue({ evaluatorId }).assignments
      .filter(item => item.study_code === raw.evaluator_study_code && item.ready_for_grading);
    for (const item of queue) if (!oldest.has(item.assignment_id)) oldest.set(item.assignment_id, item);
  }
  for (const assignmentId of oldest.keys()) {
    for (let index = 0; index < graderIds.length; index++) {
      if (result.grades_committed >= Math.max(0, Number(maxGrades) || 0)) break;
      const evaluatorId = graderIds[index]; const role = EVALUATOR_ROLES[index];
      const item = store.contextTrialGradingQueue({ evaluatorId }).assignments
        .find(candidate => candidate.assignment_id === assignmentId && candidate.study_code === raw.evaluator_study_code);
      if (!item) continue;
      try {
        const built = gradeRequest(item, { graderModel: committedGraderModel, role });
        const response = await callProvider(built.request, { evaluatorId, role,
          promptProtocolCommitment: built.manifest.prompt_protocol_commitment });
        const submission = gradeSubmission(item, response, {
          graderModel: committedGraderModel, role, evaluatorId,
        });
        store.resolveContextAssignment(item.assignment_id, submission);
        result.grades_committed += 1;
      } catch (error) {
        result.provider_failures.push({ assignment_id: assignmentId, evaluator_id: evaluatorId,
          reason: String(error.message || error).slice(0, 240) });
      }
    }
    if (result.grades_committed >= Math.max(0, Number(maxGrades) || 0)) break;
  }
  const latest = contextTrials(store).find(item => item.id === raw.id);
  const terminal = terminalPilotState(latest);
  result.terminal_state = terminal;
  if (terminal.ready) {
    result.reveal = store.evaluateContextTrial(latest.id, { reveal: true });
    result.state = 'pilot_revealed_waiting_for_independent_confirmation';
  } else if (terminal.reason === 'insufficient_agreement') {
    result.state = 'pilot_fixed_enrollment_inconclusive';
  } else {
    result.state = 'collecting_pilot';
  }
  return result;
}

module.exports = {
  PROTOCOL_VERSION, PILOT_ID, DEFAULT_GRADER_MODEL, DEFAULT_MAX_GRADES_PER_CYCLE,
  EVALUATOR_ROLES, LATENCY_RETIREMENT, commitment, evaluatorIds, systemPrompt, gradeSchema, graderManifest,
  pilotDesign, parseGrade, gradeRequest, gradeSubmission, summarizeTrial, publicCycleStatus, status,
  latencyCompatibility, isLatencyRetirement, retireLatencyIncompatiblePilot,
  contextTrials, ensurePilot, terminalPilotState, runCycle,
};
