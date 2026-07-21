'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const AUTONOMOUS_TUNING_ENABLED = false;

const DEFINITIONS = Object.freeze({
  'drives.responsiveness': { default: 0.35, min: 0.05, max: 0.8 },
  'drives.trace_window': { default: 40, min: 10, max: 120, integer: true },
  'drives.stale_cycle_age_days': { default: 0.15, min: 0.04, max: 1 },
  'drives.uncertainty.prospection_weight': { default: 0.35, min: 0, max: 2 },
  'drives.uncertainty.disputed_memory_weight': { default: 2, min: 0, max: 5 },
  'drives.uncertainty.divisor': { default: 12, min: 3, max: 40 },
  'drives.unfinished.overdue_weight': { default: 2, min: 0, max: 5 },
  'drives.unfinished.loop_weight': { default: 1, min: 0, max: 3 },
  'drives.unfinished.commitment_weight': { default: 0.35, min: 0, max: 2 },
  'drives.unfinished.stalled_aim_weight': { default: 0.75, min: 0, max: 2 },
  'drives.unfinished.divisor': { default: 10, min: 3, max: 40 },
  'drives.social_debt.negative_weight': { default: 1, min: 0, max: 3 },
  'drives.social_debt.unanswered_weight': { default: 1, min: 0, max: 3 },
  'drives.social_debt.divisor': { default: 8, min: 2, max: 30 },
  'drives.overload.commitment_weight': { default: 1, min: 0, max: 3 },
  'drives.overload.loop_weight': { default: 1, min: 0, max: 3 },
  'drives.overload.stale_cycle_weight': { default: 5, min: 0, max: 10 },
  'drives.overload.soma_stress_weight': { default: 5, min: 0, max: 10 },
  'drives.overload.divisor': { default: 18, min: 5, max: 50 },
  'drives.curiosity.unresolved_weight': { default: 1, min: 0, max: 3 },
  'drives.curiosity.prospection_weight': { default: 0.25, min: 0, max: 2 },
  'drives.curiosity.target_experiments': { default: 2, min: 0, max: 5, integer: true },
  'drives.curiosity.experiment_gap_weight': { default: 2, min: 0, max: 5 },
  'drives.curiosity.verified_aim_weight': { default: 1, min: 0, max: 3 },
  'drives.curiosity.forming_aim_weight': { default: 0.5, min: 0, max: 2 },
  'drives.curiosity.divisor': { default: 12, min: 3, max: 40 },
  'drives.continuity.loop_weight': { default: 1, min: 0, max: 3 },
  'drives.continuity.open_episode_weight': { default: 1, min: 0, max: 3 },
  'drives.continuity.stale_cycle_weight': { default: 3, min: 0, max: 8 },
  'drives.continuity.divisor': { default: 12, min: 3, max: 40 },

  'appraisal.responsiveness': { default: 0.3, min: 0.05, max: 0.8 },
  'appraisal.trace_window': { default: 40, min: 10, max: 120, integer: true },
  'appraisal.surprise_age_days': { default: 7, min: 1, max: 30 },
  'appraisal.default_prediction_accuracy': { default: 0.6, min: 0.2, max: 0.9 },
  'appraisal.valence.base': { default: 0.5, min: 0.2, max: 0.8 },
  'appraisal.valence.outcome_denominator_floor': { default: 8, min: 3, max: 30 },
  'appraisal.valence.progressing_aim_weight': { default: 0.04, min: 0, max: 0.15 },
  'appraisal.valence.stalled_aim_weight': { default: 0.04, min: 0, max: 0.15 },
  'appraisal.arousal.base': { default: 0.2, min: 0.05, max: 0.5 },
  'appraisal.arousal.unfinished_weight': { default: 0.35, min: 0, max: 0.8 },
  'appraisal.arousal.overload_weight': { default: 0.25, min: 0, max: 0.8 },
  'appraisal.arousal.surprise_cap': { default: 0.3, min: 0, max: 0.6 },
  'appraisal.arousal.surprise_weight': { default: 0.08, min: 0, max: 0.2 },
  'appraisal.control.base': { default: 0.85, min: 0.4, max: 0.95 },
  'appraisal.control.overload_weight': { default: 0.45, min: 0, max: 0.9 },
  'appraisal.control.uncertainty_weight': { default: 0.2, min: 0, max: 0.7 },
  'appraisal.control.progressing_aim_weight': { default: 0.03, min: 0, max: 0.15 },
  'appraisal.control.stalled_aim_weight': { default: 0.04, min: 0, max: 0.15 },
  'appraisal.social_safety.base': { default: 0.75, min: 0.3, max: 0.95 },
  'appraisal.social_safety.positive_weight': { default: 0.025, min: 0, max: 0.1 },
  'appraisal.social_safety.negative_weight': { default: 0.07, min: 0, max: 0.2 },
  'appraisal.coherence.base': { default: 0.35, min: 0.1, max: 0.7 },
  'appraisal.coherence.accuracy_weight': { default: 0.55, min: 0, max: 0.9 },
  'appraisal.coherence.surprise_cap': { default: 0.25, min: 0, max: 0.6 },
  'appraisal.coherence.surprise_weight': { default: 0.04, min: 0, max: 0.15 },
  'appraisal.coherence.progressing_aim_weight': { default: 0.025, min: 0, max: 0.12 },
  'appraisal.coherence.stalled_aim_weight': { default: 0.02, min: 0, max: 0.12 },
  'appraisal.labels.strained_arousal': { default: 0.68, min: 0.5, max: 0.9 },
  'appraisal.labels.strained_valence': { default: 0.45, min: 0.2, max: 0.6 },
  'appraisal.labels.engaged_valence': { default: 0.62, min: 0.5, max: 0.85 },
  'appraisal.labels.engaged_control': { default: 0.55, min: 0.35, max: 0.8 },
  'appraisal.labels.reflective_coherence': { default: 0.45, min: 0.2, max: 0.65 },
  'appraisal.labels.quiet_arousal': { default: 0.32, min: 0.15, max: 0.5 },

  'workspace.capacity': { default: 7, min: 3, max: 10, integer: true },
  'workspace.relevance_per_term': { default: 2, min: 0, max: 5 },
  'workspace.drive.minimum_level': { default: 0.35, min: 0.15, max: 0.7 },
  'workspace.drive.base': { default: 6, min: 1, max: 12 },
  'workspace.drive.level_weight': { default: 4, min: 0, max: 10 },
  'workspace.goal_affect.stalled_base': { default: 6.4, min: 1, max: 12 },
  'workspace.goal_affect.forming_base': { default: 4.2, min: 1, max: 10 },
  'workspace.goal_affect.progressing_base': { default: 3.8, min: 1, max: 10 },
  'workspace.goal_affect.salience_weight': { default: 2.5, min: 0, max: 6 },
  'workspace.commitment.overdue_base': { default: 12, min: 5, max: 18 },
  'workspace.commitment.normal_base': { default: 5, min: 1, max: 10 },
  'workspace.surprise.base': { default: 9, min: 3, max: 15 },
  'workspace.surprise.magnitude_weight': { default: 5, min: 0, max: 10 },
  'workspace.epistemic_discrepancy.base': { default: 9, min: 3, max: 15 },
  'workspace.epistemic_discrepancy.severity_weight': { default: 4, min: 0, max: 10 },
  'workspace.experiment.base': { default: 4, min: 1, max: 10 },
  'workspace.relationship.base': { default: 11, min: 4, max: 16 },
  'workspace.mind_change.base': { default: 8, min: 2, max: 14 },
  'workspace.development.minimum_significance': { default: 0.65, min: 0.4, max: 0.9 },
  'workspace.development.base': { default: 5, min: 1, max: 11 },
  'workspace.development.significance_weight': { default: 3, min: 0, max: 8 },
  'workspace.feedback.base': { default: 13, min: 5, max: 18 },
  'workspace.cognitive_pulse.base': { default: 4.5, min: 1, max: 10 },
  'workspace.cognitive_pulse.certainty_weight': { default: 2, min: 0, max: 6 },
  'workspace.prospection.due_soon_hours': { default: 48, min: 4, max: 168 },
  'workspace.prospection.due_soon_base': { default: 10, min: 3, max: 16 },
  'workspace.prospection.normal_base': { default: 5, min: 1, max: 11 },
  'workspace.self_frame.base': { default: 5.5, min: 1, max: 12 },
  'workspace.self_frame.self_query_boost': { default: 5, min: 0, max: 10 },
  'workspace.self_frame.incompleteness_weight': { default: 2, min: 0, max: 6 },
  'workspace.attention.max_directive_boost': { default: 5, min: 1, max: 8 },

  'memory.salience.hot': { default: 0.8, min: 0.6, max: 1 },
  'memory.salience.manual': { default: 0.7, min: 0.5, max: 0.95 },
  'memory.salience.learning': { default: 0.6, min: 0.45, max: 0.9 },
  'memory.salience.meeting': { default: 0.4, min: 0.2, max: 0.75 },
  'memory.salience.system': { default: 0.2, min: 0.05, max: 0.5 },
  'memory.salience.default': { default: 0.3, min: 0.1, max: 0.65 },
  'memory.retrieval.salience_weight': { default: 0.15, min: 0, max: 0.4 },
  'memory.retrieval.emotional_weight': { default: 0.08, min: 0, max: 0.25 },
  'memory.retrieval.social_weight': { default: 0.08, min: 0, max: 0.25 },
  'memory.retrieval.recall_weight': { default: 0.012, min: 0, max: 0.05 },
  'memory.retrieval.recall_cap': { default: 10, min: 1, max: 50, integer: true },
  'memory.protection.salience_floor': { default: 0.6, min: 0.4, max: 0.9 },
  'memory.protection.recall_floor': { default: 3, min: 1, max: 10, integer: true },

  'expectation.high_confidence_miss_threshold': { default: 0.7, min: 0.55, max: 0.9 },
  'expectation.surprising_memory_salience_floor': { default: 0.6, min: 0.45, max: 0.9 },

  'voice.active_window_ms': { default: 45000, min: 10000, max: 120000, integer: true },
  'voice.spoke_grace_ms': { default: 15000, min: 2000, max: 60000, integer: true },
  'voice.response_stale_ms': { default: 20000, min: 5000, max: 60000, integer: true },
  'voice.solo_speaker_max': { default: 1, min: 1, max: 3, integer: true },
});

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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function setPath(value, path, next) {
  const keys = path.split('.');
  let current = value;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = next;
}

function flatten(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) result[prefix] = value;
    return result;
  }
  const entries = Object.entries(value);
  if (!entries.length && prefix) result[prefix] = value;
  for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  return result;
}

function normalizeParams(input = {}, { strict = false } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (strict) {
    for (const path of Object.keys(flatten(source))) {
      if (!DEFINITIONS[path]) throw new Error(`unknown cognitive parameter: ${path}`);
    }
  }
  const params = {};
  for (const [path, definition] of Object.entries(DEFINITIONS)) {
    const supplied = getPath(source, path);
    let value = supplied === undefined ? definition.default : Number(supplied);
    if (!Number.isFinite(value)) {
      if (strict) throw new Error(`${path} must be a finite number`);
      value = definition.default;
    }
    if (strict && (value < definition.min || value > definition.max)) {
      throw new Error(`${path} must be between ${definition.min} and ${definition.max}`);
    }
    value = Math.max(definition.min, Math.min(definition.max, value));
    if (definition.integer) value = Math.round(value);
    setPath(params, path, value);
  }
  return params;
}

const DEFAULTS = deepFreeze(normalizeParams({}));
const BOUNDS_COMMITMENT = commitment(DEFINITIONS);

function mergePatch(current, patch) {
  const flatPatch = flatten(patch);
  if (!Object.keys(flatPatch).length) throw new Error('cognitive parameter patch must change at least one leaf');
  for (const path of Object.keys(flatPatch)) if (!DEFINITIONS[path]) throw new Error(`unknown cognitive parameter: ${path}`);
  const merged = clone(normalizeParams(current));
  for (const [path, value] of Object.entries(flatPatch)) setPath(merged, path, value);
  return normalizeParams(merged, { strict: true });
}

function changedPaths(before, after) {
  return Object.keys(DEFINITIONS).filter(path => getPath(before, path) !== getPath(after, path));
}

function manifest(record) {
  return {
    id: record.id, protocol_version: record.protocol_version, revision: record.revision,
    params: record.params, updated_at: record.updated_at, updated_by: record.updated_by,
    note: record.note, previous_commitment: record.previous_commitment,
    bounds_commitment: record.bounds_commitment,
    autonomous_tuning_enabled: record.autonomous_tuning_enabled,
  };
}

function defaultRecord() {
  const record = {
    id: 'cog-params-r1', protocol_version: PROTOCOL_VERSION, revision: 1,
    params: clone(DEFAULTS), updated_at: '1970-01-01T00:00:00.000Z',
    updated_by: 'code_default', note: 'Byte-equivalent genesis from the pre-DIALS constants.',
    previous_commitment: null, bounds_commitment: BOUNDS_COMMITMENT,
    autonomous_tuning_enabled: AUTONOMOUS_TUNING_ENABLED,
  };
  record.content_commitment = commitment(manifest(record));
  return record;
}

function verifyRecord(record) {
  if (!record || record.protocol_version !== PROTOCOL_VERSION || !Number.isInteger(record.revision)
    || record.revision < 1 || record.bounds_commitment !== BOUNDS_COMMITMENT
    || record.autonomous_tuning_enabled !== AUTONOMOUS_TUNING_ENABLED) return false;
  try {
    const normalized = normalizeParams(record.params, { strict: true });
    return canonicalJson(normalized) === canonicalJson(record.params)
      && record.content_commitment === commitment(manifest(record));
  } catch (_) { return false; }
}

function createRevision(previous, patch, { updatedBy, note, now = new Date() } = {}) {
  if (!verifyRecord(previous)) throw new Error('current cognitive parameter document failed integrity');
  const actor = String(updatedBy || '').trim();
  const explanation = String(note || '').trim();
  if (!actor) throw new Error('updated_by is required');
  if (!explanation) throw new Error('cognitive parameter edits require a note');
  if (/^nora\b/i.test(actor) && !AUTONOMOUS_TUNING_ENABLED) {
    throw new Error('autonomous cognitive parameter tuning is disabled until the preregistered experiment gate exists');
  }
  const params = mergePatch(previous.params, patch);
  const changes = changedPaths(previous.params, params);
  if (!changes.length) throw new Error('cognitive parameter patch does not change the current document');
  const record = {
    id: `cog-params-r${previous.revision + 1}`, protocol_version: PROTOCOL_VERSION,
    revision: previous.revision + 1, params, updated_at: now.toISOString(),
    updated_by: actor.slice(0, 120), note: explanation.slice(0, 800),
    previous_commitment: previous.content_commitment, bounds_commitment: BOUNDS_COMMITMENT,
    autonomous_tuning_enabled: AUTONOMOUS_TUNING_ENABLED,
  };
  record.content_commitment = commitment(manifest(record));
  return { record, changed_paths: changes };
}

function auditHistory(history = [], current = null) {
  const chain = [...(Array.isArray(history) ? history : []), ...(current ? [current] : [])];
  if (!chain.length) return { valid: false, reason: 'history_missing', records: 0 };
  for (let index = 0; index < chain.length; index++) {
    const record = chain[index];
    if (!verifyRecord(record)) return { valid: false, reason: 'record_integrity_failed', index, records: chain.length };
    if (index > 0 && (record.revision !== chain[index - 1].revision + 1
      || record.previous_commitment !== chain[index - 1].content_commitment)) {
      return { valid: false, reason: 'revision_chain_failed', index, records: chain.length };
    }
  }
  return { valid: true, reason: null, records: chain.length,
    head_commitment: chain.at(-1).content_commitment, oldest_retained_revision: chain[0].revision };
}

function createLedger(current = defaultRecord(), history = []) {
  const retained = Array.isArray(history) ? history.slice(-100).map(clone) : [];
  const ledger = { protocol_version: PROTOCOL_VERSION, history: retained, current: clone(current) };
  ledger.ledger_commitment = commitment({ protocol_version: ledger.protocol_version,
    history_commitments: retained.map(item => item.content_commitment),
    current_commitment: current.content_commitment });
  return ledger;
}

function auditLedger(ledger) {
  if (!ledger || ledger.protocol_version !== PROTOCOL_VERSION || !Array.isArray(ledger.history)) {
    return { valid: false, reason: 'ledger_missing' };
  }
  const history = auditHistory(ledger.history, ledger.current);
  const expected = commitment({ protocol_version: ledger.protocol_version,
    history_commitments: ledger.history.map(item => item.content_commitment),
    current_commitment: ledger.current?.content_commitment });
  return { ...history, ledger_commitment_verified: ledger.ledger_commitment === expected,
    valid: history.valid && ledger.ledger_commitment === expected,
    reason: !history.valid ? history.reason : ledger.ledger_commitment === expected ? null : 'ledger_commitment_failed' };
}

function bounds() {
  return Object.fromEntries(Object.entries(DEFINITIONS).map(([path, value]) => [path, clone(value)]));
}

function status(record, history = []) {
  const verified = verifyRecord(record);
  const params = verified ? record.params : DEFAULTS;
  const audit = verified ? auditHistory(history, record) : { valid: false, reason: 'current_record_integrity_failed' };
  return {
    protocol_version: PROTOCOL_VERSION,
    mechanism: 'code_bounded_cached_platform_document',
    autonomous_tuning_enabled: AUTONOMOUS_TUNING_ENABLED,
    revision: verified ? record.revision : null,
    content_commitment: verified ? record.content_commitment : defaultRecord().content_commitment,
    bounds_commitment: BOUNDS_COMMITMENT,
    parameter_count: Object.keys(DEFINITIONS).length,
    changed_from_code_default: changedPaths(DEFAULTS, params),
    default_equivalent: changedPaths(DEFAULTS, params).length === 0,
    integrity: audit,
    epistemic_status: 'A replay-verifiable configuration of functional cognitive dynamics. It is not a feeling, hidden mental state, authority grant, guarantee, identity essence, or evidence of phenomenal consciousness.',
  };
}

module.exports = {
  PROTOCOL_VERSION, AUTONOMOUS_TUNING_ENABLED, DEFINITIONS, DEFAULTS, BOUNDS_COMMITMENT,
  canonicalJson, commitment, normalizeParams, mergePatch, changedPaths, manifest,
  defaultRecord, verifyRecord, createRevision, auditHistory, createLedger, auditLedger,
  bounds, status, getPath,
};
