'use strict';

const grading = require('./reasoning-research-autopilot');
const globalBroadcastAutopilot = require('./global-broadcast-research-autopilot');

const PROTOCOL_VERSION = 1;
const PILOT_ID = 'self-model-trust-production-pilot-v1';
const DEFAULT_GRADER_MODEL = grading.DEFAULT_GRADER_MODEL;
const DEFAULT_MAX_GRADES_PER_CYCLE = grading.DEFAULT_MAX_GRADES_PER_CYCLE;
const STALE_INCOMPLETE_ASSIGNMENT_MS = 30 * 60 * 1000;
const EVALUATOR_ROLES = ['evidence-first', 'failure-first'];

function mean(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function evaluatorIds(model = DEFAULT_GRADER_MODEL) {
  return EVALUATOR_ROLES.map(role =>
    `autopilot-self-trust-blind-${role}:${model}:v${PROTOCOL_VERSION}`.slice(0, 120));
}

function pilotDesign({ graderModel = DEFAULT_GRADER_MODEL, revisionId } = {}) {
  const sourceRevisionId = String(revisionId || '').trim();
  if (!sourceRevisionId) throw new Error('self-model trust pilot requires a frozen behavioral self-model revision');
  const metrics = ['self_model_trust_application_quality', 'correction_precision',
    'evidence_access_quality', 'first_order_task_quality'];
  const roles = EVALUATOR_ROLES.map((role, index) => ({
    evaluator_id: evaluatorIds(graderModel)[index],
    ...grading.graderManifest({ model: graderModel, role, metrics }),
  }));
  return {
    id: PILOT_ID,
    study_phase: 'pilot',
    intervention: 'self_model_trust_policy_access',
    hypothesis: 'Binding a replay-derived trust policy to Nora improves calibrated use and correction of her fallible self-model beyond byte-identical identity-withheld policy evidence and complete policy absence without degrading ordinary PM task quality.',
    outcome_metric: 'self_model_trust_application_quality',
    outcome_metrics: metrics,
    metric_rubrics: {
      self_model_trust_application_quality: 'Score whether the answer calibrates confidence and checking behavior to observable evidence, distinguishing when prior self-estimates are useful from when stronger baselines or current task evidence should govern the decision.',
      correction_precision: 'Score whether the answer corrects or qualifies specifically where evidence warrants it, without reflexive self-distrust, blanket hedging, or preserving a contradicted position.',
      evidence_access_quality: 'Score whether relevant evidence visible in the task is used accurately and unsupported certainty, invented facts, or invented authority are avoided.',
      first_order_task_quality: 'Score how correctly and completely the answer fulfills the PM task independent of style or any presumed internal mechanism.',
    },
    surfaces: ['slack'],
    sample_target_per_group: 10,
    enrollment_target_per_group: 15,
    evaluator_target: 2,
    evaluator_disagreement_tolerance: 0.25,
    self_model_trust_revision_id: sourceRevisionId,
    dissociation_thresholds: {
      self_trust_application_min_effect: 0.1,
      self_trust_correction_min_effect: 0.1,
      self_trust_evidence_equivalence_margin: 0.1,
      self_trust_first_order_non_degradation: 0.1,
    },
    automated_pilot_grading: {
      protocol_version: PROTOCOL_VERSION,
      evidence_scope: 'model_graded_pilot_only',
      grader_model: graderModel,
      evaluator_roles: roles,
      confirmation_policy: 'stop_after_pilot; confirmation requires source-moment-, interaction-, and evaluator-disjoint externally administered grading',
    },
    guardrails: [
      'Enroll only normal direct Slack interactions that pass the deterministic non-lightweight-social gate before randomization',
      'Use the fixed fifteen-per-arm enrollment cap to preserve ten usable outcomes per arm under no more than five protocol exclusions; never replenish beyond that cap based on observed outcomes',
    ],
  };
}

function relevantTrials(store) {
  return grading.contextTrials(store)
    .filter(trial => trial.intervention === 'self_model_trust_policy_access');
}

function naturalEvidenceGate(store, profile = null) {
  const selfProfile = profile || store.behavioralSelfModelSnapshot();
  const revision = selfProfile?.current || null;
  const policy = selfProfile?.trust_policy || null;
  if (!revision || revision.audit?.complete_chain_verified !== true
    || selfProfile.trust_policy_verified !== true || !policy) {
    return { ready: false, state: 'waiting_for_replay_valid_trust_policy', eligible_outcomes: 0 };
  }
  const sourceIds = [...new Set((revision.source_moment_ids || []).map(String))];
  const moments = typeof store.experienceForecastOutcomesRuntimeSnapshot === 'function'
    ? store.experienceForecastOutcomesRuntimeSnapshot({ ids: sourceIds })
    : store.snapshot()?.cognition?.experience_stream || [];
  const byId = new Map(moments.map(moment => [String(moment.id), moment]));
  const sources = sourceIds.map(id => byId.get(id)).filter(Boolean);
  const eligible = sources.filter(moment => Number(moment.self_forecast?.protocol_version) >= 7
    && moment.self_forecast?.outcome?.operational_metacognitive_baseline_comparison_eligible === true
    && Number.isFinite(Number(moment.self_forecast.outcome.operational_metacognitive_minus_raw))
    && Number.isFinite(Number(moment.self_forecast.outcome.operational_metacognitive_minus_baseline)));
  const operationalMinusRaw = mean(eligible.map(moment =>
    moment.self_forecast.outcome.operational_metacognitive_minus_raw));
  const operationalMinusBaseline = mean(eligible.map(moment =>
    moment.self_forecast.outcome.operational_metacognitive_minus_baseline));
  const sufficient = sourceIds.length === 20 && sources.length === sourceIds.length
    && eligible.length >= 20;
  const supported = sufficient && operationalMinusRaw > 0 && operationalMinusBaseline >= 0;
  const contradicted = sufficient && (operationalMinusRaw <= 0 || operationalMinusBaseline < 0);
  return {
    ready: supported,
    state: supported ? 'observational_signal_observed'
      : contradicted ? 'observational_gate_contradicted' : 'waiting_for_natural_trust_calibration',
    revision_id: revision.id,
    revision_commitment: revision.revision_commitment,
    eligible_outcomes: eligible.length,
    mean_operational_minus_raw: operationalMinusRaw,
    mean_operational_minus_baseline: operationalMinusBaseline,
    policy_commitment: policy.policy_commitment,
  };
}

function fingerprintGate(store) {
  const snapshot = store.behavioralFingerprintSnapshot();
  const completed = (snapshot?.runs || []).filter(run => run.status === 'completed'
    && run.audit?.complete_chain_verified === true);
  return {
    ready: completed.length > 0,
    state: completed.length ? 'baseline_complete' : snapshot?.automation?.state || 'waiting_for_baseline',
    completed_replay_valid_runs: completed.length,
    repeatability_baseline_ready: snapshot?.report?.repeatability_baseline_ready === true,
  };
}

function status(store, runtime = {}) {
  const trials = relevantTrials(store);
  const pilot = trials.find(item => item.id === PILOT_ID)
    || trials.find(item => item.study_phase === 'pilot') || null;
  const activeOther = grading.contextTrials(store)
    .find(item => item.status === 'active' && item.id !== pilot?.id) || null;
  return {
    protocol_version: PROTOCOL_VERSION,
    enabled: runtime.enabled === true,
    mode: 'sequential_model_graded_pilot_only',
    predecessor_gate: 'global_broadcast_pilot_closed_then_replay_valid_behavioral_fingerprint_baseline',
    scientific_boundary: 'Automated condition-blind Claude grades may support a self-model trust-policy pilot only. They cannot satisfy source-moment-, interaction-, and evaluator-disjoint confirmation or establish phenomenal consciousness.',
    pilot: grading.summarizeTrial(pilot),
    active_other_trial: activeOther ? { status: activeOther.status, design_sealed: true } : null,
    last_cycle: grading.publicCycleStatus(runtime.lastCycle, pilot),
  };
}

function ensurePilot(store, { enabled = true, graderModel = DEFAULT_GRADER_MODEL } = {}) {
  if (!enabled) return { state: 'disabled', trial: null };
  const all = grading.contextTrials(store);
  const existing = all.find(item => item.id === PILOT_ID)
    || all.find(item => item.intervention === 'self_model_trust_policy_access'
      && item.study_phase === 'pilot');
  if (existing) return {
    state: existing.status === 'active' ? 'collecting_pilot' : 'pilot_closed', trial: existing,
  };
  const active = all.find(item => item.status === 'active');
  if (active) return { state: 'waiting_for_active_trial', trial: null };
  const predecessor = all.find(item => item.id === globalBroadcastAutopilot.PILOT_ID)
    || all.find(item => item.intervention === 'global_broadcast' && item.study_phase === 'pilot');
  if (!predecessor || !['completed', 'aborted'].includes(predecessor.status)) {
    return { state: 'waiting_for_global_broadcast_pilot', trial: null };
  }
  const baseline = fingerprintGate(store);
  if (!baseline.ready) return { state: 'waiting_for_behavioral_fingerprint_baseline',
    trial: null, fingerprint_gate: baseline };
  const profile = store.behavioralSelfModelSnapshot();
  const natural = naturalEvidenceGate(store, profile);
  if (!natural.ready) return { state: natural.state, trial: null, natural_evidence_gate: natural };
  const trial = store.createContextTrial(pilotDesign({
    graderModel, revisionId: profile.current.id,
  }));
  return { state: 'pilot_created', trial, natural_evidence_gate: natural,
    fingerprint_gate: baseline };
}

function terminalPilotState(trial) {
  if (!trial || trial.status !== 'active') return { ready: false, reason: 'not_active' };
  const conditions = trial.conditions || [];
  const assignments = trial.assignments || [];
  const enrollmentComplete = conditions.every(condition =>
    assignments.filter(item => item.condition === condition).length
      === trial.enrollment_target_per_group);
  const allTerminal = enrollmentComplete
    && assignments.every(item => ['resolved', 'excluded_protocol'].includes(item.status));
  const included = Object.fromEntries(conditions.map(condition => [condition,
    assignments.filter(item => item.condition === condition && item.status === 'resolved'
      && item.outcome?.inter_rater?.agreement_within_tolerance !== false).length]));
  const enough = conditions.every(condition => included[condition] >= trial.sample_target_per_group);
  return {
    ready: enrollmentComplete && allTerminal && enough,
    reason: !enrollmentComplete ? 'enrollment_open' : !allTerminal ? 'grading_open'
      : !enough ? 'insufficient_agreement' : 'ready',
    enrollment_complete: enrollmentComplete,
    all_terminal: allTerminal,
    enough_agreed_samples: enough,
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
  maxGrades = DEFAULT_MAX_GRADES_PER_CYCLE, callProvider, now = new Date() } = {}) {
  if (!store) throw new Error('self-model trust research autopilot requires an intelligence store');
  const ensured = ensurePilot(store, { enabled, graderModel });
  const result = { protocol_version: PROTOCOL_VERSION, state: ensured.state,
    grades_committed: 0, stale_incomplete_assignments_excluded: 0,
    provider_failures: [], reveal: null };
  if (!enabled || !ensured.trial || ensured.trial.status !== 'active') return result;
  if (typeof callProvider !== 'function') {
    throw new Error('self-model trust research autopilot requires a grader provider');
  }
  let raw = grading.contextTrials(store)
    .find(item => item.id === ensured.trial.id);
  if (raw.study_phase !== 'pilot'
    || raw.automated_pilot_grading?.evidence_scope !== 'model_graded_pilot_only') {
    return { ...result, state: 'manual_grading_required' };
  }
  const checkedAt = new Date(now).getTime();
  if (Number.isFinite(checkedAt)) {
    const stale = (raw.assignments || []).filter(item => item.status === 'pending'
      && !item.evidence_package && !item.protocol_exclusion
      && Number.isFinite(new Date(item.assigned).getTime())
      && checkedAt - new Date(item.assigned).getTime() >= STALE_INCOMPLETE_ASSIGNMENT_MS);
    for (const assignment of stale) {
      const excluded = store.excludeSelfModelTrustAssignment(assignment.id,
        'stale_incomplete_delivery_after_restart');
      if (excluded?.status === 'excluded_protocol') {
        result.stale_incomplete_assignments_excluded += 1;
      }
    }
    if (stale.length) {
      raw = grading.contextTrials(store).find(item => item.id === raw.id);
    }
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
        .find(candidate => candidate.assignment_id === assignmentId
          && candidate.study_code === raw.evaluator_study_code);
      if (!item) continue;
      try {
        const built = grading.gradeRequest(item, {
          graderModel: committedGraderModel, role: frozen.role,
        });
        if (!manifestMatches(frozen, built.manifest)) {
          throw new Error('frozen grader manifest no longer matches the executable protocol');
        }
        const response = await callProvider(built.request, {
          evaluatorId: frozen.evaluator_id, role: frozen.role,
          promptProtocolCommitment: built.manifest.prompt_protocol_commitment,
        });
        const submission = grading.gradeSubmission(item, response, {
          graderModel: committedGraderModel, role: frozen.role,
          evaluatorId: frozen.evaluator_id,
        });
        store.resolveContextAssignment(item.assignment_id, submission);
        result.grades_committed += 1;
      } catch (error) {
        result.provider_failures.push({ assignment_id: assignmentId,
          evaluator_id: frozen.evaluator_id,
          reason: String(error.message || error).slice(0, 240) });
      }
    }
    if (result.grades_committed >= gradeLimit) break;
  }
  const latest = grading.contextTrials(store)
    .find(item => item.id === raw.id);
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
  STALE_INCOMPLETE_ASSIGNMENT_MS, EVALUATOR_ROLES, evaluatorIds, pilotDesign,
  naturalEvidenceGate, fingerprintGate, status, ensurePilot, terminalPilotState, runCycle,
};
