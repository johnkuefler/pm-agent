async function loadIntelligence() {
  const [summaryRes, commitmentsRes, episodesRes, relationshipsRes, experimentsRes, tracesRes, benchRes] = await Promise.all([
    api('/intelligence'), api('/commitments?status=open'), api('/episodes?limit=12'), api('/relationships'),
    api('/learning-experiments'), api('/decision-traces?limit=20'), api('/nora-bench'),
  ]);
  if (![summaryRes, commitmentsRes, episodesRes, relationshipsRes, experimentsRes, tracesRes, benchRes].every(response => response.ok)) {
    document.getElementById('intelligence-stats').innerHTML = '<div class="error">Could not load intelligence state.</div>';
    return;
  }
  const [summary, commitments, episodes, relationships, experiments, traces, bench] = await Promise.all([
    summaryRes.json(), commitmentsRes.json(), episodesRes.json(), relationshipsRes.json(), experimentsRes.json(), tracesRes.json(), benchRes.json(),
  ]);
  document.getElementById('intelligence-stats').innerHTML = [
    ['Open promises', summary.commitments.open], ['Episodes', summary.episodes], ['People learned', summary.relationships],
    ['Active experiments', summary.experiments.active], ['Decision traces', summary.traces],
  ].map(([label, value]) => `<div class="intelligence-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
  document.getElementById('bench-status').innerHTML = `<strong>Nora Bench: ${bench.passed}/${bench.total} passing</strong> &middot; meeting judgment, uncertainty, repair, and initiative policies`;
  renderCommitments(commitments);
  renderEpisodes(episodes);
  renderRelationships(relationships);
  renderExperiments(experiments);
  renderDecisionTraces(traces);
}

function renderCommitments(items) {
  document.getElementById('commitment-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.what)}</strong>
      <div>${escHtml(item.owner)}${item.beneficiary ? ` → ${escHtml(item.beneficiary)}` : ''}${item.due ? ` &middot; due ${escHtml(item.due)}` : ''}</div>
      <div class="intelligence-meta">${item.evidence?.channel ? `source: ${escHtml(item.evidence.channel)}` : 'manually recorded'} &middot; updated ${new Date(item.updated).toLocaleString()}</div>
      <button class="btn btn-success btn-sm" style="margin-top:7px" onclick="fulfillCommitment('${item.id}')">Mark fulfilled</button>
    </div>`).join('') : '<div class="empty">No open commitments.</div>';
}

async function addCommitment() {
  const what = document.getElementById('commitment-what').value.trim();
  if (!what) return;
  await api('/commitments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    what, owner: document.getElementById('commitment-owner').value.trim() || 'Nora', due: document.getElementById('commitment-due').value.trim() || null,
  }) });
  document.getElementById('commitment-what').value = '';
  loadIntelligence();
}

async function fulfillCommitment(id) {
  await api(`/commitments/${encodeURIComponent(id)}/fulfilled`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadIntelligence();
}

function renderEpisodes(items) {
  document.getElementById('episode-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.title)}</strong>
      <div>${item.project ? `${escHtml(item.project)} &middot; ` : ''}${item.events.length} connected event${item.events.length === 1 ? '' : 's'}</div>
      <div class="intelligence-meta">${item.participants.map(escHtml).join(', ') || 'participants unknown'} &middot; ${new Date(item.updated).toLocaleString()}</div>
    </div>`).join('') : '<div class="empty">Episodes will appear as Nora carries conversations across meetings and Slack.</div>';
}

function renderRelationships(items) {
  document.getElementById('relationship-list').innerHTML = items.length ? items.map(item => {
    const observations = item.observations.filter(observation => observation.status === 'active').slice(-3);
    return `<div class="intelligence-card"><strong>${escHtml(item.name)}</strong>${observations.map(observation => `<div>${escHtml(observation.observation)} <span class="intelligence-meta">${Math.round(observation.confidence * 100)}%</span></div>`).join('')}</div>`;
  }).join('') : '<div class="empty">No evidence-backed relationship observations yet.</div>';
}

function renderExperiments(items) {
  document.getElementById('experiment-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.behavior)}</strong><div>${escHtml(item.hypothesis)}</div>
      <div class="intelligence-meta">${item.status} &middot; ${item.samples.length} outcome sample${item.samples.length === 1 ? '' : 's'}${item.review_at ? ` &middot; review ${escHtml(item.review_at)}` : ''}</div>
      ${item.status === 'active' ? `<button class="btn btn-sm" style="margin-top:7px" onclick="evaluateExperiment('${item.id}')">Evaluate</button>` : ''}
    </div>`).join('') : '<div class="empty">No behavior experiments yet.</div>';
}

async function evaluateExperiment(id) {
  await api(`/learning-experiments/${encodeURIComponent(id)}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conclude: true }) });
  loadIntelligence();
}

async function addExperiment() {
  const behavior = document.getElementById('experiment-behavior').value.trim();
  const hypothesis = document.getElementById('experiment-hypothesis').value.trim();
  if (!behavior || !hypothesis) return;
  await api('/learning-experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ behavior, hypothesis }) });
  document.getElementById('experiment-behavior').value = '';
  document.getElementById('experiment-hypothesis').value = '';
  loadIntelligence();
}

function renderDecisionTraces(items) {
  document.getElementById('trace-list').innerHTML = items.length ? items.map(item => `
    <div class="intelligence-card"><strong>${escHtml(item.decision || item.action)}</strong> &middot; ${escHtml(item.channel || 'system')}
      <div>${item.reasons.map(escHtml).join(' &middot; ') || 'No reason recorded'}</div>
      ${item.preview ? `<div class="intelligence-meta">${escHtml(item.preview)}</div>` : ''}
      <div class="intelligence-meta">${new Date(item.at).toLocaleString()}${item.confidence != null ? ` &middot; ${Math.round(item.confidence * 100)}% confidence` : ''}</div>
    </div>`).join('') : '<div class="empty">Decision traces appear as Nora responds, stays silent, or acts.</div>';
}
