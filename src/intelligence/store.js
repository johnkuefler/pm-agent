'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCommitment } = require('./models');

const STATE_KEY = 'operations_v1';
const LEGACY_STATE_KEY = 'intelligence_v1';
const MAX_COMMITMENTS = 4000;
const MAX_EPISODES = 4000;
const MAX_TRACES = 3000;
const MAX_CYCLES = 1000;
const MAX_EXECUTIONS = 4000;
const MAX_ATTESTATIONS = 4000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function boundedText(value, maximum = 1000) {
  return value == null ? null : String(value).slice(0, maximum);
}

function unique(values = []) {
  return [...new Set(values.filter(value => value != null && value !== ''))];
}

function emptyState() {
  return {
    version: 1,
    commitments: [],
    episodes: [],
    relationships: [],
    traces: [],
    cycles: [],
    initiative: { default_daily: 3, scopes: {} },
    agency: { executions: [], claim_attestations: [] },
    affordances: [],
    external_source_attestations: [],
  };
}

function compactLegacyState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const state = emptyState();
  state.commitments = Array.isArray(source.commitments)
    ? source.commitments.slice(-MAX_COMMITMENTS) : [];
  state.episodes = Array.isArray(source.episodes)
    ? source.episodes.slice(-MAX_EPISODES) : [];
  state.relationships = Array.isArray(source.relationships)
    ? source.relationships.slice(-1000) : [];
  state.traces = Array.isArray(source.traces)
    ? source.traces.slice(-MAX_TRACES) : [];
  state.cycles = Array.isArray(source.cycles)
    ? source.cycles.slice(-MAX_CYCLES) : [];
  if (source.initiative && typeof source.initiative === 'object') {
    state.initiative = {
      default_daily: Math.max(0, Number(source.initiative.default_daily) || 3),
      scopes: source.initiative.scopes && typeof source.initiative.scopes === 'object'
        ? source.initiative.scopes : {},
    };
  }
  const legacyAgency = source.agency || source.cognition?.agency || {};
  state.agency.executions = Array.isArray(legacyAgency.executions)
    ? legacyAgency.executions.slice(-MAX_EXECUTIONS) : [];
  state.agency.claim_attestations = Array.isArray(legacyAgency.claim_attestations)
    ? legacyAgency.claim_attestations.slice(-MAX_ATTESTATIONS) : [];
  const affordances = source.affordances || source.cognition?.situational_affordances?.frames;
  state.affordances = Array.isArray(affordances) ? affordances.slice(-1000) : [];
  const attestations = source.external_source_attestations
    || source.cognition?.external_source_attestations;
  state.external_source_attestations = Array.isArray(attestations)
    ? attestations.slice(-2000) : [];
  return state;
}

function createIntelligenceStore({
  filePath = null,
  db = null,
  isDbReady = () => false,
  clock = () => new Date(),
  initialState = null,
  strictPersistenceTimeoutMs = 10000,
} = {}) {
  let state = compactLegacyState(initialState || emptyState());
  let revision = 0;
  let requestedRevision = 0;
  let committedRevision = 0;
  let writeQueue = Promise.resolve();
  let flushRunning = false;
  let strictWaiters = 0;
  let lastError = null;
  let lastCommittedAt = null;

  const now = () => {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  };
  const isoNow = () => now().toISOString();
  const nextId = prefix => `${prefix}-${crypto.randomUUID()}`;
  const touch = () => {
    revision += 1;
    void persist().catch(() => {});
  };
  const trim = (list, maximum) => {
    if (list.length > maximum) list.splice(0, list.length - maximum);
  };

  async function readPersistedState() {
    if (isDbReady() && db?.getState) {
      const current = await db.getState(STATE_KEY);
      if (current) return current;
      return db.getState(LEGACY_STATE_KEY);
    }
    if (!filePath) return null;
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writePersistedState(snapshot) {
    const serialized = JSON.stringify(snapshot);
    if (isDbReady() && db) {
      if (typeof db.setStateSerialized === 'function') {
        await db.setStateSerialized(STATE_KEY, serialized);
      } else if (typeof db.setState === 'function') {
        await db.setState(STATE_KEY, snapshot);
      }
      return;
    }
    if (!filePath) return;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fs.promises.writeFile(temporary, serialized, 'utf8');
    await fs.promises.rename(temporary, filePath);
  }

  async function init() {
    const persisted = await readPersistedState();
    if (persisted) state = compactLegacyState(persisted);
    revision += 1;
    return snapshot();
  }

  function snapshot() {
    return clone(state);
  }

  function snapshotRevision() {
    return revision;
  }

  function persist() {
    const target = ++requestedRevision;
    const captured = snapshot();
    const operation = writeQueue.then(async () => {
      flushRunning = true;
      try {
        await writePersistedState(captured);
        committedRevision = Math.max(committedRevision, target);
        lastCommittedAt = isoNow();
        lastError = null;
        return captured;
      } catch (error) {
        lastError = boundedText(error?.message || error, 500);
        throw error;
      } finally {
        flushRunning = false;
      }
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function persistStrict() {
    strictWaiters += 1;
    let timeout;
    try {
      const operation = persist();
      const bounded = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            `intelligence persistence exceeded ${strictPersistenceTimeoutMs}ms`);
          error.code = 'INTELLIGENCE_PERSISTENCE_TIMEOUT';
          reject(error);
        }, strictPersistenceTimeoutMs);
        timeout.unref?.();
      });
      return await Promise.race([operation, bounded]);
    } finally {
      if (timeout) clearTimeout(timeout);
      strictWaiters -= 1;
    }
  }

  function persistenceDiagnostics() {
    return {
      state_key: STATE_KEY,
      requested_revision: requestedRevision,
      committed_revision: committedRevision,
      pending_revisions: Math.max(0, requestedRevision - committedRevision),
      flush_scheduled: requestedRevision > committedRevision && !flushRunning,
      flush_running: flushRunning,
      strict_waiters: strictWaiters,
      strict_timeout_ms: strictPersistenceTimeoutMs,
      last_committed_at: lastCommittedAt,
      last_error: lastError,
      cycle_open: { in_flight: false },
      database: typeof db?.diagnostics === 'function' ? db.diagnostics() : null,
    };
  }

  function list(kind, predicate = () => true) {
    return (Array.isArray(state[kind]) ? state[kind] : [])
      .filter(predicate).map(clone);
  }

  function get(kind, id) {
    const record = (Array.isArray(state[kind]) ? state[kind] : [])
      .find(item => item.id === id);
    return record ? clone(record) : null;
  }

  function addCommitment(input = {}) {
    const normalized = normalizeCommitment(input, now());
    if (!normalized.what) throw new Error('commitment requires what');
    const duplicate = state.commitments.find(item =>
      item.status === 'open'
      && item.what.toLowerCase() === normalized.what.toLowerCase()
      && String(item.owner || '').toLowerCase() === normalized.owner.toLowerCase()
      && (normalized.task_id ? item.task_id === normalized.task_id
        : normalized.episode_id ? item.episode_id === normalized.episode_id : false));
    if (duplicate) return clone(duplicate);
    state.commitments.push(normalized);
    trim(state.commitments, MAX_COMMITMENTS);
    touch();
    return clone(normalized);
  }

  function updateCommitment(id, changes = {}) {
    const index = state.commitments.findIndex(item => item.id === id);
    if (index < 0) return null;
    const previous = state.commitments[index];
    state.commitments[index] = normalizeCommitment({
      ...previous,
      ...changes,
      id: previous.id,
      created: previous.created,
      updated: isoNow(),
      fulfilled_at: changes.status === 'fulfilled'
        ? changes.fulfilled_at || isoNow() : changes.fulfilled_at || previous.fulfilled_at,
    }, now());
    touch();
    return clone(state.commitments[index]);
  }

  function episodeForInput(input) {
    if (input.episode_id) return state.episodes.find(item => item.id === input.episode_id);
    if (input.correlation) {
      return state.episodes.find(item => item.correlation === input.correlation);
    }
    return null;
  }

  function recordEpisodeEvent(input = {}) {
    let episode = episodeForInput(input);
    if (!episode) {
      episode = {
        id: input.episode_id || (input.correlation
          ? `episode-${hash(input.correlation).slice(0, 20)}` : nextId('episode')),
        correlation: input.correlation || null,
        title: boundedText(input.title || input.text || 'Operational episode', 300),
        project: boundedText(input.project, 200),
        participants: unique(input.participants || []),
        summary: boundedText(input.summary || input.text, 3000),
        decisions: unique(input.decisions || []),
        open_loops: [],
        commitment_ids: [],
        events: [],
        status: input.status || 'open',
        channel: input.channel || null,
        kind: input.kind || null,
        source_ref: clone(input.source_ref || null),
        created: input.at || isoNow(),
        updated: input.at || isoNow(),
      };
      state.episodes.push(episode);
      trim(state.episodes, MAX_EPISODES);
    }
    if (input.title) episode.title = boundedText(input.title, 300);
    if (input.project) episode.project = boundedText(input.project, 200);
    if (input.summary) episode.summary = boundedText(input.summary, 3000);
    if (input.status) episode.status = input.status;
    if (input.source_ref) episode.source_ref = clone(input.source_ref);
    episode.participants = unique([...(episode.participants || []), ...(input.participants || [])]);
    episode.decisions = unique([...(episode.decisions || []), ...(input.decisions || [])]);
    if (input.open_loop?.what) {
      const key = canonicalJson(input.open_loop);
      if (!(episode.open_loops || []).some(item => canonicalJson(item) === key)) {
        episode.open_loops.push(clone(input.open_loop));
      }
    }
    episode.commitment_ids = unique([
      ...(episode.commitment_ids || []), ...(input.commitment_ids || []),
    ]);
    if (input.record_event !== false && (input.text || input.actor || input.kind)) {
      const event = {
        id: input.event_id || nextId('event'),
        at: input.at || isoNow(),
        actor: boundedText(input.actor, 160),
        kind: input.kind || null,
        text: boundedText(input.text, 3000),
      };
      const duplicate = episode.events.some(item =>
        item.at === event.at && item.actor === event.actor
        && item.kind === event.kind && item.text === event.text);
      if (!duplicate) episode.events.push(event);
      trim(episode.events, 500);
    }
    episode.updated = input.at || isoNow();
    touch();
    return clone(episode);
  }

  function recordEpisodeEvents(inputs = []) {
    return inputs.map(recordEpisodeEvent);
  }

  function relevantEpisodes({ person = null, project = null, query = '', limit = 5 } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(term => term.length > 2);
    return state.episodes.map(item => {
      const searchable = canonicalJson(item).toLowerCase();
      let score = terms.filter(term => searchable.includes(term)).length;
      if (person && searchable.includes(String(person).toLowerCase())) score += 3;
      if (project && searchable.includes(String(project).toLowerCase())) score += 3;
      return { item, score };
    }).filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score
        || String(right.item.updated).localeCompare(String(left.item.updated)))
      .slice(0, Math.max(0, Number(limit) || 5)).map(entry => clone(entry.item));
  }

  function observeRelationship(input = {}) {
    const name = boundedText(input.name || input.person, 160);
    if (!name) return null;
    let relationship = state.relationships.find(item =>
      String(item.name).toLowerCase() === name.toLowerCase());
    if (!relationship) {
      relationship = { id: nextId('relationship'), name, observations: [], updated: isoNow() };
      state.relationships.push(relationship);
    }
    relationship.observations.push({
      at: input.at || isoNow(),
      dimension: boundedText(input.dimension, 120),
      observation: boundedText(input.observation, 1000),
    });
    trim(relationship.observations, 100);
    relationship.updated = isoNow();
    touch();
    return clone(relationship);
  }

  function recordTrace(input = {}) {
    const trace = {
      id: input.id || nextId('trace'),
      at: input.at || isoNow(),
      channel: boundedText(input.channel, 200),
      action: boundedText(input.action, 200),
      decision: boundedText(input.decision, 200),
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
      reasons: Array.isArray(input.reasons) ? input.reasons.map(item => boundedText(item, 500)) : [],
      preview: boundedText(input.preview, 500),
      episode_id: input.episode_id || null,
      interaction_id: input.interaction_id || null,
      outcome: input.outcome || null,
    };
    state.traces.push(trace);
    trim(state.traces, MAX_TRACES);
    touch();
    return clone(trace);
  }

  function recordTraces(inputs = []) {
    return inputs.map(recordTrace);
  }

  function updateTraceOutcome(id, input = {}) {
    const candidates = id ? state.traces.filter(item => item.id === id)
      : state.traces.filter(item => input.interaction_id
        && item.interaction_id === input.interaction_id);
    for (const trace of candidates) Object.assign(trace, {
      outcome: input.outcome || trace.outcome,
      signal: boundedText(input.signal, 1000),
      reviewed_at: input.reviewed_at || isoNow(),
    });
    if (candidates.length) touch();
    return candidates.map(clone);
  }

  function initiativeStatus(scope = 'global', at = now()) {
    const date = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
    const existing = state.initiative.scopes[scope] || {};
    const spent = existing.date === date ? Math.max(0, Number(existing.spent) || 0) : 0;
    const limit = Math.max(0, Number(existing.limit) || state.initiative.default_daily || 3);
    return { scope, date, limit, spent, remaining: Math.max(0, limit - spent) };
  }

  function spendInitiative(scope = 'global', metadata = {}) {
    const status = initiativeStatus(scope);
    state.initiative.scopes[scope] = {
      date: status.date,
      limit: status.limit,
      spent: Math.min(status.limit, status.spent + 1),
      last: { at: isoNow(), metadata: clone(metadata) },
    };
    touch();
    return initiativeStatus(scope);
  }

  function openOrResumeCycle(input = {}) {
    const kind = input.kind || 'hourly';
    const running = input.resume_active === false ? null : state.cycles.find(item =>
      item.status === 'running'
      && item.kind === kind
      && (!input.run_lock_holder || item.run_lock_holder === input.run_lock_holder));
    if (running) return Promise.resolve({ cycle: clone(running), resumed: true });
    const cycle = {
      id: input.id || nextId('cycle'),
      kind,
      holder: input.holder || null,
      run_lock_holder: input.run_lock_holder || null,
      trigger_source: input.trigger_source || null,
      status: 'running',
      started: input.started || isoNow(),
      finished: null,
      summary: null,
      actions: [],
    };
    state.cycles.push(cycle);
    trim(state.cycles, MAX_CYCLES);
    touch();
    return Promise.resolve({ cycle: clone(cycle), resumed: false });
  }

  async function completeCycleDurable(id, input = {}) {
    const cycle = state.cycles.find(item => item.id === id);
    if (!cycle) throw new Error(`unknown operational cycle ${id}`);
    if (cycle.status !== 'running') return clone(cycle);
    cycle.status = input.status === 'failed' ? 'failed' : 'completed';
    cycle.finished = input.finished || isoNow();
    cycle.summary = boundedText(input.summary, 3000);
    cycle.actions = Array.isArray(input.actions) ? clone(input.actions).slice(0, 100) : [];
    if (cycle.status === 'failed') {
      cycle.failure_reason = boundedText(input.failure_reason || input.summary, 1000);
    }
    touch();
    await persistStrict();
    return clone(cycle);
  }

  function recoverStaleCycles({
    now: observedAt = now(),
    staleAfterMs = 90 * 60 * 1000,
    reason = 'stale_cycle_recovery',
  } = {}) {
    const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
    const records = [];
    for (const cycle of state.cycles) {
      if (cycle.status !== 'running') continue;
      const age = observed.getTime() - new Date(cycle.started).getTime();
      if (Number.isFinite(age) && age < staleAfterMs) continue;
      cycle.status = 'failed';
      cycle.finished = observed.toISOString();
      cycle.recovery = { reason, recovered_at: observed.toISOString() };
      records.push(clone(cycle));
    }
    if (records.length) touch();
    return { recovered: records.length, records };
  }

  function actionExecutionPayload(record) {
    const { audit, content_commitment, ...payload } = record;
    return payload;
  }

  function actionExecutionAudit(record) {
    if (!record || typeof record !== 'object') {
      return { complete_chain_verified: false, reason: 'missing_execution' };
    }
    const expected = hash(canonicalJson(actionExecutionPayload(record)));
    return {
      complete_chain_verified: record.content_commitment === expected,
      reason: record.content_commitment === expected ? null : 'content_commitment_mismatch',
    };
  }

  function publicExecution(record) {
    return { ...clone(record), audit: actionExecutionAudit(record) };
  }

  function beginActionExecution(input = {}) {
    const id = input.id || nextId('execution');
    const existing = state.agency.executions.find(item => item.id === id);
    if (existing) return publicExecution(existing);
    const record = {
      id,
      tool_use_id: boundedText(input.tool_use_id, 200),
      tool_name: boundedText(input.tool_name, 240),
      tool_family: boundedText(input.tool_family, 160),
      actor_class: input.actor_class || 'model_selected',
      selection_origin: input.selection_origin || null,
      surface: boundedText(input.surface, 120),
      interaction_ref: boundedText(input.interaction_ref, 240),
      access_mode: input.access_mode || 'read',
      deferred: input.deferred === true,
      status: 'selected',
      selected: input.selected || isoNow(),
      queued: null,
      completed: null,
      job_id: null,
      arguments_commitment: hash(canonicalJson(input.arguments || {})),
      result_commitment: null,
      error_commitment: null,
    };
    record.content_commitment = hash(canonicalJson(record));
    state.agency.executions.push(record);
    trim(state.agency.executions, MAX_EXECUTIONS);
    touch();
    return publicExecution(record);
  }

  function markActionExecutionQueued(id, input = {}) {
    const record = state.agency.executions.find(item => item.id === id);
    if (!record) return null;
    record.status = 'queued';
    record.queued = input.queued || isoNow();
    record.job_id = boundedText(input.job_id, 240);
    record.content_commitment = hash(canonicalJson(actionExecutionPayload(record)));
    touch();
    return publicExecution(record);
  }

  function completeActionExecution(id, input = {}) {
    const record = state.agency.executions.find(item => item.id === id);
    if (!record) return null;
    record.status = input.status === 'succeeded' ? 'succeeded' : 'failed';
    record.completed = input.completed || isoNow();
    record.result_commitment = input.status === 'succeeded'
      ? hash(canonicalJson(input.result || null)) : null;
    record.error_commitment = input.status === 'succeeded'
      ? null : hash(String(input.error || 'tool failed'));
    record.content_commitment = hash(canonicalJson(actionExecutionPayload(record)));
    touch();
    return publicExecution(record);
  }

  function actionExecutionsById(ids = []) {
    const selected = new Set(ids);
    return state.agency.executions.filter(item => selected.has(item.id)).map(publicExecution);
  }

  function claimAttestationPayload(record) {
    const { audit, content_commitment, ...payload } = record;
    return payload;
  }

  function actionClaimAttestationAudit(record) {
    if (!record || typeof record !== 'object') {
      return { complete_chain_verified: false, reason: 'missing_attestation' };
    }
    const expected = hash(canonicalJson(claimAttestationPayload(record)));
    return {
      complete_chain_verified: record.content_commitment === expected,
      reason: record.content_commitment === expected ? null : 'content_commitment_mismatch',
    };
  }

  function recordActionClaimAttestation(input = {}) {
    const candidateCommitment = input.candidate_commitment
      || hash(String(input.candidate_response || ''));
    const finalCommitment = input.final_response_commitment
      || hash(String(input.final_response || ''));
    const id = input.id || `claim-${hash(canonicalJson({
      surface: input.surface,
      interaction_ref: input.interaction_ref,
      candidate_commitment: candidateCommitment,
    })).slice(0, 24)}`;
    const existing = state.agency.claim_attestations.find(item => item.id === id);
    if (existing) return { ...clone(existing), audit: actionClaimAttestationAudit(existing) };
    const record = {
      id,
      protocol_version: Number(input.protocol_version) || 1,
      at: input.at || isoNow(),
      surface: boundedText(input.surface, 120),
      interaction_ref: boundedText(input.interaction_ref, 240),
      disposition: input.disposition || 'no_claim',
      detected_claim_count: Math.max(0, Number(input.detected_claim_count) || 0),
      claim_families: unique(input.claim_families || []).sort(),
      unsupported_claim_families: unique(input.unsupported_claim_families || []).sort(),
      claim_receipt_bindings: clone(input.claim_receipt_bindings || []).slice(0, 100),
      candidate_commitment: candidateCommitment,
      final_response_commitment: finalCommitment,
    };
    record.content_commitment = hash(canonicalJson(record));
    state.agency.claim_attestations.push(record);
    trim(state.agency.claim_attestations, MAX_ATTESTATIONS);
    touch();
    return { ...clone(record), audit: actionClaimAttestationAudit(record) };
  }

  function agencySnapshot() {
    const executions = state.agency.executions.map(publicExecution);
    const claimAttestations = state.agency.claim_attestations.map(item => ({
      ...clone(item), audit: actionClaimAttestationAudit(item),
    }));
    const valid = claimAttestations.filter(item => item.audit.complete_chain_verified);
    return {
      experimental_access_sealed: false,
      executions,
      claim_attestations: claimAttestations,
      report: {
        replay_valid_action_executions: executions
          .filter(item => item.audit.complete_chain_verified).length,
        replay_valid_action_claim_attestations: valid.length,
        verified_completion_claims: valid
          .filter(item => item.disposition === 'verified').length,
        blocked_unverified_completion_claims: valid
          .filter(item => item.disposition === 'blocked').length,
      },
    };
  }

  function recordSituationalAffordanceFrame(input = {}) {
    const record = {
      id: input.id || nextId('affordance'),
      at: input.at || isoNow(),
      surface: input.surface || null,
      context_kind: input.context_kind || null,
      context_key: boundedText(input.context_key, 500),
      capabilities: clone(input.capabilities || []).slice(0, 100),
      constraints: (input.constraints || []).map(item => boundedText(item, 500)),
      evidence: clone(input.evidence || []).slice(0, 100),
    };
    record.content_commitment = hash(canonicalJson(record));
    state.affordances.push(record);
    trim(state.affordances, 1000);
    touch();
    return clone(record);
  }

  function recordVerifiedExternalSourceAttestation(commitmentId, input = {}) {
    const existing = state.external_source_attestations.find(item =>
      item.commitment_id === commitmentId
      && item.content_commitment === input.content_commitment);
    if (existing) return clone(existing);
    const record = {
      id: input.id || nextId('source-attestation'),
      commitment_id: commitmentId,
      source_type: input.source_type || input.type || null,
      source_id: boundedText(input.source_id || input.id, 300),
      content_commitment: input.content_commitment || hash(canonicalJson(input)),
      recorded_at: input.recorded_at || isoNow(),
    };
    state.external_source_attestations.push(record);
    trim(state.external_source_attestations, 2000);
    touch();
    return clone(record);
  }

  const unavailable = () => null;
  const noEffect = () => null;

  return {
    init,
    snapshot,
    snapshotRevision,
    persist,
    persistStrict,
    persistenceDiagnostics,
    list,
    get,
    addCommitment,
    updateCommitment,
    recordEpisodeEvent,
    recordEpisodeEvents,
    relevantEpisodes,
    observeRelationship,
    recordTrace,
    recordTraces,
    updateTraceOutcome,
    initiativeStatus,
    spendInitiative,
    openOrResumeCycle,
    completeCycleDurable,
    recoverStaleCycles,
    beginActionExecution,
    markActionExecutionQueued,
    completeActionExecution,
    actionExecutionAudit,
    actionExecutionsById,
    recordActionClaimAttestation,
    actionClaimAttestationAudit,
    agencySnapshot,
    recordSituationalAffordanceFrame,
    recordVerifiedExternalSourceAttestation,
    interventionActive: () => false,
    contextCondition: unavailable,
    endogenousAttentionSelectionAvailable: () => false,
    affectContext: unavailable,
    relationalAffectSnapshot: () => ({ current: null, records: [] }),
    epistemicAgendaSnapshot: () => ({ questions: [], attempts: [] }),
    experienceMomentForCycle: unavailable,
    experienceStreamSnapshot: () => ({ moments: [] }),
    continuityProjectionAudit: () => ({
      usable: false,
      legacy_unbound: false,
      reason: 'continuity_projection_retired',
    }),
    continuityHandoffAudit: () => ({
      valid: false,
      usable: false,
      reason: 'continuity_handoff_retired',
    }),
    continuityProjectionRecovery: () => ({
      required: false,
      repairable: false,
      reason: 'continuity_projection_retired',
    }),
    expectationSurprise: unavailable,
    autobiographyEvidence: unavailable,
    lifecyclePerformanceSnapshot: () => ({
      cycle_count: state.cycles.length,
      running_cycles: state.cycles.filter(item => item.status === 'running').length,
    }),
    interactivePerformanceSnapshot: () => ({}),
    noteExternalConfigurationChange: () => { revision += 1; },
    beginProspectiveOutputMonitor: unavailable,
    completeProspectiveOutputMonitor: unavailable,
    failProspectiveOutputMonitor: noEffect,
    markProspectiveOutputMonitorDelivered: noEffect,
    excludeProspectiveOutputMonitorAssignment: noEffect,
    resolveProspectiveOutputMonitorOutcome: noEffect,
    beginEndogenousAttentionSelection: unavailable,
    completeEndogenousAttentionSelection: unavailable,
    failEndogenousAttentionSelection: noEffect,
    recordEndogenousAttentionResponse: noEffect,
    beginProviderReasoningRegulation: unavailable,
    completeProviderReasoningRegulation: noEffect,
    excludeProviderReasoningRegulationAssignment: noEffect,
    beginReasoningSelfRegulation: unavailable,
    submitReasoningSelfRegulationForecastPair: unavailable,
    commitReasoningSelfRegulationMainRequest: noEffect,
    completeReasoningSelfRegulation: noEffect,
    excludeReasoningSelfRegulationAssignment: noEffect,
    beginBehavioralSelfProfileForecast: unavailable,
    submitBehavioralSelfProfileForecast: noEffect,
    commitBehavioralSelfProfileMainRequest: noEffect,
    completeBehavioralSelfProfileForecast: noEffect,
    excludeBehavioralSelfProfileAssignment: noEffect,
    excludeCognitiveParameterAssignment: noEffect,
    markCognitiveParameterAssignmentDelivered: noEffect,
    resolveCognitiveParameterAssignmentOutcome: noEffect,
    excludeGlobalBroadcastAssignment: noEffect,
    excludeSelfModelTrustAssignment: noEffect,
    submitIntrospectiveDiagnosis: noEffect,
    recordGoalAccessResponse: noEffect,
    recordGlobalBroadcastResponse: noEffect,
    recordSelfModelTrustResponse: noEffect,
    recordAffectiveRegulationApplication: unavailable,
    resolveAffectiveRegulationApplicationOutcome: noEffect,
    recordProfessionalViewpointAccessApplication: unavailable,
    resolveProfessionalViewpointAccessOutcome: noEffect,
    recordEpistemicAgendaAccessApplication: unavailable,
    resolveEpistemicAgendaAccessOutcome: unavailable,
    syncCapabilityBoundaryOutcomes: noEffect,
    recordProcedureInteractionOutcome: noEffect,
    recordExemplarInteractionOutcome: noEffect,
    recordExperimentSample: noEffect,
    resolveContextAssignment: noEffect,
  };
}

module.exports = { createIntelligenceStore, emptyState };
