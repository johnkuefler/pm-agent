let runtimeActivitySource = null;
let runtimeActivitySnapshot = null;
let runtimeActivityContext = null;
let runtimeActivityFallbackTimer = null;
let runtimeActivityContextTimer = null;
let runtimeActivityContextRequest = null;
let runtimeActivityContextLoadedAt = 0;
let runtimeActivityConnection = 'connecting';

const runtimeActivityLaneLabels = {
  work: 'Hourly work',
  conversation: 'Conversation',
  background: 'Background',
  learning: 'Learning',
  leisure: 'Play',
  system: 'System',
};

const runtimeActivityRegionDefaults = {
  executive: ['Standing by', 'Hourly work and connector actions land here.'],
  social: ['Standing by', 'Slack, Zoom, and meeting responses land here.'],
  learning: ['Between encounters', 'Reading and source-bound learning land here.'],
  play: ['Between sessions', 'Bounded games and leisure choices land here.'],
  self: ['Standing by', 'Fingerprinting, reflection, and self-correction land here.'],
  subconscious: ['Standing by', 'Bounded background inference and dreams land here.'],
  continuity: ['Online', 'Runtime health, handoffs, and system state land here.'],
};

const runtimeActivitySelfKinds = [
  'behavioral_fingerprint', 'self_authored', 'self_inquiry', 'self_induction',
  'self_correction', 'professional_viewpoint', 'meeting_professional_reflection',
  'post_delivery_self_evaluation', 'interaction_outcome_review', 'cognitive_initiation',
];

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

function runtimeActivityRegion(item = {}) {
  const kind = String(item.kind || '').toLowerCase();
  if (item.lane === 'conversation') return 'social';
  if (item.lane === 'leisure' || kind.includes('autonomous_play')) return 'play';
  if (item.lane === 'learning' || kind.includes('developmental_reading') || kind.includes('epistemic_agenda')) return 'learning';
  if (item.lane === 'work' || kind === 'deferred_tool_job' || kind.startsWith('hourly_')) return 'executive';
  if (item.lane === 'system' || kind.includes('continuity') || kind === 'process_boot') return 'continuity';
  if (runtimeActivitySelfKinds.some(fragment => kind.includes(fragment))) return 'self';
  return 'subconscious';
}

function runtimeActivityStateLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'failed') return 'Needs attention';
  if (status === 'deferred') return 'Deferred';
  if (status === 'preempted') return 'Yielded';
  if (status === 'completed') return 'Recent';
  return status ? status.replaceAll('_', ' ') : 'Quiet';
}

function setRuntimeActivityConnection(state) {
  runtimeActivityConnection = state;
  const label = document.getElementById('live-connection-label');
  const mark = document.getElementById('live-connection-indicator');
  const strip = document.getElementById('global-activity-strip');
  const cortex = document.getElementById('live-cortex');
  if (label) label.textContent = state === 'connected' ? 'Live' : state === 'disconnected' ? 'Reconnecting' : 'Connecting';
  if (mark) mark.className = `live-status-mark is-${state}`;
  if (strip) strip.classList.toggle('is-connecting', state !== 'connected');
  if (cortex) cortex.classList.toggle('is-connecting', state !== 'connected');
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
  if (!target) return;
  target.setAttribute('aria-busy', 'false');
  if (!items.length) {
    target.innerHTML = '<span class="live-current-empty">No active process. The regions below retain the most recent signal in each system.</span>';
    return;
  }
  target.innerHTML = items.map(item => `<span class="live-current-chip" data-lane="${escHtml(item.lane)}">
    <strong>${escHtml(item.label)}</strong><span>${escHtml(runtimeActivityLaneLabels[item.lane] || item.lane)}</span>
  </span>`).join('');
}

function latestRegionActivity(region, current, recent) {
  return current.find(item => runtimeActivityRegion(item) === region)
    || recent.find(item => runtimeActivityRegion(item) === region)
    || null;
}

function renderRuntimeRegions(current, recent) {
  Object.keys(runtimeActivityRegionDefaults).forEach(region => {
    const node = document.querySelector(`[data-live-region="${region}"]`);
    if (!node) return;
    const item = latestRegionActivity(region, current, recent);
    const status = item?.status || 'quiet';
    node.dataset.status = status;
    const state = node.querySelector('.live-region-state');
    const title = node.querySelector('.live-region-title');
    const detail = node.querySelector('.live-region-detail');
    const time = node.querySelector('.live-region-time');
    if (state) state.textContent = runtimeActivityStateLabel(status);
    if (title) title.textContent = item?.label || runtimeActivityRegionDefaults[region][0];
    if (detail) detail.textContent = item?.outcome || item?.detail || runtimeActivityRegionDefaults[region][1];
    if (time) time.textContent = item
      ? `${item.status === 'active' ? 'Started' : 'Updated'} ${activityTime(item.completed_at || item.updated_at || item.started_at)}`
      : 'No recent signal';
    const link = document.querySelector(`[data-live-link="${region}"]`);
    if (link) link.dataset.status = status;
  });
}

function renderActivityHistory(items) {
  const target = document.getElementById('live-history-list');
  const summary = document.getElementById('live-history-summary');
  if (!target) return;
  const failures = items.filter(item => item.status === 'failed').length;
  if (summary) summary.textContent = items.length
    ? `${items.length} retained events${failures ? `, ${failures} need attention` : ''}`
    : 'No retained events in this process';
  if (!items.length) {
    target.innerHTML = '<div class="live-empty"><strong>No recent activity in this process yet.</strong><span>New terminal events will appear here as Nora works.</span></div>';
    return;
  }
  target.innerHTML = items.slice(0, 40).map(item => {
    const duration = activityDuration(item.duration_ms);
    const status = item.kind === 'hourly_phase' ? 'Started' : runtimeActivityStateLabel(item.status);
    return `<article class="live-history-item" data-status="${escHtml(item.status)}">
      <div class="live-history-rail" aria-hidden="true"></div>
      <div class="live-history-copy">
        <div class="live-item-topline"><strong>${escHtml(item.label)}</strong><span>${escHtml(status)}</span></div>
        <p>${escHtml(item.outcome || item.detail || 'The activity reached a terminal state.')}</p>
        <small>${escHtml(runtimeActivityLaneLabels[item.lane] || item.lane)} / ${escHtml(activityTime(item.completed_at || item.updated_at))}${duration && item.kind !== 'hourly_phase' ? ` / ${escHtml(duration)}` : ''}</small>
      </div>
    </article>`;
  }).join('');
}

function miniBoard(board) {
  const values = Array.isArray(board) && board.length === 4 ? board.flat().slice(0, 16) : Array(16).fill(0);
  while (values.length < 16) values.push(0);
  return values.map(value => {
    const rank = value ? Math.min(7, Math.max(1, Math.log2(Number(value) || 1))) : 0;
    return `<span class="live-mini-cell" data-rank="${rank}"></span>`;
  }).join('');
}

function renderRuntimeActivityContext() {
  const readingTarget = document.getElementById('live-reading-snapshot');
  const playTarget = document.getElementById('live-play-snapshot');
  const reading = runtimeActivityContext?.reading || null;
  const play = runtimeActivityContext?.play || null;
  if (readingTarget) {
    const progress = reading?.total_chunks
      ? `${reading.completed_chunks}/${reading.total_chunks} chunks`
      : reading ? runtimeActivityStateLabel(reading.status) : 'No admitted encounter yet';
    readingTarget.innerHTML = `<span class="live-book-mark" aria-hidden="true"></span><div>
      <strong>${escHtml(reading?.title || 'The shelves are ready')}</strong>
      <p>${escHtml(reading ? `${reading.author || 'Author unavailable'} / ${progress}${reading.last_reflection ? ` / ${reading.last_reflection}` : ''}` : 'A source-bound reading snapshot will appear here.')}</p>
    </div>`;
    const node = readingTarget.closest('[data-live-region]');
    if (node && reading?.status === 'active' && node.dataset.status === 'quiet') node.dataset.status = 'active';
  }
  if (playTarget) {
    const activity = play?.activity === 'merge_grid' ? 'Merge grid' : play?.activity === 'quiet' ? 'Quiet interval' : 'No session yet';
    const score = play?.game ? `${play.game.score} points / tile ${play.game.maximum_tile}` : runtimeActivityStateLabel(play?.status);
    playTarget.innerHTML = `<div class="live-mini-board" aria-hidden="true">${miniBoard(play?.game?.board)}</div><div>
      <strong>${escHtml(activity)}</strong><p>${escHtml(play ? `${score}${play.appraisal?.satisfaction != null ? ` / satisfaction ${Math.round(play.appraisal.satisfaction * 100)}%` : ''}` : 'A bounded game snapshot will appear here.')}</p>
    </div>`;
    const node = playTarget.closest('[data-live-region]');
    if (node && play?.status && !['completed', 'excluded'].includes(play.status) && node.dataset.status === 'quiet') node.dataset.status = 'active';
  }
}

function renderRuntimeActivity() {
  renderRuntimeActivityGlobal();
  if (!document.getElementById('page-live')?.classList.contains('active')) return;
  const current = [...(runtimeActivitySnapshot?.current || [])]
    .sort((left, right) => runtimeActivityPriority(left) - runtimeActivityPriority(right)
      || String(right.updated_at).localeCompare(String(left.updated_at)));
  const recent = runtimeActivitySnapshot?.recent || [];
  const primary = current[0] || null;
  const focus = document.getElementById('live-region-focus');
  const title = document.getElementById('live-primary-label');
  const detail = document.getElementById('live-primary-detail');
  const time = document.getElementById('live-focus-time');
  const meta = document.getElementById('live-primary-meta');
  if (focus) focus.dataset.status = primary?.status || 'quiet';
  if (title) title.textContent = primary?.label || (runtimeActivityConnection === 'connected' ? 'Standing by between tasks' : 'Reconnecting to Nora');
  if (detail) detail.textContent = primary?.detail || (runtimeActivityConnection === 'connected'
    ? 'The stream is live. New activity will illuminate the functional region handling it.'
    : 'The last bounded snapshot remains visible while the connection retries.');
  if (time) time.textContent = primary ? `Started ${activityTime(primary.started_at)}` : 'No process currently holds attention';
  if (meta) meta.textContent = runtimeActivitySnapshot
    ? `Updated ${activityTime(runtimeActivitySnapshot.generated_at)}`
    : 'No live timestamp yet';
  renderCurrentActivity(current);
  renderRuntimeRegions(current, recent);
  renderRuntimeActivityContext();
  renderActivityHistory(recent);
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
  if (['learning', 'leisure'].includes(item.lane)
    || ['developmental_reading', 'developmental_reading_selection', 'autonomous_play'].includes(item.kind)) {
    scheduleRuntimeActivityContext(350);
  }
  renderRuntimeActivity();
}

async function fetchRuntimeActivitySnapshot() {
  const response = await api('/runtime-activity', { cache: 'no-store' });
  if (!response.ok) throw new Error(`activity snapshot returned ${response.status}`);
  applyRuntimeActivitySnapshot(await response.json());
}

async function fetchRuntimeActivityContext() {
  runtimeActivityContextRequest?.abort();
  runtimeActivityContextRequest = new AbortController();
  const response = await api('/runtime-activity/context', { cache: 'no-store', signal: runtimeActivityContextRequest.signal });
  if (!response.ok) throw new Error(`activity context returned ${response.status}`);
  runtimeActivityContext = await response.json();
  runtimeActivityContextLoadedAt = Date.now();
  renderRuntimeActivityContext();
}

function scheduleRuntimeActivityContext(delay = 0) {
  if (!document.getElementById('page-live')?.classList.contains('active')) return;
  clearTimeout(runtimeActivityContextTimer);
  runtimeActivityContextTimer = setTimeout(() => {
    const conversationActive = (runtimeActivitySnapshot?.current || []).some(item => item.lane === 'conversation');
    if (conversationActive) return;
    fetchRuntimeActivityContext().catch(error => {
      if (error.name !== 'AbortError') renderRuntimeActivityContext();
    });
  }, Math.max(0, delay));
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
  if (!runtimeActivityContext || Date.now() - runtimeActivityContextLoadedAt > 60000) {
    scheduleRuntimeActivityContext(250);
  }
  connectRuntimeActivityStream();
}

function startRuntimeActivity() {
  loadRuntimeActivity();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchRuntimeActivitySnapshot().catch(() => {});
  });
}
