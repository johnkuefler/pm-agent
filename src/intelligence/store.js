'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeCommitment } = require('./models');
const { clamp01, computeAppraisal, computeDrives, scoreWorkspace, calibration } = require('./cognition');

function emptyState() {
  return {
    version: 2,
    commitments: [],
    episodes: [],
    relationships: [],
    traces: [],
    experiments: [],
    cycles: [],
    initiative: { default_daily: 3, scopes: {} },
    cognition: {
      workspace: { at: null, capacity: 7, slots: [], suppressed_count: 0 },
      drives: {}, appraisal: {}, surprises: [], mind_changes: [], development: [], counterfactuals: [],
    },
  };
}

function createIntelligenceStore({ filePath, db, isDbReady, clock = () => new Date() }) {
  let state = emptyState();
  let writeQueue = Promise.resolve();

  function hydrate(value) {
    state = { ...emptyState(), ...(value && typeof value === 'object' ? value : {}) };
    for (const key of ['commitments', 'episodes', 'relationships', 'traces', 'experiments', 'cycles']) {
      if (!Array.isArray(state[key])) state[key] = [];
    }
    if (!state.initiative || typeof state.initiative !== 'object') state.initiative = emptyState().initiative;
    if (!state.initiative.scopes) state.initiative.scopes = {};
    state.cognition = { ...emptyState().cognition, ...(state.cognition || {}) };
    for (const key of ['surprises', 'mind_changes', 'development', 'counterfactuals']) {
      if (!Array.isArray(state.cognition[key])) state.cognition[key] = [];
    }
    for (const episode of state.episodes) {
      if (!Array.isArray(episode.participants)) episode.participants = [];
      if (!Array.isArray(episode.events)) episode.events = [];
      if (!Array.isArray(episode.decisions)) episode.decisions = [];
      if (!Array.isArray(episode.open_loops)) episode.open_loops = [];
      if (!Array.isArray(episode.commitment_ids)) episode.commitment_ids = [];
      if (!episode.status) episode.status = 'open';
    }
    for (const experiment of state.experiments) {
      if (!Array.isArray(experiment.samples)) experiment.samples = [];
      if (!experiment.minimum_samples) experiment.minimum_samples = 5;
      if (experiment.target == null && (!experiment.metric || experiment.metric === 'positive_rate')) experiment.target = 0.65;
    }
    for (const relationship of state.relationships) if (!Array.isArray(relationship.perspectives)) relationship.perspectives = [];
  }

  async function init() {
    if (isDbReady()) {
      const remote = await db.getState('intelligence_v1');
      if (remote) hydrate(remote);
      else await db.setState('intelligence_v1', state);
      return state;
    }
    try { hydrate(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { hydrate(emptyState()); }
    return state;
  }

  function persist() {
    const snapshot = JSON.parse(JSON.stringify(state));
    writeQueue = writeQueue.then(async () => {
      if (isDbReady()) return db.setState('intelligence_v1', snapshot);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(temp, filePath);
    }).catch(error => console.error('intelligence persistence failed:', error.message));
    return writeQueue;
  }

  function mutate(fn) {
    const result = fn(state);
    persist();
    return result;
  }

  function list(kind, predicate = () => true) { return (state[kind] || []).filter(predicate).map(item => ({ ...item })); }
  function get(kind, id) { return (state[kind] || []).find(item => item.id === id) || null; }

  function addCommitment(input) {
    return mutate(current => {
      const commitment = normalizeCommitment(input, clock());
      if (!commitment.what) throw new Error('what is required');
      const normalizedWhat = commitment.what.toLowerCase().replace(/\s+/g, ' ').trim();
      const duplicate = current.commitments.find(item => item.status === 'open' && (
        (item.task_id && item.task_id === commitment.task_id)
        || (commitment.episode_id && item.episode_id === commitment.episode_id
          && item.owner.toLowerCase() === commitment.owner.toLowerCase()
          && item.what.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedWhat)
        || (commitment.evidence?.channel && commitment.evidence?.id && item.evidence?.channel === commitment.evidence.channel
          && item.evidence?.id === commitment.evidence.id && item.what.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedWhat)
      ));
      if (duplicate) return duplicate;
      current.commitments.push(commitment);
      current.commitments = current.commitments.slice(-500);
      return commitment;
    });
  }

  function updateCommitment(id, changes) {
    return mutate(current => {
      const index = current.commitments.findIndex(item => item.id === id);
      if (index === -1) return null;
      const previous = current.commitments[index];
      const nextChanges = { ...changes };
      if (nextChanges.status === 'fulfilled' && previous.status !== 'fulfilled' && !nextChanges.fulfilled_at) nextChanges.fulfilled_at = clock().toISOString();
      current.commitments[index] = normalizeCommitment({ ...previous, ...nextChanges, id, updated: clock().toISOString() }, clock());
      const updated = current.commitments[index];
      if (updated.episode_id && updated.status !== 'open') {
        const episode = current.episodes.find(item => item.id === updated.episode_id);
        if (episode) {
          const hasOpenCommitment = current.commitments.some(item => item.episode_id === episode.id && item.status === 'open');
          const hasOpenLoop = (episode.open_loops || []).some(loop => loop.status === 'open');
          if (!hasOpenCommitment && !hasOpenLoop) episode.status = 'closed';
          episode.updated = clock().toISOString();
        }
      }
      return updated;
    });
  }

  function recordEpisodeEvent(input = {}) {
    return mutate(current => {
      const correlation = input.correlation || input.episode_id || null;
      let episode = correlation && current.episodes.find(item => item.correlation === correlation || item.id === correlation);
      if (!episode) {
        episode = {
          id: input.episode_id || `episode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          correlation,
          title: input.title || 'Conversation',
          participants: [...new Set((input.participants || []).filter(Boolean))],
          project: input.project || null,
          status: 'open',
          started: input.at || clock().toISOString(),
          updated: input.at || clock().toISOString(),
          events: [],
          summary: input.summary || '',
          decisions: [],
          open_loops: [],
          commitment_ids: [],
        };
        current.episodes.push(episode);
      }
      episode.updated = input.at || clock().toISOString();
      episode.participants = [...new Set([...episode.participants, ...(input.participants || []).filter(Boolean)])];
      if (input.project) episode.project = input.project;
      if (input.title && episode.title === 'Conversation') episode.title = input.title;
      if (input.summary) episode.summary = String(input.summary).slice(0, 2000);
      if (input.status) episode.status = input.status;
      if (Array.isArray(input.decisions)) episode.decisions = [...new Set([...(episode.decisions || []), ...input.decisions.map(String)])].slice(-30);
      if (Array.isArray(input.commitment_ids)) episode.commitment_ids = [...new Set([...(episode.commitment_ids || []), ...input.commitment_ids])].slice(-50);
      if (input.open_loop?.what) {
        const loop = {
          id: input.open_loop.id || `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          what: String(input.open_loop.what).slice(0, 1000), owner: input.open_loop.owner || null,
          due: input.open_loop.due || null, status: input.open_loop.status || 'open',
          created: input.open_loop.created || clock().toISOString(), resolved_at: null,
        };
        const duplicateLoop = (episode.open_loops || []).find(item => item.status === 'open' && item.what.toLowerCase() === loop.what.toLowerCase());
        if (!duplicateLoop) episode.open_loops.push(loop);
      }
      if (input.resolve_open_loop) {
        const loop = (episode.open_loops || []).find(item => item.id === input.resolve_open_loop);
        if (loop) { loop.status = 'resolved'; loop.resolved_at = clock().toISOString(); }
      }
      if (input.record_event !== false) {
        const event = {
          id: input.event_id || `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          at: input.at || clock().toISOString(),
          channel: input.channel || 'unknown',
          kind: input.kind || 'message',
          actor: input.actor || null,
          text: input.text ? String(input.text).slice(0, 2000) : '',
          source_ref: input.source_ref || null,
        };
        const duplicateEvent = episode.events.some(item =>
          (input.event_id && item.id === input.event_id)
          || (item.at === event.at && item.kind === event.kind && item.actor === event.actor && item.text === event.text
            && (item.source_ref?.id || null) === (event.source_ref?.id || null)));
        if (!duplicateEvent) episode.events.push(event);
      }
      episode.events = episode.events.slice(-100);
      current.episodes = current.episodes.sort((a, b) => a.updated.localeCompare(b.updated)).slice(-300);
      return episode;
    });
  }

  function observeRelationship(input = {}) {
    return mutate(current => {
      const name = String(input.name || '').trim();
      const observation = String(input.observation || '').trim();
      if (!name) throw new Error('name is required');
      if (!observation) throw new Error('observation is required');
      let relationship = current.relationships.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (!relationship) {
        relationship = { id: `person-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, observations: [], updated: clock().toISOString() };
        current.relationships.push(relationship);
      }
      relationship.updated = clock().toISOString();
      relationship.observations.push({
        id: `observation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        dimension: input.dimension || 'general',
        observation: observation.slice(0, 600),
        confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.7))),
        evidence: input.evidence || null,
        observed_at: input.observed_at || clock().toISOString(),
        status: input.status || 'active',
      });
      relationship.observations = relationship.observations.slice(-60);
      return relationship;
    });
  }

  function observePerspective(input = {}) {
    return mutate(current => {
      const name = String(input.name || '').trim();
      const hypothesis = String(input.hypothesis || input.belief || '').trim();
      if (!name || !hypothesis) throw new Error('name and hypothesis are required');
      if (!Array.isArray(input.evidence) || !input.evidence.length) throw new Error('perspective hypotheses require evidence');
      let relationship = current.relationships.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (!relationship) {
        relationship = { id: `person-${Date.now().toString(36)}`, name, observations: [], perspectives: [], updated: clock().toISOString() };
        current.relationships.push(relationship);
      }
      if (!Array.isArray(relationship.perspectives)) relationship.perspectives = [];
      const perspective = {
        id: input.id || `perspective-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        hypothesis: hypothesis.slice(0, 800), dimension: input.dimension || 'current_state',
        confidence: clamp01(input.confidence ?? 0.5), evidence: input.evidence.slice(0, 12),
        valid_until: input.valid_until || new Date(clock().getTime() + 30 * 86400000).toISOString(),
        status: input.status || 'active', created: input.created || clock().toISOString(), updated: clock().toISOString(),
      };
      relationship.perspectives.push(perspective);
      relationship.perspectives = relationship.perspectives.slice(-40);
      relationship.updated = clock().toISOString();
      return perspective;
    });
  }

  function updatePerspective(id, input = {}) {
    return mutate(current => {
      for (const relationship of current.relationships) {
        const perspective = (relationship.perspectives || []).find(item => item.id === id);
        if (!perspective) continue;
        if (input.confidence != null) perspective.confidence = clamp01(input.confidence);
        if (input.status) perspective.status = ['active', 'supported', 'revised', 'retired'].includes(input.status) ? input.status : perspective.status;
        if (input.hypothesis) perspective.hypothesis = String(input.hypothesis).slice(0, 800);
        if (input.evidence) perspective.evidence = [...(perspective.evidence || []), ...input.evidence].slice(-12);
        perspective.updated = clock().toISOString();
        relationship.updated = perspective.updated;
        return perspective;
      }
      return null;
    });
  }

  function refreshCognition(input = {}) {
    return mutate(current => {
      const now = input.now ? new Date(input.now) : clock();
      current.cognition.drives = computeDrives(current, input, now);
      current.cognition.appraisal = computeAppraisal(current, current.cognition.drives, input, now);
      current.cognition.workspace = scoreWorkspace(current, input, now);
      return JSON.parse(JSON.stringify(current.cognition));
    });
  }

  function recordPredictionResolution(input = {}) {
    return mutate(current => {
      const confidence = clamp01(input.confidence ?? 0.5);
      if (input.outcome !== 'right' && input.outcome !== 'wrong') return { surprise: null, mind_change: null, brier: null };
      const wrong = input.outcome === 'wrong';
      const magnitude = wrong ? confidence : 1 - confidence;
      let surprise = null;
      if (magnitude >= 0.55) {
        surprise = { id: `surprise-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          prediction_id: input.id || null, expectation: String(input.prediction || input.expectation || '').slice(0, 1000),
          outcome: input.outcome, magnitude, evidence: input.evidence || input.notes || null, at: clock().toISOString(), status: 'unreviewed' };
        current.cognition.surprises.push(surprise);
        current.cognition.surprises = current.cognition.surprises.slice(-300);
      }
      let mindChange = null;
      if (wrong && confidence >= 0.7) {
        mindChange = { id: `mind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          prior_belief: String(input.prediction || '').slice(0, 1000), prior_confidence: confidence,
          new_belief: null, new_confidence: null, reason: 'High-confidence prediction was wrong',
          evidence: input.evidence || input.notes || null, status: 'open', created: clock().toISOString(), resolved: null };
        current.cognition.mind_changes.push(mindChange);
        current.cognition.mind_changes = current.cognition.mind_changes.slice(-300);
      }
      return { surprise, mind_change: mindChange, brier: (confidence - (wrong ? 0 : 1)) ** 2 };
    });
  }

  function recordMindChange(input = {}) {
    return mutate(current => {
      if (!input.prior_belief || !input.new_belief || !input.evidence) throw new Error('prior_belief, new_belief, and evidence are required');
      const item = { id: input.id || `mind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        prior_belief: String(input.prior_belief).slice(0, 1000), prior_confidence: clamp01(input.prior_confidence),
        new_belief: String(input.new_belief).slice(0, 1000), new_confidence: clamp01(input.new_confidence),
        reason: String(input.reason || '').slice(0, 1000), evidence: input.evidence, status: 'resolved',
        created: input.created || clock().toISOString(), resolved: clock().toISOString() };
      current.cognition.mind_changes.push(item); current.cognition.mind_changes = current.cognition.mind_changes.slice(-300); return item;
    });
  }

  function recordDevelopment(input = {}) {
    return mutate(current => {
      if (!input.event || !input.changed_to || !input.evidence) throw new Error('event, changed_to, and evidence are required');
      const item = { id: input.id || `development-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        event: String(input.event).slice(0, 1000), believed_before: input.believed_before ? String(input.believed_before).slice(0, 1000) : null,
        changed_to: String(input.changed_to).slice(0, 1000), why: String(input.why || '').slice(0, 1000), evidence: input.evidence,
        identity_significance: clamp01(input.identity_significance ?? 0.5), status: input.status || 'candidate', at: input.at || clock().toISOString() };
      current.cognition.development.push(item); current.cognition.development = current.cognition.development.slice(-200); return item;
    });
  }

  function recordCounterfactual(input = {}) {
    return mutate(current => {
      if (!input.actual || !input.alternative || !input.evidence_basis) throw new Error('actual, alternative, and evidence_basis are required');
      const item = { id: input.id || `counterfactual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        decision_trace_id: input.decision_trace_id || null, actual: String(input.actual).slice(0, 1200),
        alternative: String(input.alternative).slice(0, 1200), predicted_difference: String(input.predicted_difference || '').slice(0, 1200),
        confidence: clamp01(input.confidence ?? 0.4), evidence_basis: input.evidence_basis, status: 'simulated',
        experiment_id: input.experiment_id || null, created: clock().toISOString() };
      current.cognition.counterfactuals.push(item); current.cognition.counterfactuals = current.cognition.counterfactuals.slice(-300); return item;
    });
  }

  function cognitionSnapshot(predictions = []) {
    return { ...JSON.parse(JSON.stringify(state.cognition)), calibration: calibration(predictions) };
  }

  function affectContext() { return { ...(state.cognition.appraisal || {}) }; }

  function recordTrace(input = {}) {
    return mutate(current => {
      const trace = {
        id: input.id || `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: input.at || clock().toISOString(),
        channel: input.channel || null,
        action: input.action || 'respond',
        decision: input.decision || null,
        confidence: input.confidence ?? null,
        reasons: Array.isArray(input.reasons) ? input.reasons : [],
        memory_ids: Array.isArray(input.memory_ids) ? input.memory_ids : [],
        source_refs: Array.isArray(input.source_refs) ? input.source_refs : [],
        charter_rule: input.charter_rule || null,
        episode_id: input.episode_id || null,
        interaction_id: input.interaction_id || null,
        preview: input.preview ? String(input.preview).slice(0, 500) : '',
        outcome: input.outcome || null,
        signal: input.signal || null,
        reviewed_at: input.reviewed_at || null,
      };
      current.traces.push(trace);
      current.traces = current.traces.slice(-1000);
      return trace;
    });
  }

  function updateTraceOutcome(id, input = {}) {
    return mutate(current => {
      const trace = current.traces.find(item => item.id === id || (input.interaction_id && item.interaction_id === input.interaction_id));
      if (!trace) return null;
      trace.outcome = input.outcome || trace.outcome;
      trace.signal = input.signal ? String(input.signal).slice(0, 1000) : trace.signal;
      trace.reviewed_at = input.reviewed_at || clock().toISOString();
      return trace;
    });
  }

  function createExperiment(input = {}) {
    return mutate(current => {
      const experiment = {
        id: input.id || `experiment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        behavior: String(input.behavior || '').trim(),
        hypothesis: String(input.hypothesis || '').trim(),
        metric: input.metric || 'positive_rate',
        baseline: input.baseline ?? null,
        target: input.target ?? (input.metric === 'positive_rate' || !input.metric ? 0.65 : null),
        minimum_samples: Math.max(1, Number(input.minimum_samples) || 5),
        started: input.started || clock().toISOString(),
        review_at: input.review_at || null,
        status: input.status || 'active',
        samples: [],
        conclusion: input.conclusion || null,
        origin: input.origin || 'human',
        chosen_by: input.chosen_by || (input.origin === 'nora' ? 'Nora' : null),
        rationale: input.rationale ? String(input.rationale).slice(0, 1200) : '',
        scope: input.scope || 'communication_behavior',
        reversible: input.reversible !== false,
        risk: input.risk || 'low',
        guardrails: Array.isArray(input.guardrails) ? input.guardrails.map(String).slice(0, 12) : [],
        stop_conditions: Array.isArray(input.stop_conditions) ? input.stop_conditions.map(String).slice(0, 12) : [],
        source_refs: Array.isArray(input.source_refs) ? input.source_refs.slice(0, 12) : [],
      };
      if (!experiment.behavior || !experiment.hypothesis) throw new Error('behavior and hypothesis are required');
      current.experiments.push(experiment);
      current.experiments = current.experiments.slice(-100);
      return experiment;
    });
  }

  function recordExperimentSample(input = {}) {
    return mutate(current => {
      const active = input.experiment_id
        ? current.experiments.filter(item => item.id === input.experiment_id)
        : current.experiments.filter(item => item.status === 'active');
      for (const experiment of active) {
        experiment.samples.push({ at: clock().toISOString(), outcome: input.outcome, value: input.value ?? null, interaction_id: input.interaction_id || null });
        experiment.samples = experiment.samples.slice(-500);
      }
      return active;
    });
  }

  function evaluateExperiment(id, { conclude = false, notes = '' } = {}) {
    return mutate(current => {
      const experiment = current.experiments.find(item => item.id === id);
      if (!experiment) return null;
      const values = experiment.samples.map(sample => Number(sample.value)).filter(Number.isFinite);
      const currentValue = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const comparator = experiment.baseline != null ? Number(experiment.baseline) : experiment.target != null ? Number(experiment.target) : null;
      const improved = currentValue == null || comparator == null ? null : currentValue >= comparator;
      const enoughEvidence = values.length >= (experiment.minimum_samples || 5);
      experiment.evaluation = { samples: values.length, current: currentValue, comparator, improved, enough_evidence: enoughEvidence, evaluated_at: clock().toISOString(), notes: String(notes).slice(0, 1000) };
      if (conclude) {
        if (!enoughEvidence) {
          experiment.conclusion = 'Not enough outcome evidence yet; keep observing before retaining or retiring this behavior.';
        } else {
          experiment.status = improved === false ? 'retired' : 'retained';
          experiment.conclusion = improved === false ? 'Outcome signal did not improve; retire or revise this behavior.' : 'Outcome signal supports retaining this behavior.';
        }
      }
      return experiment;
    });
  }

  function initiativeStatus(scope = 'global', now = clock()) {
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const configured = state.initiative.scopes[scope] || {};
    const limit = Number.isFinite(configured.daily_limit) ? configured.daily_limit : state.initiative.default_daily;
    const spent = configured.day === day ? configured.spent || 0 : 0;
    return { scope, day, limit, spent, remaining: Math.max(0, limit - spent) };
  }

  function spendInitiative(scope = 'global', metadata = {}) {
    return mutate(current => {
      const status = initiativeStatus(scope);
      if (status.remaining <= 0) return { ...status, allowed: false };
      current.initiative.scopes[scope] = { ...(current.initiative.scopes[scope] || {}), day: status.day, spent: status.spent + 1, last: clock().toISOString(), metadata };
      return { ...initiativeStatus(scope), allowed: true };
    });
  }

  function setInitiativeBudget(scope, dailyLimit) {
    return mutate(current => {
      current.initiative.scopes[scope] = { ...(current.initiative.scopes[scope] || {}), daily_limit: Math.max(0, Number(dailyLimit) || 0) };
      return initiativeStatus(scope);
    });
  }

  function chooseExperiment(input = {}) {
    const activeSelfChosen = state.experiments.filter(item => item.status === 'active' && item.origin === 'nora');
    if (activeSelfChosen.length >= 2) throw new Error('Nora already has two active self-chosen experiments');
    if (input.reversible === false || (input.risk && input.risk !== 'low')) throw new Error('self-chosen experiments must be low-risk and reversible');
    if (!input.rationale || !Array.isArray(input.source_refs) || !input.source_refs.length) throw new Error('self-chosen experiments require a rationale and evidence source');
    const forbidden = /\b(permission|authority|approval|financial gate|send external|impersonat|deceiv|manipulat|withhold disclosure)\b/i;
    if (forbidden.test(`${input.behavior || ''} ${input.hypothesis || ''} ${input.rationale || ''}`)) throw new Error('self-chosen experiment crosses an authority or trust boundary');
    return createExperiment({
      ...input, origin: 'nora', chosen_by: 'Nora', risk: 'low', reversible: true,
      review_at: input.review_at || new Date(clock().getTime() + 14 * 86400000).toISOString(),
      guardrails: [...new Set([...(input.guardrails || []), 'Do not expand delegated authority', 'Do not optimize for approval over correctness', 'Stop if a person is harmed, misled, or repeatedly annoyed'])],
    });
  }

  function parseDue(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function orient(input = {}) {
    const now = input.now ? new Date(input.now) : clock();
    const nowMs = now.getTime();
    const openCommitments = state.commitments.filter(item => item.status === 'open');
    const overdue = openCommitments.filter(item => parseDue(item.due) != null && parseDue(item.due) < nowMs);
    const dueSoon = openCommitments.filter(item => {
      const due = parseDue(item.due);
      return due != null && due >= nowMs && due <= nowMs + 48 * 60 * 60 * 1000;
    });
    const needsCheck = openCommitments.filter(item => item.follow_up && (
      (parseDue(item.next_check) != null && parseDue(item.next_check) <= nowMs)
      || nowMs - new Date(item.updated || item.created).getTime() >= 72 * 60 * 60 * 1000
    ));
    const openEpisodes = state.episodes.filter(item => item.status === 'open' && (
      (item.open_loops || []).some(loop => loop.status === 'open')
      || (item.commitment_ids || []).some(id => openCommitments.some(commitment => commitment.id === id))
    )).sort((a, b) => b.updated.localeCompare(a.updated));
    const experimentsDue = state.experiments.filter(item => item.status === 'active' && item.review_at && parseDue(item.review_at) <= nowMs);
    const unreviewedTraces = state.traces.filter(item => !item.reviewed_at && nowMs - new Date(item.at).getTime() <= 7 * 86400000);
    const staleCycles = state.cycles.filter(item => item.status === 'running' && nowMs - new Date(item.started).getTime() >= 2 * 60 * 60 * 1000);
    const activeSelfChosen = state.experiments.filter(item => item.status === 'active' && item.origin === 'nora');
    const recommendations = [
      ...overdue.map(item => ({ type: 'commitment', id: item.id, priority: 'critical', reason: `overdue${item.due ? ` since ${item.due}` : ''}`, action: 'verify delivery evidence, fulfill it, or renegotiate explicitly' })),
      ...dueSoon.map(item => ({ type: 'commitment', id: item.id, priority: 'high', reason: `due soon${item.due ? ` (${item.due})` : ''}`, action: 'confirm the next concrete step before it becomes late' })),
      ...needsCheck.filter(item => !overdue.includes(item) && !dueSoon.includes(item)).map(item => ({ type: 'commitment', id: item.id, priority: 'normal', reason: 'follow-up check is due', action: 'look for evidence or ask the smallest useful follow-up' })),
      ...openEpisodes.slice(0, 12).map(item => ({ type: 'episode', id: item.id, priority: 'normal', reason: `${(item.open_loops || []).filter(loop => loop.status === 'open').length} unresolved loop(s)`, action: 'continue the same story instead of starting a disconnected thread' })),
      ...experimentsDue.map(item => ({ type: 'experiment', id: item.id, priority: 'normal', reason: `review point reached with ${item.samples.length} sample(s)`, action: 'evaluate evidence and retain, revise, or retire' })),
      ...staleCycles.map(item => ({ type: 'cycle', id: item.id, priority: 'critical', reason: 'a prior intelligence cycle never closed', action: 'inspect its last recorded state and recover or close it as failed' })),
    ];
    return {
      at: now.toISOString(),
      commitments: { open: openCommitments, overdue, due_soon: dueSoon, needs_check: needsCheck },
      episodes: { open: openEpisodes },
      experiments: { due: experimentsDue },
      self_experiments: { active: activeSelfChosen, limit: 2, capacity: Math.max(0, 2 - activeSelfChosen.length) },
      traces: { unreviewed: unreviewedTraces.slice(-100) },
      cycles: { stale: staleCycles },
      initiative: { hourly: initiativeStatus('cowork:proactive', now) },
      recommendations: recommendations.sort((a, b) => {
        const order = { critical: 0, high: 1, normal: 2 };
        return order[a.priority] - order[b.priority];
      }),
    };
  }

  function startCycle(input = {}) {
    return mutate(current => {
      const orientation = orient(input);
      const cycle = {
        id: input.id || `cycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: input.kind || 'hourly', holder: input.holder || 'nora', started: orientation.at,
        status: 'running', orientation: {
          overdue_commitments: orientation.commitments.overdue.map(item => item.id),
          due_soon_commitments: orientation.commitments.due_soon.map(item => item.id),
          open_episodes: orientation.episodes.open.map(item => item.id),
          due_experiments: orientation.experiments.due.map(item => item.id),
          active_self_experiments: orientation.self_experiments.active.map(item => item.id),
          self_experiment_capacity: orientation.self_experiments.capacity,
          unreviewed_traces: orientation.traces.unreviewed.map(item => item.id),
          stale_cycles: orientation.cycles.stale.map(item => item.id),
        },
        recommendations: orientation.recommendations, actions: [], summary: '', finished: null,
      };
      current.cycles.push(cycle);
      current.cycles = current.cycles.slice(-240);
      return { cycle, orientation };
    });
  }

  function completeCycle(id, input = {}) {
    return mutate(current => {
      const cycle = current.cycles.find(item => item.id === id);
      if (!cycle) return null;
      cycle.status = input.status === 'failed' ? 'failed' : 'completed';
      cycle.finished = input.finished || clock().toISOString();
      cycle.summary = input.summary ? String(input.summary).slice(0, 2000) : '';
      cycle.actions = Array.isArray(input.actions) ? input.actions.slice(0, 100) : [];
      return cycle;
    });
  }

  function relevantEpisodes({ person, project, query, channel, limit = 3 } = {}) {
    const stop = new Set(['the', 'and', 'you', 'your', 'are', 'can', 'could', 'would', 'should', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'what', 'when', 'where', 'who', 'why', 'how', 'for', 'not', 'but', 'was', 'were', 'will', 'just', 'about']);
    const terms = (String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(term => !stop.has(term));
    const nowMs = clock().getTime();
    return state.episodes.map(episode => {
      const haystack = [episode.title, episode.summary, episode.project, ...(episode.participants || []), ...(episode.events || []).slice(-8).map(event => event.text)].join(' ').toLowerCase();
      let score = 0;
      let signal = 0;
      let directSignal = 0;
      if (project && episode.project && episode.project.toLowerCase() === String(project).toLowerCase()) directSignal += 8;
      if (person && (episode.participants || []).some(name => name.toLowerCase() === String(person).toLowerCase())) signal += 6;
      if (channel && String(episode.correlation || '').toLowerCase().includes(String(channel).toLowerCase())) directSignal += 4;
      const semanticSignal = Math.min(8, [...new Set(terms)].filter(term => haystack.includes(term)).length);
      signal += directSignal + semanticSignal;
      score += signal;
      if (episode.status === 'open') score += 2;
      if (nowMs - new Date(episode.updated).getTime() <= 7 * 86400000) score += 2;
      return { episode, score, signal, directSignal, semanticSignal };
    }).filter(item => item.directSignal > 0 || item.semanticSignal >= 2).sort((a, b) => b.score - a.score || b.episode.updated.localeCompare(a.episode.updated)).slice(0, limit).map(item => item.episode);
  }

  function promptContext({ person, project, query, channel } = {}) {
    const blocks = [];
    const workspace = scoreWorkspace(state, { person, project, query, channel }, clock());
    if (workspace.slots.length) blocks.push(`[Limited attention workspace — these won the current competition for attention. Treat everything else as latent memory, not simultaneous thought.]
${workspace.slots.map(item => `- ${item.text}`).join('\n')}`);
    const appraisal = state.cognition.appraisal || {};
    if (appraisal.label) blocks.push(`[Current grounded internal appraisal]
- ${appraisal.label}; valence ${Number(appraisal.valence || 0).toFixed(2)}, arousal ${Number(appraisal.arousal || 0).toFixed(2)}, control ${Number(appraisal.control || 0).toFixed(2)}, social safety ${Number(appraisal.social_safety || 0).toFixed(2)}, coherence ${Number(appraisal.coherence || 0).toFixed(2)}.
- This is a functional appraisal based on evidence, not proof of consciousness. Let it subtly shape tone; never announce scores.`);
    const episodes = relevantEpisodes({ person, project, query, channel });
    if (episodes.length) blocks.push(`[Relevant conversation continuity. Continue these threads naturally; do not announce that you retrieved them.]
${episodes.map(item => {
  const loops = (item.open_loops || []).filter(loop => loop.status === 'open').map(loop => loop.what).slice(0, 3);
  const recent = (item.events || []).slice(-3).map(event => `${event.actor || 'Someone'}: ${event.text}`).join(' / ');
  return `- ${item.title}${item.project ? ` (${item.project})` : ''}: ${item.summary || recent}${loops.length ? ` | Still open: ${loops.join('; ')}` : ''}`;
}).join('\n')}`);
    return blocks.join('\n\n');
  }

  return {
    init, snapshot: () => JSON.parse(JSON.stringify(state)), persist,
    list, get, addCommitment, updateCommitment, recordEpisodeEvent, observeRelationship, observePerspective, updatePerspective,
    recordTrace, updateTraceOutcome, createExperiment, chooseExperiment, recordExperimentSample, evaluateExperiment, initiativeStatus, spendInitiative,
    setInitiativeBudget, orient, startCycle, completeCycle, relevantEpisodes, promptContext,
    refreshCognition, cognitionSnapshot, affectContext, recordPredictionResolution, recordMindChange, recordDevelopment, recordCounterfactual,
  };
}

module.exports = { createIntelligenceStore, emptyState };
