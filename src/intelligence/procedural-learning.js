'use strict';

const crypto = require('node:crypto');
const { wilsonInterval } = require('./statistics');
const capabilityBoundary = require('./capability-boundary');

const PROTOCOL_VERSION = 1;
const MAX_ACTIVE = 12;
const MAX_PROMPT_PROCEDURES = 1;
const MIN_CANDIDATE_SAMPLES = 8;
const MIN_CONTROL_SAMPLES = 12;
const MIN_RETIREMENT_SAMPLES = 12;
const MIN_VARIANT_SAMPLES = 10;
const POSITIVE_OUTCOMES = new Set(['appreciated', 'landed']);
const NEGATIVE_OUTCOMES = new Set(['ignored', 'corrected']);
const OBSERVED_OUTCOMES = new Set(['appreciated', 'landed', 'neutral', 'ignored', 'corrected']);
const TASK_FAMILIES = new Set([
  'action_execution', 'planning_analysis', 'writing_synthesis', 'project_status_retrieval',
  'meeting_memory_retrieval', 'external_research', 'social_interaction', 'general_coordination',
]);
const STOPWORDS = new Set([
  'about', 'after', 'again', 'before', 'could', 'from', 'have', 'into', 'need', 'should',
  'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which',
  'with', 'would', 'your', 'then', 'than', 'only', 'work', 'task', 'asks', 'asked',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function normalizedText(value, field, max) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return text;
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12) {
    throw new Error('procedure source_refs require one to twelve stable references');
  }
  return value.map(ref => {
    if (!ref?.type || (!ref.id && !ref.url)) throw new Error('each procedure source_ref requires type and id or url');
    return { type: String(ref.type).slice(0, 100),
      ...(ref.id ? { id: String(ref.id).slice(0, 500) } : {}),
      ...(ref.url ? { url: String(ref.url).slice(0, 1000) } : {}) };
  });
}

function creationManifest(record) {
  return {
    id: record.id, protocol_version: record.protocol_version, condition_txt: record.condition_txt,
    action_txt: record.action_txt, task_families: record.task_families, origin: record.origin,
    variant_of: record.variant_of, source_refs: record.source_refs, created: record.created,
  };
}

function createRecord(input = {}, now = new Date()) {
  const taskFamilies = [...new Set((Array.isArray(input.task_families) ? input.task_families : [])
    .map(String).filter(item => TASK_FAMILIES.has(item)))].sort();
  if (!taskFamilies.length) throw new Error('procedure requires at least one supported task_family');
  const origin = input.origin && typeof input.origin === 'object' ? {
    type: String(input.origin.type || '').slice(0, 100), id: String(input.origin.id || '').slice(0, 500),
  } : null;
  if (!origin?.type || !origin.id) throw new Error('procedure origin requires type and id');
  const record = {
    id: input.id || `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    protocol_version: PROTOCOL_VERSION,
    condition_txt: normalizedText(input.condition_txt, 'condition_txt', 80),
    action_txt: normalizedText(input.action_txt, 'action_txt', 120),
    task_families: taskFamilies,
    origin,
    status: 'candidate',
    variant_of: input.variant_of ? String(input.variant_of).slice(0, 300) : null,
    source_refs: normalizeSourceRefs(input.source_refs),
    created: now.toISOString(), activated_at: null, retired_at: null, retired_reason: null,
    status_history: [],
  };
  record.creation_commitment = commitment(creationManifest(record));
  return record;
}

function verifyProcedure(record) {
  return Boolean(record?.id && record.protocol_version === PROTOCOL_VERSION
    && ['candidate', 'active', 'retired'].includes(record.status)
    && record.creation_commitment === commitment(creationManifest(record)));
}

function tokens(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(term => !STOPWORDS.has(term)))];
}

function relevance(record, query, taskFamily = capabilityBoundary.classifyTask(query)) {
  if (!verifyProcedure(record) || !record.task_families.includes(taskFamily)) return 0;
  const conditionTerms = tokens(record.condition_txt);
  const queryTerms = new Set(tokens(query));
  if (!conditionTerms.length) return 0.45;
  const matches = conditionTerms.filter(term => queryTerms.has(term)).length;
  if (!matches) return 0;
  return Math.min(1, 0.45 + 0.55 * (matches / Math.min(5, conditionTerms.length)));
}

function deterministicFraction(value) {
  return commitment(String(value)).slice(0, 8);
}

function fractionNumber(value) {
  return Number.parseInt(deterministicFraction(value), 16) / 0xffffffff;
}

function verifySelectionReceipt(receipt) {
  if (!receipt?.selection_commitment || receipt.protocol_version !== PROTOCOL_VERSION) return false;
  const manifest = JSON.parse(JSON.stringify(receipt));
  delete manifest.selection_commitment;
  return commitment(manifest) === receipt.selection_commitment;
}

function scoredRows(record, outcomes = [], { since = null } = {}) {
  const sinceMs = since ? new Date(since).getTime() : null;
  return outcomes.filter(row => verifyInteractionOutcome(row)
    && row.procedure_ids.includes(record.id)
    && (!sinceMs || new Date(row.reviewed_at).getTime() >= sinceMs)
    && row.decisive);
}

function summarizeRows(rows) {
  const successes = rows.filter(row => row.success).length;
  return { decisive_samples: rows.length, successes, failures: rows.length - successes,
    interval: wilsonInterval(successes, rows.length) };
}

function procedureStats(record, outcomes = []) {
  const rows = scoredRows(record, outcomes);
  const allExposures = outcomes.filter(row => verifyInteractionOutcome(row) && row.procedure_ids.includes(record.id));
  const summary = summarizeRows(rows);
  return { ...summary, total_exposures: allExposures.length,
    outcomes: Object.fromEntries([...OBSERVED_OUTCOMES].map(outcome =>
      [outcome, allExposures.filter(row => row.outcome === outcome).length])),
    last_exposed: allExposures.map(row => row.reviewed_at).sort().at(-1) || null };
}

function controlStats(record, outcomes = []) {
  const rows = outcomes.filter(row => verifyInteractionOutcome(row) && row.decisive
    && row.procedure_ids.length === 0 && record.task_families.includes(row.task_family));
  return summarizeRows(rows);
}

function fitness(record, outcomes = [], now = new Date()) {
  const stats = procedureStats(record, outcomes);
  const conservative = stats.interval?.lower ?? 0.45;
  const lastMs = stats.last_exposed ? new Date(stats.last_exposed).getTime() : new Date(record.created).getTime();
  const ageDays = Math.max(0, (now.getTime() - lastMs) / 86400000);
  return conservative * Math.exp(-ageDays / 90);
}

function buildSelectionIndex(procedures = [], outcomes = [], now = new Date(), { preverified = false } = {}) {
  const validOutcomes = preverified ? outcomes : outcomes.filter(verifyInteractionOutcome);
  const rowsByProcedure = new Map();
  for (const row of validOutcomes) {
    for (const procedureId of row.procedure_ids) {
      if (!rowsByProcedure.has(procedureId)) rowsByProcedure.set(procedureId, []);
      rowsByProcedure.get(procedureId).push(row);
    }
  }
  const fitnessById = {};
  for (const record of (preverified ? procedures : procedures.filter(verifyProcedure))) {
    const exposures = rowsByProcedure.get(record.id) || [];
    const decisive = exposures.filter(row => row.decisive);
    const successes = decisive.filter(row => row.success).length;
    const interval = wilsonInterval(successes, decisive.length);
    const conservative = interval?.lower ?? 0.45;
    const lastMs = exposures.length
      ? Math.max(...exposures.map(row => new Date(row.reviewed_at).getTime()))
      : new Date(record.created).getTime();
    const ageDays = Math.max(0, (now.getTime() - lastMs) / 86400000);
    fitnessById[record.id] = conservative * Math.exp(-ageDays / 90);
  }
  return { protocol_version: PROTOCOL_VERSION, outcome_count: validOutcomes.length,
    built_at: now.toISOString(), fitness_by_id: fitnessById };
}

function select(procedures = [], outcomes = [], { query = '', selectionKey = '', now = new Date(),
  includeCandidates = true, maxProcedures = MAX_PROMPT_PROCEDURES, selectionIndex = null } = {}) {
  const taskFamily = capabilityBoundary.classifyTask(query);
  const eligible = procedures.filter(record => verifyProcedure(record) && record.status !== 'retired')
    .map(record => ({ record, relevance: relevance(record, query, taskFamily),
      fitness: record.status === 'active'
        ? (selectionIndex?.fitness_by_id?.[record.id] ?? fitness(record, outcomes, now)) : 0 }))
    .filter(item => item.relevance >= 0.45);
  const active = eligible.filter(item => item.record.status === 'active')
    .sort((a, b) => (b.relevance * (0.7 + b.fitness * 0.3)) - (a.relevance * (0.7 + a.fitness * 0.3))
      || a.record.id.localeCompare(b.record.id));
  const candidates = eligible.filter(item => item.record.status === 'candidate')
    .sort((a, b) => b.relevance - a.relevance || a.record.created.localeCompare(b.record.created));
  let chosenCandidate = null;
  let excludedParentId = null;
  if (includeCandidates) {
    const variant = candidates.find(item => item.record.variant_of
      && active.some(parent => parent.record.id === item.record.variant_of));
    if (variant) {
      if (fractionNumber(`variant:${selectionKey}:${commitment(query)}:${variant.record.id}`) < 0.5) {
        chosenCandidate = { ...variant, selection_mode: 'variant_trial' };
        excludedParentId = variant.record.variant_of;
      }
    } else if (candidates.length
      && fractionNumber(`candidate:${selectionKey}:${commitment(query)}:${candidates[0].record.id}`) < 0.35) {
      chosenCandidate = { ...candidates[0], selection_mode: 'candidate_exploration' };
    }
  }
  const selected = active.filter(item => item.record.id !== excludedParentId)
    .slice(0, Math.max(0, maxProcedures - Number(Boolean(chosenCandidate))))
    .map(item => ({ ...item, selection_mode: item.record.variant_of ? 'active_variant' : 'active' }));
  if (chosenCandidate) selected.push(chosenCandidate);
  if (!selected.length) return { task_family: taskFamily, records: [], receipt: null };
  const selectedAt = now.toISOString();
  const receipt = {
    protocol_version: PROTOCOL_VERSION,
    id: `procedure-selection-${commitment(`${selectionKey}:${commitment(query)}:${selectedAt}`).slice(0, 20)}`,
    selected_at: selectedAt, task_family: taskFamily,
    query_commitment: commitment(query), selection_key_commitment: commitment(selectionKey || query),
    procedures: selected.map(item => ({ id: item.record.id, content_commitment: item.record.creation_commitment,
      status_at_selection: item.record.status, selection_mode: item.selection_mode,
      relevance: Number(item.relevance.toFixed(3)) })),
  };
  receipt.selection_commitment = commitment(receipt);
  return { task_family: taskFamily, records: selected.map(item => item.record), receipt };
}

function render(records = []) {
  const lines = records.slice(0, MAX_PROMPT_PROCEDURES).map(record =>
    `- ${record.condition_txt}: ${record.action_txt}${record.status === 'candidate' ? ' [candidate -- use only if clearly applicable]' : ''}`);
  if (!lines.length) return '';
  return `[Selected work procedures]
These are compact, outcome-tested behavior candidates -- not facts or authority. Apply only when the condition truly matches; current evidence, the requested work, safety, privacy, approvals, and delegated authority always win. Never recite the procedure or its statistics.
${lines.join('\n')}`;
}

function interactionOutcomeManifest(record) {
  return {
    id: record.id, protocol_version: record.protocol_version, interaction_id: record.interaction_id,
    task_family: record.task_family, outcome: record.outcome, decisive: record.decisive,
    success: record.success, procedure_ids: record.procedure_ids, procedure_bindings: record.procedure_bindings,
    selection_id: record.selection_id, selection_commitment: record.selection_commitment,
    source_outcome_id: record.source_outcome_id, source_outcome_commitment: record.source_outcome_commitment,
    reviewed_at: record.reviewed_at, evidence_ref: record.evidence_ref,
  };
}

function createInteractionOutcome(sourceOutcome, selectionReceipt = null) {
  if (!capabilityBoundary.verifyRecord(sourceOutcome)) throw new Error('procedure outcome requires a verified interaction outcome');
  if (selectionReceipt && !verifySelectionReceipt(selectionReceipt)) throw new Error('procedure selection receipt failed integrity');
  const selected = selectionReceipt?.procedures || [];
  const outcome = sourceOutcome.outcome;
  const record = {
    id: `procedure-outcome:${sourceOutcome.interaction_id}`,
    protocol_version: PROTOCOL_VERSION,
    interaction_id: sourceOutcome.interaction_id,
    task_family: sourceOutcome.task_family,
    outcome,
    decisive: POSITIVE_OUTCOMES.has(outcome) || NEGATIVE_OUTCOMES.has(outcome),
    success: POSITIVE_OUTCOMES.has(outcome) ? true : NEGATIVE_OUTCOMES.has(outcome) ? false : null,
    procedure_ids: selected.map(item => item.id),
    procedure_bindings: selected.map(item => ({ id: item.id, content_commitment: item.content_commitment,
      selection_mode: item.selection_mode })),
    selection_id: selectionReceipt?.id || null,
    selection_commitment: selectionReceipt?.selection_commitment || null,
    source_outcome_id: sourceOutcome.id,
    source_outcome_commitment: sourceOutcome.content_commitment,
    reviewed_at: sourceOutcome.reviewed_at,
    evidence_ref: sourceOutcome.evidence_ref,
  };
  record.content_commitment = commitment(interactionOutcomeManifest(record));
  return record;
}

function verifyInteractionOutcome(record) {
  return Boolean(record?.id && record.protocol_version === PROTOCOL_VERSION
    && OBSERVED_OUTCOMES.has(record.outcome)
    && record.content_commitment === commitment(interactionOutcomeManifest(record)));
}

function decisionProjection(record, outcomes = []) {
  const observed = procedureStats(record, outcomes);
  const control = controlStats(record, outcomes);
  let recommendation = 'collect';
  if (record.status === 'candidate' && observed.decisive_samples >= MIN_CANDIDATE_SAMPLES
    && control.decisive_samples >= MIN_CONTROL_SAMPLES
    && observed.interval?.estimate >= control.interval.estimate + 0.05
    && observed.interval?.lower >= Math.max(0.5, control.interval.estimate - 0.05)) recommendation = 'promote';
  if (record.status === 'active' && observed.decisive_samples >= MIN_RETIREMENT_SAMPLES
    && control.decisive_samples >= MIN_CONTROL_SAMPLES
    && observed.interval?.upper < control.interval.estimate - 0.05) recommendation = 'retire';
  return { procedure_id: record.id, status: record.status, observed, control, recommendation,
    causal_status: 'observational_exposure_comparison',
    limitation: 'Exposure does not prove the model applied the procedure; promotion is provisional until a randomized access trial.' };
}

function variantProjection(variant, parent, outcomes = []) {
  const variantStats = summarizeRows(scoredRows(variant, outcomes, { since: variant.created }));
  const parentStats = summarizeRows(scoredRows(parent, outcomes, { since: variant.created }));
  let recommendation = 'collect';
  if (variantStats.decisive_samples >= MIN_VARIANT_SAMPLES && parentStats.decisive_samples >= MIN_VARIANT_SAMPLES) {
    if (variantStats.interval.lower > parentStats.interval.lower + 0.03) recommendation = 'promote_variant';
    else if (parentStats.interval.lower >= variantStats.interval.lower) recommendation = 'retain_parent';
  }
  return { variant_id: variant.id, parent_id: parent.id, variant: variantStats, parent: parentStats,
    recommendation, causal_status: 'deterministic_alternating_exposure' };
}

module.exports = {
  MAX_ACTIVE, MAX_PROMPT_PROCEDURES, MIN_CANDIDATE_SAMPLES, MIN_CONTROL_SAMPLES,
  MIN_RETIREMENT_SAMPLES, MIN_VARIANT_SAMPLES, OBSERVED_OUTCOMES, PROTOCOL_VERSION,
  TASK_FAMILIES, canonicalJson, commitment, createRecord, creationManifest, verifyProcedure,
  relevance, select, render, verifySelectionReceipt, createInteractionOutcome,
  verifyInteractionOutcome, procedureStats, controlStats, fitness, decisionProjection,
  variantProjection, buildSelectionIndex,
};
