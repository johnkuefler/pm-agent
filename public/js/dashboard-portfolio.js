// Portfolio command center. This loads after dashboard-knowledge.js and replaces the legacy
// project-memory list with the durable project-control story while keeping context editing available.
var selectedPortfolioProjectKey = null;
var projectPortfolioFilter = 'attention';
var projectPortfolioState = {
  projects: [], legacy: [], risks: [], evaluation: {}, report: {}, hydration: {},
};

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
  })
    .format(new Date(parsed));
}

function portfolioRelativeTime(value) {
  const parsed = portfolioDateValue(value);
  if (parsed === null) return 'not yet';
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function portfolioProjectSignals(project) {
  const schedule = project.hydration?.schedule || {};
  const due = portfolioDateValue(project.next_milestone_due);
  const openRisks = projectPortfolioState.risks.filter(risk => risk.project_key === project.key);
  const decisions = Number(project.decision_state?.open_count) || 0;
  const overdueTasks = Number(schedule.overdue_tasks) || 0;
  const unassignedTasks = Number(schedule.unassigned_tasks) || 0;
  const hydrated = project.hydration?.source === 'teamwork_project_story';
  const checkpointOverdue = due !== null && due < portfolioStartOfToday();
  const healthAttention = project.health === 'red' || project.health === 'amber';
  const incomplete = Number(project.completeness?.ratio) < 1;
  const attention = checkpointOverdue || overdueTasks > 0 || decisions > 0 || openRisks.length > 0
    || healthAttention || (hydrated && incomplete);
  return { due, openRisks, decisions, overdueTasks, unassignedTasks, hydrated,
    checkpointOverdue, healthAttention, incomplete, attention };
}

function portfolioPriority(project) {
  const signal = portfolioProjectSignals(project);
  const severity = signal.openRisks.reduce((score, risk) => Math.max(score,
    ['low', 'medium', 'high', 'critical'].indexOf(risk.severity) + 1), 0);
  return severity * 120 + (project.health === 'red' ? 400 : project.health === 'amber' ? 220 : 0)
    + (signal.checkpointOverdue ? 180 : 0) + Math.min(120, signal.overdueTasks * 12)
    + Math.min(100, signal.decisions * 14) + Math.min(50, signal.unassignedTasks * 3)
    + (signal.incomplete && signal.hydrated ? 20 : 0);
}

function portfolioMetric(label, value, detail, tone = '', filter = '') {
  const tag = filter ? 'button' : 'div';
  const attrs = filter ? ` type="button" onclick="setProjectFilter('${filter}')"` : '';
  return `<${tag} class="portfolio-stat ${tone}"${attrs}><span>${escHtml(label)}</span>`
    + `<strong>${escHtml(value)}</strong><small>${escHtml(detail)}</small></${tag}>`;
}

function renderPortfolioStats() {
  const projectReport = projectPortfolioState.report.projects || {};
  const quality = projectPortfolioState.evaluation.quality || {};
  const hydrated = Number(projectReport.teamwork_hydrated) || 0;
  const complete = projectPortfolioState.projects.filter(project =>
    project.hydration?.source === 'teamwork_project_story' && project.completeness?.ratio === 1).length;
  const attention = projectPortfolioState.projects.filter(project => {
    const signal = portfolioProjectSignals(project);
    return signal.hydrated && signal.attention;
  }).length;
  const antiAnnoyance = Math.round((quality.dimensions?.anti_annoyance || 0) * 100);
  document.getElementById('pm-control-stats').innerHTML = [
    portfolioMetric('Live project stories', hydrated, 'refreshed from Teamwork', 'is-primary', 'active'),
    portfolioMetric('Needs attention', attention, 'verified exceptions', attention ? 'is-warn' : '', 'attention'),
    portfolioMetric('Past-due checkpoints', projectReport.milestone_overdue || 0,
      'next delivery dates', projectReport.milestone_overdue ? 'is-danger' : '', 'overdue'),
    portfolioMetric('Decision candidates', projectReport.decision_candidates || 0,
      'approval or sign-off work', projectReport.decision_candidates ? 'is-warn' : '', 'decisions'),
    portfolioMetric('Complete stories', `${complete}/${hydrated}`, 'objective, owner, phase, checkpoint'),
    portfolioMetric('Quiet discipline', `${antiAnnoyance}%`, `${quality.noisy_days || 0} noisy days`,
      antiAnnoyance >= 95 ? 'is-success' : 'is-warn'),
  ].join('');
}

function renderHydrationStatus() {
  const hydration = projectPortfolioState.hydration || {};
  const element = document.getElementById('pm-hydration-status');
  const state = hydration.state || 'idle';
  element.dataset.state = state;
  if (state === 'running') element.lastElementChild.textContent = 'Refreshing Teamwork project stories now';
  else if (state === 'failed') element.lastElementChild.textContent =
    `Hydration needs attention: ${hydration.error || 'unknown failure'}`;
  else if (state === 'succeeded') element.lastElementChild.textContent =
    `Teamwork current · ${hydration.result?.projects_seen || 0} stories · checked ${portfolioRelativeTime(hydration.completed_at)}`;
  else element.lastElementChild.textContent = 'Waiting for the first Teamwork refresh';
}

function renderPortfolioPosture() {
  const quality = projectPortfolioState.evaluation.quality || {};
  const dimensions = quality.dimensions || {};
  const rows = [
    ['Overall PM quality', quality.score || 0],
    ['Project coverage', dimensions.project_coverage || 0],
    ['Intervention quality', dimensions.intervention_quality || 0],
    ['Learning closure', dimensions.learning_closure || 0],
  ];
  document.getElementById('pm-control-posture').innerHTML = `
    <div class="portfolio-posture-lead"><strong>${escHtml(String(quality.rollout_stage || 'shadow_calibration').replaceAll('_', ' '))}</strong>
      <span>Bounded autonomy stays evidence-first. Hydration never spends a human interruption.</span></div>
    <div class="portfolio-meter-list">${rows.map(([label, value]) => `
      <div class="portfolio-meter-row"><div><span>${escHtml(label)}</span><strong>${Math.round(value * 100)}%</strong></div>
      <div class="portfolio-meter"><i style="width:${Math.max(0, Math.min(100, value * 100))}%"></i></div></div>`).join('')}</div>
    <div class="portfolio-quiet-note"><strong>Anti-annoyance:</strong> ${quality.noisy_days || 0} days exceeded the one-interruption limit.</div>`;
}

function renderPortfolioDecisions() {
  const candidates = projectPortfolioState.projects.flatMap(project =>
    (project.decision_state?.candidates || []).map(candidate => ({ ...candidate, project })));
  candidates.sort((left, right) => (portfolioDateValue(left.due_at) || Infinity)
    - (portfolioDateValue(right.due_at) || Infinity));
  document.getElementById('pm-control-decisions').innerHTML = candidates.length
    ? candidates.slice(0, 6).map(candidate => `
      <button class="portfolio-radar-item" type="button" data-project-key="${escHtml(candidate.project.key)}" onclick="viewProject(this.dataset.projectKey)">
        <span>${escHtml(candidate.project.name)}</span><strong>${escHtml(candidate.title)}</strong>
        <small>${escHtml(portfolioDate(candidate.due_at))} · ${escHtml((candidate.assignees || []).join(', ') || 'unassigned')}</small>
      </button>`).join('')
    : '<p class="portfolio-empty">No decision candidates are currently visible.</p>';
}

function renderPortfolioRisks() {
  const severity = ['low', 'medium', 'high', 'critical'];
  const risks = [...projectPortfolioState.risks].sort((left, right) =>
    severity.indexOf(right.severity) - severity.indexOf(left.severity));
  document.getElementById('pm-control-risks').innerHTML = risks.length ? risks.slice(0, 6).map(risk => `
    <button class="portfolio-radar-item is-risk" type="button" data-project-key="${escHtml(risk.project_key)}" onclick="viewProject(this.dataset.projectKey)">
      <span>${escHtml(risk.severity)} risk</span><strong>${escHtml(risk.title)}</strong>
      <small>${escHtml(risk.owner || 'unowned')} · ${escHtml(risk.next_action || risk.decision_needed || 'next action missing')}</small>
    </button>`).join('')
    : '<div class="portfolio-clear-state"><span aria-hidden="true">✓</span><div><strong>No verified delivery risks</strong><p>Nora will not manufacture a red status from missing source data.</p></div></div>';
}

function portfolioProjectCard(project) {
  const signal = portfolioProjectSignals(project);
  const dueText = signal.checkpointOverdue
    ? `Past due ${portfolioDate(project.next_milestone_due)}` : portfolioDate(project.next_milestone_due);
  const chips = [];
  if (signal.checkpointOverdue) chips.push(['Past-due checkpoint', 'danger']);
  if (signal.overdueTasks) chips.push([`${signal.overdueTasks} overdue task${signal.overdueTasks === 1 ? '' : 's'}`, 'danger']);
  if (signal.decisions) chips.push([`${signal.decisions} decision${signal.decisions === 1 ? '' : 's'}`, 'warn']);
  if (signal.unassignedTasks) chips.push([`${signal.unassignedTasks} unassigned`, 'neutral']);
  if (signal.incomplete) chips.push(['Story incomplete', 'neutral']);
  if (!chips.length) chips.push(['No current exception', 'success']);
  const source = project.hydration?.field_sources?.objective?.derived
    ? 'Source-grounded inference' : 'Verified Teamwork story';
  return `<button class="portfolio-project-card${signal.attention ? ' needs-attention' : ''}" type="button" data-project-key="${escHtml(project.key)}" onclick="viewProject(this.dataset.projectKey)">
    <div class="portfolio-card-top"><span>${escHtml(project.client || 'Client not recorded')}</span>
      <span class="portfolio-phase">${escHtml(project.phase || 'Phase unknown')}</span></div>
    <h3>${escHtml(project.name)}</h3><p class="portfolio-objective">${escHtml(project.objective || 'Objective not yet established.')}</p>
    <div class="portfolio-card-facts">
      <div><span>Project manager</span><strong>${escHtml(project.pm || 'Not assigned')}</strong></div>
      <div><span>Next checkpoint</span><strong>${escHtml(project.next_milestone || 'Not established')}</strong><small>${escHtml(dueText)}</small></div>
    </div>
    <div class="portfolio-chip-row">${chips.slice(0, 4).map(([label, tone]) =>
      `<span class="portfolio-chip is-${tone}">${escHtml(label)}</span>`).join('')}</div>
    <div class="portfolio-card-foot"><span>${escHtml(source)}</span><span>Open story</span></div>
  </button>`;
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

function renderProjectPortfolio() {
  const search = String(document.getElementById('portfolio-search')?.value || '').trim().toLowerCase();
  const all = projectPortfolioState.projects;
  const active = all.filter(project => portfolioProjectSignals(project).hydrated);
  const counts = {
    attention: active.filter(project => portfolioProjectSignals(project).attention).length,
    decisions: active.filter(project => portfolioProjectSignals(project).decisions > 0).length,
    overdue: active.filter(project => {
      const signal = portfolioProjectSignals(project);
      return signal.checkpointOverdue || signal.overdueTasks > 0;
    }).length,
    active: active.length,
    all: all.length,
  };
  Object.entries(counts).forEach(([name, count]) => {
    const element = document.getElementById(`portfolio-filter-${name}-count`);
    if (element) element.textContent = count;
  });
  let projects = all.filter(project => {
    const signal = portfolioProjectSignals(project);
    if (projectPortfolioFilter === 'attention') return signal.hydrated && signal.attention;
    if (projectPortfolioFilter === 'decisions') return signal.hydrated && signal.decisions > 0;
    if (projectPortfolioFilter === 'overdue') return signal.hydrated
      && (signal.checkpointOverdue || signal.overdueTasks > 0);
    if (projectPortfolioFilter === 'active') return signal.hydrated;
    return true;
  });
  if (search) projects = projects.filter(project => [project.name, project.client, project.pm,
    project.phase, project.objective, project.next_milestone].some(value =>
    String(value || '').toLowerCase().includes(search)));
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
  document.getElementById('portfolio-result-summary').textContent = `${projects.length} project${projects.length === 1 ? '' : 's'} in this view, ranked from the current durable story.`;
  document.getElementById('project-list').innerHTML = projects.length
    ? projects.map(portfolioProjectCard).join('')
    : '<div class="portfolio-empty"><strong>No projects match this view.</strong><span>Try another filter or clear the search.</span></div>';
}

async function loadProjects() {
  const list = document.getElementById('project-list');
  document.getElementById('portfolio-overview').style.display = '';
  document.getElementById('project-detail').style.display = 'none';
  document.getElementById('project-edit').style.display = 'none';
  list.innerHTML = '<div class="portfolio-loading"><span></span><span></span><span></span></div>';
  try {
    const responses = await Promise.all([
      api('/projects'), api('/pm-control'), api('/pm-control/evaluation'), api('/pm-control/hydration'),
    ]);
    if (responses.some(response => !response.ok)) throw new Error('One or more portfolio sources failed');
    const [legacy, control, evaluation, hydration] = await Promise.all(responses.map(response => response.json()));
    projectPortfolioState.legacy = Array.isArray(legacy) ? legacy : [];
    projectPortfolioState.projects = control.ledger?.projects || [];
    projectPortfolioState.risks = (control.ledger?.risks || []).filter(risk =>
      risk.status === 'open' || risk.status === 'monitoring');
    projectPortfolioState.report = control.report || {};
    projectPortfolioState.evaluation = evaluation || {};
    projectPortfolioState.hydration = hydration || {};
    renderPortfolioStats();
    renderHydrationStatus();
    renderPortfolioPosture();
    renderPortfolioDecisions();
    renderPortfolioRisks();
    renderProjectPortfolio();
  } catch (error) {
    list.innerHTML = `<div class="portfolio-load-error"><strong>Portfolio unavailable</strong><span>${escHtml(error.message)}</span><button class="btn btn-sm" type="button" onclick="loadProjects()">Try again</button></div>`;
  }
}

async function refreshProjectStories(button) {
  const prior = button.textContent;
  button.disabled = true;
  button.textContent = 'Syncing Teamwork';
  const status = document.getElementById('pm-hydration-status');
  status.dataset.state = 'running';
  status.lastElementChild.textContent = 'Refreshing Teamwork project stories now';
  try {
    const response = await api('/pm-control/hydrate/teamwork', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 120000 });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Teamwork sync failed');
    await loadProjects();
  } catch (error) {
    status.dataset.state = 'failed';
    status.lastElementChild.textContent = `Teamwork sync failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = prior;
  }
}

function projectDetailSection(title, content, wide = false) {
  return `<section class="section portfolio-story-section${wide ? ' is-wide' : ''}"><span class="portfolio-kicker">${escHtml(title)}</span>${content}</section>`;
}

async function viewProject(key) {
  const project = projectPortfolioState.projects.find(item => item.key === key);
  if (!project) return;
  selectedPortfolioProjectKey = key;
  document.getElementById('portfolio-overview').style.display = 'none';
  document.getElementById('project-edit').style.display = 'none';
  document.getElementById('project-detail').style.display = 'block';
  document.getElementById('project-detail-name').textContent = project.name;
  document.getElementById('project-detail-client').textContent = project.client || 'Client not recorded';
  const signal = portfolioProjectSignals(project);
  const badges = [
    [project.health === 'unknown' ? 'Health not assessed' : `${project.health} health`, project.health],
    [project.phase || 'Phase unknown', 'neutral'],
    [signal.hydrated ? 'Teamwork live' : 'Legacy record', signal.hydrated ? 'success' : 'neutral'],
  ];
  document.getElementById('project-detail-badges').innerHTML = badges.map(([label, tone]) =>
    `<span class="portfolio-chip is-${escHtml(tone)}">${escHtml(label)}</span>`).join('');
  document.getElementById('project-detail-info').innerHTML = '<div class="portfolio-loading"><span></span><span></span></div>';
  document.getElementById('project-memories').innerHTML = '';
  let legacy = null;
  try {
    const response = await api('/projects/' + encodeURIComponent(project.name));
    if (response.ok) legacy = await response.json();
  } catch {}
  const schedule = project.hydration?.schedule || {};
  const critical = project.critical_path || [];
  const candidates = project.decision_state?.candidates || [];
  const sources = Object.entries(project.hydration?.field_sources || {});
  const story = `<h3>${escHtml(project.objective || 'Objective not yet established.')}</h3>
    <p>${escHtml(project.health_reason || 'No health claim has been made without verified evidence.')}</p>`;
  const control = `<div class="portfolio-fact-grid">
    <div><span>Project manager</span><strong>${escHtml(project.pm || 'Not assigned')}</strong></div>
    <div><span>Current phase</span><strong>${escHtml(project.phase || 'Not established')}</strong></div>
    <div><span>Next checkpoint</span><strong>${escHtml(project.next_milestone || 'Not established')}</strong><small>${escHtml(portfolioDate(project.next_milestone_due))}</small></div>
    <div><span>Story completeness</span><strong>${Math.round((project.completeness?.ratio || 0) * 100)}%</strong><small>${escHtml((project.completeness?.missing || []).join(', ') || 'minimum picture complete')}</small></div>
  </div>`;
  const scheduleContent = `<div class="portfolio-schedule-grid">
    <div><strong>${Number(schedule.open_tasks) || 0}</strong><span>open tasks</span></div>
    <div class="${Number(schedule.overdue_tasks) ? 'is-danger' : ''}"><strong>${Number(schedule.overdue_tasks) || 0}</strong><span>overdue</span></div>
    <div><strong>${Number(schedule.unassigned_tasks) || 0}</strong><span>unassigned</span></div>
    <div><strong>${Number(schedule.open_milestones) || 0}</strong><span>open milestones</span></div>
  </div>`;
  const path = critical.length ? `<ol class="portfolio-path-list">${critical.map(item => `<li>${escHtml(item)}</li>`).join('')}</ol>`
    : '<p class="portfolio-empty">No critical-path task is currently inferred.</p>';
  const decisions = candidates.length ? `<div class="portfolio-decision-list">${candidates.map(candidate => `
    <div><strong>${escHtml(candidate.title)}</strong><span>${escHtml(portfolioDate(candidate.due_at))} · ${escHtml((candidate.assignees || []).join(', ') || 'unassigned')}</span></div>`).join('')}</div>`
    : '<p class="portfolio-empty">No approval, sign-off, or decision candidate is currently visible.</p>';
  const provenance = sources.length ? `<div class="portfolio-source-list">${sources.map(([field, source]) => `
    <div><span>${escHtml(field.replaceAll('_', ' '))}</span><strong>${source.derived ? 'Nora inferred' : 'Source exact'}</strong><small>${Math.round((source.confidence || 0) * 100)}% confidence · ${escHtml(String(source.source || '').replaceAll('_', ' '))}</small></div>`).join('')}</div>`
    : '<p class="portfolio-empty">This legacy record has no field-level provenance.</p>';
  document.getElementById('project-detail-info').innerHTML = [
    projectDetailSection('Delivery objective', story, true),
    projectDetailSection('Control picture', control, true),
    projectDetailSection('Schedule load', scheduleContent),
    projectDetailSection('Critical path', path),
    projectDetailSection('Decision candidates', decisions),
    projectDetailSection('Why Nora believes this', provenance),
  ].join('');
  const memories = legacy?.memories || [];
  document.getElementById('project-memories').innerHTML = `<span class="portfolio-kicker">Durable context</span>
    <h2>Memory and research</h2>${legacy?.details ? `<p class="portfolio-legacy-detail">${escHtml(legacy.details)}</p>` : ''}
    ${memories.length ? `<div class="portfolio-memory-list">${memories.map(memory => `<div><p>${escHtml(memory.fact)}</p><small>${escHtml(memory.added || '')}</small></div>`).join('')}</div>`
    : '<p class="portfolio-empty">No additional memories are tagged to this project.</p>'}`;
}

function closeProject() {
  selectedPortfolioProjectKey = null;
  document.getElementById('project-detail').style.display = 'none';
  document.getElementById('project-edit').style.display = 'none';
  document.getElementById('portfolio-overview').style.display = '';
}

function showAddProject() {
  selectedPortfolioProjectKey = null;
  editingProjectName = null;
  document.getElementById('portfolio-overview').style.display = 'none';
  document.getElementById('project-detail').style.display = 'none';
  document.getElementById('project-edit-title').textContent = 'Add project context';
  document.getElementById('project-edit-name').value = '';
  document.getElementById('project-edit-details').value = '';
  document.getElementById('project-edit-name').disabled = false;
  document.getElementById('project-context-delete').style.display = 'none';
  document.getElementById('project-edit').style.display = 'block';
  document.getElementById('project-status').className = 'toast';
}

function editProject() {
  const project = projectPortfolioState.projects.find(item => item.key === selectedPortfolioProjectKey);
  if (!project) return;
  const legacy = projectPortfolioState.legacy.find(item =>
    item.name.toLowerCase() === project.name.toLowerCase());
  editingProjectName = legacy?.name || null;
  document.getElementById('project-edit-title').textContent = legacy
    ? 'Edit legacy project context' : 'Add project context';
  document.getElementById('project-edit-name').value = project.name;
  document.getElementById('project-edit-details').value = legacy?.details || '';
  document.getElementById('project-edit-name').disabled = Boolean(legacy);
  document.getElementById('project-context-delete').style.display = legacy ? '' : 'none';
  document.getElementById('project-detail').style.display = 'none';
  document.getElementById('project-edit').style.display = 'block';
  document.getElementById('project-status').className = 'toast';
}

function cancelEditProject() {
  document.getElementById('project-edit').style.display = 'none';
  if (selectedPortfolioProjectKey) viewProject(selectedPortfolioProjectKey);
  else closeProject();
  editingProjectName = null;
}

async function saveProject() {
  const status = document.getElementById('project-status');
  const name = document.getElementById('project-edit-name').value.trim();
  const details = document.getElementById('project-edit-details').value.trim();
  if (!name) { status.className = 'toast err'; status.textContent = 'Project name is required'; return; }
  try {
    const response = editingProjectName ? await api('/projects/' + encodeURIComponent(editingProjectName), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details }),
    }) : await api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, details }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Context save failed');
    status.className = 'toast ok';
    status.textContent = 'Project context saved';
    const returnKey = selectedPortfolioProjectKey;
    setTimeout(async () => {
      await loadProjects();
      if (returnKey) viewProject(returnKey);
    }, 350);
  } catch (error) {
    status.className = 'toast err';
    status.textContent = `Failed: ${error.message}`;
  }
}

async function deleteProject() {
  if (!editingProjectName) return;
  if (!confirm(`Delete the legacy context record for "${editingProjectName}"? Project control data and memories remain intact.`)) return;
  try {
    const response = await api('/projects/' + encodeURIComponent(editingProjectName), { method: 'DELETE' });
    if (!response.ok) throw new Error('Context deletion failed');
    await loadProjects();
    if (selectedPortfolioProjectKey) viewProject(selectedPortfolioProjectKey);
  } catch (error) { alert(`Failed: ${error.message}`); }
}
