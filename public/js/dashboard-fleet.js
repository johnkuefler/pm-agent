var fleetSupervisorState = null;
var fleetSupervisorFilter = 'open';

function fleetRelativeTime(value) {
  const time = new Date(value || 0).getTime();
  if (!Number.isFinite(time) || !time) return 'not yet';
  const delta = Date.now() - time;
  if (delta < 60000) return 'just now';
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return `${Math.floor(delta / 86400000)}d ago`;
}

function fleetStat(label, value, detail, tone = '') {
  return `<article class="portfolio-stat ${tone}"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong><small>${escHtml(detail)}</small></article>`;
}

function fleetStatusLabel(value) {
  return String(value || 'unknown').replaceAll('-', ' ');
}

function renderFleetStats(state) {
  const summary = state.summary || {};
  const fleet = state.fleet || {};
  const quiet = state.quiet || {};
  const budget = state.budget || {};
  document.getElementById('fleet-supervisor-stats').innerHTML = [
    fleetStat('Agent team', String(fleet.total || 0), 'configured agents', 'is-primary'),
    fleetStat('Open incidents', String(summary.open || 0), summary.open ? 'durable, deduplicated records' : 'nothing needs management', summary.open ? 'is-warn' : ''),
    fleetStat('Needs human', String(summary.needs_human || 0), 'actionable, not routine noise', summary.needs_human ? 'is-danger' : ''),
    fleetStat('Quiet closures', String(quiet.recoveries_closed_silently || 0), 'recoveries closed without a message'),
    fleetStat('Interruptions today', `${budget.spent || 0}/${budget.limit == null ? 1 : budget.limit}`, `${budget.remaining == null ? 0 : budget.remaining} shared slot remaining`),
  ].join('');
}

function fleetIncidentCard(incident) {
  const acknowledged = incident.acknowledged_at ? '<span class="fleet-incident-ack">Acknowledged</span>' : '';
  const human = incident.requires_human ? '<span class="fleet-incident-human">Human action</span>' : '<span>Monitoring</span>';
  return `<button class="fleet-incident-card is-${escHtml(incident.severity || 'low')}" type="button" data-incident-id="${escHtml(incident.id)}" onclick="openFleetIncident(this.dataset.incidentId)">
    <div class="fleet-incident-card-top"><span>${escHtml(incident.client || incident.agent_slug)}</span><span>${escHtml(incident.severity || 'low')}</span></div>
    <h3>${escHtml(incident.title || 'Fleet incident')}</h3>
    <p>${escHtml(incident.detail || 'No additional detail was reported.')}</p>
    <div class="fleet-incident-meta">${human}${acknowledged}<span>${incident.occurrences || 1} observation${Number(incident.occurrences) === 1 ? '' : 's'}</span><span>changed ${escHtml(fleetRelativeTime(incident.last_changed_at))}</span></div>
  </button>`;
}

function renderFleetIncidents(state) {
  const all = Array.isArray(state.incidents) ? state.incidents : [];
  const incidents = all.filter(incident => {
    if (fleetSupervisorFilter === 'human') return incident.status === 'open' && incident.requires_human;
    if (fleetSupervisorFilter === 'resolved') return incident.status === 'resolved';
    return incident.status === 'open';
  });
  document.querySelectorAll('.fleet-filter').forEach(button => {
    const active = button.dataset.fleetFilter === fleetSupervisorFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.getElementById('fleet-incident-summary').textContent = incidents.length
    ? `${incidents.length} ${fleetSupervisorFilter === 'resolved' ? 'resolved' : 'active'} incident${incidents.length === 1 ? '' : 's'}, with repeated evidence merged.`
    : fleetSupervisorFilter === 'resolved' ? 'No recoveries have been recorded yet.' : 'No incidents match this view.';
  document.getElementById('fleet-incident-list').innerHTML = incidents.length
    ? incidents.map(fleetIncidentCard).join('')
    : '<div class="fleet-clear-state"><span aria-hidden="true">✓</span><div><strong>Nothing needs attention here</strong><p>Nora does not turn a quiet Fleet into a status report.</p></div></div>';
}

function renderFleetQuietState(state) {
  const quiet = state.quiet || {};
  const policy = state.policy || {};
  const budget = state.budget || {};
  const rows = [
    ['Repeated signals suppressed', quiet.unchanged_suppressions || 0],
    ['Baseline items kept private', quiet.baseline_suppressions || 0],
    ['Budget suppressions', quiet.budget_suppressions || 0],
    ['Person-facing messages', quiet.notifications_sent || 0],
  ];
  document.getElementById('fleet-quiet-state').innerHTML = `
    <div class="fleet-posture"><strong>Silent by default</strong><p>Normal, off-hours, unchanged, and recovered conditions do not produce a message.</p></div>
    <div class="fleet-quiet-list">${rows.map(([label, value]) => `<div><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong></div>`).join('')}</div>
    <div class="fleet-budget"><span>Shared daily interruption budget</span><strong>${budget.remaining == null ? 0 : budget.remaining} remaining</strong></div>
    <small>${policy.emergency_bypasses_daily_budget ? 'A new critical incident may bypass the daily slot once, but repeated evidence still merges.' : 'All incidents respect the daily slot.'}</small>`;
}

function renderFleetLearning(state) {
  const learning = state.learning || {};
  const total = Number(learning.total) || 0;
  const closed = (Number(learning.adopted) || 0) + (Number(learning.promoted) || 0);
  const rate = total ? Math.round(closed / total * 100) : 0;
  document.getElementById('fleet-learning-state').innerHTML = `
    <div class="fleet-learning-rate"><strong>${rate}%</strong><span>adopted or promoted</span></div>
    <div class="fleet-learning-meter"><i style="width:${Math.max(0, Math.min(100, rate))}%"></i></div>
    <div class="fleet-quiet-list">
      <div><span>Proposed</span><strong>${Number(learning.proposed) || 0}</strong></div>
      <div><span>Held</span><strong>${Number(learning.held) || 0}</strong></div>
      <div><span>Adopted</span><strong>${Number(learning.adopted) || 0}</strong></div>
      <div><span>Promoted</span><strong>${Number(learning.promoted) || 0}</strong></div>
    </div>
    <p class="fleet-learning-note">The goal is verified transfer into better agent behavior, not a larger pile of observations.</p>`;
}

function fleetAgentCard(agent) {
  const warnings = Array.isArray(agent.configWarnings) ? agent.configWarnings : [];
  const teamwork = agent.teamwork || {};
  const warning = warnings[0];
  return `<article class="fleet-agent-card is-${escHtml(agent.status || 'unknown')}">
    <div class="fleet-agent-card-top"><span>${escHtml(agent.client || agent.slug)}</span><span class="fleet-status-pill">${escHtml(fleetStatusLabel(agent.status))}</span></div>
    <h3>${escHtml(agent.slug)}</h3>
    <p>${escHtml(agent.detail || 'No current exception.')}</p>
    <dl><div><dt>Cadence</dt><dd>${escHtml(agent.cadence || 'unknown')}</dd></div><div><dt>Last run</dt><dd>${escHtml(fleetRelativeTime(agent.lastRunAt))}</dd></div><div><dt>Teamwork</dt><dd>${escHtml(teamwork.tasklistName || 'not bound')}</dd></div></dl>
    ${warning ? `<div class="fleet-agent-warning"><strong>${escHtml(warning.title)}</strong><span>${escHtml(warning.detail)}</span></div>` : ''}
  </article>`;
}

function renderFleetAgents(state) {
  const rank = { failed: 0, stuck: 1, blocked: 2, overdue: 3, idle: 4, healthy: 5, 'off-hours': 6, paused: 7 };
  const agents = [...(state.agents || [])].sort((left, right) =>
    (rank[left.status] == null ? 8 : rank[left.status]) - (rank[right.status] == null ? 8 : rank[right.status])
    || String(left.client || '').localeCompare(String(right.client || '')));
  document.getElementById('fleet-agent-list').innerHTML = agents.length
    ? agents.map(fleetAgentCard).join('')
    : '<p class="portfolio-empty">No Fleet agents are visible through Nora\'s read-only connection.</p>';
}

function renderFleetSupervisor(state) {
  fleetSupervisorState = state;
  renderFleetStats(state);
  renderFleetIncidents(state);
  renderFleetQuietState(state);
  renderFleetLearning(state);
  renderFleetAgents(state);
  const sync = document.getElementById('fleet-supervisor-sync');
  if (state.last_error) {
    sync.className = 'fleet-sync is-error';
    sync.textContent = state.last_error;
  } else {
    sync.className = 'fleet-sync is-ready';
    sync.textContent = state.last_success_at
      ? `Quiet scan completed ${fleetRelativeTime(state.last_success_at)}`
      : 'Baseline has not been established yet.';
  }
}

async function loadFleetSupervisor() {
  const list = document.getElementById('fleet-incident-list');
  if (!fleetSupervisorState) list.innerHTML = '<div class="portfolio-loading"><span></span><span></span><span></span></div>';
  try {
    const response = await api('/fleet-supervisor');
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Fleet supervisor unavailable');
    renderFleetSupervisor(state);
  } catch (error) {
    list.innerHTML = `<div class="portfolio-load-error"><strong>Fleet supervisor unavailable</strong><span>${escHtml(error.message)}</span><button class="btn btn-sm" type="button" onclick="loadFleetSupervisor()">Try again</button></div>`;
  }
}

async function scanFleetSupervisor(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Scanning';
  try {
    const response = await operatorApi('/fleet-supervisor/scan', { method: 'POST' });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'Fleet scan failed');
    renderFleetSupervisor(state);
  } catch (error) {
    const sync = document.getElementById('fleet-supervisor-sync');
    sync.className = 'fleet-sync is-error';
    sync.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function setFleetFilter(filter) {
  fleetSupervisorFilter = ['open', 'human', 'resolved'].includes(filter) ? filter : 'open';
  if (fleetSupervisorState) renderFleetIncidents(fleetSupervisorState);
}

function openFleetIncident(incidentId) {
  const incident = (fleetSupervisorState?.incidents || []).find(item => item.id === incidentId);
  if (!incident) return;
  const detail = document.getElementById('fleet-incident-detail');
  const evidence = escHtml(incident.evidence_ref || 'Fleet evidence');
  detail.innerHTML = `<span class="portfolio-kicker">${escHtml(incident.agent_slug)}</span>
    <h2 id="fleet-dialog-title">${escHtml(incident.title)}</h2>
    <div class="fleet-dialog-badges"><span class="is-${escHtml(incident.severity)}">${escHtml(incident.severity)}</span><span>${escHtml(incident.status)}</span>${incident.requires_human ? '<span>Human action</span>' : '<span>Monitoring</span>'}</div>
    <p class="fleet-dialog-detail">${escHtml(incident.detail)}</p>
    <dl class="fleet-dialog-facts"><div><dt>Opened</dt><dd>${escHtml(new Date(incident.opened_at).toLocaleString())}</dd></div><div><dt>Last changed</dt><dd>${escHtml(new Date(incident.last_changed_at).toLocaleString())}</dd></div><div><dt>Observations</dt><dd>${incident.occurrences || 1}</dd></div><div><dt>Evidence</dt><dd>${evidence}</dd></div></dl>
    ${incident.status === 'open' && !incident.acknowledged_at ? `<button class="btn btn-primary btn-sm" type="button" data-incident-id="${escHtml(incident.id)}" onclick="acknowledgeFleetIncident(this.dataset.incidentId,this)">Acknowledge and keep tracking</button>` : '<p class="fleet-dialog-note">This incident is already acknowledged or resolved. Nora will continue tracking it silently.</p>'}`;
  document.getElementById('fleet-incident-dialog').showModal();
}

async function acknowledgeFleetIncident(incidentId, button) {
  button.disabled = true;
  try {
    const response = await operatorApi(`/fleet-supervisor/incidents/${encodeURIComponent(incidentId)}/acknowledge`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Incident could not be acknowledged');
    const index = fleetSupervisorState.incidents.findIndex(item => item.id === incidentId);
    if (index >= 0) fleetSupervisorState.incidents[index] = body.incident;
    document.getElementById('fleet-incident-dialog').close();
    renderFleetSupervisor(fleetSupervisorState);
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}
