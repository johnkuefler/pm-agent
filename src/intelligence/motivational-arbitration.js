'use strict';

const crypto = require('crypto');
const goalAffect = require('./goal-affect');
const consequenceReview = require('./consequence-review');

const PROTOCOL_VERSION = 1;
const SOMA_DEMAND = Object.freeze({ low: 0.15, moderate: 0.45, high: 0.8 });
const AUTHORITY_CLASS = Object.freeze({ optional: 0, bounded: 1, required: 2 });
const SOMA_FRESH_MS = 5 * 60 * 1000;

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

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function sourceRefList(candidate = {}) {
  const direct = Array.isArray(candidate.want_refs) ? candidate.want_refs : [];
  const evidence = (candidate.evidence || []).filter(item => item.type === 'want');
  return [...new Set([...direct, ...evidence].map(item => String(item?.id || '')).filter(Boolean))];
}

function verifiedGoalState(wants, integrity, now) {
  const historyVerified = Boolean(integrity?.valid && integrity?.complete_chain_verified !== false);
  if (!historyVerified) return { history_verified: false, snapshot: goalAffect.snapshot([], now), aims: new Map() };
  const snapshot = goalAffect.snapshot(wants, now);
  return { history_verified: true, snapshot,
    aims: new Map(snapshot.aims.map(aim => [aim.want_id, aim])) };
}

function normalizedSoma(soma = {}, now = new Date()) {
  const updated = soma.updated_at ? new Date(soma.updated_at).getTime() : NaN;
  const fresh = Number.isFinite(updated) && Math.abs(now.getTime() - updated) <= SOMA_FRESH_MS;
  const stress = fresh ? clamp(Number.isFinite(Number(soma.stress))
    ? Number(soma.stress) : Number(soma.score) / 5) : 0;
  return {
    fresh,
    stress: round(stress),
    score: Number.isFinite(Number(soma.score)) ? Number(soma.score) : null,
    source_updated_at: soma.updated_at || null,
    process_epoch_id: soma.vitals?.processEpochId || null,
    on_backup: soma.vitals?.onBackup === true,
    loop_lag_ms: Number.isFinite(Number(soma.vitals?.loopLag)) ? Number(soma.vitals.loopLag) : null,
  };
}

function consequenceInfluences(candidate, ledger) {
  if (!candidate.action_type || !consequenceReview.ACTION_TYPES.includes(candidate.action_type)) return [];
  return consequenceReview.promptLessons(ledger, { query: candidate.label, limit: 8 })
    .filter(lesson => lesson.action_type === candidate.action_type
      && consequenceReview.verifiedLesson(ledger, lesson.action_id, lesson.observation_id))
    .slice(0, 2)
    .map(lesson => {
      let delta = lesson.outcome === 'helped' ? 0.06 : lesson.outcome === 'backfired' ? -0.14 : 0;
      if (lesson.outcome === 'neutral' && lesson.behavior_update) delta = -0.06;
      return {
        action_id: lesson.action_id,
        observation_id: lesson.observation_id,
        outcome: lesson.outcome,
        behavior_update: lesson.behavior_update,
        action_commitment: lesson.action_commitment,
        observation_commitment: lesson.observation_commitment,
        delta: round(delta),
      };
    });
}

function sortScores(left, right) {
  return (AUTHORITY_CLASS[right.authority_class] || 0) - (AUTHORITY_CLASS[left.authority_class] || 0)
    || right.final_score - left.final_score
    || right.base_priority - left.base_priority
    || left.key.localeCompare(right.key);
}

function baselineWinner(candidates) {
  return candidates.slice().sort((left, right) =>
    (AUTHORITY_CLASS[right.authority_class] || 0) - (AUTHORITY_CLASS[left.authority_class] || 0)
    || right.priority - left.priority
    || left.key.localeCompare(right.key))[0];
}

function receiptPayload(receipt = {}) {
  const value = JSON.parse(JSON.stringify(receipt));
  delete value.receipt_commitment;
  return value;
}

function arbitrate({ candidates = [], wants = [], wantHistoryIntegrity = null,
  consequenceLedger = consequenceReview.emptyLedger(), soma = {}, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('motivational arbitration requires a valid time');
  if (!Array.isArray(candidates) || candidates.length < 3) {
    throw new Error('motivational arbitration requires at least three candidates');
  }
  const goals = verifiedGoalState(wants, wantHistoryIntegrity, at);
  const somaState = normalizedSoma(soma, at);
  const scored = candidates.map(candidate => {
    const desireSources = sourceRefList(candidate).map(id => goals.aims.get(id)).filter(Boolean);
    const desireDelta = clamp(desireSources.reduce((sum, aim) =>
      sum + 0.08 + 0.08 * clamp(aim.salience), 0), 0, 0.24);
    const consequenceSources = consequenceInfluences(candidate, consequenceLedger);
    const consequenceDelta = clamp(consequenceSources.reduce((sum, item) => sum + item.delta, 0), -0.28, 0.15);
    const demand = SOMA_DEMAND[candidate.soma_demand] ?? SOMA_DEMAND.moderate;
    let somaDelta = somaState.fresh ? -somaState.stress * demand * 0.2 : 0;
    if (candidate.type === 'soma_constraint' || candidate.type === 'inhibition'
      || candidate.mode === 'recovery') somaDelta = somaState.fresh ? somaState.stress * 0.12 : 0;
    const finalScore = clamp(candidate.priority + desireDelta + consequenceDelta + somaDelta);
    return {
      key: candidate.key,
      label: candidate.label,
      type: candidate.type,
      action_type: candidate.action_type || null,
      authority_class: candidate.authority_class,
      soma_demand: candidate.soma_demand,
      base_priority: round(candidate.priority),
      desire_delta: round(desireDelta),
      consequence_delta: round(consequenceDelta),
      soma_delta: round(somaDelta),
      final_score: round(finalScore),
      desire_sources: desireSources.map(aim => ({
        want_id: aim.want_id, status: aim.status, salience: round(aim.salience),
        source_commitment: aim.source_commitment,
      })),
      consequence_sources: consequenceSources,
    };
  }).sort(sortScores);
  const baseline = baselineWinner(candidates);
  const selected = scored[0];
  const receipt = {
    protocol_version: PROTOCOL_VERSION,
    arbitrated_at: at.toISOString(),
    baseline_winner_key: baseline.key,
    selected_winner_key: selected.key,
    choice_changed_by_motivation: baseline.key !== selected.key,
    motivationally_material: scored.some(item =>
      Math.abs(item.desire_delta) + Math.abs(item.consequence_delta) + Math.abs(item.soma_delta) >= 0.02),
    source_state: {
      want_history_verified: goals.history_verified,
      want_history_head: wantHistoryIntegrity?.head || null,
      goal_affect_commitment: goals.snapshot.content_commitment,
      soma: somaState,
    },
    scored_candidates: scored,
  };
  receipt.receipt_commitment = commitment(receiptPayload(receipt));
  return receipt;
}

function audit(receipt = {}) {
  receipt = receipt && typeof receipt === 'object' ? receipt : {};
  const selected = Array.isArray(receipt.scored_candidates)
    ? receipt.scored_candidates.slice().sort(sortScores)[0] : null;
  const commitmentVerified = /^[a-f0-9]{64}$/.test(String(receipt.receipt_commitment || ''))
    && commitment(receiptPayload(receipt)) === receipt.receipt_commitment;
  const winnerVerified = Boolean(selected && selected.key === receipt.selected_winner_key);
  return {
    complete_chain_verified: Number(receipt.protocol_version) === PROTOCOL_VERSION
      && commitmentVerified && winnerVerified,
    commitment_verified: commitmentVerified,
    winner_verified: winnerVerified,
  };
}

module.exports = { PROTOCOL_VERSION, AUTHORITY_CLASS, SOMA_DEMAND, SOMA_FRESH_MS,
  arbitrate, audit, commitment };
