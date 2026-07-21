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
  return { version: 1, actions: [], observations: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    actions: Array.isArray(ledger.actions) ? ledger.actions.map(normalizeActionRecord).filter(Boolean).slice(-1000) : [],
    observations: Array.isArray(ledger.observations) ? ledger.observations.map(normalizeObservationRecord).filter(Boolean).slice(-1000) : [],
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
  return { ledger: current, action, report: report(current) };
}

function observeAction(ledger = emptyLedger(), id, input = {}, { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const action = current.actions.find(item => item.id === id);
  if (!action) throw new Error('consequence action not found');
  const outcome = normalizeOutcome(input.outcome);
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
    observed_by: normalizeText(input.observed_by || 'Nora', 80),
    observed_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
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
  });
  action.status = outcome === 'not_yet' ? 'open' : 'observed';
  action.latest_outcome = outcome;
  action.latest_observation_id = observation.id;
  action.latest_observation_at = observation.observed_at;
  action.behavior_update = observation.behavior_update || action.behavior_update || '';
  current.observations.push(observation);
  return { ledger: current, action, observation, report: report(current) };
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
  return { ledger: current, action, report: report(current) };
}

function dueActions(ledger = emptyLedger(), { now = new Date(), includeFuture = false, status = 'open', limit = 50 } = {}) {
  const current = normalizeLedger(ledger);
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return current.actions
    .filter(action => !status || action.status === status)
    .filter(action => includeFuture || new Date(action.consequence_due).getTime() <= time)
    .sort((a, b) => String(a.consequence_due).localeCompare(String(b.consequence_due)))
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

function report(ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  const outcomes = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
  for (const action of current.actions) {
    counts[action.status] = (counts[action.status] || 0) + 1;
    if (action.latest_outcome) outcomes[action.latest_outcome] = (outcomes[action.latest_outcome] || 0) + 1;
  }
  const due = dueActions(current, { now, status: 'open', limit: 200 });
  return {
    total_actions: current.actions.length,
    total_observations: current.observations.length,
    counts,
    outcomes,
    due_open_actions: due.length,
    behavior_updates: current.observations.filter(item => item.should_change_behavior).length,
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
      return { action, observation: latest, relevance: relevance + personMatch };
    })
    .filter(Boolean)
    .filter(item => !terms.length || item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance
      || Number(Boolean(b.observation.should_change_behavior)) - Number(Boolean(a.observation.should_change_behavior))
      || String(b.observation.observed_at).localeCompare(String(a.observation.observed_at)))
    .slice(0, Math.max(0, Math.min(8, Number(limit) || 0)))
    .map(({ action, observation }) => ({
      action_id: action.id,
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
    }));
}

function renderPromptLessons(lessons = []) {
  if (!Array.isArray(lessons) || !lessons.length) return '';
  return lessons.map(item => {
    const update = item.behavior_update ? ` Behavior update: ${item.behavior_update}` : '';
    const evidence = (item.evidence || []).slice(0, 3)
      .map(ref => `${ref.type}:${ref.id || ref.url || 'ref'}`).join(', ');
    return `- ${item.action_type}: intended ${item.intended_effect}; observed ${item.outcome} - ${item.observed_effect}.${update} Evidence ${evidence || 'committed'}; observation ${String(item.observation_commitment || '').slice(0, 12)}.`;
  }).join('\n');
}

module.exports = {
  ACTION_TYPES,
  OUTCOMES,
  STATUSES,
  closeAction,
  createAction,
  dueActions,
  emptyLedger,
  normalizeLedger,
  observeAction,
  promptLessons,
  report,
  renderPromptLessons,
};
