'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const STATE_KEY = 'operations_v1';
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
    version: 2,
    cycles: [],
    actions: { executions: [], claim_attestations: [] },
  };
}

function normalizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const state = emptyState();
  state.cycles = Array.isArray(source.cycles)
    ? source.cycles.slice(-MAX_CYCLES) : [];
  const actions = source.actions || source.agency || {};
  state.actions.executions = Array.isArray(actions.executions)
    ? actions.executions.slice(-MAX_EXECUTIONS) : [];
  state.actions.claim_attestations = Array.isArray(actions.claim_attestations)
    ? actions.claim_attestations.slice(-MAX_ATTESTATIONS) : [];
  return state;
}

function createOperationStore({
  filePath = null,
  db = null,
  isDbReady = () => false,
  clock = () => new Date(),
  initialState = null,
  strictPersistenceTimeoutMs = 10000,
} = {}) {
  let state = normalizeState(initialState || emptyState());
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
      return db.getState(STATE_KEY);
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
    if (persisted) state = normalizeState(persisted);
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
            `operation persistence exceeded ${strictPersistenceTimeoutMs}ms`);
          error.code = 'OPERATION_PERSISTENCE_TIMEOUT';
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
    const existing = state.actions.executions.find(item => item.id === id);
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
    state.actions.executions.push(record);
    trim(state.actions.executions, MAX_EXECUTIONS);
    touch();
    return publicExecution(record);
  }

  function markActionExecutionQueued(id, input = {}) {
    const record = state.actions.executions.find(item => item.id === id);
    if (!record) return null;
    record.status = 'queued';
    record.queued = input.queued || isoNow();
    record.job_id = boundedText(input.job_id, 240);
    record.content_commitment = hash(canonicalJson(actionExecutionPayload(record)));
    touch();
    return publicExecution(record);
  }

  function completeActionExecution(id, input = {}) {
    const record = state.actions.executions.find(item => item.id === id);
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
    return state.actions.executions.filter(item => selected.has(item.id)).map(publicExecution);
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
    const existing = state.actions.claim_attestations.find(item => item.id === id);
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
    state.actions.claim_attestations.push(record);
    trim(state.actions.claim_attestations, MAX_ATTESTATIONS);
    touch();
    return { ...clone(record), audit: actionClaimAttestationAudit(record) };
  }

  function actionSnapshot() {
    const executions = state.actions.executions.map(publicExecution);
    const claimAttestations = state.actions.claim_attestations.map(item => ({
      ...clone(item), audit: actionClaimAttestationAudit(item),
    }));
    const valid = claimAttestations.filter(item => item.audit.complete_chain_verified);
    return {
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

  return {
    init,
    snapshot,
    snapshotRevision,
    persist,
    persistStrict,
    persistenceDiagnostics,
    list,
    get,
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
    actionSnapshot,
    lifecyclePerformanceSnapshot: () => ({
      cycle_count: state.cycles.length,
      running_cycles: state.cycles.filter(item => item.status === 'running').length,
    }),
  };
}

module.exports = { createOperationStore, emptyState };
