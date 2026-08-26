// Teamwork-first project browser. This screen is intentionally read-only apart from sync.
var selectedPortfolioProjectKey = null;
var projectPortfolioFilter = 'attention';
var projectPortfolioState = { projects: [], risks: [], report: {}, hydration: {} };

function portfolioDateValue(value) {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function portfolioStartOfToday() {
  const today = new Date();
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

function portfolioDate(value, fallback = 'Not scheduled') {
  const parsed = portfolioDateValue(value);
  if (parsed === null) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(parsed));
}

function portfolioRelativeTime(value) {
  const parsed = portfolioDateValue(value);
  if (parsed === null) return 'not yet';
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function portfolioProjectSignals(project) {
  const schedule = project.hydration?.schedule || {};
  const due = portfolioDateValue(project.next_milestone_due);
  const openRisks = projectPortfolioState.risks.filter(risk => risk.project_key === project.key
    && ['open', 'monitoring'].includes(risk.status));
  const decisions = Number(project.decision_state?.open_count) || 0;
  const overdueTasks = Number(schedule.overdue_tasks) || 0;
  const unassignedTasks = Number(schedule.unassigned_tasks) || 0;
  const hydrated = project.hydration?.source === 'teamwork_project_story';
  const checkpointOverdue = due !== null && due < portfolioStartOfToday();
  const healthAttention = ['red', 'amber'].includes(project.health);
  const attention = checkpointOverdue || overdueTasks > 0 || decisions > 0
    || openRisks.length > 0 || healthAttention || unassignedTasks > 0;
  return { due, openRisks, decisions, overdueTasks, unassignedTasks, hydrated,
    checkpointOverdue, healthAttention, attention };
}

function portfolioPriority(project) {
  const signal = portfolioProjectSignals(project);
  const severity = signal.openRisks.reduce((score, risk) => Math.max(score,
    ['low', 'medium', 'high', 'critical'].indexOf(risk.severity) + 1), 0);
  return severity * 120 + (project.health === 'red' ? 400 : project.health === 'amber' ? 220 : 0)
    + (signal.checkpointOverdue ? 180 : 0) + Math.min(120, signal.overdueTasks * 12)
    + Math.min(100, signal.decisions * 14) + Math.min(50, signal.unassignedTasks * 3);
}

function renderPortfolioStats() {
  const active = projectPortfolioState.projects.filter(project => portfolioProjectSignals(project).hydrated);
  const signals = active.map(portfolioProjectSignals);
  const values = [
    ['Active projects', active.length],
    ['Needs attention', signals.filter(signal => signal.attention).length],
    ['Overdue tasks', signals.reduce((sum, signal) => sum + signal.overdueTasks, 0)],
    ['Unassigned tasks', signals.reduce((sum, signal) => sum + signal.unassignedTasks, 0)],
    ['Open decisions', signals.reduce((sum, signal) => sum + signal.decisions, 0)],
  ];
  document.getElementById('pm-control-stats').innerHTML = values.map(([label, value]) =>
    `<div class="portfolio-stat"><span>${escHtml(label)}</span><strong>${value}</strong></div>`).join('');
}

function renderHydrationStatus() {
  const status = document.getElementById('pm-hydration-status');
  const hydration = projectPortfolioState.hydration || {};
  status.dataset.state = hydration.state || 'idle';
  if (hydration.state === 'running') status.lastElementChild.textContent = 'Syncing Teamwork now';
  else if (hydration.state === 'failed') status.lastElementChild.textContent =
    `Sync failed: ${hydration.error || 'unknown error'}`;
  else if (hydration.state === 'succeeded') status.lastElementChild.textContent =
    `Current as of ${portfolioRelativeTime(hydration.completed_at)}`;
  else status.lastElementChild.textContent = 'Teamwork has not synced yet';
}

function setProjectFilter(filter) {
  projectPortfolioFilter = filter;
  document.querySelectorAll('[data-project-filter]').forEach(button => {
    const active = button.dataset.projectFilter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  renderProjectPortfolio();
}

function portfolioProjectCard(project) {
  const signal = portfolioProjectSignals(project);
  const chips = [];
  if (signal.checkpointOverdue) chips.push(['Checkpoint past due', 'danger']);
  if (signal.overdueTasks) chips.push([`${signal.overdueTasks} overdue`, 'danger']);
  if (signal.unassignedTasks) chips.push([`${signal.unassignedTasks} unassigned`, 'warn']);
  if (signal.decisions) chips.push([`${signal.decisions} decision${signal.decisions === 1 ? '' : 's'}`, 'warn']);
  if (!chips.length) chips.push(['On track', 'success']);
  return `<button class="portfolio-project-card${signal.attention ? ' needs-attention' : ''}" type="button" data-project-key="${escHtml(project.key)}" onclick="viewProject(this.dataset.projectKey)">
    <div class="portfolio-card-main"><span>${escHtml(project.client || 'Client not recorded')}</span><h3>${escHtml(project.name)}</h3>
      <p>${escHtml(project.objective || 'Project objective not recorded in Teamwork.')}</p></div>
    <div class="portfolio-card-owner"><span>PM</span><strong>${escHtml(project.pm || 'Unassigned')}</strong></div>
    <div class="portfolio-card-date"><span>Next checkpoint</span><strong>${escHtml(project.next_milestone || 'Not scheduled')}</strong><small>${escHtml(portfolioDate(project.next_milestone_due))}</small></div>
    <div class="portfolio-chip-row">${chips.slice(0, 3).map(([label, tone]) =>
      `<span class="portfolio-chip is-${tone}">${escHtml(label)}</span>`).join('')}</div>
  </button>`;
}

function renderProjectPortfolio() {
  const active = projectPortfolioState.projects.filter(project => portfolioProjectSignals(project).hydrated);
  const counts = {
    attention: active.filter(project => portfolioProjectSignals(project).attention).length,
    overdue: active.filter(project => {
      const signal = portfolioProjectSignals(project);
      return signal.checkpointOverdue || signal.overdueTasks > 0;
    }).length,
    decisions: active.filter(project => portfolioProjectSignals(project).decisions > 0).length,
    all: active.length,
  };
  Object.entries(counts).forEach(([name, count]) => {
    const element = document.getElementById(`portfolio-filter-${name}-count`);
    if (element) element.textContent = count;
  });

  let projects = active.filter(project => {
    const signal = portfolioProjectSignals(project);
    if (projectPortfolioFilter === 'attention') return signal.attention;
    if (projectPortfolioFilter === 'overdue') return signal.checkpointOverdue || signal.overdueTasks > 0;
    if (projectPortfolioFilter === 'decisions') return signal.decisions > 0;
    return true;
  });
  const search = String(document.getElementById('portfolio-search')?.value || '').trim().toLowerCase();
  if (search) projects = projects.filter(project => [project.name, project.client, project.pm]
    .some(value => String(value || '').toLowerCase().includes(search)));
  const sort = document.getElementById('portfolio-sort')?.value || 'priority';
  projects.sort((left, right) => {
    if (sort === 'project') return left.name.localeCompare(right.name);
    if (sort === 'pm') return String(left.pm || 'zz').localeCompare(String(right.pm || 'zz'))
      || left.name.localeCompare(right.name);
    if (sort === 'checkpoint') return (portfolioDateValue(left.next_milestone_due) || Infinity)
      - (portfolioDateValue(right.next_milestone_due) || Infinity);
    return portfolioPriority(right) - portfolioPriority(left)
      || (portfolioDateValue(left.next_milestone_due) || Infinity)
      - (portfolioDateValue(right.next_milestone_due) || Infinity);
  });
  document.getElementById('portfolio-result-summary').textContent =
    `${projects.length} of ${active.length} active Teamwork projects shown`;
  document.getElementById('project-list').innerHTML = projects.length
    ? projects.map(portfolioProjectCard).join('')
    : '<div class="portfolio-empty"><strong>No projects match this view.</strong><span>Choose another filter or clear the search.</span></div>';
}

async function loadProjects() {
  document.getElementById('portfolio-overview').style.display = '';
  document.getElementById('project-detail').style.display = 'none';
  const list = document.getElementById('project-list');
  list.innerHTML = '<div class="portfolio-loading"><span></span><span></span></div>';
  try {
    const responses = await Promise.all([api('/pm-control'), api('/pm-control/hydration')]);
    if (responses.some(response => !response.ok)) throw new Error('Project plans could not be loaded');
    const [control, hydration] = await Promise.all(responses.map(response => response.json()));
    projectPortfolioState.projects = control.ledger?.projects || [];
    projectPortfolioState.risks = control.ledger?.risks || [];
    projectPortfolioState.report = control.report || {};
    projectPortfolioState.hydration = hydration || {};
    renderPortfolioStats();
    renderHydrationStatus();
    renderProjectPortfolio();
  } catch (error) {
    list.innerHTML = `<div class="portfolio-load-error"><strong>Projects unavailable</strong><span>${escHtml(error.message)}</span><button class="btn btn-sm" type="button" onclick="loadProjects()">Try again</button></div>`;
  }
}

async function refreshProjectStories(button) {
  const prior = button.textContent;
  const status = document.getElementById('pm-hydration-status');
  button.disabled = true;
  button.textContent = 'Syncing';
  status.dataset.state = 'running';
  status.lastElementChild.textContent = 'Syncing Teamwork now';
  try {
    const response = await api('/pm-control/hydrate/teamwork', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 120000,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Teamwork sync failed');
    await loadProjects();
  } catch (error) {
    status.dataset.state = 'failed';
    status.lastElementChild.textContent = `Sync failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = prior;
  }
}

function projectDetailSection(title, content) {
  return `<section class="section portfolio-story-section"><h3>${escHtml(title)}</h3>${content}</section>`;
}

function viewProject(key) {
  const project = projectPortfolioState.projects.find(item => item.key === key);
  if (!project) return;
  selectedPortfolioProjectKey = key;
  document.getElementById('portfolio-overview').style.display = 'none';
  document.getElementById('project-detail').style.display = 'grid';
  document.getElementById('project-detail-name').textContent = project.name;
  document.getElementById('project-detail-client').textContent = project.client || 'Client not recorded';
  document.getElementById('project-detail-teamwork').textContent = project.teamwork_id
    ? `Teamwork project ${project.teamwork_id}` : 'Teamwork project ID unavailable';
  const signal = portfolioProjectSignals(project);
  const badges = [
    [project.health === 'unknown' ? 'Health not assessed' : `${project.health} health`, project.health],
    [project.phase || 'Phase not recorded', 'neutral'],
  ];
  document.getElementById('project-detail-badges').innerHTML = badges.map(([label, tone]) =>
    `<span class="portfolio-chip is-${escHtml(tone)}">${escHtml(label)}</span>`).join('');

  const schedule = project.hydration?.schedule || {};
  const decisions = project.decision_state?.candidates || [];
  const criticalPath = project.critical_path || [];
  const risks = signal.openRisks;
  const overview = `<p class="portfolio-objective-detail">${escHtml(project.objective || 'Project objective not recorded in Teamwork.')}</p>
    <div class="portfolio-fact-grid">
      <div><span>Project manager</span><strong>${escHtml(project.pm || 'Unassigned')}</strong></div>
      <div><span>Current phase</span><strong>${escHtml(project.phase || 'Not recorded')}</strong></div>
      <div><span>Next checkpoint</span><strong>${escHtml(project.next_milestone || 'Not scheduled')}</strong><small>${escHtml(portfolioDate(project.next_milestone_due))}</small></div>
      <div><span>Health</span><strong>${escHtml(project.health || 'Unknown')}</strong><small>${escHtml(project.health_reason || 'No verified health reason recorded')}</small></div>
    </div>`;
  const scheduleView = `<div class="portfolio-schedule-grid">
    <div><strong>${Number(schedule.open_tasks) || 0}</strong><span>open tasks</span></div>
    <div class="${Number(schedule.overdue_tasks) ? 'is-danger' : ''}"><strong>${Number(schedule.overdue_tasks) || 0}</strong><span>overdue</span></div>
    <div><strong>${Number(schedule.unassigned_tasks) || 0}</strong><span>unassigned</span></div>
    <div><strong>${Number(schedule.open_milestones) || 0}</strong><span>milestones</span></div>
  </div>`;
  const pathView = criticalPath.length
    ? `<ol class="portfolio-path-list">${criticalPath.map(item => `<li>${escHtml(item)}</li>`).join('')}</ol>`
    : '<p class="portfolio-empty">No critical path is recorded.</p>';
  const decisionView = decisions.length ? `<div class="portfolio-detail-list">${decisions.map(item => `
    <article><strong>${escHtml(item.title)}</strong><p>${escHtml(item.description || 'Decision detail is missing from the Teamwork task.')}</p><small>${escHtml((item.assignees || []).join(', ') || 'Unassigned')} · ${escHtml(portfolioDate(item.due_at))}</small></article>`).join('')}</div>`
    : '<p class="portfolio-empty">No open decision candidates.</p>';
  const riskView = risks.length ? `<div class="portfolio-detail-list">${risks.map(risk => `
    <article><strong>${escHtml(risk.title)}</strong><p>${escHtml(risk.next_action || risk.decision_needed || 'Next action not recorded')}</p><small>${escHtml(risk.severity)} · ${escHtml(risk.owner || 'Unowned')}</small></article>`).join('')}</div>`
    : '<p class="portfolio-empty">No open delivery risks.</p>';
  document.getElementById('project-detail-info').innerHTML = [
    projectDetailSection('Project plan', overview),
    projectDetailSection('Schedule', scheduleView),
    projectDetailSection('Critical path', pathView),
    projectDetailSection('Decisions', decisionView),
    projectDetailSection('Risks', riskView),
  ].join('');
}

function closeProject() {
  selectedPortfolioProjectKey = null;
  document.getElementById('project-detail').style.display = 'none';
  document.getElementById('portfolio-overview').style.display = '';
}
