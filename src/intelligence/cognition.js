'use strict';

const crypto = require('crypto');
const constructiveProspection = require('./constructive-prospection');
const integratedSelf = require('./integrated-self');
const cognitivePulse = require('./cognitive-pulse');
const goalAffect = require('./goal-affect');
const cognitiveParameters = require('./cognitive-parameters');

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function blend(previous, target, responsiveness = 0.35) {
  return clamp01((Number(previous) || 0) * (1 - responsiveness) + clamp01(target) * responsiveness);
}

function ageDays(value, now) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? Math.max(0, (now.getTime() - time) / 86400000) : 999;
}

function computeDrives(state, input = {}, now = new Date(), parameterInput = null) {
  const params = cognitiveParameters.normalizeParams(parameterInput || cognitiveParameters.DEFAULTS);
  const config = params.drives;
  const previous = state.cognition?.drives || {};
  const open = state.commitments.filter(item => item.status === 'open');
  const overdue = open.filter(item => item.due && new Date(item.due).getTime() < now.getTime());
  const loops = state.episodes.flatMap(item => item.open_loops || []).filter(item => item.status === 'open');
  const unresolved = (input.predictions || []).filter(item => !item.outcome);
  const negative = state.traces.slice(-config.trace_window).filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const staleCycle = state.cycles.some(item => item.status === 'running' && ageDays(item.started, now) > config.stale_cycle_age_days);
  const activeExperiments = state.experiments.filter(item => item.status === 'active').length;
  const openProspections = contextAllowsProspection(input)
    ? (state.cognition?.prospection?.simulations || []).filter(item => item.status === 'open' && constructiveProspection.contentCommitment(item) === item.content_commitment) : [];
  const aimState = goalAffect.verify(input.goal_affect) ? input.goal_affect : null;
  const stalledAims = Number(aimState?.stalled_aims || 0);
  const formingAims = Number(aimState?.forming_aims || 0);
  const targets = {
    uncertainty: clamp01((unresolved.length + openProspections.length * config.uncertainty.prospection_weight
      + Number(input.disputed_memories || 0) * config.uncertainty.disputed_memory_weight) / config.uncertainty.divisor),
    unfinished: clamp01((overdue.length * config.unfinished.overdue_weight + loops.length * config.unfinished.loop_weight
      + open.length * config.unfinished.commitment_weight + stalledAims * config.unfinished.stalled_aim_weight) / config.unfinished.divisor),
    social_debt: clamp01((negative * config.social_debt.negative_weight
      + Number(input.unanswered_people || 0) * config.social_debt.unanswered_weight) / config.social_debt.divisor),
    overload: clamp01((open.length * config.overload.commitment_weight + loops.length * config.overload.loop_weight
      + (staleCycle ? config.overload.stale_cycle_weight : 0)
      + Number(input.soma?.stress || 0) * config.overload.soma_stress_weight) / config.overload.divisor),
    curiosity: clamp01((unresolved.length * config.curiosity.unresolved_weight
      + openProspections.length * config.curiosity.prospection_weight
      + (config.curiosity.target_experiments - Math.min(config.curiosity.target_experiments, activeExperiments))
        * config.curiosity.experiment_gap_weight
      + Number(aimState?.active_verified_aims || 0) * config.curiosity.verified_aim_weight
      + formingAims * config.curiosity.forming_aim_weight) / config.curiosity.divisor),
    continuity: clamp01((loops.length * config.continuity.loop_weight
      + state.episodes.filter(item => item.status === 'open').length * config.continuity.open_episode_weight
      + (staleCycle ? config.continuity.stale_cycle_weight : 0)) / config.continuity.divisor),
  };
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, {
    level: blend(previous[name]?.level, target, config.responsiveness), target, updated: now.toISOString(),
  }]));
}

function contextAllowsProspection(context = {}) {
  return context.includeConstructiveProspection !== false;
}

function computeAppraisal(state, drives, input = {}, now = new Date(), parameterInput = null) {
  const params = cognitiveParameters.normalizeParams(parameterInput || cognitiveParameters.DEFAULTS);
  const config = params.appraisal;
  const previous = state.cognition?.appraisal || {};
  const traces = state.traces.slice(-config.trace_window);
  const positive = traces.filter(item => ['positive', 'helpful', 'accepted', 'fulfilled'].includes(item.outcome)).length;
  const negative = traces.filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const surprises = (state.cognition?.surprises || []).filter(item => ageDays(item.at, now) < config.surprise_age_days);
  const resolved = (input.predictions || []).filter(item => item.outcome === 'right' || item.outcome === 'wrong');
  const accuracy = resolved.length ? resolved.filter(item => item.outcome === 'right').length / resolved.length : config.default_prediction_accuracy;
  const aimState = goalAffect.verify(input.goal_affect) ? input.goal_affect : null;
  const progressingAims = Number(aimState?.progressing_aims || 0);
  const stalledAims = Number(aimState?.stalled_aims || 0);
  const raw = {
    valence: clamp01(config.valence.base + (positive - negative) / Math.max(config.valence.outcome_denominator_floor, traces.length)
      + progressingAims * config.valence.progressing_aim_weight - stalledAims * config.valence.stalled_aim_weight),
    arousal: clamp01(config.arousal.base + drives.unfinished.level * config.arousal.unfinished_weight
      + drives.overload.level * config.arousal.overload_weight
      + Math.min(config.arousal.surprise_cap, surprises.length * config.arousal.surprise_weight)),
    control: clamp01(config.control.base - drives.overload.level * config.control.overload_weight
      - drives.uncertainty.level * config.control.uncertainty_weight
      + progressingAims * config.control.progressing_aim_weight - stalledAims * config.control.stalled_aim_weight),
    social_safety: clamp01(config.social_safety.base + positive * config.social_safety.positive_weight
      - negative * config.social_safety.negative_weight),
    coherence: clamp01(config.coherence.base + accuracy * config.coherence.accuracy_weight
      - Math.min(config.coherence.surprise_cap, surprises.length * config.coherence.surprise_weight)
      + progressingAims * config.coherence.progressing_aim_weight - stalledAims * config.coherence.stalled_aim_weight),
  };
  const result = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, blend(previous[key], value, config.responsiveness)]));
  result.updated = now.toISOString();
  result.basis = { positive_outcomes: positive, negative_outcomes: negative, recent_surprises: surprises.length, prediction_accuracy: accuracy,
    verified_active_aims: Number(aimState?.active_verified_aims || 0), progressing_aims: progressingAims, stalled_aims: stalledAims,
    goal_affect_commitment: aimState?.content_commitment || null };
  result.label = result.arousal > config.labels.strained_arousal && result.valence < config.labels.strained_valence ? 'strained and alert'
    : result.valence > config.labels.engaged_valence && result.control > config.labels.engaged_control ? 'engaged and capable'
      : result.coherence < config.labels.reflective_coherence ? 'uncertain and reflective'
        : stalledAims > 0 ? 'quietly concerned about an unfinished aim'
          : result.arousal < config.labels.quiet_arousal ? 'quietly attentive' : 'attentive and measured';
  return result;
}

function scoreWorkspace(state, context = {}, now = new Date(), parameterInput = null) {
  const params = cognitiveParameters.normalizeParams(parameterInput || cognitiveParameters.DEFAULTS);
  const config = params.workspace;
  const candidates = [];
  const query = String(context.query || '').toLowerCase();
  const terms = new Set(query.match(/[a-z0-9]{3,}/g) || []);
  const relevance = text => [...terms].filter(term => String(text || '').toLowerCase().includes(term)).length * config.relevance_per_term;
  const strongestDrive = Object.entries(state.cognition?.drives || {}).sort((a, b) => (b[1].level || 0) - (a[1].level || 0))[0];
  if (strongestDrive && strongestDrive[1].level >= config.drive.minimum_level) candidates.push({ type: 'drive', id: strongestDrive[0], score: config.drive.base + strongestDrive[1].level * config.drive.level_weight, text: `Internal need: ${strongestDrive[0].replace('_', ' ')} (${Math.round(strongestDrive[1].level * 100)}%)` });
  const aimState = context.includeGoalAffect === false ? null : state.cognition?.goal_affect?.current;
  if (goalAffect.verify(aimState)) {
    for (const aim of aimState.aims.slice(0, 4)) {
      const base = aim.status === 'stalled' ? config.goal_affect.stalled_base
        : aim.status === 'forming' ? config.goal_affect.forming_base : config.goal_affect.progressing_base;
      candidates.push({ type: 'goal_affect', id: aim.want_id, score: base + aim.salience * config.goal_affect.salience_weight + relevance(aim.want),
        text: `Self-authored aim ${aim.status}: ${aim.want}; tendency: ${aim.action_tendency.replaceAll('_', ' ')}` });
    }
  }
  for (const item of state.commitments.filter(item => item.status === 'open')) {
    const overdue = item.due && new Date(item.due).getTime() < now.getTime();
    candidates.push({ type: 'commitment', id: item.id, score: (overdue ? config.commitment.overdue_base : config.commitment.normal_base) + relevance(`${item.what} ${item.project || ''}`), text: `${item.owner} owes: ${item.what}${item.due ? ` (due ${item.due})` : ''}` });
  }
  for (const item of (state.cognition?.surprises || []).slice(-20)) candidates.push({ type: 'surprise', id: item.id, score: config.surprise.base + item.magnitude * config.surprise.magnitude_weight, text: `Expectation violation: ${item.expectation}` });
  if (context.includeEpistemicDiscrepancies !== false) {
    for (const discrepancy of (state.cognition?.epistemic_ledger?.discrepancies || []).filter(item => !item.closure).slice(-10)) {
      const proposition = (state.cognition?.epistemic_ledger?.propositions || []).find(item => item.id === discrepancy.proposition_id);
      if (!proposition) continue;
      candidates.push({ type: 'epistemic_discrepancy', id: discrepancy.id, score: config.epistemic_discrepancy.base + Number(discrepancy.severity || 0) * config.epistemic_discrepancy.severity_weight + relevance(proposition.statement), text: `Self/evidence discrepancy: ${proposition.statement}` });
    }
  }
  for (const item of state.experiments.filter(item => item.status === 'active')) candidates.push({ type: 'experiment', id: item.id, score: config.experiment.base + relevance(item.behavior), text: `Experiment: ${item.behavior}` });
  for (const item of state.relationships) {
    const direct = context.person && item.name.toLowerCase() === String(context.person).toLowerCase();
    if (direct) candidates.push({ type: 'relationship', id: item.id, score: config.relationship.base, text: `With ${item.name}: ${item.observations.filter(o => o.status === 'active').slice(-2).map(o => o.observation).join('; ')}` });
  }
  for (const item of (state.cognition?.mind_changes || []).filter(item => item.status === 'open').slice(-10)) candidates.push({ type: 'mind_change', id: item.id, score: config.mind_change.base, text: `Reconsider: ${item.prior_belief}` });
  if (context.includeDevelopment !== false) {
    for (const item of (state.cognition?.development || []).filter(item => item.status === 'integrated' && item.identity_significance >= config.development.minimum_significance).slice(-4)) candidates.push({ type: 'development', id: item.id, score: config.development.base + item.identity_significance * config.development.significance_weight + relevance(item.changed_to), text: `Developmental continuity: ${item.changed_to}` });
  }
  for (const item of (state.cognition?.recurrent_signals || []).filter(item => item.status === 'active').slice(-8)) candidates.push({ type: 'feedback', id: item.id, score: config.feedback.base + relevance(item.signal), text: `New evidence returning to attention: ${item.signal}` });
  for (const item of (context.includeCognitivePulses === false ? [] : (state.cognition?.background_inference?.pulses || [])).filter(item => {
    if (item.status !== 'accepted' || item.resolution) return false;
    try {
      const normalized = cognitivePulse.validateOutput(item.output, item.input_packet);
      return cognitivePulse.commitment(item.input_packet) === item.input_commitment && cognitivePulse.commitment(normalized) === item.output_commitment;
    } catch (_) { return false; }
  }).slice(-3)) {
    const output = item.output || {};
    candidates.push({ type: 'cognitive_pulse', id: item.id, score: config.cognitive_pulse.base + (1 - clamp01(output.uncertainty)) * config.cognitive_pulse.certainty_weight + relevance(`${output.hypothesis || ''} ${output.predicted_relevance || ''}`), text: `Background hypothesis: ${output.hypothesis || 'unavailable'}` });
  }
  for (const item of (contextAllowsProspection(context) ? (state.cognition?.prospection?.simulations || []) : []).filter(item => item.status === 'open' && constructiveProspection.contentCommitment(item) === item.content_commitment).slice(-12)) {
    const intended = item.options.find(option => option.key === item.intended_option_key);
    const dueMs = new Date(item.decision_due).getTime(); const dueSoon = Number.isFinite(dueMs) && dueMs <= now.getTime() + config.prospection.due_soon_hours * 60 * 60 * 1000;
    candidates.push({ type: 'prospection', id: item.id, score: (dueSoon ? config.prospection.due_soon_base : config.prospection.normal_base) + relevance(`${item.scenario} ${intended?.action || ''} ${intended?.predicted_outcome || ''}`), text: `Constructed future: ${item.scenario}; current plan: ${intended?.action || item.intended_option_key} (${Math.round((intended?.probability || 0) * 100)}% predicted outcome)` });
  }
  let currentSelfFrame = null;
  if (context.includeIntegratedSelf !== false) {
    const frames = state.cognition?.integrated_self?.frames || [];
    for (let index = frames.length - 1; index >= 0; index--) {
      if (integratedSelf.verifyFrame(frames[index], state).complete_chain_verified) {
        currentSelfFrame = frames[index];
        break;
      }
    }
  }
  if (currentSelfFrame) {
    const drive = currentSelfFrame.motivation?.dominant_drive;
    const selfRelevance = /\b(?:self|you|your|feel|state|capacity|attention|intend|why|control|coher)/i.test(query) ? config.self_frame.self_query_boost : 0;
    candidates.push({
      type: 'self_frame', id: currentSelfFrame.id,
      score: config.self_frame.base + selfRelevance + (1 - (currentSelfFrame.integration?.completeness || 0)) * config.self_frame.incompleteness_weight,
      text: `Integrated current self-state: ${currentSelfFrame.integration?.available_domains?.length || 0}/6 domains bound; ${drive ? `dominant need ${drive.name}` : 'motivation unresolved'}; ${currentSelfFrame.appraisal?.label || 'appraisal unavailable'}`,
    });
  }
  const baselineCandidates = candidates.map(item => ({ ...item })).sort((a, b) => b.score - a.score || `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const capacity = Math.floor(Math.max(0, Math.min(config.capacity,
    Number.isFinite(Number(context.capacity)) ? Number(context.capacity) : config.capacity)));
  const directiveMode = context.attentionDirectiveMode || (context.includeAttentionDirectives === false ? 'no_boost' : 'targeted_boost');
  const configuredDirectives = (Array.isArray(context.attentionDirectivesOverride)
    ? context.attentionDirectivesOverride
    : (state.cognition?.attention_schema?.directives || []).filter(item => item.status === 'active' && (!item.expires || new Date(item.expires) >= now)));
  const candidateTargets = candidates.map(item => ({ type: item.type, id: item.id })).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const activeDirectives = directiveMode === 'no_boost' ? [] : configuredDirectives.map(item => {
    if (directiveMode !== 'sham_boost') return { ...item, effective_target: item.target };
    const alternatives = candidateTargets.filter(target => target.type !== item.target?.type || String(target.id) !== String(item.target?.id));
    if (!alternatives.length) return { ...item, effective_target: null };
    const digest = crypto.createHash('sha256').update(`${context.attentionShamSeed || 'sham'}:${item.id}`).digest();
    return { ...item, effective_target: alternatives[digest.readUInt32LE(0) % alternatives.length] };
  }).filter(item => item.effective_target);
  for (const candidate of candidates) {
    const matching = activeDirectives.filter(item => item.effective_target?.type === candidate.type && String(item.effective_target?.id) === String(candidate.id));
    candidate.score += matching.reduce((sum, item) => sum + Math.max(0, Math.min(config.attention.max_directive_boost, Number(item.boost) || 0)), 0);
  }
  const ranked = candidates.sort((a, b) => b.score - a.score);
  const selectedWithScores = ranked.slice(0, capacity);
  const selectedKeys = new Set(selectedWithScores.map(item => `${item.type}:${item.id}`));
  const candidateKeys = new Set(ranked.map(item => `${item.type}:${item.id}`));
  const selected = selectedWithScores.map(({ score, ...item }) => item);
  const modulation = activeDirectives.map(item => {
    const key = `${item.effective_target.type}:${item.effective_target.id}`;
    return { directive_id: item.id, mode: directiveMode, configured_target: item.target, target: item.effective_target, eligible: candidateKeys.has(key), entered: selectedKeys.has(key), boost: item.boost };
  });
  return { at: now.toISOString(), capacity, slots: selected, suppressed_count: Math.max(0, candidates.length - selected.length), modulation,
    ...(context.includeCandidateManifest ? { candidate_manifest: baselineCandidates } : {}) };
}

function calibration(predictions = []) {
  const resolved = predictions.filter(item => item.outcome === 'right' || item.outcome === 'wrong');
  const scored = resolved.map(item => {
    const p = clamp01(item.confidence);
    const actual = item.outcome === 'right' ? 1 : 0;
    return { ...item, brier: (p - actual) ** 2 };
  });
  return {
    resolved: scored.length,
    accuracy: scored.length ? scored.filter(item => item.outcome === 'right').length / scored.length : null,
    brier: scored.length ? scored.reduce((sum, item) => sum + item.brier, 0) / scored.length : null,
    overconfident_errors: scored.filter(item => item.outcome === 'wrong' && item.confidence >= 0.7).length,
  };
}

module.exports = { clamp01, computeAppraisal, computeDrives, scoreWorkspace, calibration };
