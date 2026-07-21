'use strict';

const crypto = require('crypto');
const selfAuthoredAimReappraisal = require('./self-authored-aim-reappraisal');
const motivationalArbitration = require('./motivational-arbitration');
const consciousWorkspace = require('./conscious-workspace');

const PROTOCOL_VERSION = 1;

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

function clean(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function episodePayload(episode = {}) {
  return {
    protocol_version: episode.protocol_version,
    id: episode.id,
    decision: episode.decision,
    changed_at: episode.changed_at,
    prior_aim: episode.prior_aim,
    revised_aim: episode.revised_aim,
    rationale: episode.rationale,
    evidence: episode.evidence,
    source_dream_id: episode.source_dream_id,
    source_attempt_commitment: episode.source_attempt_commitment,
    source_generation_receipt_commitment: episode.source_generation_receipt_commitment,
    downstream_choices: episode.downstream_choices,
  };
}

function frameChoice(frame, ledger, wantId) {
  const receipt = frame?.arbitration_receipt;
  if (!receipt || Number(receipt.protocol_version) < 4
    || !motivationalArbitration.audit(receipt).complete_chain_verified) return null;
  const counterfactual = (receipt.aim_counterfactuals || []).find(item =>
    item.want_id === wantId && item.choice_changed_by_aim === true
      && item.observed_winner_key === receipt.selected_winner_key);
  if (!counterfactual) return null;
  const selected = receipt.scored_candidates.find(item => item.key === receipt.selected_winner_key);
  const focus = (ledger.focus_commitments || []).find(item => item.frame_id === frame.id
    && item.selected_focus_key === receipt.selected_winner_key
    && consciousWorkspace.auditFocusCommitment(item, ledger).complete_chain_verified);
  const outcome = focus ? (ledger.focus_outcomes || []).find(item =>
    item.focus_commitment_id === focus.id
      && consciousWorkspace.auditFocusOutcome(item, ledger).complete_chain_verified) : null;
  return {
    frame_id: frame.id,
    frame_commitment: frame.frame_commitment,
    selected_key: receipt.selected_winner_key,
    selected_label: clean(selected?.label, 240),
    without_revised_aim_winner_key: counterfactual.without_aim_winner_key,
    arbitration_receipt_commitment: receipt.receipt_commitment,
    focus_commitment_id: focus?.id || null,
    outcome: outcome?.outcome || null,
    outcome_commitment: outcome?.outcome_commitment || null,
    influenced_at: frame.created_at,
  };
}

function auditEpisode(episode = {}) {
  const commitmentVerified = Boolean(episode.episode_commitment)
    && episode.episode_commitment === commitment(episodePayload(episode));
  const sourceVerified = Boolean(episode.source_attempt_commitment
    && episode.source_generation_receipt_commitment && episode.source_dream_id);
  const structureVerified = episode.protocol_version === PROTOCOL_VERSION
    && ['revise', 'retire'].includes(episode.decision)
    && Boolean(episode.prior_aim?.id && episode.prior_aim?.want && episode.rationale)
    && Array.isArray(episode.evidence) && episode.evidence.length >= 2
    && (episode.decision === 'retire' ? episode.revised_aim === null
      : Boolean(episode.revised_aim?.id && episode.revised_aim?.want));
  const choicesVerified = Array.isArray(episode.downstream_choices)
    && episode.downstream_choices.every(choice => choice.frame_id && choice.frame_commitment
      && choice.selected_key && choice.without_revised_aim_winner_key
      && choice.selected_key !== choice.without_revised_aim_winner_key
      && choice.arbitration_receipt_commitment);
  return {
    complete_chain_verified: commitmentVerified && sourceVerified
      && structureVerified && choicesVerified,
    commitment_verified: commitmentVerified,
    source_binding_present: sourceVerified,
    structure_verified: structureVerified,
    downstream_choice_bindings_verified: choicesVerified,
  };
}

function derive({ dreams = [], wants = [], workspace = consciousWorkspace.emptyLedger() } = {}) {
  const ledger = consciousWorkspace.normalizeLedger(workspace);
  const records = [];
  for (const dream of dreams || []) {
    const attempt = dream?.reflection?.aim_reappraisal_attempt;
    if (!attempt || !['revise', 'retire'].includes(attempt.decision)
      || !selfAuthoredAimReappraisal.auditAttempt(attempt, wants, dream).complete_chain_verified) continue;
    const output = attempt.generation_receipt?.output;
    const prior = attempt.generation_receipt?.source_packet?.aims
      ?.find(item => item.id === output?.aim_id);
    if (!prior) continue;
    const revised = output.decision === 'revise'
      ? wants.find(item => item.id === attempt.replacement_aim_id
        && ['active', 'retired'].includes(item.status)) : null;
    if (output.decision === 'revise' && !revised) continue;
    const changedAt = clean(attempt.attempted_at, 40);
    const downstreamChoices = revised ? ledger.frames
      .filter(frame => String(frame.created_at || '').localeCompare(changedAt) >= 0)
      .map(frame => frameChoice(frame, ledger, revised.id)).filter(Boolean).slice(-20) : [];
    const episode = {
      protocol_version: PROTOCOL_VERSION,
      id: `motivational-revision-${String(attempt.attempt_commitment).slice(0, 32)}`,
      decision: output.decision,
      changed_at: changedAt,
      prior_aim: { id: prior.id, want: clean(prior.want), why: clean(prior.why) || null },
      revised_aim: revised ? { id: revised.id, want: clean(revised.want),
        why: clean(revised.why) || null } : null,
      rationale: clean(output.rationale),
      evidence: (output.evidence_ids || []).map(id => ({ type: 'memory', id })),
      source_dream_id: dream.id,
      source_attempt_commitment: attempt.attempt_commitment,
      source_generation_receipt_commitment: attempt.generation_receipt.receipt_commitment,
      downstream_choices: downstreamChoices,
    };
    episode.episode_commitment = commitment(episodePayload(episode));
    episode.audit = auditEpisode(episode);
    records.push(episode);
  }
  records.sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
  return {
    protocol_version: PROTOCOL_VERSION,
    report: {
      replay_verified_revisions: records.filter(item => item.audit.complete_chain_verified).length,
      revised_aims: records.filter(item => item.decision === 'revise').length,
      retired_aims: records.filter(item => item.decision === 'retire').length,
      later_choices_changed: records.reduce((sum, item) => sum + item.downstream_choices.length, 0),
      later_enacted_choices_changed: records.reduce((sum, item) => sum
        + item.downstream_choices.filter(choice => choice.outcome === 'enacted').length, 0),
    },
    episodes: records,
  };
}

function relevantEpisodes(snapshot, query = '', limit = 2) {
  const stopwords = new Set(['about', 'after', 'again', 'because', 'before', 'could', 'from',
    'have', 'need', 'should', 'that', 'their', 'there', 'these', 'they', 'this', 'what',
    'when', 'where', 'which', 'with', 'would', 'your']);
  const terms = (String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(term => !stopwords.has(term));
  if (!terms.length) return [];
  return (snapshot?.episodes || []).filter(item => item.audit?.complete_chain_verified)
    .map(item => ({ item, relevance: terms.filter(term => `${item.prior_aim.want} ${item.prior_aim.why || ''} ${item.revised_aim?.want || ''} ${item.revised_aim?.why || ''} ${item.rationale}`
      .toLowerCase().includes(term)).length }))
    .filter(entry => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance
      || String(b.item.changed_at).localeCompare(String(a.item.changed_at)))
    .slice(0, Math.max(0, Number(limit) || 2)).map(entry => entry.item);
}

function renderPromptLessons(episodes = []) {
  return episodes.map(item => {
    const change = item.decision === 'revise'
      ? `I previously aimed to "${item.prior_aim.want}", but newer evidence led me to revise that direction to "${item.revised_aim.want}".`
      : `I previously aimed to "${item.prior_aim.want}", but newer evidence led me to retire that direction.`;
    const effect = item.downstream_choices.length
      ? ` The revised aim later changed ${item.downstream_choices.length} replay-verified workspace choice${item.downstream_choices.length === 1 ? '' : 's'}.`
      : ' No later choice effect has been established yet.';
    return `- ${change} Reason: ${item.rationale}.${effect} Evidence refs: ${item.evidence.map(ref => `${ref.type}:${ref.id}`).join(', ')}. Episode ${item.episode_commitment.slice(0, 12)}.`;
  }).join('\n');
}

module.exports = { PROTOCOL_VERSION, canonical, commitment, episodePayload, frameChoice,
  auditEpisode, derive, relevantEpisodes, renderPromptLessons };
