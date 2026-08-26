// Slack conversation troubleshooting log
let slackLogRequest = null;

const slackOutcomeLabels = {
  delivered: 'Responded',
  no_response_needed: 'No response needed',
  intentionally_skipped: 'Intentionally skipped',
  handled_by_approval_flow: 'Approval flow',
  superseded: 'Superseded',
  processing: 'Processing',
  processing_file: 'Processing a file',
  error_message_delivered: 'Error explained',
  failed: 'Failed',
};

function slackOutcomeLabel(status) {
  if (slackOutcomeLabels[status]) return slackOutcomeLabels[status];
  return String(status || 'unknown').replaceAll('_', ' ');
}

function slackOutcomeTone(status) {
  if (status === 'delivered' || status === 'handled_by_approval_flow') return 'success';
  if (status === 'failed' || status === 'error_message_delivered') return 'danger';
  if (status === 'processing' || status === 'processing_file') return 'info';
  return 'quiet';
}

function slackLogSince(days) {
  if (!days || days === 'all') return null;
  const since = new Date();
  since.setDate(since.getDate() - Number(days));
  return since.toISOString();
}

function slackLogTime(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function slackLogChannel(item) {
  if (item.channel_name) {
    return item.channel_type === 'im' || item.channel_type === 'mpim'
      ? item.channel_name : '#' + item.channel_name.replace(/^#/, '');
  }
  return item.channel_type === 'im' || item.channel_type === 'mpim'
    ? 'Direct message' : 'Slack channel';
}

function slackSkipReason(item) {
  const reasons = {
    routing_gate: 'Nora was not addressed and the routing rules kept her quiet.',
    addressed_to_someone_else: 'The message appeared to be for someone else.',
    thread_engagement_gate: 'Nora determined that joining the thread would add noise.',
    channel_file_handling_is_dm_only: 'Channel file handling is limited to direct messages.',
    reply_not_needed: 'Nora determined that no reply was needed.',
    newer_inbound_arrived: 'A newer message replaced this request before Nora replied.',
  };
  return reasons[item.metadata?.reason] || item.metadata?.reason || null;
}

function renderSlackConversation(item) {
  const status = item.handling_status || 'unknown';
  const person = item.user_name || 'Unknown teammate';
  const channel = slackLogChannel(item);
  const response = item.response_text || slackSkipReason(item);
  const responseHeading = item.response_text ? 'Nora replied' : 'What happened';
  const error = item.error ? `
    <div class="slack-log-error"><strong>Error</strong><span>${escHtml(item.error)}</span></div>` : '';
  const responseBlock = response ? `
    <div class="slack-log-message slack-log-response">
      <div class="slack-log-message-label">${responseHeading}</div>
      <div class="slack-log-message-text">${escHtml(response)}</div>
    </div>` : `
    <div class="slack-log-message slack-log-response slack-log-pending">
      <div class="slack-log-message-label">What happened</div>
      <div class="slack-log-message-text">No response or terminal reason has been recorded yet.</div>
    </div>`;

  return `<article class="slack-log-card">
    <div class="slack-log-card-head">
      <div class="slack-log-where">
        <strong>${escHtml(person)}</strong>
        <span>${escHtml(channel)}</span>
        <time datetime="${escHtml(item.received_at || '')}">${escHtml(slackLogTime(item.received_at))}</time>
      </div>
      <span class="slack-outcome slack-outcome-${slackOutcomeTone(status)}">${escHtml(slackOutcomeLabel(status))}</span>
    </div>
    <div class="slack-log-message slack-log-inbound">
      <div class="slack-log-message-label">They asked</div>
      <div class="slack-log-message-text">${escHtml(item.inbound_text || '(No text. The message may have contained only a file.)')}</div>
    </div>
    ${responseBlock}
    ${error}
  </article>`;
}

function renderSlackLogSummary(conversations) {
  const summary = document.getElementById('slack-log-summary');
  if (!summary) return;
  const responded = conversations.filter(item => item.handling_status === 'delivered').length;
  const quiet = conversations.filter(item => ['no_response_needed', 'intentionally_skipped', 'superseded']
    .includes(item.handling_status)).length;
  const issues = conversations.filter(item => ['failed', 'error_message_delivered']
    .includes(item.handling_status)).length;
  summary.innerHTML = `
    <span><strong>${conversations.length}</strong> conversation${conversations.length === 1 ? '' : 's'}</span>
    <span><strong>${responded}</strong> responded</span>
    <span><strong>${quiet}</strong> stayed quiet</span>
    <span class="${issues ? 'has-issues' : ''}"><strong>${issues}</strong> issue${issues === 1 ? '' : 's'}</span>`;
}

async function loadSlackLog() {
  const list = document.getElementById('slack-log-list');
  if (!list) return;
  if (slackLogRequest) slackLogRequest.abort();
  const requestController = new AbortController();
  slackLogRequest = requestController;
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<p class="empty">Loading Slack conversations...</p>';

  const params = new URLSearchParams({ limit: '250' });
  const query = document.getElementById('slack-log-search')?.value.trim();
  const status = document.getElementById('slack-log-status')?.value;
  const since = slackLogSince(document.getElementById('slack-log-range')?.value || '7');
  if (query) params.set('q', query);
  if (status) params.set('status', status);
  if (since) params.set('since', since);

  try {
    const response = await api('/slack/conversations?' + params.toString(), {
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error(`Slack log request failed (${response.status})`);
    const payload = await response.json();
    const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
    renderSlackLogSummary(conversations);
    list.innerHTML = conversations.length
      ? conversations.map(renderSlackConversation).join('')
      : '<p class="empty">No Slack conversations match these filters.</p>';
  } catch (error) {
    if (error?.name === 'AbortError') return;
    document.getElementById('slack-log-summary').innerHTML = '';
    list.innerHTML = `<div class="slack-log-load-error">
      <strong>Could not load the Slack log.</strong>
      <span>${escHtml(error.message || 'Please try again.')}</span>
      <button class="btn btn-sm" type="button" onclick="loadSlackLog()">Try again</button>
    </div>`;
  } finally {
    if (slackLogRequest === requestController) {
      slackLogRequest = null;
      list.setAttribute('aria-busy', 'false');
    }
  }
}

function submitSlackLogFilters(event) {
  event.preventDefault();
  loadSlackLog();
}
