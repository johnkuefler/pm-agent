'use strict';

const crypto = require('crypto');

const ACTION_TYPES = Object.freeze([
  'slack_message',
  'teamwork_comment',
  'gift',
  'api_use',
  'deadline_flag',
  'warmth',
  'routine_change',
  'meeting_behavior',
  'other',
]);

const STATUSES = Object.freeze(['open', 'observed', 'closed', 'retired']);
const OUTCOMES = Object.freeze(['helped', 'neutral', 'backfired', 'unclear', 'not_yet']);
const STOPWORDS = new Set([
  'about', 'after', 'again', 'before', 'being', 'could', 'from', 'have', 'help',
  'into', 'just', 'more', 'next', 'only', 'over', 'that', 'their', 'there',
  'these', 'they', 'this', 'what', 'when', 'where', 'which', 'with', 'would',
  'your',
]);

function normalizeText(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function emptyLedger() {
  return { version: 2, actions: [], observations: [], applications: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 2,
    actions: Array.isArray(ledger.actions) ? ledger.actions.map(normalizeActionRecord).filter(Boolean).slice(-1000) : [],
    observations: Array.isArray(ledger.observations) ? ledger.observations.map(normalizeObservationRecord).filter(Boolean).slice(-1000) : [],
    applications: Array.isArray(ledger.applications) ? ledger.applications.map(normalizeApplicationRecord).filter(Boolean).slice(-2000) : [],
  };
}

function normalizeEvidence(evidence, { required = true } = {}) {
  if (!Array.isArray(evidence) || (required && evidence.length < 1) || evidence.length > 12) {
    throw new Error(required ? 'consequence records require one to twelve evidence references' : 'consequence records accept at most twelve evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    const note = normalizeText(item?.note, 300);
    if (!type || (!id && !url)) throw new Error('each evidence reference requires type and id or url');
    return { type, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(note ? { note } : {}) };
  });
}

function normalizeRefList(values, { maxItems = 8 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 300);
    const label = normalizeText(item?.label, 240);
    if (!type || !id) return null;
    return { type, id, ...(label ? { label } : {}) };
  }).filter(Boolean).slice(0, maxItems);
}

function normalizeActionType(value) {
  const type = normalizeText(value || 'other', 80).toLowerCase();
  if (!ACTION_TYPES.includes(type)) throw new Error(`action_type must be one of: ${ACTION_TYPES.join(', ')}`);
  return type;
}

function normalizeStatus(value) {
  const status = normalizeText(value || 'open', 40).toLowerCase();
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
  return status;
}

function normalizeOutcome(value) {
  const outcome = normalizeText(value || 'unclear', 40).toLowerCase();
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  return outcome;
}

function normalizeDue(value, now = new Date()) {
  if (!value) {
    return new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) + 24 * 60 * 60 * 1000).toISOString();
  }
  const due = new Date(value);
  if (!Number.isFinite(due.getTime())) throw new Error('consequence_due must be an ISO-compatible date');
  return due.toISOString();
}

function createAction(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const description = normalizeText(input.description, 1200);
  const intendedEffect = normalizeText(input.intended_effect, 900);
  const successCriteria = normalizeText(input.success_criteria, 900);
  if (description.length < 8) throw new Error('description must be specific');
  if (!intendedEffect) throw new Error('intended_effect is required');
  if (!successCriteria) throw new Error('success_criteria is required');
  const evidence = normalizeEvidence(input.evidence);
  const id = input.id ? normalizeText(input.id, 120) : `cr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.actions.some(item => item.id === id)) throw new Error('consequence action id already exists');
  const action = {
    id,
    status: 'open',
    action_type: normalizeActionType(input.action_type),
    description,
    intended_effect: intendedEffect,
    success_criteria: successCriteria,
    expected_signal: normalizeText(input.expected_signal, 700),
    beneficiary: normalizeText(input.beneficiary, 240),
    target_ref: normalizeText(input.target_ref, 300),
    source_ref: normalizeText(input.source_ref, 300),
    workspace_frame_id: normalizeText(input.workspace_frame_id, 120),
    epistemic_claim_refs: normalizeRefList(input.epistemic_claim_refs),
    evidence,
    consequence_due: normalizeDue(input.consequence_due, now),
    created_by: normalizeText(input.created_by || 'Nora', 80),
    created_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  action.action_commitment = commitment({
    id: action.id,
    action_type: action.action_type,
    description: action.description,
    intended_effect: action.intended_effect,
    success_criteria: action.success_criteria,
    expected_signal: action.expected_signal,
    target_ref: action.target_ref,
    workspace_frame_id: action.workspace_frame_id,
    evidence: action.evidence,
    consequence_due: action.consequence_due,
  });
  current.actions.push(action);
  return { ledger: current, action, report: report(current, { now }) };
}

function observeAction(ledger = emptyLedger(), id, input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const action = current.actions.find(item => item.id === id);
  if (!action) throw new Error('consequence action not found');
  const outcome = normalizeOutcome(input.outcome);
  const observedAt = now instanceof Date ? now : new Date(now);
  let nextReviewDue = null;
  if (outcome === 'not_yet') {
    if (!input.next_review_due) {
      throw new Error('next_review_due is required when consequence outcome is not_yet');
    }
    const candidate = new Date(input.next_review_due);
    if (!Number.isFinite(candidate.getTime()) || candidate <= observedAt
      || candidate.getTime() > observedAt.getTime() + 30 * 24 * 60 * 60 * 1000) {
      throw new Error('next_review_due must be after the observation and within thirty days');
    }
    nextReviewDue = candidate.toISOString();
  }
  const observedEffect = normalizeText(input.observed_effect, 1200);
  if (!observedEffect) throw new Error('observed_effect is required');
  const evidence = normalizeEvidence(input.evidence);
  const observation = {
    id: `cr-obs-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    action_id: action.id,
    outcome,
    observed_effect: observedEffect,
    evidence,
    should_change_behavior: Boolean(input.should_change_behavior),
    behavior_update: normalizeText(input.behavior_update, 900),
    followup_action: normalizeText(input.followup_action, 700),
    next_review_due: nextReviewDue,
    observed_by: normalizeText(input.observed_by || 'Nora', 80),
    observed_at: observedAt.toISOString(),
  };
  if (observation.should_change_behavior && !observation.behavior_update) {
    throw new Error('behavior_update is required when should_change_behavior is true');
  }
  observation.observation_commitment = commitment({
    action_id: action.id,
    action_commitment: action.action_commitment,
    outcome,
    observed_effect: observation.observed_effect,
    evidence,
    should_change_behavior: observation.should_change_behavior,
    behavior_update: observation.behavior_update,
    next_review_due: observation.next_review_due,
  });
  action.status = outcome === 'not_yet' ? 'open' : 'observed';
  action.latest_outcome = outcome;
  action.latest_observation_id = observation.id;
  action.latest_observation_at = observation.observed_at;
  action.latest_review_due = observation.next_review_due || action.latest_review_due || null;
  action.behavior_update = observation.behavior_update || action.behavior_update || '';
  current.observations.push(observation);
  return { ledger: current, action, observation, report: report(current, { now }) };
}

function closeAction(ledger = emptyLedger(), id, input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const action = current.actions.find(item => item.id === id);
  if (!action) throw new Error('consequence action not found');
  const status = normalizeStatus(input.status || 'closed');
  if (!['closed', 'retired'].includes(status)) throw new Error('close status must be closed or retired');
  action.status = status;
  action.closed_reason = normalizeText(input.reason, 700);
  action.closed_by = normalizeText(input.closed_by || 'Nora', 80);
  action.closed_at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  action.close_commitment = commitment({
    id: action.id,
    action_commitment: action.action_commitment,
    status,
    reason: action.closed_reason,
    closed_at: action.closed_at,
  });
  return { ledger: current, action, report: report(current, { now }) };
}

function dueActions(ledger = emptyLedger(), { now = new Date(), includeFuture = false, status = 'open', limit = 50 } = {}) {
  const current = normalizeLedger(ledger);
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return current.actions
    .filter(action => !status || action.status === status)
    .filter(action => includeFuture
      || new Date(action.latest_review_due || action.consequence_due).getTime() <= time)
    .sort((a, b) => String(a.latest_review_due || a.consequence_due)
      .localeCompare(String(b.latest_review_due || b.consequence_due)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

function normalizeActionRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    status: normalizeStatus(record.status || 'open'),
    action_type: ACTION_TYPES.includes(record.action_type) ? record.action_type : 'other',
    epistemic_claim_refs: Array.isArray(record.epistemic_claim_refs) ? record.epistemic_claim_refs : [],
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function normalizeObservationRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.action_id) return null;
  return {
    ...record,
    outcome: OUTCOMES.includes(record.outcome) ? record.outcome : 'unclear',
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
  };
}

function actionManifest(action = {}) {
  return {
    id: action.id,
    action_type: action.action_type,
    description: action.description,
    intended_effect: action.intended_effect,
    success_criteria: action.success_criteria,
    expected_signal: action.expected_signal,
    target_ref: action.target_ref,
    workspace_frame_id: action.workspace_frame_id,
    evidence: action.evidence,
    consequence_due: action.consequence_due,
  };
}

function observationManifest(observation = {}, action = {}) {
  const manifest = {
    action_id: action.id,
    action_commitment: action.action_commitment,
    outcome: observation.outcome,
    observed_effect: observation.observed_effect,
    evidence: observation.evidence,
    should_change_behavior: observation.should_change_behavior,
    behavior_update: observation.behavior_update,
  };
  // Preserve verification of v2 observations committed before review deferrals existed.
  if (Object.hasOwn(observation, 'next_review_due')) {
    manifest.next_review_due = observation.next_review_due || null;
  }
  return manifest;
}

function ledgerIndexes(ledger) {
  return {
    actions: new Map(ledger.actions.map(item => [item.id, item])),
    observations: new Map(ledger.observations.map(item => [item.id, item])),
  };
}

function verifiedLesson(ledger, actionId, observationId, indexes = null) {
  const action = indexes ? indexes.actions.get(actionId) : ledger.actions.find(item => item.id === actionId);
  const observation = indexes ? indexes.observations.get(observationId)
    : ledger.observations.find(item => item.id === observationId);
  return Boolean(action && observation
    && observation.action_id === actionId
    && action.action_commitment === commitment(actionManifest(action))
    && observation.observation_commitment === commitment(observationManifest(observation, action)));
}

function applicationManifest(application = {}) {
  return {
    id: application.id,
    surface: application.surface,
    lesson_refs: application.lesson_refs,
    query_commitment: application.query_commitment,
    person_commitment: application.person_commitment,
    interaction_id: application.interaction_id,
    interaction_ref_commitment: application.interaction_ref_commitment,
    created_at: application.created_at,
  };
}

function applicationResolutionManifest(application = {}, resolution = {}) {
  return {
    application_commitment: application.application_commitment,
    interaction_id: resolution.interaction_id,
    outcome: resolution.outcome,
    signal_commitment: resolution.signal_commitment,
    reviewed_at: resolution.reviewed_at,
  };
}

function normalizeApplicationRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.interaction_id) return null;
  return {
    ...record,
    lesson_refs: Array.isArray(record.lesson_refs) ? record.lesson_refs.slice(0, 8) : [],
    resolution: record.resolution && typeof record.resolution === 'object'
      ? { ...record.resolution } : null,
  };
}

function auditNormalizedApplication(current, application = {}, indexes = null) {
  const lookup = indexes || ledgerIndexes(current);
  const lessonsVerified = Array.isArray(application.lesson_refs)
    && application.lesson_refs.length > 0
    && application.lesson_refs.every(ref => verifiedLesson(current, ref.action_id, ref.observation_id, lookup)
      && lookup.actions.get(ref.action_id)?.action_commitment === ref.action_commitment
      && lookup.observations.get(ref.observation_id)?.observation_commitment === ref.observation_commitment);
  const applicationVerified = application.application_commitment === commitment(applicationManifest(application));
  const resolutionVerified = !application.resolution || (application.resolution.interaction_id === application.interaction_id
    && application.resolution.resolution_commitment
      === commitment(applicationResolutionManifest(application, application.resolution)));
  return {
    lessons_verified: lessonsVerified,
    application_verified: applicationVerified,
    resolution_verified: resolutionVerified,
    complete_chain_verified: lessonsVerified && applicationVerified && resolutionVerified,
  };
}

function auditApplication(ledger = emptyLedger(), application = {}) {
  return auditNormalizedApplication(normalizeLedger(ledger), application);
}

function recordPromptApplication(ledger = emptyLedger(), input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const interactionId = normalizeText(input.interaction_id, 200);
  const interactionRef = normalizeText(input.interaction_ref, 500);
  const surface = normalizeText(input.surface || 'slack', 40).toLowerCase();
  if (!interactionId || !interactionRef) throw new Error('consequence application requires a delivered interaction id and reference');
  const existing = current.applications.find(item => item.interaction_id === interactionId);
  if (existing) return { ledger: current, application: existing, idempotent: true };
  const requestedRefs = Array.isArray(input.lesson_refs) ? input.lesson_refs : [];
  if (!requestedRefs.length || requestedRefs.length > 8) throw new Error('consequence application requires one to eight lesson references');
  const lessonRefs = requestedRefs.map(ref => {
    const actionId = normalizeText(ref.action_id, 120);
    const observationId = normalizeText(ref.observation_id, 160);
    if (!verifiedLesson(current, actionId, observationId)) throw new Error('consequence application lesson failed integrity verification');
    const action = current.actions.find(item => item.id === actionId);
    const observation = current.observations.find(item => item.id === observationId);
    return { action_id: actionId, observation_id: observationId,
      action_commitment: action.action_commitment,
      observation_commitment: observation.observation_commitment };
  });
  const observedAt = now instanceof Date ? now : new Date(now);
  const application = {
    id: input.id ? normalizeText(input.id, 160)
      : `cr-app-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    surface,
    lesson_refs: lessonRefs,
    query_commitment: commitment(normalizeText(input.query, 6000)),
    person_commitment: input.person ? commitment(normalizeText(input.person, 240).toLowerCase()) : null,
    interaction_id: interactionId,
    interaction_ref_commitment: commitment(interactionRef),
    created_at: observedAt.toISOString(),
    resolution: null,
  };
  application.application_commitment = commitment(applicationManifest(application));
  current.applications.push(application);
  return { ledger: current, application, idempotent: false };
}

function resolvePromptApplication(ledger = emptyLedger(), input = {}) {
  const current = normalizeLedger(ledger);
  const interactionId = normalizeText(input.interaction_id, 200);
  const application = current.applications.find(item => item.interaction_id === interactionId);
  if (!application) return { ledger: current, application: null, resolved: false };
  if (!auditNormalizedApplication(current, application).complete_chain_verified) {
    throw new Error('consequence application failed replay verification');
  }
  const outcome = normalizeText(input.outcome, 40).toLowerCase();
  if (!['landed', 'appreciated', 'neutral', 'ignored', 'corrected'].includes(outcome)) {
    throw new Error('consequence application outcome is unsupported');
  }
  const signal = normalizeText(input.signal, 1200);
  if (!signal) throw new Error('consequence application outcome requires observable signal');
  const reviewedAt = new Date(input.reviewed_at || new Date());
  if (!Number.isFinite(reviewedAt.getTime())) throw new Error('consequence application reviewed_at is invalid');
  const candidate = {
    interaction_id: interactionId,
    outcome,
    signal_commitment: commitment(signal),
    reviewed_at: reviewedAt.toISOString(),
  };
  candidate.resolution_commitment = commitment(applicationResolutionManifest(application, candidate));
  if (application.resolution) {
    if (canonical(application.resolution) !== canonical(candidate)) {
      throw new Error('consequence application outcome is already sealed');
    }
    return { ledger: current, application, resolved: true, idempotent: true };
  }
  application.resolution = candidate;
  return { ledger: current, application, resolved: true, idempotent: false };
}

function applicationFeedbackMap(current) {
  const counts = new Map();
  const indexes = ledgerIndexes(current);
  for (const application of current.applications) {
    if (!application.resolution || application.resolution.outcome === 'neutral'
      || !auditNormalizedApplication(current, application, indexes).complete_chain_verified) continue;
    const positive = ['landed', 'appreciated'].includes(application.resolution.outcome);
    for (const actionId of new Set(application.lesson_refs.map(ref => ref.action_id))) {
      const row = counts.get(actionId) || { decisive: 0, positive: 0, negative: 0 };
      row.decisive += 1;
      if (positive) row.positive += 1;
      else row.negative += 1;
      counts.set(actionId, row);
    }
  }
  return new Map([...counts].map(([actionId, row]) => [actionId, {
    ...row,
    observed_success_rate: row.decisive ? row.positive / row.decisive : null,
    epistemic_limit: 'Observational prompt-exposure outcomes; exposure does not prove use or causation.',
  }]));
}

function applicationFeedback(ledger = emptyLedger(), actionId) {
  return applicationFeedbackMap(normalizeLedger(ledger)).get(String(actionId)) || {
    decisive: 0, positive: 0, negative: 0, observed_success_rate: null,
    epistemic_limit: 'Observational prompt-exposure outcomes; exposure does not prove use or causation.',
  };
}

function report(ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  const outcomes = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
  for (const action of current.actions) {
    counts[action.status] = (counts[action.status] || 0) + 1;
    if (action.latest_outcome) outcomes[action.latest_outcome] = (outcomes[action.latest_outcome] || 0) + 1;
  }
  const due = dueActions(current, { now, status: 'open', limit: 200 });
  const indexes = ledgerIndexes(current);
  const verifiedApplications = current.applications.filter(application =>
    auditNormalizedApplication(current, application, indexes).complete_chain_verified);
  const resolvedApplications = verifiedApplications.filter(application => application.resolution);
  return {
    total_actions: current.actions.length,
    total_observations: current.observations.length,
    counts,
    outcomes,
    due_open_actions: due.length,
    behavior_updates: current.observations.filter(item => item.should_change_behavior).length,
    prompt_applications: current.applications.length,
    replay_verified_prompt_applications: verifiedApplications.length,
    reviewed_prompt_applications: resolvedApplications.length,
    prompt_application_outcomes: Object.fromEntries(
      ['landed', 'appreciated', 'neutral', 'ignored', 'corrected'].map(outcome => [outcome,
        resolvedApplications.filter(item => item.resolution.outcome === outcome).length])),
  };
}

function tokenize(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(term => !STOPWORDS.has(term));
}

function actionSearchText(action = {}, observations = []) {
  return [
    action.action_type,
    action.description,
    action.intended_effect,
    action.success_criteria,
    action.expected_signal,
    action.beneficiary,
    action.target_ref,
    action.source_ref,
    ...observations.flatMap(observation => [
      observation.outcome,
      observation.observed_effect,
      observation.behavior_update,
      observation.followup_action,
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function promptLessons(ledger = emptyLedger(), { query = '', person = '', limit = 3 } = {}) {
  const current = normalizeLedger(ledger);
  const feedbackByAction = applicationFeedbackMap(current);
  const observationsByAction = new Map();
  for (const observation of current.observations) {
    const list = observationsByAction.get(observation.action_id) || [];
    list.push(observation);
    observationsByAction.set(observation.action_id, list);
  }
  const terms = tokenize(`${query} ${person}`);
  return current.actions
    .filter(action => action.status === 'observed' && action.latest_observation_id)
    .map(action => {
      const observations = (observationsByAction.get(action.id) || [])
        .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
      const latest = observations.find(item => item.id === action.latest_observation_id) || observations[0];
      if (!latest) return null;
      const learningSignal = latest.should_change_behavior || latest.behavior_update
        || ['helped', 'backfired'].includes(latest.outcome);
      if (!learningSignal) return null;
      const haystack = actionSearchText(action, observations);
      const relevance = terms.length ? terms.filter(term => haystack.includes(term)).length : 0;
      const personMatch = person && haystack.includes(String(person).trim().toLowerCase()) ? 1 : 0;
      return { action, observation: latest, relevance: relevance + personMatch,
        feedback: feedbackByAction.get(action.id) || {
          decisive: 0, positive: 0, negative: 0, observed_success_rate: null,
          epistemic_limit: 'Observational prompt-exposure outcomes; exposure does not prove use or causation.',
        } };
    })
    .filter(Boolean)
    .filter(item => !terms.length || item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance
      || (b.feedback.decisive >= 3 ? b.feedback.observed_success_rate : 0.5)
        - (a.feedback.decisive >= 3 ? a.feedback.observed_success_rate : 0.5)
      || Number(Boolean(b.observation.should_change_behavior)) - Number(Boolean(a.observation.should_change_behavior))
      || String(b.observation.observed_at).localeCompare(String(a.observation.observed_at)))
    .slice(0, Math.max(0, Math.min(8, Number(limit) || 0)))
    .map(({ action, observation, feedback }) => ({
      action_id: action.id,
      observation_id: observation.id,
      action_type: action.action_type,
      intended_effect: action.intended_effect,
      success_criteria: action.success_criteria,
      outcome: observation.outcome,
      observed_effect: observation.observed_effect,
      behavior_update: observation.behavior_update || '',
      evidence: observation.evidence || [],
      action_commitment: action.action_commitment,
      observation_commitment: observation.observation_commitment,
      observed_at: observation.observed_at,
      application_feedback: feedback,
    }));
}

function renderPromptLessons(lessons = []) {
  if (!Array.isArray(lessons) || !lessons.length) return '';
  return lessons.map(item => {
    const update = item.behavior_update ? ` Behavior update: ${item.behavior_update}` : '';
    const forecast = item.outcome === 'backfired'
      ? ` Pre-action error forecast: repeating this pattern risks ${item.observed_effect}.`
      : item.behavior_update ? ' Pre-action check: this task matches a prior evidence-backed behavior revision.' : '';
    const feedback = item.application_feedback?.decisive >= 3
      ? ` Later prompt-exposure outcomes: ${item.application_feedback.positive} positive, ${item.application_feedback.negative} negative; observational only.` : '';
    const evidence = (item.evidence || []).slice(0, 3)
      .map(ref => `${ref.type}:${ref.id || ref.url || 'ref'}`).join(', ');
    return `- ${item.action_type}: intended ${item.intended_effect}; observed ${item.outcome} - ${item.observed_effect}.${forecast}${update}${feedback} Evidence ${evidence || 'committed'}; observation ${String(item.observation_commitment || '').slice(0, 12)}.`;
  }).join('\n');
}

module.exports = {
  ACTION_TYPES,
  OUTCOMES,
  STATUSES,
  applicationFeedback,
  auditApplication,
  closeAction,
  createAction,
  dueActions,
  emptyLedger,
  normalizeLedger,
  observeAction,
  recordPromptApplication,
  promptLessons,
  report,
  renderPromptLessons,
  resolvePromptApplication,
  verifiedLesson,
};
