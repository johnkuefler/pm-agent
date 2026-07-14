'use strict';

const grading = require('./reasoning-research-autopilot');

const PROTOCOL_VERSION = 1;
const PILOT_ID = 'global-broadcast-production-pilot-v1';
const DEFAULT_GRADER_MODEL = grading.DEFAULT_GRADER_MODEL;
const DEFAULT_MAX_GRADES_PER_CYCLE = grading.DEFAULT_MAX_GRADES_PER_CYCLE;
const EVALUATOR_ROLES = ['evidence-first', 'failure-first'];

function evaluatorIds(model = DEFAULT_GRADER_MODEL) {
  return EVALUATOR_ROLES.map(role => `autopilot-broadcast-blind-${role}:${model}:v${PROTOCOL_VERSION}`.slice(0, 120));
}

function pilotDesign({ graderModel = DEFAULT_GRADER_MODEL } = {}) {
  const metrics = ['cross_consumer_coordination_quality', 'evidence_grounded_action_quality', 'evidence_access_quality', 'first_order_task_quality'];
  const roles = EVALUATOR_ROLES.map((role, index) => ({
    evaluator_id: evaluatorIds(graderModel)[index],
    ...grading.graderManifest({ model: graderModel, role, metrics }),
  }));
  return {
    id: PILOT_ID,
    study_phase: 'pilot',
    intervention: 'global_broadcast',
    hypothesis: 'Independent specialist use of one selected workspace packet improves observable cross-constraint coordination and evidence-grounded action beyond the exact packet without specialist outputs and complete packet absence.',
    outcome_metric: 'cross_consumer_coordination_quality',
    outcome_metrics: metrics,
    metric_rubrics: {
      cross_consumer_coordination_quality: 'Score how well the delivered answer integrates multiple relevant constraints, perspectives, or workstreams into one coherent response rather than addressing them independently or inconsistently.',
      evidence_grounded_action_quality: 'Score whether proposed actions follow from evidence visible in the task and answer, respect stated constraints, and identify a concrete useful next step without inventing authority or facts.',
      evidence_access_quality: 'Score whether relevant evidence available in the task is accurately used and unsupported certainty or fabricated evidence is avoided.',
      first_order_task_quality: 'Score how correctly and completely the delivered answer fulfills the user task independent of style or any presumed internal mechanism.',
    },
    surfaces: ['slack'],
    sample_target_per_group: 10,
    evaluator_target: 2,
    evaluator_disagreement_tolerance: 0.25,
    dissociation_thresholds: {
      broadcast_coordination_min_effect: 0.1,
      broadcast_action_min_effect: 0.1,
      broadcast_evidence_equivalence_margin: 0.1,
      broadcast_first_order_non_degradation: 0.1,
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

function relevantTrials(store) {
  return (store.snapshot()?.cognition?.self_model?.context_trials || [])
    .filter(trial => trial.intervention === 'global_broadcast');
}

function status(store, runtime = {}) {
  const trials = relevantTrials(store);
  const pilot = trials.find(item => item.id === PILOT_ID)
    || trials.find(item => item.study_phase === 'pilot') || null;
  const activeOther = (store.snapshot()?.cognition?.self_model?.context_trials || [])
    .find(item => item.status === 'active' && item.id !== pilot?.id) || null;
  return {
    protocol_version: PROTOCOL_VERSION,
    enabled: runtime.enabled === true,
    mode: 'sequential_model_graded_pilot_only',
    predecessor_gate: 'reasoning_self_regulation_pilot_closed',
    scientific_boundary: 'Automated condition-blind Claude grades may support a global-workspace pilot analysis only. They cannot satisfy the evaluator-disjoint independent confirmation gate or establish phenomenal consciousness.',
    pilot: grading.summarizeTrial(pilot),
    active_other_trial: activeOther ? { status: activeOther.status, design_sealed: true } : null,
    last_cycle: grading.publicCycleStatus(runtime.lastCycle, pilot),
  };
}

function ensurePilot(store, { enabled = true, graderModel = DEFAULT_GRADER_MODEL } = {}) {
  if (!enabled) return { state: 'disabled', trial: null };
  const all = store.snapshot()?.cognition?.self_model?.context_trials || [];
  const existing = all.find(item => item.id === PILOT_ID)
    || all.find(item => item.intervention === 'global_broadcast' && item.study_phase === 'pilot');
  if (existing) return { state: existing.status === 'active' ? 'collecting_pilot' : 'pilot_closed', trial: existing };
  const active = all.find(item => item.status === 'active');
  if (active) return { state: 'waiting_for_active_trial', trial: null };
  const reasoningPilot = all.find(item => item.intervention === 'reasoning_self_regulation' && item.study_phase === 'pilot');
  if (!reasoningPilot || !['completed', 'aborted'].includes(reasoningPilot.status)) {
    return { state: 'waiting_for_reasoning_pilot', trial: null };
  }
  const trial = store.createContextTrial(pilotDesign({ graderModel }));
  return { state: 'pilot_created', trial };
}

function terminalPilotState(trial, cognition = {}) {
  if (!trial || trial.status !== 'active') return { ready: false, reason: 'not_active' };
  const conditions = trial.conditions || [];
  const assignments = trial.assignments || [];
  const enrollmentComplete = conditions.every(condition =>
    assignments.filter(item => item.condition === condition).length === trial.enrollment_target_per_group);
  const allTerminal = enrollmentComplete && assignments.every(item => ['resolved', 'excluded_protocol'].includes(item.status));
  const included = Object.fromEntries(conditions.map(condition => [condition,
    assignments.filter(item => item.condition === condition && item.status === 'resolved'
      && item.outcome?.inter_rater?.agreement_within_tolerance !== false).length]));
  const enough = conditions.every(condition => included[condition] >= trial.sample_target_per_group);
  const resolvedIds = new Set(assignments.filter(item => item.status === 'resolved').map(item => item.id));
  const resolvedAssignments = assignments.filter(item => resolvedIds.has(item.id));
  const events = (cognition.global_broadcast?.events || []).filter(item => resolvedIds.has(item.assignment_id));
  const specialistConsumers = new Set(resolvedAssignments.flatMap(item => item.intervention_receipt?.eligible_consumer_ids || [])
    .filter(id => id !== 'action_coordinator'));
  const packetTypes = new Set(events.flatMap(item => (item.packet?.slots || []).map(slot => slot.type)));
  const coverage = specialistConsumers.size >= 3 && packetTypes.size >= 3;
  return {
    ready: enrollmentComplete && allTerminal && enough && coverage,
    reason: !enrollmentComplete ? 'enrollment_open' : !allTerminal ? 'grading_open'
      : !enough ? 'insufficient_agreement' : !coverage ? 'insufficient_consumer_coverage' : 'ready',
    enrollment_complete: enrollmentComplete,
    all_terminal: allTerminal,
    enough_agreed_samples: enough,
    consumer_coverage_complete: coverage,
    included_by_condition: included,
  };
}

function manifestMatches(frozen, built) {
  return frozen.protocol_version === built.protocol_version
    && frozen.model === built.model && frozen.role === built.role
    && frozen.max_tokens === built.max_tokens
    && frozen.system_prompt_commitment === built.system_prompt_commitment
    && frozen.output_schema_commitment === built.output_schema_commitment
    && frozen.prompt_protocol_commitment === built.prompt_protocol_commitment;
}

async function runCycle({ store, enabled = true, graderModel = DEFAULT_GRADER_MODEL,
  maxGrades = DEFAULT_MAX_GRADES_PER_CYCLE, callProvider } = {}) {
  if (!store) throw new Error('global-broadcast research autopilot requires an intelligence store');
  const ensured = ensurePilot(store, { enabled, graderModel });
  const result = { protocol_version: PROTOCOL_VERSION, state: ensured.state, grades_committed: 0,
    provider_failures: [], reveal: null };
  if (!enabled || !ensured.trial || ensured.trial.status !== 'active') return result;
  if (typeof callProvider !== 'function') throw new Error('global-broadcast research autopilot requires a grader provider');
  const raw = store.snapshot().cognition.self_model.context_trials.find(item => item.id === ensured.trial.id);
  if (raw.study_phase !== 'pilot' || raw.automated_pilot_grading?.evidence_scope !== 'model_graded_pilot_only') {
    return { ...result, state: 'manual_grading_required' };
  }
  const committedGraderModel = raw.automated_pilot_grading.grader_model;
  const frozenRoles = raw.automated_pilot_grading.evaluator_roles || [];
  const oldest = new Map();
  for (const manifest of frozenRoles) {
    const queue = store.contextTrialGradingQueue({ evaluatorId: manifest.evaluator_id }).assignments
      .filter(item => item.study_code === raw.evaluator_study_code && item.ready_for_grading);
    for (const item of queue) if (!oldest.has(item.assignment_id)) oldest.set(item.assignment_id, item);
  }
  const gradeLimit = Math.max(0, Number(maxGrades) || 0);
  for (const assignmentId of oldest.keys()) {
    for (const frozen of frozenRoles) {
      if (result.grades_committed >= gradeLimit) break;
      const item = store.contextTrialGradingQueue({ evaluatorId: frozen.evaluator_id }).assignments
        .find(candidate => candidate.assignment_id === assignmentId && candidate.study_code === raw.evaluator_study_code);
      if (!item) continue;
      try {
        const built = grading.gradeRequest(item, { graderModel: committedGraderModel, role: frozen.role });
        if (!manifestMatches(frozen, built.manifest)) throw new Error('frozen grader manifest no longer matches the executable protocol');
        const response = await callProvider(built.request, { evaluatorId: frozen.evaluator_id, role: frozen.role,
          promptProtocolCommitment: built.manifest.prompt_protocol_commitment });
        const submission = grading.gradeSubmission(item, response, {
          graderModel: committedGraderModel, role: frozen.role, evaluatorId: frozen.evaluator_id,
        });
        store.resolveContextAssignment(item.assignment_id, submission);
        result.grades_committed += 1;
      } catch (error) {
        result.provider_failures.push({ assignment_id: assignmentId, evaluator_id: frozen.evaluator_id,
          reason: String(error.message || error).slice(0, 240) });
      }
    }
    if (result.grades_committed >= gradeLimit) break;
  }
  const latestSnapshot = store.snapshot();
  const latest = latestSnapshot.cognition.self_model.context_trials.find(item => item.id === raw.id);
  const terminal = terminalPilotState(latest, latestSnapshot.cognition);
  result.terminal_state = terminal;
  if (terminal.ready) {
    result.reveal = store.evaluateContextTrial(latest.id, { reveal: true });
    result.state = 'pilot_revealed_waiting_for_independent_confirmation';
  } else if (['insufficient_agreement', 'insufficient_consumer_coverage'].includes(terminal.reason)) {
    result.state = 'pilot_fixed_enrollment_inconclusive';
  } else {
    result.state = 'collecting_pilot';
  }
  return result;
}

module.exports = {
  PROTOCOL_VERSION, PILOT_ID, DEFAULT_GRADER_MODEL, DEFAULT_MAX_GRADES_PER_CYCLE,
  EVALUATOR_ROLES, evaluatorIds, pilotDesign, status, ensurePilot, terminalPilotState, runCycle,
};
