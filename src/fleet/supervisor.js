'use strict';

const crypto = require('crypto');
const { isFleetConnection } = require('../mcp/fleet-policy');

const PROTOCOL_VERSION = 1;
const STATE_KEY = 'fleet_supervisor_v1';
const ATTENTION_STATUSES = new Set(['failed', 'stuck', 'blocked', 'overdue']);
const CALM_STATUSES = new Set(['healthy', 'idle', 'off-hours', 'paused']);
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const EVENT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_INCIDENTS = 300;
const MAX_TRANSITIONS = 240;

function clean(value, max = 1000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(value, fallback = new Date()) {
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function decodeToolResult(result) {
  if (result == null) return null;
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return result; }
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = Array.isArray(result.content)
    ? result.content.find(item => item && item.type === 'text' && typeof item.text === 'string')?.text
    : null;
  if (text) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

function emptyState(now = new Date()) {
  return {
    protocol_version: PROTOCOL_VERSION,
    mode: 'silent_supervision',
    baseline_at: null,
    last_scan_at: null,
    last_success_at: null,
    last_error: null,
    updated_at: now.toISOString(),
    connection: { available: false, name: null, usable_tools: 0 },
    policy: {
      default_daily_interruption_limit: 1,
      shared_budget_scope: 'cowork:proactive',
      bootstrap_is_silent: true,
      recovery_is_silent: true,
      unchanged_incidents_are_silent: true,
      emergency_bypasses_daily_budget: true,
    },
    fleet: { generated_at: null, total: 0, counts: {}, needs_attention: [] },
    learning: { total: 0, proposed: 0, held: 0, adopted: 0, promoted: 0, closure_rate: 0 },
    agents: [],
    incidents: [],
    transitions: [],
    quiet: {
      scans: 0,
      baseline_suppressions: 0,
      unchanged_suppressions: 0,
      budget_suppressions: 0,
      notifications_sent: 0,
      recoveries_closed_silently: 0,
      last_notification_at: null,
      last_notification_incident_ids: [],
    },
  };
}

function normalizeState(input, now = new Date()) {
  const base = emptyState(now);
  if (!input || typeof input !== 'object') return base;
  return {
    ...base,
    ...input,
    protocol_version: PROTOCOL_VERSION,
    connection: { ...base.connection, ...(input.connection || {}) },
    policy: { ...base.policy, ...(input.policy || {}) },
    fleet: { ...base.fleet, ...(input.fleet || {}) },
    learning: { ...base.learning, ...(input.learning || {}) },
    quiet: { ...base.quiet, ...(input.quiet || {}) },
    agents: Array.isArray(input.agents) ? input.agents : [],
    incidents: Array.isArray(input.incidents) ? input.incidents : [],
    transitions: Array.isArray(input.transitions) ? input.transitions : [],
  };
}

function severityForStatus(status, row = {}, now = new Date()) {
  if (status === 'failed' || status === 'stuck') return 'critical';
  if (status === 'blocked') return 'high';
  if (status === 'overdue') {
    const since = new Date(row.overdueSince || row.overdue_since || 0).getTime();
    if (Number.isFinite(since) && since > 0 && now.getTime() - since >= 6 * 60 * 60 * 1000) return 'high';
    return 'medium';
  }
  return 'low';
}

function issueNeedsHuman(text, kind, severity) {
  if (severity === 'critical' || kind === 'config') return true;
  if (/needs? human|credential|expired|unset|task scheduler|not bound|no teamwork|missing|permission|access|authenticate|configuration/i.test(text)) return true;
  return false;
}

function normalizeIssueSignature(message) {
  return clean(message, 800)
    .toLowerCase()
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t[^ ]+)?\b/g, '<date>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .slice(0, 500);
}

function operationalObservation(row, now) {
  const status = clean(row.status, 40).toLowerCase();
  if (!ATTENTION_STATUSES.has(status)) return null;
  const severity = severityForStatus(status, row, now);
  const detail = clean(row.detail || row.run?.error || row.run?.message || `${row.client || row.slug} is ${status}`, 1200);
  return {
    key: `${row.slug}:operational`, source: 'fleet_status', kind: 'operational',
    agent_slug: clean(row.slug, 160), client: clean(row.client, 240),
    title: `${clean(row.client || row.slug, 220)} is ${status}`,
    detail, severity, requires_human: issueNeedsHuman(detail, 'operational', severity),
    observed_at: now.toISOString(), evidence_ref: `fleet:status:${row.slug}:${status}`,
    status_value: status,
  };
}

function configObservations(agent, now) {
  return (Array.isArray(agent.configWarnings) ? agent.configWarnings : []).map(warning => {
    const severity = warning.severity === 'crit' ? 'high' : 'medium';
    const detail = clean(warning.detail || warning.title, 1200);
    return {
      key: `${agent.slug}:config:${clean(warning.code, 120)}`,
      source: 'list_agents', kind: 'config', agent_slug: clean(agent.slug, 160),
      client: clean(agent.client, 240), title: clean(warning.title || warning.code, 300),
      detail, severity, requires_human: true, observed_at: now.toISOString(),
      evidence_ref: `fleet:config:${agent.slug}:${warning.code}`,
      status_value: clean(warning.code, 120),
    };
  });
}

function eventObservation(event, now) {
  const message = clean(event.message, 1200);
  if (!message || !event.slug) return null;
  const signature = normalizeIssueSignature(message);
  const severity = event.severity === 'critical'
    ? 'critical'
    : event.type === 'blocked' ? 'high' : 'medium';
  return {
    key: `${event.slug}:event:${hash(`${event.type}:${signature}`)}`,
    source: 'recent_activity', kind: 'event', agent_slug: clean(event.slug, 160),
    client: clean(event.client, 240), title: message.slice(0, 180), detail: message,
    severity, requires_human: issueNeedsHuman(message, 'event', severity),
    observed_at: timestamp(event.occurredAt, now), evidence_ref: `fleet:event:${event.id || hash(message)}`,
    status_value: clean(event.type || 'warning', 80),
  };
}

function learningSummary(rows) {
  const byStatus = Object.fromEntries((rows || []).map(item => [item.status, Number(item.total) || 0]));
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
  const closed = (byStatus.adopted || 0) + (byStatus.promoted || 0);
  return {
    total,
    proposed: byStatus.proposed || 0,
    held: byStatus.held || 0,
    adopted: byStatus.adopted || 0,
    promoted: byStatus.promoted || 0,
    rejected: byStatus.rejected || 0,
    superseded: byStatus.superseded || 0,
    closure_rate: total ? closed / total : 0,
  };
}

function transition(state, incident, kind, at, note) {
  state.transitions.unshift({
    id: `fleet-transition-${hash(`${incident.id}:${kind}:${at}:${note}`)}`,
    incident_id: incident.id, agent_slug: incident.agent_slug, kind,
    at, note: clean(note, 500),
  });
  state.transitions = state.transitions.slice(0, MAX_TRANSITIONS);
}

function calmAfterIncident(incident, agentBySlug) {
  const agent = agentBySlug.get(incident.agent_slug);
  if (!agent || !CALM_STATUSES.has(agent.status)) return false;
  if (incident.kind !== 'event') return true;
  const runAt = new Date(agent.run?.startedAt || agent.lastRunAt || 0).getTime();
  const seenAt = new Date(incident.last_seen_at || 0).getTime();
  return Number.isFinite(runAt) && runAt > seenAt && agent.run?.status === 'ok';
}

function reconcileState(previous, snapshot, { now = new Date(), notify = true } = {}) {
  const state = normalizeState(previous, now);
  const baseline = !state.baseline_at;
  const priorByKey = new Map(state.incidents.map(incident => [incident.key, incident]));
  const observations = snapshot.observations || [];
  const activeKeys = new Set();
  const material = [];

  for (const observation of observations) {
    activeKeys.add(observation.key);
    const existing = priorByKey.get(observation.key);
    if (!existing) {
      const incident = {
        id: `fleet-incident-${hash(observation.key)}`,
        key: observation.key,
        status: 'open', acknowledged_at: null, acknowledged_by: null,
        opened_at: observation.observed_at, last_seen_at: observation.observed_at,
        last_changed_at: observation.observed_at, occurrences: 1,
        notified_at: null, notification_count: 0,
        ...observation,
      };
      state.incidents.unshift(incident);
      priorByKey.set(incident.key, incident);
      transition(state, incident, 'opened', observation.observed_at, observation.detail);
      material.push({ incident, change: 'opened' });
      continue;
    }

    const priorRank = SEVERITY_RANK[existing.severity] || 0;
    const nextRank = SEVERITY_RANK[observation.severity] || 0;
    const changed = existing.status !== 'open'
      || existing.status_value !== observation.status_value
      || nextRank > priorRank
      || (!existing.requires_human && observation.requires_human);
    existing.status = 'open';
    existing.last_seen_at = observation.observed_at;
    existing.occurrences = Math.max(0, Number(existing.occurrences) || 0) + 1;
    Object.assign(existing, observation);
    if (changed) {
      existing.last_changed_at = observation.observed_at;
      existing.acknowledged_at = null;
      existing.acknowledged_by = null;
      transition(state, existing, 'changed', observation.observed_at, observation.detail);
      material.push({ incident: existing, change: 'changed' });
    } else {
      state.quiet.unchanged_suppressions += 1;
    }
  }

  const agentBySlug = new Map((snapshot.agents || []).map(agent => [agent.slug, agent]));
  for (const incident of state.incidents) {
    if (incident.status !== 'open' || activeKeys.has(incident.key)) continue;
    const shouldResolve = incident.kind === 'config'
      || incident.kind === 'operational'
      || calmAfterIncident(incident, agentBySlug);
    if (!shouldResolve) continue;
    incident.status = 'resolved';
    incident.resolved_at = now.toISOString();
    incident.last_changed_at = now.toISOString();
    transition(state, incident, 'resolved', now.toISOString(), 'Later Fleet evidence showed the condition cleared.');
    state.quiet.recoveries_closed_silently += 1;
  }

  if (baseline) {
    state.baseline_at = now.toISOString();
    state.quiet.baseline_suppressions += material.length;
  }

  state.incidents.sort((left, right) => {
    const open = Number(right.status === 'open') - Number(left.status === 'open');
    if (open) return open;
    const severity = (SEVERITY_RANK[right.severity] || 0) - (SEVERITY_RANK[left.severity] || 0);
    if (severity) return severity;
    return String(right.last_changed_at || '').localeCompare(String(left.last_changed_at || ''));
  });
  state.incidents = state.incidents.slice(0, MAX_INCIDENTS);
  state.agents = snapshot.agents || [];
  state.fleet = snapshot.fleet || state.fleet;
  state.learning = snapshot.learning || state.learning;
  state.last_scan_at = now.toISOString();
  state.last_success_at = now.toISOString();
  state.last_error = null;
  state.updated_at = now.toISOString();
  state.quiet.scans += 1;

  const candidates = baseline || !notify ? [] : material
    .map(item => item.incident)
    .filter(incident => incident.status === 'open'
      && !incident.acknowledged_at
      && incident.requires_human
      && (!incident.notified_at || incident.last_changed_at > incident.notified_at))
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  return { state, baseline, material, candidates };
}

function interruptionMessage(candidates) {
  const visible = candidates.slice(0, 3);
  const heading = candidates.length === 1
    ? 'Fleet needs one intervention.'
    : `Fleet needs attention on ${candidates.length} incidents.`;
  const lines = visible.map(incident => `• ${incident.client || incident.agent_slug}: ${incident.title}`);
  if (candidates.length > visible.length) lines.push(`• ${candidates.length - visible.length} more are grouped in Nora's Fleet view.`);
  return [heading, ...lines, 'I am tracking these as durable incidents and will stay quiet unless something materially changes.'].join('\n');
}

function publicSnapshot(state, budget = null) {
  const current = normalizeState(state);
  const open = current.incidents.filter(incident => incident.status === 'open');
  return {
    protocol_version: current.protocol_version,
    mode: current.mode,
    baseline_at: current.baseline_at,
    last_scan_at: current.last_scan_at,
    last_success_at: current.last_success_at,
    last_error: current.last_error,
    updated_at: current.updated_at,
    connection: current.connection,
    policy: current.policy,
    budget,
    fleet: current.fleet,
    learning: current.learning,
    summary: {
      open: open.length,
      critical: open.filter(item => item.severity === 'critical').length,
      needs_human: open.filter(item => item.requires_human).length,
      acknowledged: open.filter(item => item.acknowledged_at).length,
      resolved: current.incidents.filter(item => item.status === 'resolved').length,
    },
    agents: current.agents,
    incidents: current.incidents,
    transitions: current.transitions.slice(0, 80),
    quiet: current.quiet,
  };
}

function createFleetSupervisor({
  mcpManager,
  loadState = async () => null,
  saveState = async () => {},
  notifyHuman = async () => false,
  handoffCandidates = null,
  getInterruptionBudget = () => ({ remaining: 0 }),
  spendInterruption = () => ({ allowed: false, remaining: 0 }),
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!mcpManager) throw new Error('mcpManager is required');
  let state = emptyState(now());
  let hydrated = false;
  let inFlight = null;

  async function hydrate() {
    if (hydrated) return state;
    state = normalizeState(await loadState(), now());
    hydrated = true;
    return state;
  }

  async function persist() {
    state.updated_at = now().toISOString();
    await saveState(state);
  }

  function fleetConnection() {
    return mcpManager.list().find(connection => connection.status === 'connected'
      && connection.enabled !== false && isFleetConnection(connection));
  }

  async function call(connection, tool, args, signal) {
    return decodeToolResult(await mcpManager.callTool(connection.id, tool, args || {}, { timeout: 20000, signal }));
  }

  async function collect(connection, signal) {
    const statuses = ['proposed', 'held', 'adopted', 'promoted', 'rejected', 'superseded'];
    const [fleet, configured, activity, ...learningRows] = await Promise.all([
      call(connection, 'fleet_status', {}, signal),
      call(connection, 'list_agents', { limit: 200 }, signal),
      call(connection, 'recent_activity', { limit: 100 }, signal),
      ...statuses.map(status => call(connection, 'list_learnings', { status, limit: 1 }, signal)),
    ]);
    const scanTime = now();
    const fleetAgents = Array.isArray(fleet?.agents) ? fleet.agents : [];
    const configuredAgents = Array.isArray(configured?.agents) ? configured.agents : [];
    const configuredBySlug = new Map(configuredAgents.map(agent => [agent.slug, agent]));
    const agents = fleetAgents.map(agent => {
      const config = configuredBySlug.get(agent.slug) || {};
      return {
        slug: clean(agent.slug, 160), client: clean(agent.client || config.client, 240),
        platform: clean(agent.platform || config.platform, 80), cadence: clean(agent.cadence || config.cadence, 80),
        status: clean(agent.status, 40), severity: clean(agent.severity, 40), detail: clean(agent.detail, 900),
        lastRunAt: agent.lastRunAt || null, lastSeenAt: agent.lastSeenAt || null,
        nextExpectedRunAt: agent.nextExpectedRunAt || null,
        run: agent.run ? { id: agent.run.id, status: agent.run.status, message: clean(agent.run.message, 500), startedAt: agent.run.startedAt } : null,
        teamwork: config.teamwork || null,
        configWarnings: Array.isArray(config.configWarnings) ? config.configWarnings : [],
        runnerReady: Boolean(config.runnerReady),
      };
    });
    const observations = [
      ...fleetAgents.map(agent => operationalObservation(agent, scanTime)).filter(Boolean),
      ...configuredAgents.flatMap(agent => configObservations(agent, scanTime)),
    ];
    const cutoff = state.last_scan_at
      ? new Date(state.last_scan_at).getTime() - 60 * 1000
      : scanTime.getTime() - EVENT_LOOKBACK_MS;
    for (const event of Array.isArray(activity?.events) ? activity.events : []) {
      const occurred = new Date(event.occurredAt || 0).getTime();
      if (!Number.isFinite(occurred) || occurred < cutoff) continue;
      const observation = eventObservation(event, scanTime);
      if (observation) observations.push(observation);
    }
    return {
      fleet: {
        generated_at: fleet?.generatedAt || scanTime.toISOString(),
        total: Number(fleet?.total) || fleetAgents.length,
        counts: fleet?.counts || {},
        needs_attention: Array.isArray(fleet?.needsAttention) ? fleet.needsAttention : [],
      },
      agents,
      observations,
      learning: learningSummary(statuses.map((status, index) => ({ status, total: learningRows[index]?.total }))),
    };
  }

  async function deliverCandidates(candidates) {
    if (!candidates.length) return { sent: false, reason: 'none' };
    if (typeof handoffCandidates === 'function') {
      const handoff = await handoffCandidates(candidates);
      if (!handoff?.accepted) return { sent: false, reason: 'firewall_handoff_failed' };
      const at = now().toISOString();
      for (const incident of candidates) {
        incident.firewall_handoff_at = at;
        incident.firewall_case_ids = handoff.case_ids || [];
        transition(state, incident, 'managed_by_executive_firewall', at,
          'Executive Firewall accepted responsibility without notifying the executive.');
      }
      return { sent: false, reason: 'executive_firewall', handed_off: true,
        case_ids: handoff.case_ids || [] };
    }
    const emergency = candidates.some(incident => incident.severity === 'critical');
    let budget = getInterruptionBudget();
    if (!emergency) {
      if (!budget || Number(budget.remaining) <= 0) {
        state.quiet.budget_suppressions += candidates.length;
        return { sent: false, reason: 'budget_exhausted', budget };
      }
      budget = spendInterruption({
        kind: 'fleet_supervisor',
        incident_ids: candidates.map(incident => incident.id),
      });
      if (!budget?.allowed) {
        state.quiet.budget_suppressions += candidates.length;
        return { sent: false, reason: 'budget_reservation_failed', budget };
      }
    }
    const sent = await notifyHuman(interruptionMessage(candidates));
    if (!sent) return { sent: false, reason: 'delivery_failed', budget };
    const at = now().toISOString();
    for (const incident of candidates) {
      incident.notified_at = at;
      incident.notification_count = Math.max(0, Number(incident.notification_count) || 0) + 1;
      transition(state, incident, 'notified', at, emergency ? 'Critical incident notification sent.' : 'Shared interruption slot used.');
    }
    state.quiet.notifications_sent += 1;
    state.quiet.last_notification_at = at;
    state.quiet.last_notification_incident_ids = candidates.map(incident => incident.id);
    return { sent: true, reason: emergency ? 'critical' : 'budgeted', budget };
  }

  async function runScan(options = {}) {
    await hydrate();
    const connection = fleetConnection();
    if (!connection) {
      state.connection = { available: false, name: null, usable_tools: 0 };
      state.last_scan_at = now().toISOString();
      state.last_error = 'The connected read-only Fleet MCP is unavailable.';
      await persist();
      return { ...publicSnapshot(state, getInterruptionBudget()), scan: { ok: false, reason: 'connection_unavailable' } };
    }
    state.connection = {
      available: true,
      name: connection.name,
      usable_tools: (connection.tools || []).filter(tool => tool.allowed !== false).length,
    };
    try {
      const snapshot = await collect(connection, options.signal);
      const result = reconcileState(state, snapshot, { now: now(), notify: options.notify !== false });
      state = result.state;
      const delivery = await deliverCandidates(result.candidates);
      await persist();
      return {
        ...publicSnapshot(state, getInterruptionBudget()),
        scan: { ok: true, baseline: result.baseline, material_changes: result.material.length, candidates: result.candidates.length, delivery },
      };
    } catch (error) {
      state.last_scan_at = now().toISOString();
      state.last_error = clean(error?.message || error || 'Fleet scan failed', 500);
      state.updated_at = now().toISOString();
      await persist();
      logger.warn?.(`Fleet supervisor scan failed: ${state.last_error}`);
      return { ...publicSnapshot(state, getInterruptionBudget()), scan: { ok: false, reason: 'scan_failed' } };
    }
  }

  function scan(options = {}) {
    if (inFlight) return inFlight;
    inFlight = runScan(options).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function snapshot() {
    await hydrate();
    return publicSnapshot(state, getInterruptionBudget());
  }

  async function acknowledge(incidentId, actor = 'operator') {
    await hydrate();
    const incident = state.incidents.find(item => item.id === incidentId);
    if (!incident) return null;
    if (!incident.acknowledged_at) {
      incident.acknowledged_at = now().toISOString();
      incident.acknowledged_by = clean(actor, 120) || 'operator';
      transition(state, incident, 'acknowledged', incident.acknowledged_at, 'Operator acknowledged the incident.');
      await persist();
    }
    return incident;
  }

  function promptContext() {
    if (!hydrated) return '';
    const open = state.incidents.filter(incident => incident.status === 'open');
    const needsHuman = open.filter(incident => incident.requires_human && !incident.acknowledged_at);
    const top = open.slice(0, 5).map(incident =>
      `- ${incident.agent_slug}: ${incident.title} (${incident.severity}, ${incident.requires_human ? 'human action may be needed' : 'monitoring'})`);
    return `\n\nDURABLE FLEET SUPERVISOR STATE: ${open.length} open incident(s), ${needsHuman.length} unacknowledged human-action candidate(s). This is your private management ledger, not a status message. Repeated or unchanged conditions stay silent. Recovery closes silently. Never announce normal, idle, or off-hours agents. Fleet exceptions enter the Executive Firewall for team-first resolution; never message John about them directly.\n${top.length ? top.join('\n') : '- No open Fleet incidents.'}`;
  }

  return { STATE_KEY, hydrate, scan, snapshot, acknowledge, promptContext };
}

module.exports = {
  PROTOCOL_VERSION,
  STATE_KEY,
  emptyState,
  normalizeState,
  decodeToolResult,
  normalizeIssueSignature,
  operationalObservation,
  configObservations,
  eventObservation,
  learningSummary,
  reconcileState,
  interruptionMessage,
  publicSnapshot,
  createFleetSupervisor,
};
