'use strict';

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
  const targets = {
    uncertainty: clamp01((unresolved.length + Number(input.disputed_memories || 0) * 2) / 12),
    unfinished: clamp01((overdue.length * 2 + loops.length + open.length * 0.35) / 10),
    social_debt: clamp01((negative + Number(input.unanswered_people || 0)) / 8),
    overload: clamp01((open.length + loops.length + (staleCycle ? 5 : 0) + Number(input.soma?.stress || 0) * 5) / 18),
    curiosity: clamp01((unresolved.length + (2 - Math.min(2, activeExperiments)) * 2 + (input.wants?.length || 0)) / 12),
    continuity: clamp01((loops.length + state.episodes.filter(item => item.status === 'open').length + (staleCycle ? 3 : 0)) / 12),
  };
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, {
    level: blend(previous[name]?.level, target), target, updated: now.toISOString(),
  }]));
}

function computeAppraisal(state, drives, input = {}, now = new Date()) {
  const previous = state.cognition?.appraisal || {};
  const traces = state.traces.slice(-40);
  const positive = traces.filter(item => ['positive', 'helpful', 'accepted', 'fulfilled'].includes(item.outcome)).length;
  const negative = traces.filter(item => ['negative', 'corrected', 'ignored', 'interrupted'].includes(item.outcome)).length;
  const surprises = (state.cognition?.surprises || []).filter(item => ageDays(item.at, now) < 7);
  const resolved = (input.predictions || []).filter(item => item.outcome === 'right' || item.outcome === 'wrong');
  const accuracy = resolved.length ? resolved.filter(item => item.outcome === 'right').length / resolved.length : 0.6;
  const raw = {
    valence: clamp01(0.5 + (positive - negative) / Math.max(8, traces.length)),
    arousal: clamp01(0.2 + drives.unfinished.level * 0.35 + drives.overload.level * 0.25 + Math.min(0.3, surprises.length * 0.08)),
    control: clamp01(0.85 - drives.overload.level * 0.45 - drives.uncertainty.level * 0.2),
    social_safety: clamp01(0.75 + positive * 0.025 - negative * 0.07),
    coherence: clamp01(0.35 + accuracy * 0.55 - Math.min(0.25, surprises.length * 0.04)),
  };
  const result = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, blend(previous[key], value, 0.3)]));
  result.updated = now.toISOString();
  result.basis = { positive_outcomes: positive, negative_outcomes: negative, recent_surprises: surprises.length, prediction_accuracy: accuracy };
  result.label = result.arousal > 0.68 && result.valence < 0.45 ? 'strained and alert'
    : result.valence > 0.62 && result.control > 0.55 ? 'engaged and capable'
      : result.coherence < 0.45 ? 'uncertain and reflective'
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
  for (const item of state.commitments.filter(item => item.status === 'open')) {
    const overdue = item.due && new Date(item.due).getTime() < now.getTime();
    candidates.push({ type: 'commitment', id: item.id, score: (overdue ? 12 : 5) + relevance(`${item.what} ${item.project || ''}`), text: `${item.owner} owes: ${item.what}${item.due ? ` (due ${item.due})` : ''}` });
  }
  for (const item of (state.cognition?.surprises || []).slice(-20)) candidates.push({ type: 'surprise', id: item.id, score: 9 + item.magnitude * 5, text: `Expectation violation: ${item.expectation}` });
  for (const item of state.experiments.filter(item => item.status === 'active')) candidates.push({ type: 'experiment', id: item.id, score: 4 + relevance(item.behavior), text: `Experiment: ${item.behavior}` });
  for (const item of state.relationships) {
    const direct = context.person && item.name.toLowerCase() === String(context.person).toLowerCase();
    if (direct) candidates.push({ type: 'relationship', id: item.id, score: 11, text: `With ${item.name}: ${item.observations.filter(o => o.status === 'active').slice(-2).map(o => o.observation).join('; ')}` });
    for (const p of (item.perspectives || []).filter(p => p.status === 'active' && (!p.valid_until || new Date(p.valid_until) >= now))) {
      if (direct) candidates.push({ type: 'perspective', id: p.id, score: 10 * p.confidence, text: `Hypothesis about ${item.name}: ${p.hypothesis} (${Math.round(p.confidence * 100)}% confidence)` });
    }
  }
  for (const item of (state.cognition?.mind_changes || []).filter(item => item.status === 'open').slice(-10)) candidates.push({ type: 'mind_change', id: item.id, score: 8, text: `Reconsider: ${item.prior_belief}` });
  for (const item of (state.cognition?.development || []).filter(item => item.status === 'integrated' && item.identity_significance >= 0.65).slice(-4)) candidates.push({ type: 'development', id: item.id, score: 5 + item.identity_significance * 3 + relevance(item.changed_to), text: `Developmental continuity: ${item.changed_to}` });
  const selected = candidates.sort((a, b) => b.score - a.score).slice(0, 7).map(({ score, ...item }) => item);
  return { at: now.toISOString(), capacity: 7, slots: selected, suppressed_count: Math.max(0, candidates.length - selected.length) };
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
