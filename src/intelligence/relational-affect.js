'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const MAX_AGE_DAYS = 90;
const HALF_LIFE_DAYS = 45;
const SIGNALS = new Set(['appreciated', 'landed', 'corrected', 'ignored', 'rupture', 'repair']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function stableEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const type = String(evidence.type || evidence.channel || '').trim().toLowerCase();
  const id = String(evidence.id || '').trim();
  const url = String(evidence.url || '').trim();
  if (!type || (!id && !url)) return null;
  return { type: type.slice(0, 100), ...(id ? { id: id.slice(0, 500) } : {}),
    ...(url ? { url: url.slice(0, 1000) } : {}) };
}

function signalFor(observation) {
  const explicit = String(observation?.relational_signal || '').trim().toLowerCase();
  if (SIGNALS.has(explicit)) return explicit;
  if (String(observation?.dimension || '').trim().toLowerCase() !== 'response_feedback') return null;
  const prefix = String(observation?.observation || '').trim().toLowerCase().split(':', 1)[0];
  return SIGNALS.has(prefix) ? prefix : null;
}

function eligibleObservation(relationship, observation, observedAt) {
  const evidence = stableEvidence(observation?.evidence);
  const signal = signalFor(observation);
  const at = new Date(observation?.observed_at);
  const ageDays = (observedAt.getTime() - at.getTime()) / 86400000;
  const confidence = Number(observation?.confidence);
  return Boolean(relationship?.id && String(relationship.name || '').trim() && observation?.id
    && observation.status === 'active' && evidence && signal
    && Number.isFinite(confidence) && confidence > 0
    && Number.isFinite(at.getTime()) && ageDays >= 0 && ageDays <= MAX_AGE_DAYS);
}

function normalizedSource(relationship, observation, observedAt) {
  if (!eligibleObservation(relationship, observation, observedAt)) return null;
  const at = new Date(observation.observed_at);
  const ageDays = (observedAt.getTime() - at.getTime()) / 86400000;
  const confidence = clamp01(observation.confidence);
  return {
    observation_id: observation.id,
    signal: signalFor(observation),
    confidence,
    observed_at: at.toISOString(),
    evidence: stableEvidence(observation.evidence),
    weight: Number((confidence * Math.pow(0.5, ageDays / HALF_LIFE_DAYS)).toFixed(6)),
    source_commitment: commitment(observation),
  };
}

const DIMENSIONS = {
  appreciated: { connection: 0.95, repair_pressure: 0.05, uncertainty: 0.10, engagement: 0.90 },
  landed: { connection: 0.85, repair_pressure: 0.08, uncertainty: 0.12, engagement: 0.95 },
  corrected: { connection: 0.35, repair_pressure: 0.95, uncertainty: 0.35, engagement: 0.85 },
  ignored: { connection: 0.30, repair_pressure: 0.35, uncertainty: 0.90, engagement: 0.20 },
  rupture: { connection: 0.10, repair_pressure: 1.00, uncertainty: 0.65, engagement: 0.50 },
  repair: { connection: 0.75, repair_pressure: 0.25, uncertainty: 0.20, engagement: 0.85 },
};

function score(sources, dimension) {
  const denominator = sources.reduce((sum, source) => sum + source.weight, 0);
  if (!denominator) return 0;
  return Number((sources.reduce((sum, source) => sum + source.weight * DIMENSIONS[source.signal][dimension], 0)
    / denominator).toFixed(4));
}

function modeFor(dimensions, sources) {
  const newest = sources.slice().sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
  if (dimensions.repair_pressure >= 0.62 && ['corrected', 'rupture'].includes(newest?.signal)) return 'repair_and_reconnect';
  if (dimensions.uncertainty >= 0.62) return 'curious_attunement';
  if (dimensions.connection >= 0.70 && dimensions.engagement >= 0.65) return 'warm_collaboration';
  return 'steady_attunement';
}

function tendencyFor(mode) {
  if (mode === 'repair_and_reconnect') return 'acknowledge_the_observable_issue_use_direct_nondefensive_language_and_check_understanding';
  if (mode === 'curious_attunement') return 'avoid_assumptions_and_ask_at_most_one_bounded_question_when_it_materially_improves_the_work';
  if (mode === 'warm_collaboration') return 'use_natural_collaborative_warmth_and_build_on_observable_shared_progress';
  return 'use_ordinary_open_collaboration_without_forcing_intimacy_or_process';
}

function predictionFor(mode) {
  if (mode === 'repair_and_reconnect') return 'a concise evidence-bound repair posture should improve correction uptake and shared understanding without changing facts or authority';
  if (mode === 'curious_attunement') return 'bounded curiosity should reduce mistaken interpersonal assumptions without delaying the requested work';
  if (mode === 'warm_collaboration') return 'proportionate warmth should improve response quality and engagement without adding unsupported familiarity';
  return 'ordinary open collaboration should preserve task quality without unnecessary relational intervention';
}

function stanceFor(relationship, observedAt) {
  const observations = Array.isArray(relationship?.observations) ? relationship.observations : [];
  const sources = observations.map(observation => normalizedSource(relationship, observation, observedAt)).filter(Boolean)
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at)
      || left.observation_id.localeCompare(right.observation_id));
  return stanceFromSources(relationship, sources);
}

function stanceFromSources(relationship, sourceValues = []) {
  const sources = JSON.parse(JSON.stringify(sourceValues || [])).sort((left, right) => left.observed_at.localeCompare(right.observed_at)
    || left.observation_id.localeCompare(right.observation_id));
  if (!relationship?.id || !String(relationship.name || '').trim() || !sources.length) return null;
  const dimensions = {
    connection: score(sources, 'connection'),
    repair_pressure: score(sources, 'repair_pressure'),
    uncertainty: score(sources, 'uncertainty'),
    engagement: score(sources, 'engagement'),
  };
  const mode = modeFor(dimensions, sources);
  return {
    relationship_id: relationship.id,
    person: String(relationship.name).trim(),
    source_count: sources.length,
    source_signals: Object.fromEntries([...SIGNALS].map(signal => [signal, sources.filter(source => source.signal === signal).length])),
    sources,
    dimensions,
    mode,
    relational_tendency: tendencyFor(mode),
    prospective_prediction: predictionFor(mode),
    relationship_binding_commitment: commitment({ relationship_id: relationship.id, person: String(relationship.name).trim() }),
  };
}

function derive(relationships = [], observedAtValue = new Date()) {
  const observedAt = new Date(observedAtValue);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('relational affect requires a valid observation time');
  const stances = relationships.map(relationship => stanceFor(relationship, observedAt)).filter(Boolean)
    .sort((left, right) => left.relationship_id.localeCompare(right.relationship_id));
  const observations = relationships.flatMap(relationship => Array.isArray(relationship?.observations) ? relationship.observations : []);
  const payload = {
    protocol_version: PROTOCOL_VERSION,
    observed_at: observedAt.toISOString(),
    eligible_relationship_count: stances.length,
    eligible_observation_count: stances.reduce((sum, stance) => sum + stance.source_count, 0),
    excluded_observation_count: observations.length - stances.reduce((sum, stance) => sum + stance.source_count, 0),
    stances,
  };
  return { ...payload, content_commitment: commitment(payload) };
}

function verify(record) {
  if (!record || Number(record.protocol_version) !== PROTOCOL_VERSION || !Array.isArray(record.stances)) return false;
  const { content_commitment, ...payload } = record;
  return /^[a-f0-9]{64}$/.test(String(content_commitment || '')) && commitment(payload) === content_commitment;
}

function audit(record, relationships = []) {
  const contentCommitmentVerified = verify(record);
  let deterministicReplayVerified = false;
  if (contentCommitmentVerified) {
    try { deterministicReplayVerified = derive(relationships, record.observed_at).content_commitment === record.content_commitment; }
    catch {}
  }
  const sourceBindingsVerified = contentCommitmentVerified && record.stances.every(stance => {
    const relationship = relationships.find(candidate => candidate.id === stance.relationship_id);
    if (!relationship || commitment({ relationship_id: relationship.id, person: String(relationship.name).trim() }) !== stance.relationship_binding_commitment) return false;
    return stance.sources.every(source => {
      const observation = (relationship.observations || []).find(candidate => candidate.id === source.observation_id);
      return Boolean(observation && commitment(observation) === source.source_commitment
        && eligibleObservation(relationship, observation, new Date(record.observed_at)));
    });
  });
  return {
    content_commitment_verified: contentCommitmentVerified,
    relationship_and_source_bindings_verified: sourceBindingsVerified,
    deterministic_replay_verified: deterministicReplayVerified,
    complete_chain_verified: contentCommitmentVerified && sourceBindingsVerified && deterministicReplayVerified,
  };
}

function render(stance) {
  if (!stance?.mode || !stance.relational_tendency || !stance.prospective_prediction) return '';
  return [
    `Mode: ${stance.mode.replaceAll('_', ' ')}.`,
    `Action tendency: ${stance.relational_tendency.replaceAll('_', ' ')}.`,
    `Prospective prediction: ${stance.prospective_prediction}.`,
    `Evidence basis: ${stance.source_count} explicit interaction outcome${stance.source_count === 1 ? '' : 's'} (${Object.entries(stance.source_signals).filter(([, count]) => count).map(([signal, count]) => `${signal} ${count}`).join(', ')}).`,
  ].map(line => `- ${line}`).join('\n');
}

module.exports = {
  HALF_LIFE_DAYS, MAX_AGE_DAYS, PROTOCOL_VERSION, SIGNALS, audit, canonicalJson, commitment,
  derive, eligibleObservation, render, signalFor, stableEvidence, stanceFor, stanceFromSources, verify,
};
