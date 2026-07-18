'use strict';

const crypto = require('node:crypto');
const cognitiveParameters = require('./cognitive-parameters');

const PROTOCOL_VERSION = 1;
const ARMS = Object.freeze(['frozen_baseline', 'candidate_parameter']);
const OUTCOMES = Object.freeze(['landed', 'appreciated', 'neutral', 'ignored', 'corrected']);
const SUPPORTED_PATHS = new Set(['workspace.relevance_per_term']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function patchForPath(path, value) {
  const result = {};
  const keys = path.split('.');
  let current = result;
  for (const key of keys.slice(0, -1)) current = current[key] = {};
  current[keys.at(-1)] = value;
  return result;
}

function studyManifest(study) {
  return {
    id: study.id, protocol_version: study.protocol_version, title: study.title,
    study_phase: study.study_phase, created_at: study.created_at, created_by: study.created_by,
    parameter_path: study.parameter_path, baseline: study.baseline, candidate: study.candidate,
    randomization: study.randomization, preregistration: study.preregistration,
    replicates_study_id: study.replicates_study_id,
    replicated_study_commitment: study.replicated_study_commitment,
    authority: study.authority,
  };
}

function assignmentManifest(assignment) {
  return {
    id: assignment.id, protocol_version: assignment.protocol_version,
    study_id: assignment.study_id, study_commitment: assignment.study_commitment,
    sequence: assignment.sequence, randomization_block: assignment.randomization_block,
    assigned_at: assignment.assigned_at,
    unit_commitment: assignment.unit_commitment, surface: assignment.surface,
    arm: assignment.arm, applied_value: assignment.applied_value,
    effective_params_commitment: assignment.effective_params_commitment,
    previous_assignment_commitment: assignment.previous_assignment_commitment,
  };
}

function deliveryManifest(assignment) {
  return {
    assignment_id: assignment.id, assignment_commitment: assignment.content_commitment,
    delivered_at: assignment.delivery.delivered_at,
    interaction_id: assignment.delivery.interaction_id,
    interaction_ref_commitment: assignment.delivery.interaction_ref_commitment,
    latency: assignment.delivery.latency,
    workspace_commitment: assignment.delivery.workspace_commitment,
    procedure_selection_commitment: assignment.delivery.procedure_selection_commitment,
    exemplar_selection_commitment: assignment.delivery.exemplar_selection_commitment,
  };
}

function resolutionManifest(assignment) {
  return {
    assignment_id: assignment.id, delivery_commitment: assignment.delivery_commitment,
    resolved_at: assignment.resolution.resolved_at,
    interaction_id: assignment.resolution.interaction_id,
    outcome: assignment.resolution.outcome, score: assignment.resolution.score,
    evidence_commitment: assignment.resolution.evidence_commitment,
  };
}

function exclusionManifest(assignment) {
  return {
    assignment_id: assignment.id, assignment_commitment: assignment.content_commitment,
    excluded_at: assignment.exclusion.excluded_at, reason: assignment.exclusion.reason,
  };
}

function terminalManifest(study) {
  return {
    study_id: study.id, study_commitment: study.content_commitment,
    status: study.status, terminal_at: study.terminal.terminal_at,
    reason: study.terminal.reason, analysis: study.terminal.analysis,
  };
}

function paramsForArm(study, arm) {
  const baseline = cognitiveParameters.normalizeParams(study.baseline.params, { strict: true });
  return arm === 'candidate_parameter'
    ? cognitiveParameters.mergePatch(baseline, patchForPath(study.parameter_path, study.candidate.value))
    : baseline;
}

function createStudy(input = {}, baselineRecord, { randomizationSecret, now = new Date() } = {}) {
  if (!cognitiveParameters.verifyRecord(baselineRecord)) {
    throw new Error('a replay-valid cognitive parameter baseline is required');
  }
  const createdBy = String(input.created_by || '').trim();
  if (!createdBy || /^nora\b/i.test(createdBy)) {
    throw new Error('cognitive parameter studies require a non-Nora research owner');
  }
  const parameterPath = String(input.parameter_path || '').trim();
  if (!SUPPORTED_PATHS.has(parameterPath)) {
    throw new Error(`unsupported cognitive parameter study path: ${parameterPath || 'missing'}`);
  }
  const secret = String(randomizationSecret || '');
  if (secret.length < 32) throw new Error('a server-generated randomization secret is required');
  const candidateParams = cognitiveParameters.mergePatch(baselineRecord.params,
    patchForPath(parameterPath, input.candidate_value));
  const candidateValue = cognitiveParameters.getPath(candidateParams, parameterPath);
  const baselineValue = cognitiveParameters.getPath(baselineRecord.params, parameterPath);
  if (candidateValue === baselineValue) throw new Error('candidate parameter must differ from the frozen baseline');
  const phase = input.study_phase === 'confirmatory' ? 'confirmatory' : 'pilot';
  const minimumSamples = Number(input.minimum_samples_per_arm ?? (phase === 'pilot' ? 12 : 24));
  if (!Number.isInteger(minimumSamples) || minimumSamples < 10 || minimumSamples > 60) {
    throw new Error('minimum_samples_per_arm must be an integer from 10 to 60');
  }
  const maximumAssignments = Number(input.maximum_assignments ?? minimumSamples * 4);
  if (!Number.isInteger(maximumAssignments) || maximumAssignments < minimumSamples * 2
    || maximumAssignments > 240) {
    throw new Error('maximum_assignments must be at least twice the per-arm minimum and at most 240');
  }
  const windowDays = Number(input.evaluation_window_days ?? 14);
  if (!Number.isInteger(windowDays) || windowDays < 7 || windowDays > 28) {
    throw new Error('evaluation_window_days must be an integer from 7 to 28');
  }
  const minimumEffect = Number(input.minimum_effect ?? 0.08);
  if (!Number.isFinite(minimumEffect) || minimumEffect < 0.03 || minimumEffect > 0.25) {
    throw new Error('minimum_effect must be between 0.03 and 0.25');
  }
  const guardMinimumRate = Number(input.guard_minimum_rate ?? 0.9);
  if (!Number.isFinite(guardMinimumRate) || guardMinimumRate < 0.8 || guardMinimumRate > 1) {
    throw new Error('guard_minimum_rate must be between 0.8 and 1');
  }
  const startedAt = new Date(now);
  if (!Number.isFinite(startedAt.getTime())) throw new Error('study creation time is invalid');
  const id = String(input.id || `dial-study-${startedAt.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`).trim();
  const study = {
    id: id.slice(0, 200), protocol_version: PROTOCOL_VERSION,
    title: String(input.title || `Bounded ${parameterPath} experiment`).trim().slice(0, 300),
    study_phase: phase, created_at: startedAt.toISOString(), created_by: createdBy.slice(0, 120),
    parameter_path: parameterPath,
    baseline: { revision: baselineRecord.revision,
      record_commitment: baselineRecord.content_commitment,
      params: clone(baselineRecord.params), params_commitment: commitment(baselineRecord.params),
      value: baselineValue },
    candidate: { value: candidateValue, params_commitment: commitment(candidateParams) },
    randomization: { method: 'deterministic_hmac_permuted_pairs',
      seed_commitment: commitment(secret), assignment_unit: 'one_delivered_ordinary_direct_slack_turn',
      conditions_sealed_until_terminal: true },
    randomization_secret: secret,
    preregistration: {
      primary_metric: 'reviewed_interaction_quality',
      primary_analysis: 'mean within-randomization-pair candidate-minus-frozen-baseline quality with an exact one-sided sign-flip randomization test',
      scoring: { landed: 1, appreciated: 1, neutral: 0.5, ignored: 0, corrected: 0 },
      minimum_samples_per_arm: minimumSamples, maximum_assignments: maximumAssignments,
      minimum_complete_randomization_blocks: minimumSamples,
      significance_alpha: phase === 'pilot' ? 0.1 : 0.05,
      evaluation_window_days: windowDays,
      due_at: new Date(startedAt.getTime() + windowDays * 86400000).toISOString(),
      minimum_effect: minimumEffect,
      guard_metric: 'interactive_latency_and_prompt_budget', guard_minimum_rate: guardMinimumRate,
      guard_warmup_deliveries_per_arm: 5,
      stopping_rule: 'Stop immediately on any prompt-budget violation or after guard warmup when candidate latency compliance falls below the frozen minimum; otherwise analyze when both arms have the preregistered reviewed sample or the time/assignment cap is reached.',
      analysis_rule: 'Candidate minus frozen-baseline mean reviewed-interaction quality within complete randomized pairs. Directional support requires the preregistered minimum effect and exact one-sided sign-flip p-value at or below alpha, with preserved per-arm latency and prompt compliance. Pilot support permits only a disjoint confirmation; confirmation support permits only human review of a separate global parameter revision.',
    },
    replicates_study_id: input.replicates_study_id ? String(input.replicates_study_id).slice(0, 200) : null,
    replicated_study_commitment: input.replicated_study_commitment
      ? String(input.replicated_study_commitment).slice(0, 128) : null,
    authority: { autonomous_updates_enabled: false, global_document_mutated: false,
      promotion_requires_human_review: true, candidate_scope: 'ephemeral_assignment_only' },
    status: 'active', assignments: [], terminal: null, lifecycle_revision: 0,
  };
  study.content_commitment = commitment(studyManifest(study));
  if (!verifyStudy(study)) throw new Error('new cognitive parameter study failed integrity');
  return study;
}

function verifyStudy(study) {
  try {
    if (!study || study.protocol_version !== PROTOCOL_VERSION || !SUPPORTED_PATHS.has(study.parameter_path)
      || !['pilot', 'confirmatory'].includes(study.study_phase)
      || !['active', 'completed', 'aborted'].includes(study.status)
      || !study.randomization_secret
      || study.randomization.seed_commitment !== commitment(study.randomization_secret)
      || study.content_commitment !== commitment(studyManifest(study))
      || study.authority?.autonomous_updates_enabled !== false
      || study.authority?.global_document_mutated !== false) return false;
    const baseline = cognitiveParameters.normalizeParams(study.baseline.params, { strict: true });
    if (commitment(baseline) !== study.baseline.params_commitment
      || cognitiveParameters.getPath(baseline, study.parameter_path) !== study.baseline.value) return false;
    const candidate = paramsForArm(study, 'candidate_parameter');
    if (commitment(candidate) !== study.candidate.params_commitment
      || cognitiveParameters.getPath(candidate, study.parameter_path) !== study.candidate.value) return false;
    if (study.status === 'active' && study.terminal) return false;
    if (study.status !== 'active' && (!study.terminal
      || study.terminal.content_commitment !== commitment(terminalManifest(study)))) return false;
    return true;
  } catch (_) { return false; }
}

function chooseArm(study, unitKey) {
  const eligible = study.assignments.filter(item => !item.exclusion);
  const counts = Object.fromEntries(ARMS.map(arm => [arm, eligible.filter(item => item.arm === arm).length]));
  if (counts.frozen_baseline !== counts.candidate_parameter) {
    return counts.frozen_baseline < counts.candidate_parameter ? 'frozen_baseline' : 'candidate_parameter';
  }
  const digest = crypto.createHmac('sha256', study.randomization_secret).update(String(unitKey)).digest();
  return ARMS[digest[0] % ARMS.length];
}

function createAssignment(study, { unitKey, surface = 'slack', now = new Date() } = {}) {
  if (!verifyStudy(study) || study.status !== 'active') throw new Error('cognitive parameter study is not active and valid');
  const unit = String(unitKey || '').trim();
  if (!unit) throw new Error('cognitive parameter assignment requires a unique unit key');
  const unitCommitment = commitment(unit);
  const existing = study.assignments.find(item => item.unit_commitment === unitCommitment);
  if (existing) return existing;
  if (study.assignments.length >= study.preregistration.maximum_assignments) {
    throw new Error('cognitive parameter study assignment cap reached');
  }
  const sequence = study.assignments.length + 1;
  const randomizationBlock = Math.floor(study.assignments.filter(item => !item.exclusion).length / 2) + 1;
  const arm = chooseArm(study, unit);
  const params = paramsForArm(study, arm);
  const assignment = {
    id: `${study.id}:a${sequence}`, protocol_version: PROTOCOL_VERSION,
    study_id: study.id, study_commitment: study.content_commitment,
    sequence, randomization_block: randomizationBlock,
    assigned_at: new Date(now).toISOString(), unit_commitment: unitCommitment,
    surface, arm,
    applied_value: cognitiveParameters.getPath(params, study.parameter_path),
    effective_params_commitment: commitment(params),
    previous_assignment_commitment: study.assignments.at(-1)?.content_commitment || null,
    delivery: null, delivery_commitment: null, resolution: null,
    resolution_commitment: null, exclusion: null, exclusion_commitment: null,
  };
  assignment.content_commitment = commitment(assignmentManifest(assignment));
  return assignment;
}

function verifyAssignment(study, assignment, previous = null) {
  try {
    if (!verifyStudy(study) || !assignment || assignment.protocol_version !== PROTOCOL_VERSION
      || assignment.study_id !== study.id || assignment.study_commitment !== study.content_commitment
      || assignment.sequence !== (previous ? previous.sequence + 1 : 1)
      || !Number.isInteger(assignment.randomization_block) || assignment.randomization_block < 1
      || assignment.previous_assignment_commitment !== (previous?.content_commitment || null)
      || !ARMS.includes(assignment.arm)
      || assignment.content_commitment !== commitment(assignmentManifest(assignment))) return false;
    const params = paramsForArm(study, assignment.arm);
    if (assignment.applied_value !== cognitiveParameters.getPath(params, study.parameter_path)
      || assignment.effective_params_commitment !== commitment(params)) return false;
    if (assignment.delivery && assignment.delivery_commitment !== commitment(deliveryManifest(assignment))) return false;
    if (assignment.resolution && (!assignment.delivery
      || assignment.resolution_commitment !== commitment(resolutionManifest(assignment)))) return false;
    if (assignment.exclusion && assignment.exclusion_commitment !== commitment(exclusionManifest(assignment))) return false;
    if (assignment.exclusion && (assignment.delivery || assignment.resolution)) return false;
    return true;
  } catch (_) { return false; }
}

function deliverAssignment(study, assignment, input = {}, now = new Date()) {
  if (!verifyAssignment(study, assignment, study.assignments[assignment.sequence - 2] || null)
    || assignment.exclusion) throw new Error('cognitive parameter assignment failed integrity or is excluded');
  if (assignment.delivery) return assignment;
  const latency = input.latency;
  if (!latency || latency.surface !== 'slack' || !Number.isFinite(Number(latency.latency_ms))
    || !Number.isFinite(Number(latency.budget_ms))
    || typeof latency.within_budget !== 'boolean'
    || typeof latency.prompt_within_budget !== 'boolean') {
    throw new Error('cognitive parameter delivery requires the exact Slack latency and prompt-budget receipt');
  }
  const interactionId = String(input.interaction_id || '').trim();
  const interactionRef = String(input.interaction_ref || '').trim();
  if (!interactionId || !interactionRef) throw new Error('cognitive parameter delivery requires an interaction and delivery reference');
  assignment.delivery = {
    delivered_at: new Date(now).toISOString(), interaction_id: interactionId,
    interaction_ref_commitment: commitment(interactionRef), latency: clone(latency),
    workspace_commitment: input.workspace_commitment || null,
    procedure_selection_commitment: input.procedure_selection_commitment || null,
    exemplar_selection_commitment: input.exemplar_selection_commitment || null,
  };
  assignment.delivery_commitment = commitment(deliveryManifest(assignment));
  return assignment;
}

function excludeAssignment(study, assignment, reason, now = new Date()) {
  if (!verifyAssignment(study, assignment, study.assignments[assignment.sequence - 2] || null)) {
    throw new Error('cognitive parameter assignment failed integrity');
  }
  if (assignment.delivery || assignment.resolution) throw new Error('a delivered cognitive parameter assignment cannot be excluded');
  if (assignment.exclusion) return assignment;
  assignment.exclusion = { excluded_at: new Date(now).toISOString(),
    reason: String(reason || 'ineligible_before_delivery').slice(0, 300) };
  assignment.exclusion_commitment = commitment(exclusionManifest(assignment));
  return assignment;
}

function resolveAssignment(study, assignment, input = {}, now = new Date()) {
  if (!verifyAssignment(study, assignment, study.assignments[assignment.sequence - 2] || null)
    || !assignment.delivery || assignment.exclusion) {
    throw new Error('cognitive parameter outcome requires a replay-valid delivered assignment');
  }
  if (assignment.resolution) return assignment;
  const outcome = String(input.outcome || '').trim();
  if (!OUTCOMES.includes(outcome)) throw new Error('unsupported cognitive parameter interaction outcome');
  const interactionId = String(input.interaction_id || '').trim();
  if (interactionId !== assignment.delivery.interaction_id) {
    throw new Error('cognitive parameter outcome interaction does not match delivery');
  }
  const reviewedAt = new Date(input.reviewed_at || now);
  if (!Number.isFinite(reviewedAt.getTime()) || reviewedAt < new Date(assignment.delivery.delivered_at)) {
    throw new Error('cognitive parameter outcome review must follow delivery');
  }
  const score = study.preregistration.scoring[outcome];
  assignment.resolution = {
    resolved_at: reviewedAt.toISOString(), interaction_id: interactionId,
    outcome, score, evidence_commitment: commitment({ interaction_id: interactionId,
      outcome, signal: String(input.signal || '').slice(0, 1000), reviewed_at: reviewedAt.toISOString() }),
  };
  assignment.resolution_commitment = commitment(resolutionManifest(assignment));
  return assignment;
}

function auditStudy(study) {
  if (!verifyStudy(study)) return { complete_chain_verified: false, reason: 'study_integrity_failed' };
  let previous = null;
  for (const assignment of study.assignments || []) {
    if (!verifyAssignment(study, assignment, previous)) {
      return { complete_chain_verified: false, reason: 'assignment_chain_failed', assignment_id: assignment.id };
    }
    previous = assignment;
  }
  const blocks = new Map();
  for (const assignment of study.assignments.filter(item => !item.exclusion)) {
    if (!blocks.has(assignment.randomization_block)) blocks.set(assignment.randomization_block, []);
    blocks.get(assignment.randomization_block).push(assignment);
  }
  for (const [block, assignments] of blocks) {
    if (assignments.length > 2 || new Set(assignments.map(item => item.arm)).size !== assignments.length) {
      return { complete_chain_verified: false, reason: 'randomization_block_failed',
        randomization_block: block };
    }
  }
  return { complete_chain_verified: true, reason: null,
    assignments: study.assignments.length,
    delivered: study.assignments.filter(item => item.delivery).length,
    resolved: study.assignments.filter(item => item.resolution).length,
    excluded: study.assignments.filter(item => item.exclusion).length };
}

function exactPairedRandomization(differences) {
  const scaled = differences.map(value => Math.round(Number(value) * 2));
  const observed = scaled.reduce((sum, value) => sum + value, 0);
  let distribution = new Map([[0, 1n]]);
  for (const raw of scaled) {
    const magnitude = Math.abs(raw);
    if (!magnitude) continue;
    const next = new Map();
    for (const [sum, count] of distribution) {
      next.set(sum + magnitude, (next.get(sum + magnitude) || 0n) + count);
      next.set(sum - magnitude, (next.get(sum - magnitude) || 0n) + count);
    }
    distribution = next;
  }
  const total = [...distribution.values()].reduce((sum, count) => sum + count, 0n);
  const upper = [...distribution.entries()].filter(([sum]) => sum >= observed)
    .reduce((sum, [, count]) => sum + count, 0n);
  const lower = [...distribution.entries()].filter(([sum]) => sum <= observed)
    .reduce((sum, [, count]) => sum + count, 0n);
  return { complete_blocks: differences.length,
    mean_candidate_minus_baseline: differences.length
      ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null,
    exact_one_sided_candidate_advantage_p: total ? Number(upper) / Number(total) : null,
    exact_one_sided_candidate_harm_p: total ? Number(lower) / Number(total) : null };
}

function analysis(study) {
  const valid = auditStudy(study).complete_chain_verified
    ? study.assignments.filter(item => item.resolution) : [];
  const arm = name => {
    const rows = valid.filter(item => item.arm === name);
    const delivered = study.assignments.filter(item => item.arm === name && item.delivery);
    const mean = rows.length ? rows.reduce((sum, item) => sum + item.resolution.score, 0) / rows.length : null;
    const latencyWithin = delivered.filter(item => item.delivery.latency.within_budget).length;
    const promptWithin = delivered.filter(item => item.delivery.latency.prompt_within_budget).length;
    return { resolved: rows.length, delivered: delivered.length, mean_quality: mean,
      latency_within_budget_rate: delivered.length ? latencyWithin / delivered.length : null,
      prompt_within_budget_rate: delivered.length ? promptWithin / delivered.length : null,
      corrections: rows.filter(item => item.resolution.outcome === 'corrected').length,
      ignored: rows.filter(item => item.resolution.outcome === 'ignored').length };
  };
  const baseline = arm('frozen_baseline');
  const candidate = arm('candidate_parameter');
  const descriptiveEffect = baseline.mean_quality === null || candidate.mean_quality === null
    ? null : candidate.mean_quality - baseline.mean_quality;
  const byBlock = new Map();
  for (const assignment of valid) {
    if (!byBlock.has(assignment.randomization_block)) byBlock.set(assignment.randomization_block, {});
    byBlock.get(assignment.randomization_block)[assignment.arm] = assignment.resolution.score;
  }
  const pairedDifferences = [...byBlock.values()]
    .filter(block => Number.isFinite(block.frozen_baseline)
      && Number.isFinite(block.candidate_parameter))
    .map(block => block.candidate_parameter - block.frozen_baseline);
  const randomized = exactPairedRandomization(pairedDifferences);
  const effect = randomized.mean_candidate_minus_baseline;
  const sufficient = randomized.complete_blocks
    >= study.preregistration.minimum_complete_randomization_blocks;
  const guard = candidate.delivered < study.preregistration.guard_warmup_deliveries_per_arm
    ? 'warming_up'
    : candidate.prompt_within_budget_rate < 1
      || candidate.latency_within_budget_rate < study.preregistration.guard_minimum_rate
      ? 'failed' : 'passed';
  const effectDirection = !sufficient ? 'collecting'
    : effect >= study.preregistration.minimum_effect
      && randomized.exact_one_sided_candidate_advantage_p <= study.preregistration.significance_alpha
      ? 'candidate_advantage'
      : effect <= -study.preregistration.minimum_effect
        && randomized.exact_one_sided_candidate_harm_p <= study.preregistration.significance_alpha
        ? 'candidate_harm'
        : 'inconclusive_band';
  return { baseline, candidate, candidate_minus_baseline: effect,
    unpaired_descriptive_candidate_minus_baseline: descriptiveEffect,
    randomization_analysis: randomized,
    significance_alpha: study.preregistration.significance_alpha,
    sufficient_preregistered_sample: sufficient, guard, effect_direction: effectDirection,
    promotion_eligible: study.study_phase === 'confirmatory' && sufficient
      && guard === 'passed' && effectDirection === 'candidate_advantage',
    interpretation: 'Randomized ecological evidence about one bounded functional parameter. It does not establish feelings, identity, phenomenal experience, or consciousness.' };
}

function terminalRecommendation(study, now = new Date()) {
  const report = analysis(study);
  const candidateDeliveries = report.candidate.delivered;
  const baselineDeliveries = report.baseline.delivered;
  const candidatePromptViolation = candidateDeliveries > 0
    && report.candidate.prompt_within_budget_rate < 1;
  const baselinePromptViolation = baselineDeliveries > 0
    && report.baseline.prompt_within_budget_rate < 1;
  const promptViolation = candidatePromptViolation || baselinePromptViolation;
  const latencyViolation = candidateDeliveries >= study.preregistration.guard_warmup_deliveries_per_arm
    && report.candidate.latency_within_budget_rate < study.preregistration.guard_minimum_rate;
  if (promptViolation || latencyViolation) return { status: 'aborted',
    reason: promptViolation ? `${candidatePromptViolation ? 'candidate' : 'baseline'}_prompt_guard_failed_automatic_rollback`
      : 'candidate_latency_guard_failed_automatic_rollback', analysis: report };
  if (report.sufficient_preregistered_sample) return { status: 'completed',
    reason: report.effect_direction, analysis: report };
  const due = new Date(now) >= new Date(study.preregistration.due_at);
  const cap = study.assignments.length >= study.preregistration.maximum_assignments;
  if (due || cap) return { status: 'completed',
    reason: due ? 'evaluation_window_elapsed_incomplete_sample' : 'assignment_cap_reached_incomplete_sample',
    analysis: report };
  return null;
}

function closeStudy(study, recommendation, now = new Date()) {
  if (!verifyStudy(study) || study.status !== 'active') throw new Error('only an active valid study can close');
  study.status = recommendation.status;
  study.terminal = { terminal_at: new Date(now).toISOString(), reason: recommendation.reason,
    analysis: clone(recommendation.analysis || analysis(study)) };
  study.terminal.content_commitment = commitment(terminalManifest(study));
  return study;
}

function publicStudy(study) {
  const report = analysis(study);
  const sealed = study.status === 'active';
  return {
    id: study.id, protocol_version: study.protocol_version,
    title: sealed ? 'Blinded bounded cognitive parameter study' : study.title,
    study_phase: study.study_phase, created_at: study.created_at,
    parameter_family: study.parameter_path.split('.')[0], status: study.status,
    content_commitment: study.content_commitment,
    preregistration: { primary_metric: study.preregistration.primary_metric,
      primary_analysis: study.preregistration.primary_analysis,
      minimum_samples_per_arm: study.preregistration.minimum_samples_per_arm,
      minimum_complete_randomization_blocks:
        study.preregistration.minimum_complete_randomization_blocks,
      maximum_assignments: study.preregistration.maximum_assignments,
      significance_alpha: study.preregistration.significance_alpha,
      due_at: study.preregistration.due_at, guard_metric: study.preregistration.guard_metric,
      stopping_rule: study.preregistration.stopping_rule },
    assignments: study.assignments.length, delivered: study.assignments.filter(item => item.delivery).length,
    resolved: study.assignments.filter(item => item.resolution).length,
    conditions_sealed: sealed,
    analysis: sealed ? { status: 'collecting_blinded', sufficient_preregistered_sample: report.sufficient_preregistered_sample,
      guard: report.guard, promotion_eligible: false } : report,
    terminal: sealed ? null : clone(study.terminal),
    authority: clone(study.authority), audit: auditStudy(study),
    epistemic_status: 'A blinded randomized test of one bounded functional parameter on ordinary reviewed work. It never mutates the global parameter document, grants authority, establishes identity or feeling, or proves consciousness.',
  };
}

function researchStudy(study) {
  const copy = clone(study);
  delete copy.randomization_secret;
  copy.audit = auditStudy(study);
  copy.analysis = analysis(study);
  return copy;
}

module.exports = {
  PROTOCOL_VERSION, ARMS, OUTCOMES, SUPPORTED_PATHS,
  canonicalJson, commitment, patchForPath, studyManifest, assignmentManifest,
  deliveryManifest, resolutionManifest, exclusionManifest, terminalManifest,
  createStudy, verifyStudy, paramsForArm, createAssignment, verifyAssignment,
  deliverAssignment, excludeAssignment, resolveAssignment, auditStudy,
  exactPairedRandomization, analysis,
  terminalRecommendation, closeStudy, publicStudy, researchStudy,
};
