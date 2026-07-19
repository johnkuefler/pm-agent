let runtimeActivitySource = null;
let runtimeActivitySnapshot = null;
let runtimeActivityFallbackTimer = null;
let runtimeActivityConnection = 'connecting';

const runtimeActivityLaneLabels = {
  work: 'Hourly work',
  conversation: 'Conversation',
  background: 'Background',
  learning: 'Learning',
  leisure: 'Play',
  system: 'System',
};

function activityTime(value) {
  if (!value) return 'time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'time unavailable';
  const delta = Date.now() - date.getTime();
  if (delta < 5000) return 'just now';
  if (delta < 60000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function activityDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function runtimeActivityPriority(item) {
  return ({ conversation: 0, work: 1, learning: 2, leisure: 3, background: 4, system: 5 })[item.lane] ?? 6;
}

function setRuntimeActivityConnection(state) {
  runtimeActivityConnection = state;
  const label = document.getElementById('live-connection-label');
  const mark = document.getElementById('live-connection-indicator');
  const strip = document.getElementById('global-activity-strip');
  if (label) label.textContent = state === 'connected' ? 'Live' : state === 'disconnected' ? 'Reconnecting' : 'Connecting';
  if (mark) mark.className = `live-status-mark is-${state}`;
  if (strip) strip.classList.toggle('is-connecting', state !== 'connected');
}

function runtimeActivityPrimary() {
  const current = [...(runtimeActivitySnapshot?.current || [])]
    .sort((left, right) => runtimeActivityPriority(left) - runtimeActivityPriority(right)
      || String(right.updated_at).localeCompare(String(left.updated_at)));
  return current[0] || null;
}

function renderRuntimeActivityGlobal() {
  const primary = runtimeActivityPrimary();
  const label = document.getElementById('global-activity-label');
  const detail = document.getElementById('global-activity-detail');
  if (!label || !detail) return;
  if (primary) {
    label.textContent = primary.label;
    detail.textContent = primary.detail || `${runtimeActivityLaneLabels[primary.lane] || 'Runtime'} activity is in progress.`;
  } else if (runtimeActivityConnection === 'connected') {
    label.textContent = 'Nora is standing by';
    detail.textContent = 'No hourly, conversational, or background operation is active right now.';
  } else {
    label.textContent = 'Reconnecting to Nora';
    detail.textContent = 'The live view will resync from a fresh bounded snapshot.';
  }
}

function renderCurrentActivity(items) {
  const target = document.getElementById('live-current-list');
  const count = document.getElementById('live-active-count');
  if (!target || !count) return;
  count.textContent = `${items.length} active`;
  target.setAttribute('aria-busy', 'false');
  if (!items.length) {
    target.innerHTML = '<div class="live-empty"><strong>Nothing is active right now.</strong><span>Nora is connected and standing by for the next conversation, hourly pass, or due background check.</span></div>';
    return;
  }
  target.innerHTML = items.map(item => `
    <article class="live-current-item" data-lane="${escHtml(item.lane)}">
      <div class="live-item-marker" aria-hidden="true"></div>
      <div class="live-item-copy">
        <div class="live-item-topline"><strong>${escHtml(item.label)}</strong><span>${escHtml(runtimeActivityLaneLabels[item.lane] || item.lane)}</span></div>
        <p>${escHtml(item.detail || 'Activity is in progress.')}</p>
        <small>Started ${escHtml(activityTime(item.started_at))}</small>
      </div>
    </article>`).join('');
}

function renderActivityHistory(items) {
  const target = document.getElementById('live-history-list');
  if (!target) return;
  if (!items.length) {
    target.innerHTML = '<div class="live-empty"><strong>No recent activity in this process yet.</strong><span>New terminal events will appear here as Nora works.</span></div>';
    return;
  }
  target.innerHTML = items.slice(0, 50).map(item => {
    const duration = activityDuration(item.duration_ms);
    const status = item.kind === 'hourly_phase' ? 'Started' : item.status === 'completed' ? 'Done' : item.status === 'failed' ? 'Failed'
      : item.status === 'deferred' ? 'Deferred' : item.status === 'preempted' ? 'Yielded' : item.status;
    return `
      <article class="live-history-item" data-status="${escHtml(item.status)}">
        <div class="live-history-rail"><span aria-hidden="true"></span></div>
        <div class="live-history-copy">
          <div class="live-item-topline"><strong>${escHtml(item.label)}</strong><span>${escHtml(status)}</span></div>
          <p>${escHtml(item.outcome || item.detail || 'The activity reached a terminal state.')}</p>
          <small>${escHtml(runtimeActivityLaneLabels[item.lane] || item.lane)} / ${escHtml(activityTime(item.completed_at || item.updated_at))}${duration && item.kind !== 'hourly_phase' ? ` / ${escHtml(duration)}` : ''}</small>
        </div>
      </article>`;
  }).join('');
}

function renderRuntimeActivity() {
  renderRuntimeActivityGlobal();
  if (!document.getElementById('page-live')?.classList.contains('active')) return;
  const current = [...(runtimeActivitySnapshot?.current || [])]
    .sort((left, right) => runtimeActivityPriority(left) - runtimeActivityPriority(right)
      || String(right.updated_at).localeCompare(String(left.updated_at)));
  const primary = current[0] || null;
  const title = document.getElementById('live-primary-label');
  const detail = document.getElementById('live-primary-detail');
  const meta = document.getElementById('live-primary-meta');
  if (title) title.textContent = primary?.label || (runtimeActivityConnection === 'connected' ? 'Standing by between tasks' : 'Reconnecting to Nora');
  if (detail) detail.textContent = primary?.detail || (runtimeActivityConnection === 'connected'
    ? 'The stream is live. New hourly, conversational, and background activity will appear here immediately.'
    : 'The last bounded snapshot remains visible while the connection retries.');
  if (meta) meta.textContent = runtimeActivitySnapshot
    ? `Process ${runtimeActivitySnapshot.process_epoch_id} / updated ${activityTime(runtimeActivitySnapshot.generated_at)}`
    : 'No live timestamp yet';
  renderCurrentActivity(current);
  renderActivityHistory(runtimeActivitySnapshot?.recent || []);
}

function applyRuntimeActivitySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.current) || !Array.isArray(snapshot.recent)) return;
  runtimeActivitySnapshot = snapshot;
  renderRuntimeActivity();
}

function applyRuntimeActivityEvent(item) {
  if (!runtimeActivitySnapshot || !item?.id) return;
  runtimeActivitySnapshot.sequence = Math.max(Number(runtimeActivitySnapshot.sequence || 0), Number(item.sequence || 0));
  runtimeActivitySnapshot.generated_at = item.updated_at || new Date().toISOString();
  runtimeActivitySnapshot.current = runtimeActivitySnapshot.current.filter(existing => existing.id !== item.id);
  runtimeActivitySnapshot.recent = runtimeActivitySnapshot.recent.filter(existing => existing.id !== item.id);
  if (item.status === 'active') runtimeActivitySnapshot.current.unshift(item);
  else runtimeActivitySnapshot.recent.unshift(item);
  runtimeActivitySnapshot.recent = runtimeActivitySnapshot.recent.slice(0, 80);
  renderRuntimeActivity();
}

async function fetchRuntimeActivitySnapshot() {
  const response = await api('/runtime-activity', { cache: 'no-store' });
  if (!response.ok) throw new Error(`activity snapshot returned ${response.status}`);
  applyRuntimeActivitySnapshot(await response.json());
}

function startRuntimeActivityFallback() {
  if (runtimeActivityFallbackTimer) return;
  runtimeActivityFallbackTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || runtimeActivityConnection === 'connected') return;
    fetchRuntimeActivitySnapshot().catch(() => {});
  }, 5000);
}

function stopRuntimeActivityFallback() {
  if (!runtimeActivityFallbackTimer) return;
  clearInterval(runtimeActivityFallbackTimer);
  runtimeActivityFallbackTimer = null;
}

function connectRuntimeActivityStream() {
  if (!window.EventSource || runtimeActivitySource?.readyState === EventSource.OPEN
    || runtimeActivitySource?.readyState === EventSource.CONNECTING) return;
  runtimeActivitySource?.close();
  runtimeActivitySource = new EventSource('/runtime-activity/events');
  runtimeActivitySource.addEventListener('snapshot', event => {
    try { applyRuntimeActivitySnapshot(JSON.parse(event.data)); } catch {}
  });
  runtimeActivitySource.addEventListener('activity', event => {
    try { applyRuntimeActivityEvent(JSON.parse(event.data)); } catch {}
  });
  runtimeActivitySource.onopen = () => {
    setRuntimeActivityConnection('connected');
    stopRuntimeActivityFallback();
    renderRuntimeActivity();
  };
  runtimeActivitySource.onerror = () => {
    setRuntimeActivityConnection('disconnected');
    startRuntimeActivityFallback();
    renderRuntimeActivity();
  };
}

function loadRuntimeActivity() {
  setRuntimeActivityConnection(runtimeActivitySnapshot ? runtimeActivityConnection : 'connecting');
  renderRuntimeActivity();
  fetchRuntimeActivitySnapshot()
    .then(() => {
      if (!window.EventSource) setRuntimeActivityConnection('connected');
      renderRuntimeActivity();
    })
    .catch(() => {
      setRuntimeActivityConnection('disconnected');
      renderRuntimeActivity();
      startRuntimeActivityFallback();
    });
  connectRuntimeActivityStream();
}

function startRuntimeActivity() {
  loadRuntimeActivity();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchRuntimeActivitySnapshot().catch(() => {});
  });
}
