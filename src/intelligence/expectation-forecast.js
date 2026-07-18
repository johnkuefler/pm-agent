'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const SCOPES = new Set([
  'slack_inbox',
  'email_inbox',
  'teamwork_deadlines',
  'meeting_day',
  'run_shape',
]);
const EVIDENCE_TYPES = new Set([
  'slack_message',
  'slack_thread',
  'email_message',
  'teamwork_task',
  'teamwork_comment',
  'meeting_record',
  'calendar_event',
  'run_observation',
  'connector_failure',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeProbability(value) {
  const probability = Number(value);
  if (!Number.isFinite(probability) || probability < 0.05 || probability > 0.95) {
    throw new Error('each expectation probability must be between 0.05 and 0.95');
  }
  return probability;
}

function normalizeClaims(groups = [], idFactory) {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > SCOPES.size) {
    throw new Error('expectations require one to five distinct source scopes');
  }
  const seenScopes = new Set();
  let claimCount = 0;
  const normalized = groups.map(group => {
    const scope = String(group?.scope || '').trim();
    if (!SCOPES.has(scope)) throw new Error(`invalid expectation scope: ${scope || 'missing'}`);
    if (seenScopes.has(scope)) throw new Error(`duplicate expectation scope: ${scope}`);
    seenScopes.add(scope);
    if (!Array.isArray(group.claims) || group.claims.length < 1 || group.claims.length > 6) {
      throw new Error('each expectation scope requires one to six claims');
    }
    const claims = group.claims.map(item => {
      const claim = String(item?.claim || '').trim().replace(/\s+/g, ' ');
      if (!claim) throw new Error('each expectation claim requires text');
      claimCount += 1;
      return { id: idFactory(), claim: claim.slice(0, 500), probability: normalizeProbability(item.probability) };
    });
    return { scope, claims };
  });
  if (claimCount > 24) throw new Error('an expectation forecast may contain at most twenty-four claims');
  return normalized;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 10) {
    throw new Error('each expectation resolution requires one to ten evidence references');
  }
  return evidence.map(item => {
    const type = String(item?.type || '').trim();
    if (!EVIDENCE_TYPES.has(type)) throw new Error(`invalid expectation evidence type: ${type || 'missing'}`);
    if (!item.id && !item.url) throw new Error('each expectation evidence reference requires id or url');
    return {
      type,
      ...(item.id ? { id: String(item.id).slice(0, 500) } : {}),
      ...(item.url ? { url: String(item.url).slice(0, 1000) } : {}),
      ...(item.quote ? { quote: String(item.quote).slice(0, 500) } : {}),
    };
  });
}

function normalizeOutcome(value) {
  if (value === true || value === false || value === 'unclear') return value;
  throw new Error('expectation outcomes must be true, false, or unclear');
}

function scoreClaim(claim, resolution, { highConfidenceMissThreshold = 0.7 } = {}) {
  if (resolution.outcome === 'unclear') return { scored: false, brier: null, predicted: null, miss: false, magnitude: null };
  const actual = resolution.outcome ? 1 : 0;
  const predicted = claim.probability >= 0.5;
  const confidence = Math.max(claim.probability, 1 - claim.probability);
  const miss = predicted !== resolution.outcome;
  return {
    scored: true,
    brier: (claim.probability - actual) ** 2,
    predicted,
    confidence,
    miss,
    high_confidence_miss: miss && confidence >= highConfidenceMissThreshold,
    magnitude: Math.abs(claim.probability - actual),
  };
}

function summarize(forecasts = [], since = null) {
  const sinceMs = since ? new Date(since).getTime() : null;
  const eligible = forecasts.filter(item => !sinceMs || new Date(item.made_at).getTime() >= sinceMs);
  const rows = [];
  for (const forecast of eligible) {
    for (const group of forecast.scopes || []) {
      for (const claim of group.claims || []) {
        const resolution = forecast.resolution?.claims?.find(item => item.claim_id === claim.id);
        if (!resolution || resolution.outcome === 'unclear') continue;
        rows.push({ scope: group.scope, probability: claim.probability, outcome: resolution.outcome, ...scoreClaim(claim, resolution) });
      }
    }
  }
  const calculate = items => {
    if (!items.length) return { n: 0, brier: null, accuracy: null, mean_confidence: null,
      calibration_gap: null, high_confidence_misses: 0, direction: 'collecting' };
    const average = key => items.reduce((sum, item) => sum + item[key], 0) / items.length;
    const accuracy = items.filter(item => !item.miss).length / items.length;
    const meanConfidence = average('confidence');
    const gap = meanConfidence - accuracy;
    return {
      n: items.length,
      brier: average('brier'),
      accuracy,
      mean_confidence: meanConfidence,
      calibration_gap: gap,
      high_confidence_misses: items.filter(item => item.high_confidence_miss).length,
      direction: gap > 0.05 ? 'overconfident' : gap < -0.05 ? 'underconfident' : 'calibrated_band',
    };
  };
  return {
    overall: calculate(rows),
    by_scope: Object.fromEntries([...SCOPES].map(scope => [scope, calculate(rows.filter(item => item.scope === scope))])),
  };
}

function collectionGate(forecasts = [], surprises = [], calibration = summarize(forecasts)) {
  const dayNumbers = [...new Set(forecasts.map(item => {
    const value = item.resolution?.resolved_at || item.made_at;
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000 : null;
  }).filter(Number.isFinite))].sort((a, b) => a - b);
  let longestConsecutiveDays = 0; let currentStreak = 0; let previous = null;
  for (const day of dayNumbers) {
    currentStreak = previous != null && day === previous + 1 ? currentStreak + 1 : 1;
    longestConsecutiveDays = Math.max(longestConsecutiveDays, currentStreak);
    previous = day;
  }
  const scoredScopes = Object.values(calibration.by_scope || {}).filter(item => item.n > 0).length;
  const sourceBoundSurprises = surprises.filter(item => item.origin === 'expectation_forecast'
    && item.source_bound === true && item.replay_verified === true).length;
  const scoredClaims = calibration.overall?.n || 0;
  return {
    minimum_scored_claims: 40,
    minimum_scored_scopes: 3,
    minimum_consecutive_collection_days: 7,
    minimum_source_bound_surprises: 1,
    scored_claims: scoredClaims,
    scored_scopes: scoredScopes,
    distinct_collection_days: dayNumbers.length,
    longest_consecutive_collection_days: longestConsecutiveDays,
    source_bound_surprises: sourceBoundSurprises,
    ready: scoredClaims >= 40 && scoredScopes >= 3 && longestConsecutiveDays >= 7
      && sourceBoundSurprises >= 1,
  };
}

module.exports = {
  EVIDENCE_TYPES,
  PROTOCOL_VERSION,
  SCOPES,
  commitment,
  normalizeClaims,
  normalizeEvidence,
  normalizeOutcome,
  scoreClaim,
  summarize,
  collectionGate,
};
