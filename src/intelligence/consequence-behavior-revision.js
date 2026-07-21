'use strict';

const crypto = require('node:crypto');
const consequenceReview = require('./consequence-review');
const consciousWorkspace = require('./conscious-workspace');
const motivationalArbitration = require('./motivational-arbitration');

const PROTOCOL_VERSION = 1;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function clean(value, max = 1200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function episodePayload(episode = {}) {
  return {
    protocol_version: episode.protocol_version,
    id: episode.id,
    changed_at: episode.changed_at,
    prior_action: episode.prior_action,
    observed_consequence: episode.observed_consequence,
    behavior_update: episode.behavior_update,
    selected_choice: episode.selected_choice,
    without_consequence_choice: episode.without_consequence_choice,
    influence_mode: episode.influence_mode,
    source_bindings: episode.source_bindings,
    enacted_outcome: episode.enacted_outcome,
  };
}

function auditEpisode(episode = {}) {
  const commitmentVerified = Boolean(episode.episode_commitment)
    && episode.episode_commitment === commitment(episodePayload(episode));
  const structureVerified = episode.protocol_version === PROTOCOL_VERSION
    && Boolean(episode.prior_action?.id && episode.prior_action?.description
      && episode.observed_consequence?.id && episode.observed_consequence?.outcome
      && episode.selected_choice?.key && episode.without_consequence_choice?.key
      && episode.selected_choice.key !== episode.without_consequence_choice.key)
    && ['reinforced_selected_choice', 'inhibited_alternative_choice']
      .includes(episode.influence_mode);
  const sourceVerified = Boolean(episode.source_bindings?.action_commitment
    && episode.source_bindings?.observation_commitment
    && episode.source_bindings?.frame_commitment
    && episode.source_bindings?.arbitration_receipt_commitment);
  const enactmentVerified = !episode.enacted_outcome || Boolean(
    episode.enacted_outcome.focus_commitment_id
      && episode.enacted_outcome.outcome_commitment
      && episode.enacted_outcome.outcome);
  return {
    complete_chain_verified: commitmentVerified && structureVerified
      && sourceVerified && enactmentVerified,
    commitment_verified: commitmentVerified,
    structure_verified: structureVerified,
    source_bindings_present: sourceVerified,
    enactment_binding_present: enactmentVerified,
  };
}

function derive({ consequenceLedger = consequenceReview.emptyLedger(),
  workspace = consciousWorkspace.emptyLedger() } = {}) {
  const consequences = consequenceReview.normalizeLedger(consequenceLedger);
  const workspaceLedger = consciousWorkspace.normalizeLedger(workspace);
  const actions = new Map(consequences.actions.map(item => [item.id, item]));
  const observations = new Map(consequences.observations.map(item => [item.id, item]));
  const episodes = [];

  for (const frame of workspaceLedger.frames) {
    const receipt = frame.arbitration_receipt;
    if (!consciousWorkspace.auditFrame(frame).complete_chain_verified
      || Number(receipt?.protocol_version) < 5) continue;
    for (const counterfactual of receipt.consequence_counterfactuals || []) {
      if (counterfactual.choice_changed_by_consequence !== true
        || counterfactual.observed_winner_key !== receipt.selected_winner_key) continue;
      const action = actions.get(counterfactual.action_id);
      const observation = observations.get(counterfactual.observation_id);
      if (!action || !observation
        || !consequenceReview.verifiedLesson(consequences, action.id, observation.id)
        || action.action_commitment !== counterfactual.action_commitment
        || observation.observation_commitment !== counterfactual.observation_commitment
        || observation.outcome !== counterfactual.outcome) continue;
      const selected = receipt.scored_candidates.find(item =>
        item.key === receipt.selected_winner_key);
      const without = receipt.scored_candidates.find(item =>
        item.key === counterfactual.without_consequence_winner_key);
      if (!selected || !without) continue;
      const selectedCarriesLesson = (selected.consequence_sources || []).some(source =>
        source.action_id === action.id && source.observation_id === observation.id);
      const focus = workspaceLedger.focus_commitments.find(item => item.frame_id === frame.id
        && item.selected_focus_key === selected.key
        && consciousWorkspace.auditFocusCommitment(item, workspaceLedger)
          .complete_chain_verified);
      const outcome = focus ? workspaceLedger.focus_outcomes.find(item =>
        item.focus_commitment_id === focus.id
          && consciousWorkspace.auditFocusOutcome(item, workspaceLedger)
            .complete_chain_verified) : null;
      const episode = {
        protocol_version: PROTOCOL_VERSION,
        id: `consequence-revision-${commitment(`${frame.id}:${action.id}:${observation.id}`)
          .slice(0, 32)}`,
        changed_at: frame.created_at,
        prior_action: {
          id: action.id,
          action_type: action.action_type,
          description: clean(action.description),
          intended_effect: clean(action.intended_effect),
        },
        observed_consequence: {
          id: observation.id,
          outcome: observation.outcome,
          observed_effect: clean(observation.observed_effect),
        },
        behavior_update: clean(observation.behavior_update) || null,
        selected_choice: { key: selected.key, label: clean(selected.label, 300) },
        without_consequence_choice: { key: without.key, label: clean(without.label, 300) },
        influence_mode: selectedCarriesLesson
          ? 'reinforced_selected_choice' : 'inhibited_alternative_choice',
        source_bindings: {
          action_commitment: action.action_commitment,
          observation_commitment: observation.observation_commitment,
          frame_id: frame.id,
          frame_commitment: frame.frame_commitment,
          arbitration_receipt_commitment: receipt.receipt_commitment,
        },
        enacted_outcome: outcome ? {
          focus_commitment_id: focus.id,
          outcome: outcome.outcome,
          observed_expression: clean(outcome.observed_expression),
          outcome_commitment: outcome.outcome_commitment,
        } : null,
      };
      episode.episode_commitment = commitment(episodePayload(episode));
      episode.audit = auditEpisode(episode);
      episodes.push(episode);
    }
  }
  episodes.sort((left, right) => String(right.changed_at)
    .localeCompare(String(left.changed_at)) || left.id.localeCompare(right.id));
  const verified = episodes.filter(item => item.audit.complete_chain_verified);
  return {
    protocol_version: PROTOCOL_VERSION,
    report: {
      replay_verified_consequence_changed_choices: verified.length,
      enacted_consequence_changed_choices: verified.filter(item =>
        item.enacted_outcome?.outcome === 'enacted').length,
      helped_lessons_material: verified.filter(item =>
        item.observed_consequence.outcome === 'helped').length,
      backfire_lessons_material: verified.filter(item =>
        item.observed_consequence.outcome === 'backfired').length,
      later_supported_outcomes: verified.filter(item =>
        item.enacted_outcome?.outcome === 'enacted').length,
      later_failed_or_superseded_outcomes: verified.filter(item =>
        ['failed', 'superseded'].includes(item.enacted_outcome?.outcome)).length,
    },
    episodes: verified,
  };
}

function relevantEpisodes(snapshot = {}, query = '', limit = 2) {
  const terms = (String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(term => !['about', 'after', 'again', 'because', 'before', 'could', 'from',
      'have', 'should', 'that', 'their', 'there', 'these', 'they', 'this', 'what',
      'when', 'where', 'which', 'with', 'would', 'your'].includes(term));
  if (!terms.length) return [];
  return (snapshot.episodes || []).map(item => ({ item,
    relevance: terms.filter(term => `${item.prior_action.description} ${item.prior_action.intended_effect} ${item.observed_consequence.observed_effect} ${item.behavior_update || ''} ${item.selected_choice.label} ${item.without_consequence_choice.label}`
      .toLowerCase().includes(term)).length }))
    .filter(entry => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance
      || String(right.item.changed_at).localeCompare(String(left.item.changed_at)))
    .slice(0, Math.max(0, Number(limit) || 2)).map(entry => entry.item);
}

function renderPromptLessons(episodes = []) {
  return episodes.map(item => {
    const consequence = `A prior ${item.prior_action.action_type} action had a ${item.observed_consequence.outcome} consequence: ${item.observed_consequence.observed_effect}.`;
    const choice = `That evidence changed the later workspace choice to "${item.selected_choice.label}"; without it, "${item.without_consequence_choice.label}" would have won.`;
    const enactment = item.enacted_outcome
      ? ` The selected focus was later resolved as ${item.enacted_outcome.outcome}: ${item.enacted_outcome.observed_expression}.`
      : ' Selection changed, but later enactment has not been established yet.';
    return `- ${consequence} ${choice}${enactment} Episode ${item.episode_commitment.slice(0, 12)}.`;
  }).join('\n');
}

module.exports = { PROTOCOL_VERSION, canonical, commitment, episodePayload,
  auditEpisode, derive, relevantEpisodes, renderPromptLessons };
