var executiveFirewallState = null;
var executiveFirewallFilter = 'active';

function executivePercent(value) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
}

function executiveStateLabel(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function executiveDeadline(value) {
  const time = new Date(value || 0).getTime();
  if (!Number.isFinite(time) || !time) return 'without a recorded deadline';
  const delta = time - Date.now();
  const absolute = Math.abs(delta);
  const unit = absolute < 3600000 ? `${Math.max(1, Math.ceil(absolute / 60000))}m`
    : absolute < 86400000 ? `${Math.ceil(absolute / 3600000)}h`
      : `${Math.ceil(absolute / 86400000)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} past due`;
}

function executiveMetric(label, value, detail, tone) {
  return `<article class="portfolio-stat ${tone || ''}"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong><small>${escHtml(detail)}</small></article>`;
}

function renderExecutiveMetrics(data) {
  const metrics = data.metrics || {};
  document.getElementById('executive-firewall-stats').innerHTML = [
    executiveMetric('Handled without John', executivePercent(metrics.handled_without_executive_rate), `${metrics.handled_without_executive || 0} verified closures`, 'is-primary'),
    executiveMetric('Nora owns now', String(metrics.active || 0), `${metrics.resolving || 0} actively resolving`),
    executiveMetric('Needs John', String(metrics.decisions_ready || 0), 'complete decision packets only', metrics.decisions_ready ? 'is-warn' : ''),
    executiveMetric('Executive interruptions', String(metrics.executive_interruptions || 0), 'grouped, budgeted deliveries'),
    executiveMetric('Noise absorbed', String(metrics.duplicate_noise_absorbed || 0), 'duplicate matters kept private'),
    executiveMetric('Interruption precision', executivePercent(metrics.interruption_precision), `${metrics.unnecessary_escalations || 0} marked unnecessary`, metrics.unnecessary_escalations ? 'is-danger' : ''),
  ].join('');
}

function executiveCaseCard(item) {
  const owner = item.owner || 'Nora';
  const outcome = item.state === 'verified_closed'
    ? `<p class="executive-case-outcome"><strong>Verified outcome:</strong> ${escHtml(item.verified_outcome || 'Closed with evidence.')}</p>` : '';
  const protection = item.handled_without_executive === true
    ? '<span class="executive-protection-pill">Handled without John</span>' : '';
  return `<button class="executive-case-card is-${escHtml(item.severity || 'medium')}" type="button" data-case-id="${escHtml(item.id)}" onclick="openExecutiveCase(this.dataset.caseId)">
    <div class="executive-case-top"><span>${escHtml(item.project_key || item.source || 'operations')}</span><span>${escHtml(item.severity || 'medium')}</span></div>
    <h3>${escHtml(item.summary)}</h3>
    <p>${escHtml(item.next_action || item.resolution_plan || item.detail || 'Nora is establishing the next resolving action.')}</p>
    ${outcome}<div class="executive-case-meta"><span>${escHtml(executiveStateLabel(item.state))}</span><span>Owner: ${escHtml(owner)}</span>${protection}</div>
  </button>`;
}

function filteredExecutiveCases(cases) {
  if (executiveFirewallFilter === 'decisions') {
    return cases.filter(item => ['decision_ready', 'escalated'].includes(item.state));
  }
  if (executiveFirewallFilter === 'closed') {
    return cases.filter(item => ['verified_closed', 'dismissed'].includes(item.state));
  }
  return cases.filter(item => !['verified_closed', 'dismissed'].includes(item.state));
}

function renderExecutiveCases(data) {
  const cases = filteredExecutiveCases(data.state?.cases || []).sort((left, right) =>
    new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());
  document.querySelectorAll('[data-executive-filter]').forEach(button => {
    const active = button.dataset.executiveFilter === executiveFirewallFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.getElementById('executive-case-summary').textContent = cases.length
    ? `${cases.length} matter${cases.length === 1 ? '' : 's'} in this view. Every active item has an owner, next action, and closure requirement.`
    : executiveFirewallFilter === 'closed'
      ? 'No verified closures have been recorded yet.'
      : 'Nothing in this view requires attention.';
  document.getElementById('executive-case-list').innerHTML = cases.length
    ? cases.map(executiveCaseCard).join('')
    : '<div class="fleet-clear-state"><span aria-hidden="true">✓</span><div><strong>The firewall is clear</strong><p>Silence means Nora is handling the team\'s work without involving John.</p></div></div>';
}

function renderExecutiveDecisions(data) {
  const cases = (data.state?.cases || []).filter(item =>
    ['decision_ready', 'escalated'].includes(item.state) && item.decision_packet);
  document.getElementById('executive-decision-list').innerHTML = cases.length
    ? cases.map(item => `<button class="executive-decision-card" type="button" data-case-id="${escHtml(item.id)}" onclick="openExecutiveCase(this.dataset.caseId)">
      <span>${escHtml(item.id)}</span><strong>${escHtml(item.decision_packet.question)}</strong><small>Recommendation: ${escHtml(item.decision_packet.recommendation)}</small><em>Needed ${escHtml(executiveDeadline(item.decision_packet.deadline))}</em>
    </button>`).join('')
    : '<div class="executive-clear"><strong>No decisions needed</strong><p>Nora is working through owners and project managers first.</p></div>';
}

function renderExecutivePolicy(data) {
  const policy = data.state?.policy || {};
  const authority = policy.standing_authority || [];
  const gates = policy.executive_gates || [];
  document.getElementById('executive-policy').innerHTML = `
    <div class="executive-role"><strong>Team PM role preserved</strong><p>Nora manages projects, people, meetings, Teamwork, and follow-through for the whole team. The firewall only protects executive attention.</p></div>
    <div class="executive-policy-list"><span>Resolve without John</span><p>${authority.map(executiveStateLabel).map(escHtml).join(', ')}</p></div>
    <div class="executive-policy-list"><span>Executive gates</span><p>${gates.map(executiveStateLabel).map(escHtml).join(', ')}</p></div>
    <small>${policy.daily_brief_is_pull_only ? 'The executive brief is pull only. Nora never pushes a routine digest.' : 'An executive brief may be pushed by policy.'}</small>`;
}

function renderExecutiveFirewall(data) {
  executiveFirewallState = data;
  renderExecutiveMetrics(data);
  renderExecutiveCases(data);
  renderExecutiveDecisions(data);
  renderExecutivePolicy(data);
  const sync = document.getElementById('executive-firewall-sync');
  sync.className = 'fleet-sync is-ready';
  sync.textContent = data.state?.last_reconciled_at
    ? `Sources reconciled ${fleetRelativeTime(data.state.last_reconciled_at)}`
    : 'Waiting for the first source reconciliation';
}

async function loadExecutiveFirewall() {
  const list = document.getElementById('executive-case-list');
  if (!executiveFirewallState) list.innerHTML = '<div class="portfolio-loading"><span></span><span></span><span></span></div>';
  try {
    const response = await api('/executive-firewall');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Executive firewall unavailable');
    renderExecutiveFirewall(data);
  } catch (error) {
    list.innerHTML = `<div class="portfolio-load-error"><strong>Executive firewall unavailable</strong><span>${escHtml(error.message)}</span><button class="btn btn-sm" type="button" onclick="loadExecutiveFirewall()">Try again</button></div>`;
  }
}

function setExecutiveFilter(filter) {
  executiveFirewallFilter = ['active', 'decisions', 'closed'].includes(filter) ? filter : 'active';
  if (executiveFirewallState) renderExecutiveCases(executiveFirewallState);
}

async function reconcileExecutiveFirewall(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Reconciling';
  try {
    const response = await operatorApi('/executive-firewall/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notify: false }), timeoutMs: 120000,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Reconciliation failed');
    renderExecutiveFirewall({ state: body.state, metrics: body.metrics, brief: body.brief });
  } catch (error) {
    const sync = document.getElementById('executive-firewall-sync');
    sync.className = 'fleet-sync is-error';
    sync.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function executiveDecisionButtons(item) {
  if (!item.decision_packet || !['decision_ready', 'escalated'].includes(item.state)) return '';
  return `<div class="executive-decision-actions">
    <button class="btn btn-primary btn-sm" type="button" onclick="submitExecutiveDecision('${escHtml(item.id)}','approve',this)">Approve recommendation</button>
    <button class="btn btn-sm" type="button" onclick="submitExecutiveDecision('${escHtml(item.id)}','override',this)">Override</button>
    <button class="btn btn-sm" type="button" onclick="submitExecutiveDecision('${escHtml(item.id)}','defer',this)">Defer</button>
    <button class="btn btn-danger btn-sm" type="button" onclick="submitExecutiveDecision('${escHtml(item.id)}','reject',this)">Reject</button>
  </div>`;
}

function executiveFeedbackButtons(item) {
  if (!item.executive_involved) return '';
  return `<div class="executive-feedback"><span>Was this worth interrupting you?</span>
    <button class="btn btn-sm" type="button" onclick="submitExecutiveFeedback('${escHtml(item.id)}','helpful',this)">Helpful</button>
    <button class="btn btn-sm" type="button" onclick="submitExecutiveFeedback('${escHtml(item.id)}','unnecessary',this)">Unnecessary</button>
  </div>`;
}

function openExecutiveCase(caseId) {
  const item = (executiveFirewallState?.state?.cases || []).find(entry => entry.id === caseId);
  if (!item) return;
  const packet = item.decision_packet;
  const attempts = item.attempts || [];
  document.getElementById('executive-case-detail').innerHTML = `
    <span class="portfolio-kicker">${escHtml(item.id)}</span><h2 id="executive-dialog-title">${escHtml(item.summary)}</h2>
    <div class="fleet-dialog-badges"><span class="is-${escHtml(item.severity)}">${escHtml(item.severity)}</span><span>${escHtml(executiveStateLabel(item.state))}</span><span>Owner: ${escHtml(item.owner || 'Nora')}</span></div>
    <p class="fleet-dialog-detail">${escHtml(item.detail || item.resolution_plan || 'No additional detail.')}</p>
    <dl class="fleet-dialog-facts"><div><dt>Next action</dt><dd>${escHtml(item.next_action || 'Establish the next resolving action')}</dd></div><div><dt>Resolution due</dt><dd>${escHtml(new Date(item.resolution_due_at).toLocaleString())}</dd></div><div><dt>Source</dt><dd>${escHtml(`${item.source}: ${item.source_ref}`)}</dd></div><div><dt>Executive gate</dt><dd>${escHtml(executiveStateLabel(item.executive_gate || 'none'))}</dd></div></dl>
    ${packet ? `<section class="executive-packet"><span>Decision packet</span><h3>${escHtml(packet.question)}</h3><p><strong>Nora recommends:</strong> ${escHtml(packet.recommendation)}</p><p><strong>Consequence:</strong> ${escHtml(packet.consequence)}</p><ul>${packet.options.map(option => `<li>${escHtml(option)}</li>`).join('')}</ul></section>` : ''}
    <section class="executive-attempts"><span>Resolution history</span>${attempts.length ? attempts.map(attempt => `<div><strong>${escHtml(attempt.action)}</strong><p>${escHtml(attempt.result)}</p><small>${escHtml(attempt.actor)} · ${escHtml(fleetRelativeTime(attempt.at))}</small></div>`).join('') : '<p>No resolving attempts recorded yet.</p>'}</section>
    ${item.verified_outcome ? `<div class="executive-verified"><strong>Verified closed</strong><p>${escHtml(item.verified_outcome)}</p></div>` : ''}
    ${executiveDecisionButtons(item)}${executiveFeedbackButtons(item)}`;
  document.getElementById('executive-case-dialog').showModal();
}

async function submitExecutiveDecision(caseId, decision, button) {
  let instruction = '';
  if (decision !== 'approve') {
    instruction = window.prompt(decision === 'override'
      ? 'What should Nora do instead?' : decision === 'defer'
        ? 'When or under what condition should Nora return?' : 'Why are you rejecting this?') || '';
    if (!instruction) return;
  }
  button.disabled = true;
  try {
    const response = await operatorApi(`/executive-firewall/cases/${encodeURIComponent(caseId)}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, instruction }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Decision could not be recorded');
    document.getElementById('executive-case-dialog').close();
    await loadExecutiveFirewall();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}

async function submitExecutiveFeedback(caseId, rating, button) {
  button.disabled = true;
  const behaviorChange = rating === 'unnecessary'
    ? 'Resolve an analogous matter through the team without escalating it to John.' : '';
  try {
    const response = await operatorApi(`/executive-firewall/cases/${encodeURIComponent(caseId)}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, behavior_change: behaviorChange }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Feedback could not be recorded');
    document.getElementById('executive-case-dialog').close();
    await loadExecutiveFirewall();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}
