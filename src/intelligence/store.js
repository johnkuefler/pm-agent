'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeCommitment } = require('./models');

function emptyState() {
  return {
    version: 1,
    commitments: [],
    episodes: [],
    relationships: [],
    traces: [],
    experiments: [],
    initiative: { default_daily: 3, scopes: {} },
  };
}

function createIntelligenceStore({ filePath, db, isDbReady, clock = () => new Date() }) {
  let state = emptyState();
  let writeQueue = Promise.resolve();

  function hydrate(value) {
    state = { ...emptyState(), ...(value && typeof value === 'object' ? value : {}) };
    for (const key of ['commitments', 'episodes', 'relationships', 'traces', 'experiments']) {
      if (!Array.isArray(state[key])) state[key] = [];
    }
    if (!state.initiative || typeof state.initiative !== 'object') state.initiative = emptyState().initiative;
    if (!state.initiative.scopes) state.initiative.scopes = {};
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
      const duplicate = current.commitments.find(item => item.status === 'open' && item.task_id && item.task_id === commitment.task_id);
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
      current.commitments[index] = normalizeCommitment({ ...current.commitments[index], ...changes, id, updated: clock().toISOString() }, clock());
      return current.commitments[index];
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
        };
        current.episodes.push(episode);
      }
      episode.updated = input.at || clock().toISOString();
      episode.participants = [...new Set([...episode.participants, ...(input.participants || []).filter(Boolean)])];
      if (input.project) episode.project = input.project;
      if (input.title && episode.title === 'Conversation') episode.title = input.title;
      episode.events.push({
        id: input.event_id || `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: input.at || clock().toISOString(),
        channel: input.channel || 'unknown',
        kind: input.kind || 'message',
        actor: input.actor || null,
        text: input.text ? String(input.text).slice(0, 2000) : '',
        source_ref: input.source_ref || null,
      });
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
      };
      current.traces.push(trace);
      current.traces = current.traces.slice(-1000);
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
        target: input.target ?? null,
        started: input.started || clock().toISOString(),
        review_at: input.review_at || null,
        status: input.status || 'active',
        samples: [],
        conclusion: input.conclusion || null,
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
      const improved = currentValue == null || experiment.baseline == null ? null : currentValue > Number(experiment.baseline);
      experiment.evaluation = { samples: values.length, current: currentValue, improved, evaluated_at: clock().toISOString(), notes: String(notes).slice(0, 1000) };
      if (conclude) {
        if (!values.length) {
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

  function promptContext({ person, project } = {}) {
    const blocks = [];
    const open = state.commitments.filter(item => item.status === 'open' && (!project || !item.project || item.project === project)).slice(-12);
    if (open.length) blocks.push(`[Open commitments: promises matter. Track these quietly and never imply completion until confirmed.]
${open.map(item => `- ${item.owner} committed to ${item.what}${item.beneficiary ? ` for ${item.beneficiary}` : ''}${item.due ? ` (due ${item.due})` : ''}`).join('\n')}`);
    const relationships = state.relationships.filter(item => !person || item.name.toLowerCase() === person.toLowerCase()).slice(-12);
    if (relationships.length) blocks.push(`[Evidence-backed relationship observations. Use these to communicate well; never recite them or turn them into stereotypes.]
${relationships.map(item => `- ${item.name}: ${item.observations.filter(o => o.status === 'active' && o.confidence >= 0.65).slice(-4).map(o => o.observation).join('; ')}`).join('\n')}`);
    const experiments = state.experiments.filter(item => item.status === 'active').slice(-4);
    if (experiments.length) blocks.push(`[Active behavior experiments. Apply them naturally and let outcomes decide whether they survive.]
${experiments.map(item => `- Try: ${item.behavior}. Hypothesis: ${item.hypothesis}`).join('\n')}`);
    return blocks.join('\n\n');
  }

  return {
    init, snapshot: () => JSON.parse(JSON.stringify(state)), persist,
    list, get, addCommitment, updateCommitment, recordEpisodeEvent, observeRelationship,
    recordTrace, createExperiment, recordExperimentSample, evaluateExperiment, initiativeStatus, spendInitiative,
    setInitiativeBudget, promptContext,
  };
}

module.exports = { createIntelligenceStore, emptyState };
