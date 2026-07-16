'use strict';

const crypto = require('crypto');
const constructiveProspection = require('./constructive-prospection');
const integratedSelf = require('./integrated-self');
const cognitivePulse = require('./cognitive-pulse');
const goalAffect = require('./goal-affect');

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

function computeDrives(state, input = {}, now = new Date()) {
  const previous = state.cognition?.drives || {};
  const open = state.commitments.filter(item => item.status === 'open');
  const overdue = open.filter(item => item.due && new Date(item.due).getTime() < now.getTime());
  const loops = state.episodes.flatMap(item => item.open_loops || []).filter(item => item.status === 'open');
  const unresolved = (input.predictions || []).filter(item => !item.outcome);
  const negative = state.traces.slice(-40).filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const staleCycle = state.cycles.some(item => item.status === 'running' && ageDays(item.started, now) > 0.15);
  const activeExperiments = state.experiments.filter(item => item.status === 'active').length;
  const openProspections = contextAllowsProspection(input)
    ? (state.cognition?.prospection?.simulations || []).filter(item => item.status === 'open' && constructiveProspection.contentCommitment(item) === item.content_commitment) : [];
  const aimState = goalAffect.verify(input.goal_affect) ? input.goal_affect : null;
  const stalledAims = Number(aimState?.stalled_aims || 0);
  const formingAims = Number(aimState?.forming_aims || 0);
  const targets = {
    uncertainty: clamp01((unresolved.length + openProspections.length * 0.35 + Number(input.disputed_memories || 0) * 2) / 12),
    unfinished: clamp01((overdue.length * 2 + loops.length + open.length * 0.35 + stalledAims * 0.75) / 10),
    social_debt: clamp01((negative + Number(input.unanswered_people || 0)) / 8),
    overload: clamp01((open.length + loops.length + (staleCycle ? 5 : 0) + Number(input.soma?.stress || 0) * 5) / 18),
    curiosity: clamp01((unresolved.length + openProspections.length * 0.25 + (2 - Math.min(2, activeExperiments)) * 2 + (aimState?.active_verified_aims || 0) + formingAims * 0.5) / 12),
    continuity: clamp01((loops.length + state.episodes.filter(item => item.status === 'open').length + (staleCycle ? 3 : 0)) / 12),
  };
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, {
    level: blend(previous[name]?.level, target), target, updated: now.toISOString(),
  }]));
}

function contextAllowsProspection(context = {}) {
  return context.includeConstructiveProspection !== false;
}

function computeAppraisal(state, drives, input = {}, now = new Date()) {
  const previous = state.cognition?.appraisal || {};
  const traces = state.traces.slice(-40);
  const positive = traces.filter(item => ['positive', 'helpful', 'accepted', 'fulfilled'].includes(item.outcome)).length;
  const negative = traces.filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const surprises = (state.cognition?.surprises || []).filter(item => ageDays(item.at, now) < 7);
  const resolved = (input.predictions || []).filter(item => item.outcome === 'right' || item.outcome === 'wrong');
  const accuracy = resolved.length ? resolved.filter(item => item.outcome === 'right').length / resolved.length : 0.6;
  const aimState = goalAffect.verify(input.goal_affect) ? input.goal_affect : null;
  const progressingAims = Number(aimState?.progressing_aims || 0);
  const stalledAims = Number(aimState?.stalled_aims || 0);
  const raw = {
    valence: clamp01(0.5 + (positive - negative) / Math.max(8, traces.length) + progressingAims * 0.04 - stalledAims * 0.04),
    arousal: clamp01(0.2 + drives.unfinished.level * 0.35 + drives.overload.level * 0.25 + Math.min(0.3, surprises.length * 0.08)),
    control: clamp01(0.85 - drives.overload.level * 0.45 - drives.uncertainty.level * 0.2 + progressingAims * 0.03 - stalledAims * 0.04),
    social_safety: clamp01(0.75 + positive * 0.025 - negative * 0.07),
    coherence: clamp01(0.35 + accuracy * 0.55 - Math.min(0.25, surprises.length * 0.04) + progressingAims * 0.025 - stalledAims * 0.02),
  };
  const result = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, blend(previous[key], value, 0.3)]));
  result.updated = now.toISOString();
  result.basis = { positive_outcomes: positive, negative_outcomes: negative, recent_surprises: surprises.length, prediction_accuracy: accuracy,
    verified_active_aims: Number(aimState?.active_verified_aims || 0), progressing_aims: progressingAims, stalled_aims: stalledAims,
    goal_affect_commitment: aimState?.content_commitment || null };
  result.label = result.arousal > 0.68 && result.valence < 0.45 ? 'strained and alert'
    : result.valence > 0.62 && result.control > 0.55 ? 'engaged and capable'
      : result.coherence < 0.45 ? 'uncertain and reflective'
        : stalledAims > 0 ? 'quietly concerned about an unfinished aim'
          : result.arousal < 0.32 ? 'quietly attentive' : 'attentive and measured';
  return result;
}

function scoreWorkspace(state, context = {}, now = new Date()) {
  const candidates = [];
  const query = String(context.query || '').toLowerCase();
  const terms = new Set(query.match(/[a-z0-9]{3,}/g) || []);
  const relevance = text => [...terms].filter(term => String(text || '').toLowerCase().includes(term)).length * 2;
  const strongestDrive = Object.entries(state.cognition?.drives || {}).sort((a, b) => (b[1].level || 0) - (a[1].level || 0))[0];
  if (strongestDrive && strongestDrive[1].level >= 0.35) candidates.push({ type: 'drive', id: strongestDrive[0], score: 6 + strongestDrive[1].level * 4, text: `Internal need: ${strongestDrive[0].replace('_', ' ')} (${Math.round(strongestDrive[1].level * 100)}%)` });
  const aimState = context.includeGoalAffect === false ? null : state.cognition?.goal_affect?.current;
  if (goalAffect.verify(aimState)) {
    for (const aim of aimState.aims.slice(0, 4)) {
      const base = aim.status === 'stalled' ? 6.4 : aim.status === 'forming' ? 4.2 : 3.8;
      candidates.push({ type: 'goal_affect', id: aim.want_id, score: base + aim.salience * 2.5 + relevance(aim.want),
        text: `Self-authored aim ${aim.status}: ${aim.want}; tendency: ${aim.action_tendency.replaceAll('_', ' ')}` });
    }
  }
  for (const item of state.commitments.filter(item => item.status === 'open')) {
    const overdue = item.due && new Date(item.due).getTime() < now.getTime();
    candidates.push({ type: 'commitment', id: item.id, score: (overdue ? 12 : 5) + relevance(`${item.what} ${item.project || ''}`), text: `${item.owner} owes: ${item.what}${item.due ? ` (due ${item.due})` : ''}` });
  }
  for (const item of (state.cognition?.surprises || []).slice(-20)) candidates.push({ type: 'surprise', id: item.id, score: 9 + item.magnitude * 5, text: `Expectation violation: ${item.expectation}` });
  if (context.includeEpistemicDiscrepancies !== false) {
    for (const discrepancy of (state.cognition?.epistemic_ledger?.discrepancies || []).filter(item => !item.closure).slice(-10)) {
      const proposition = (state.cognition?.epistemic_ledger?.propositions || []).find(item => item.id === discrepancy.proposition_id);
      if (!proposition) continue;
      candidates.push({ type: 'epistemic_discrepancy', id: discrepancy.id, score: 9 + Number(discrepancy.severity || 0) * 4 + relevance(proposition.statement), text: `Self/evidence discrepancy: ${proposition.statement}` });
    }
  }
  for (const item of state.experiments.filter(item => item.status === 'active')) candidates.push({ type: 'experiment', id: item.id, score: 4 + relevance(item.behavior), text: `Experiment: ${item.behavior}` });
  for (const item of state.relationships) {
    const direct = context.person && item.name.toLowerCase() === String(context.person).toLowerCase();
    if (direct) candidates.push({ type: 'relationship', id: item.id, score: 11, text: `With ${item.name}: ${item.observations.filter(o => o.status === 'active').slice(-2).map(o => o.observation).join('; ')}` });
  }
  for (const item of (state.cognition?.mind_changes || []).filter(item => item.status === 'open').slice(-10)) candidates.push({ type: 'mind_change', id: item.id, score: 8, text: `Reconsider: ${item.prior_belief}` });
  if (context.includeDevelopment !== false) {
    for (const item of (state.cognition?.development || []).filter(item => item.status === 'integrated' && item.identity_significance >= 0.65).slice(-4)) candidates.push({ type: 'development', id: item.id, score: 5 + item.identity_significance * 3 + relevance(item.changed_to), text: `Developmental continuity: ${item.changed_to}` });
  }
  for (const item of (state.cognition?.recurrent_signals || []).filter(item => item.status === 'active').slice(-8)) candidates.push({ type: 'feedback', id: item.id, score: 13 + relevance(item.signal), text: `New evidence returning to attention: ${item.signal}` });
  for (const item of (context.includeCognitivePulses === false ? [] : (state.cognition?.background_inference?.pulses || [])).filter(item => {
    if (item.status !== 'accepted' || item.resolution) return false;
    try {
      const normalized = cognitivePulse.validateOutput(item.output, item.input_packet);
      return cognitivePulse.commitment(item.input_packet) === item.input_commitment && cognitivePulse.commitment(normalized) === item.output_commitment;
    } catch (_) { return false; }
  }).slice(-3)) {
    const output = item.output || {};
    candidates.push({ type: 'cognitive_pulse', id: item.id, score: 4.5 + (1 - clamp01(output.uncertainty)) * 2 + relevance(`${output.hypothesis || ''} ${output.predicted_relevance || ''}`), text: `Background hypothesis: ${output.hypothesis || 'unavailable'}` });
  }
  for (const item of (contextAllowsProspection(context) ? (state.cognition?.prospection?.simulations || []) : []).filter(item => item.status === 'open' && constructiveProspection.contentCommitment(item) === item.content_commitment).slice(-12)) {
    const intended = item.options.find(option => option.key === item.intended_option_key);
    const dueMs = new Date(item.decision_due).getTime(); const dueSoon = Number.isFinite(dueMs) && dueMs <= now.getTime() + 48 * 60 * 60 * 1000;
    candidates.push({ type: 'prospection', id: item.id, score: (dueSoon ? 10 : 5) + relevance(`${item.scenario} ${intended?.action || ''} ${intended?.predicted_outcome || ''}`), text: `Constructed future: ${item.scenario}; current plan: ${intended?.action || item.intended_option_key} (${Math.round((intended?.probability || 0) * 100)}% predicted outcome)` });
  }
  const currentSelfFrame = context.includeIntegratedSelf === false ? null : (state.cognition?.integrated_self?.frames || []).filter(item => integratedSelf.verifyFrame(item, state).complete_chain_verified).at(-1);
  if (currentSelfFrame) {
    const drive = currentSelfFrame.motivation?.dominant_drive;
    const selfRelevance = /\b(?:self|you|your|feel|state|capacity|attention|intend|why|control|coher)/i.test(query) ? 5 : 0;
    candidates.push({
      type: 'self_frame', id: currentSelfFrame.id,
      score: 5.5 + selfRelevance + (1 - (currentSelfFrame.integration?.completeness || 0)) * 2,
      text: `Integrated current self-state: ${currentSelfFrame.integration?.available_domains?.length || 0}/6 domains bound; ${drive ? `dominant need ${drive.name}` : 'motivation unresolved'}; ${currentSelfFrame.appraisal?.label || 'appraisal unavailable'}`,
    });
  }
  const baselineCandidates = candidates.map(item => ({ ...item })).sort((a, b) => b.score - a.score || `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const capacity = Math.floor(Math.max(0, Math.min(7, Number.isFinite(Number(context.capacity)) ? Number(context.capacity) : 7)));
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
    candidate.score += matching.reduce((sum, item) => sum + Math.max(0, Math.min(5, Number(item.boost) || 0)), 0);
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
