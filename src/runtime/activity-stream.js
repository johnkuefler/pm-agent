'use strict';

const crypto = require('crypto');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'deferred', 'preempted', 'cancelled']);
const ALLOWED_STATUSES = new Set(['queued', 'active', ...TERMINAL_STATUSES]);
const ALLOWED_LANES = new Set(['work', 'conversation', 'background', 'learning', 'leisure', 'system']);
const SAFE_META_KEYS = new Set([
  'surface', 'trigger', 'step', 'reason', 'result', 'interaction_kind', 'provider', 'model', 'phase',
]);

function safeText(value, maximum = 180) {
  let text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|xox[aboprs])-[-A-Za-z0-9_]{12,}\b/g, '[redacted credential]')
    .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maximum) text = `${text.slice(0, maximum - 1)}\u2026`;
  return text;
}

function safeMeta(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_META_KEYS.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) continue;
    output[key] = typeof value === 'string' ? safeText(value, 100) : value;
  }
  return output;
}

function createRuntimeActivityStream({ clock = () => new Date(), limit = 240,
  activeTtlMs = 2 * 60 * 60 * 1000, processEpochId = null } = {}) {
  const listeners = new Set();
  const records = [];
  let sequence = 0;
  const epochId = safeText(processEpochId || `epoch-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, 80);

  const nowDate = () => {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  };
  const find = id => records.find(item => item.id === id) || null;
  const trim = () => {
    if (records.length > limit) records.splice(limit);
  };
  const publish = record => {
    if (!listeners.size) return;
    const payload = JSON.parse(JSON.stringify(record));
    setImmediate(() => {
      for (const listener of listeners) {
        try { listener(payload); } catch (_) { /* Observability must never affect Nora's work. */ }
      }
    });
  };
  const stamp = record => {
    sequence += 1;
    record.sequence = sequence;
    record.updated_at = nowDate().toISOString();
    publish(record);
    return JSON.parse(JSON.stringify(record));
  };
  const normalizeStatus = status => ALLOWED_STATUSES.has(status) ? status : 'active';

  function begin({ id = null, lane = 'background', kind = 'operation', label, detail = '',
    parent_id = null, source = 'runtime', meta = {} } = {}) {
    const at = nowDate();
    const activityId = safeText(id || `activity-${at.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, 120);
    let record = find(activityId);
    if (record) {
      record.status = 'active';
      record.label = safeText(label || record.label || 'Working', 100);
      record.detail = safeText(detail || record.detail, 180);
      record.meta = { ...record.meta, ...safeMeta(meta) };
      record.completed_at = null;
      record.duration_ms = null;
      record.outcome = '';
      return stamp(record);
    }
    record = {
      id: activityId,
      sequence: 0,
      process_epoch_id: epochId,
      lane: ALLOWED_LANES.has(lane) ? lane : 'background',
      kind: safeText(kind, 60) || 'operation',
      label: safeText(label || 'Working', 100),
      detail: safeText(detail, 180),
      status: 'active',
      source: safeText(source, 60) || 'runtime',
      parent_id: parent_id ? safeText(parent_id, 120) : null,
      meta: safeMeta(meta),
      started_at: at.toISOString(),
      updated_at: at.toISOString(),
      completed_at: null,
      duration_ms: null,
      outcome: '',
    };
    records.unshift(record);
    trim();
    return stamp(record);
  }

  function progress(id, { label, detail, meta } = {}) {
    const record = find(safeText(id, 120));
    if (!record) return null;
    if (label) record.label = safeText(label, 100);
    if (detail !== undefined) record.detail = safeText(detail, 180);
    if (meta) record.meta = { ...record.meta, ...safeMeta(meta) };
    return stamp(record);
  }

  function finish(id, { status = 'completed', detail, outcome = '', meta } = {}) {
    const record = find(safeText(id, 120));
    if (!record) return null;
    const finishedAt = nowDate();
    record.status = TERMINAL_STATUSES.has(status) ? status : 'completed';
    if (detail !== undefined) record.detail = safeText(detail, 180);
    if (meta) record.meta = { ...record.meta, ...safeMeta(meta) };
    record.outcome = safeText(outcome, 180);
    record.completed_at = finishedAt.toISOString();
    record.duration_ms = Math.max(0, finishedAt.getTime() - Date.parse(record.started_at));
    return stamp(record);
  }

  function record({ status = 'completed', ...input } = {}) {
    const created = begin(input);
    return finish(created.id, { status: normalizeStatus(status), detail: input.detail,
      outcome: input.outcome, meta: input.meta });
  }

  function expireStale() {
    const now = nowDate().getTime();
    for (const item of records) {
      if (item.status !== 'active' || now - Date.parse(item.updated_at) <= activeTtlMs) continue;
      item.status = 'failed';
      item.detail = 'The process stopped reporting before it reached a terminal state.';
      item.outcome = 'Stale activity closed by the runtime safety bound.';
      item.completed_at = new Date(now).toISOString();
      item.duration_ms = Math.max(0, now - Date.parse(item.started_at));
      stamp(item);
    }
  }

  function snapshot() {
    expireStale();
    const current = records.filter(item => item.status === 'active');
    const recent = records.filter(item => item.status !== 'active').slice(0, 80);
    const lanes = {};
    for (const lane of ALLOWED_LANES) {
      const active = current.filter(item => item.lane === lane);
      const last = records.find(item => item.lane === lane) || null;
      lanes[lane] = {
        active_count: active.length,
        current_label: active[0]?.label || null,
        last_activity_at: last?.updated_at || null,
        last_status: last?.status || null,
      };
    }
    return {
      protocol_version: 1,
      process_epoch_id: epochId,
      generated_at: nowDate().toISOString(),
      sequence,
      current: JSON.parse(JSON.stringify(current)),
      recent: JSON.parse(JSON.stringify(recent)),
      lanes,
      report: {
        active: current.length,
        retained: records.length,
        failures: recent.filter(item => item.status === 'failed').length,
      },
      privacy: {
        payload_policy: 'operational labels and bounded status only',
        raw_messages_included: false,
        prompts_included: false,
        tool_arguments_included: false,
        tool_results_included: false,
      },
    };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  record({ id: `boot:${epochId}`, lane: 'system', kind: 'process_boot', label: 'Nora came online',
    detail: 'The runtime activity ledger is connected for this server process.', status: 'completed',
    source: 'runtime' });

  return { begin, progress, finish, record, snapshot, subscribe, safeText };
}

module.exports = { createRuntimeActivityStream, safeText };
