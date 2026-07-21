// ===== Admin tab =====

    async function loadAdmin() {
      // Run all sub-loaders in parallel for snappy refresh
      await Promise.all([loadGiftDeliberations(), loadApiOpportunities(), loadMcpConnections(), loadActiveBots(), loadScheduledBots(), loadBotChannels(), loadCalendarStatus(), loadFinancialApproved(), loadProactiveChannels(), loadJoinedThreads()]);
    }

    async function loadGiftDeliberations() {
      const policyEl = document.getElementById('gift-policy-state');
      const intentEl = document.getElementById('gift-intent-list');
      const deliberationEl = document.getElementById('gift-deliberation-list');
      if (!policyEl || !intentEl || !deliberationEl) return;
      try {
        const [intentResponse, deliberationResponse] = await Promise.all([
          api('/gifts/intents'), api('/gifts/deliberations?limit=20'),
        ]);
        const intents = await intentResponse.json(); const deliberations = await deliberationResponse.json();
        if (!intentResponse.ok || !deliberationResponse.ok) throw new Error(intents.error || deliberations.error || 'Gift state unavailable');
        const p = intents.report || {}; const d = deliberations.report || {};
        policyEl.innerHTML = `<strong>$${((p.remaining_cents || 0) / 100).toFixed(2)} remaining this month</strong> &middot; ${d.total || 0} deliberations &middot; ${d.proposals_created || 0} proposals &middot; ${p.goody_send_enabled ? 'Goody ready' : 'sending disabled'}`;
        const actionable = (intents.intents || []).slice().reverse();
        intentEl.innerHTML = actionable.length ? `<div class="intelligence-meta" style="margin-top:12px;">Gift proposals</div>${actionable.map(item => {
          const actions = item.status === 'proposed'
            ? `<button class="btn btn-primary btn-sm" onclick="decideGiftIntent('${item.id}','approve')">Approve</button><button class="btn btn-danger btn-sm" onclick="decideGiftIntent('${item.id}','reject')">Reject</button>`
            : item.status === 'approved'
              ? `<button class="btn btn-primary btn-sm" onclick="decideGiftIntent('${item.id}','send')">Send through Goody</button><button class="btn btn-danger btn-sm" onclick="decideGiftIntent('${item.id}','reject')">Reject</button>` : '';
          const link = item.goody_gift_link ? ` &middot; <a href="${escHtml(item.goody_gift_link)}" target="_blank" rel="noopener">gift link</a>` : '';
          return `<div class="memory-item"><div style="flex:1;min-width:0;"><div class="memory-fact">${escHtml(item.recipient_name)} &middot; $${((item.amount_cents || 0) / 100).toFixed(2)} <span style="font-size:12px;color:var(--muted);">${escHtml(item.status)}</span></div><div class="memory-meta">${escHtml(item.reason)}${link}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;">${actions}</div></div>`;
        }).join('')}` : '<p class="empty">No gift proposals yet.</p>';
        const records = deliberations.deliberations || [];
        deliberationEl.innerHTML = records.length ? `<div class="intelligence-meta" style="margin-top:12px;">Recent deliberations</div>${records.map(item => `<div class="memory-item"><div style="flex:1;min-width:0;"><div class="memory-fact">${escHtml(item.recipient_name || 'Daily scan')} <span style="font-size:12px;color:var(--muted);">${escHtml(item.decision.replaceAll('_', ' '))}</span></div><div class="memory-meta">${escHtml(item.occasion)}</div><div class="memory-meta">Why: ${escHtml(item.rationale)}</div>${item.counterconsiderations?.length ? `<div class="memory-meta">Against: ${escHtml(item.counterconsiderations.join(' · '))}</div>` : ''}</div></div>`).join('')}` : '<p class="empty">No gift deliberations recorded yet.</p>';
      } catch (e) {
        policyEl.textContent = 'Gift state unavailable.';
        intentEl.innerHTML = ''; deliberationEl.innerHTML = `<p class="empty">${escHtml(e.message)}</p>`;
      }
    }

    async function decideGiftIntent(id, action) {
      const toast = document.getElementById('gift-toast');
      let body = action === 'approve' ? { approved_by: 'John' } : action === 'send'
        ? { sent_by: 'John', delivered_by: 'Nora' }
        : { rejected_by: 'John', note: prompt('Why reject this gift?', '') || '' };
      if ((action === 'approve' || action === 'send') && !confirm(`${action === 'send' ? 'Send' : 'Approve'} this gift?`)) return;
      toast.className = 'toast'; toast.textContent = action === 'send' ? 'Creating the Goody gift...' : 'Saving decision...';
      try {
        const r = await operatorApi(`/gifts/intents/${encodeURIComponent(id)}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const value = await r.json(); toast.className = r.ok ? 'toast ok' : 'toast err';
        toast.textContent = r.ok ? (action === 'send' ? `Gift sent${value.delivery?.ok ? ' and link delivered in Slack.' : '.'}` : action === 'approve' ? 'Gift approved.' : 'Gift rejected.') : (value.error || 'Gift decision failed');
        await loadGiftDeliberations();
      } catch (e) { toast.className = 'toast err'; toast.textContent = e.message; }
    }

    async function loadApiOpportunities() {
      const list = document.getElementById('api-opportunity-list');
      if (!list) return;
      try {
        const r = await api('/api-opportunities/proposals'); const d = await r.json();
        if (!d.proposals?.length) { list.innerHTML = '<p class="empty">Nora has not proposed an outside capability yet.</p>'; return; }
        list.innerHTML = d.proposals.slice().reverse().map(p => {
          const h = p.health || {}; const success = h.success_rate == null ? 'untested' : `${Math.round(h.success_rate * 100)}% reliable`;
          const outcomes = h.reviewed_calls ? `${h.helpful} helpful / ${h.unhelpful} unhelpful / ${h.unclear} unclear` : 'no usefulness outcomes yet';
          const actions = p.status === 'proposed'
            ? `<button class="btn btn-primary btn-sm" onclick="decideApiOpportunity('${p.id}','approve')">Approve & install</button><button class="btn btn-danger btn-sm" onclick="decideApiOpportunity('${p.id}','reject')">Reject</button>`
            : ['approved','suspended'].includes(p.status)
              ? `<button class="btn btn-danger btn-sm" onclick="decideApiOpportunity('${p.id}','retire')">Retire</button>`
              : p.status === 'retired' ? `<button class="btn btn-primary btn-sm" onclick="decideApiOpportunity('${p.id}','approve')">Reapprove</button>` : '';
          return `<div class="memory-item"><div style="flex:1;min-width:0;"><div class="memory-fact">${escHtml(p.name)} <span style="font-size:12px;color:var(--muted);">${escHtml(p.status)}</span></div><div class="memory-meta">${escHtml(p.capability || 'research')} &middot; ${escHtml(p.tool?.name || '')} &middot; ${escHtml(success)} &middot; ${escHtml(outcomes)}</div><div class="memory-meta">${escHtml(p.use_case || '')}</div>${p.suspension_reason || p.retirement_reason ? `<div class="memory-meta" style="color:var(--warn);">${escHtml(p.suspension_reason || p.retirement_reason)}</div>` : ''}</div><div style="display:flex;gap:6px;flex-wrap:wrap;">${actions}</div></div>`;
        }).join('');
      } catch (e) { list.innerHTML = `<p class="empty">Could not load capability proposals: ${escHtml(e.message)}</p>`; }
    }
    async function decideApiOpportunity(id, action) {
      const toast = document.getElementById('api-opportunity-toast');
      let note = '';
      if (action === 'reject' || action === 'retire') note = prompt(`Why ${action} this capability?`, '') || '';
      const endpoint = action === 'approve' ? 'approve' : action;
      const body = action === 'approve' ? { approved_by: 'John' }
        : action === 'reject' ? { rejected_by: 'John', note } : { retired_by: 'John', note };
      try {
        const r = await operatorApi(`/api-opportunities/proposals/${encodeURIComponent(id)}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json(); toast.className = r.ok ? 'toast ok' : 'toast err';
        toast.textContent = r.ok ? `${d.proposal.name} is now ${d.proposal.status}.` : (d.error || 'Decision failed');
        await loadApiOpportunities();
      } catch (e) { toast.className = 'toast err'; toast.textContent = e.message; }
    }

    // ===== Live MCP connections =====
    let _editingMcpId = null;
    async function loadMcpConnections() {
      const list = document.getElementById('mcp-list');
      try {
        const r = await api('/admin/mcp');
        const conns = (await r.json()).connections || [];
        if (!conns.length) { list.innerHTML = '<p class="empty">No live connections yet. Add one below, authorize it if needed, then test it to discover tools.</p>'; return; }
        list.innerHTML = conns.map(c => `
          <div class="memory-item">
            <div style="flex:1;min-width:0;">
              <div class="memory-fact">${escHtml(c.name)} ${c.financial ? '<span style="color:var(--warn);font-size:12px;">financial</span>' : ''} ${c.enabled ? '' : '<span style="color:var(--muted);font-size:12px;">(disabled)</span>'}</div>
              <div class="memory-meta" style="word-break:break-all;">${escHtml(c.url_hint)} &middot; ${escHtml(c.auth_type.replaceAll('_', ' '))} &middot; ${c.access_mode === 'full' ? 'write enabled' : 'read only'}${c.deferred === true ? ' &middot; <span style="color:var(--accent-ink);">background: all tools</span>' : c.deferred === false ? ' &middot; <span style="color:var(--muted);">background: off</span>' : ''}</div>
              <div class="memory-meta">${escHtml(c.status)}${c.status_message ? `: ${escHtml(c.status_message)}` : ''}${c.last_tested ? ` &middot; tested ${new Date(c.last_tested).toLocaleString()}` : ''}</div>
              ${c.tools?.length ? `<div class="memory-meta">${c.tools.filter(t => t.allowed).length}/${c.tools.length} tools enabled</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
              ${c.auth_type === 'oauth' && !c.oauth_connected ? `<button class="btn btn-primary btn-sm" onclick="connectMcpOAuth('${c.id}')">Connect</button>` : ''}
              <button class="btn btn-sm" onclick="testMcpConnection('${c.id}')">Test</button>
              <button class="btn btn-sm" style="background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);" onclick="toggleMcp('${c.id}',${!c.enabled})">${c.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn btn-success btn-sm" onclick='editMcp(${JSON.stringify(c).replace(/'/g, "&#39;")})'>Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteMcp('${c.id}','${escHtml(c.name).replace(/'/g, "\\'")}')">Delete</button>
            </div>
          </div>`).join('');
      } catch { list.innerHTML = '<p class="empty">Failed to load connections.</p>'; }
    }
    function updateMcpAuthFields() {
      const type = document.getElementById('mcp-auth-type').value;
      document.getElementById('mcp-bearer-fields').hidden = type !== 'bearer';
      document.getElementById('mcp-oauth-fields').hidden = !['oauth', 'client_credentials'].includes(type);
      document.getElementById('mcp-header-fields').hidden = type !== 'custom_headers';
      document.getElementById('mcp-url-token-note').hidden = type !== 'url_token';
    }
    async function saveMcpConnection() {
      const value = id => document.getElementById(id).value;
      const name = value('mcp-name').trim(), url = value('mcp-url').trim(), auth_type = value('mcp-auth-type');
      const t = document.getElementById('mcp-toast');
      if (!name || (!_editingMcpId && !url)) { t.className = 'toast err'; t.textContent = 'Name and URL are required'; return; }
      const deferSel = (document.getElementById('mcp-deferred') || {}).value || 'auto';
      const body = { name, auth_type, financial: document.getElementById('mcp-financial').checked,
        enabled: document.getElementById('mcp-enabled').checked, access_mode: document.getElementById('mcp-full-access').checked ? 'full' : 'read_only',
        deferred: deferSel === 'always' ? true : deferSel === 'never' ? false : null };
      if (url) body.url = url;
      if (value('mcp-token')) body.token = value('mcp-token');
      if (value('mcp-client-id').trim()) body.client_id = value('mcp-client-id').trim();
      if (value('mcp-client-secret')) body.client_secret = value('mcp-client-secret');
      if (value('mcp-scopes').trim()) body.scopes = value('mcp-scopes').trim();
      if (auth_type === 'custom_headers') {
        try { if (value('mcp-headers').trim()) body.headers = JSON.parse(value('mcp-headers')); }
        catch { t.className = 'toast err'; t.textContent = 'Custom headers must be valid JSON'; return; }
      }
      try {
        const r = await operatorApi(_editingMcpId ? `/admin/mcp/${_editingMcpId}` : '/admin/mcp', { method: _editingMcpId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json(); if (!r.ok) { t.className = 'toast err'; t.textContent = d.error || 'Save failed'; return; }
        const savedId = d.connection.id; resetMcpForm(); await loadMcpConnections();
        t.className = 'toast ok'; t.textContent = d.connection.auth_type === 'oauth' ? 'Saved. Click Connect to authorize.' : 'Saved. Testing connection...';
        if (d.connection.auth_type !== 'oauth') await testMcpConnection(savedId);
      } catch (e) { t.className = 'toast err'; t.textContent = `Failed: ${e.message}`; }
    }
    function editMcp(c) {
      _editingMcpId = c.id;
      document.getElementById('mcp-name').value = c.name;
      ['mcp-url','mcp-token','mcp-client-id','mcp-client-secret','mcp-scopes','mcp-headers'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('mcp-auth-type').value = c.auth_type || 'none';
      document.getElementById('mcp-financial').checked = !!c.financial;
      document.getElementById('mcp-enabled').checked = c.enabled !== false;
      document.getElementById('mcp-full-access').checked = c.access_mode === 'full';
      document.getElementById('mcp-deferred').value = c.deferred === true ? 'always' : c.deferred === false ? 'never' : 'auto';
      document.getElementById('mcp-form-title').textContent = 'Edit connection (blank secrets and URL keep their current values)';
      document.getElementById('mcp-save-btn').textContent = 'Save'; updateMcpAuthFields();
      document.getElementById('mcp-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function resetMcpForm() {
      _editingMcpId = null;
      ['mcp-name','mcp-url','mcp-token','mcp-client-id','mcp-client-secret','mcp-scopes','mcp-headers'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('mcp-auth-type').value = 'none'; document.getElementById('mcp-financial').checked = false;
      document.getElementById('mcp-enabled').checked = true; document.getElementById('mcp-full-access').checked = false;
      document.getElementById('mcp-deferred').value = 'auto';
      document.getElementById('mcp-form-title').textContent = 'Add a connection'; document.getElementById('mcp-save-btn').textContent = 'Add'; updateMcpAuthFields();
    }
    async function connectMcpOAuth(id) {
      const t = document.getElementById('mcp-toast'); t.className = 'toast'; t.textContent = 'Starting secure authorization...';
      const r = await operatorApi(`/admin/mcp/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json(); if (!r.ok) { t.className = 'toast err'; t.textContent = d.error || 'Could not start OAuth'; return; }
      window.location.assign(d.authorize_url);
    }
    async function testMcpConnection(id) {
      const t = document.getElementById('mcp-toast'); t.className = 'toast'; t.textContent = 'Testing connection and discovering tools...';
      const r = await operatorApi(`/admin/mcp/${encodeURIComponent(id)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json(); t.className = r.ok ? 'toast ok' : 'toast err'; t.textContent = r.ok ? d.connection.status_message : (d.error || 'Connection test failed');
      await loadMcpConnections();
    }
    async function toggleMcp(id, enabled) { await operatorApi(`/admin/mcp/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); loadMcpConnections(); }
    async function deleteMcp(id, name) { if (!confirm(`Delete MCP connection "${name}"?`)) return; await operatorApi(`/admin/mcp/${id}`, { method: 'DELETE' }); loadMcpConnections(); }

    // Slack - channels the Nora bot is a member of
    async function loadBotChannels() {
      const el = document.getElementById('bot-channels-list');
      try {
        const r = await api('/admin/slack/bot-channels');
        const d = await r.json();
        if (!r.ok || d.error) {
          el.innerHTML = `<p class="empty">Failed to load: ${escHtml(typeof d.error === 'string' ? d.error : JSON.stringify(d.error || 'error'))}</p>`;
          return;
        }
        if (!d.channels || d.channels.length === 0) {
          el.innerHTML = '<p class="empty">Nora isn\'t a member of any channels yet.</p>';
          return;
        }
        const more = d.next_cursor ? '<div class="memory-meta" style="margin-top:8px;">More channels exist (pagination not yet shown - first 200 listed).</div>' : '';
        el.innerHTML = `
          <div class="memory-meta" style="margin-bottom: 8px;">${d.channels.length} channel${d.channels.length === 1 ? '' : 's'}</div>
          ${d.channels.map(c => `
            <div class="memory-item">
              <div style="flex: 1; min-width: 0;">
                <div class="memory-fact">#${escHtml(c.name)}${c.is_private ? ' <span style="color:var(--dim);font-size:11px;">(private)</span>' : ''}</div>
                <div class="memory-meta">${escHtml(c.id)}${c.num_members != null ? ' · ' + c.num_members + ' member' + (c.num_members === 1 ? '' : 's') : ''}${c.topic ? ' · ' + escHtml(c.topic) : ''}</div>
              </div>
            </div>
          `).join('')}
          ${more}`;
      } catch (e) {
        el.innerHTML = `<p class="empty">Failed to load bot channels: ${escHtml(e.message)}</p>`;
      }
    }

    // Active bots - list + remove
    function fmtBotStatus(s) {
      const map = {
        ready: 'Ready',
        joining_call: 'Joining',
        in_call_recording: 'In call (recording)',
        in_call_not_recording: 'In call'
      };
      return map[s] || s || 'unknown';
    }
    function fmtBotMeetingUrl(u) {
      if (!u) return '';
      // The server normalizes meeting_url to a string, but be defensive: if some
      // future code path passes an object through, render it readably instead of
      // letting JS stringify it as "[object Object]".
      if (typeof u !== 'string') {
        try { return JSON.stringify(u); } catch { return ''; }
      }
      try {
        const url = new URL(u);
        return url.hostname + url.pathname;
      } catch { return u; }
    }
    async function loadActiveBots() {
      const list = document.getElementById('active-bots-list');
      try {
        const r = await api('/admin/active-bots');
        const d = await r.json();
        if (!Array.isArray(d.bots) || d.bots.length === 0) {
          list.innerHTML = '<p class="empty">No active bots.</p>';
          return;
        }
        list.innerHTML = d.bots.map(b => `
          <div class="memory-item">
            <div style="flex: 1; min-width: 0;">
              <div class="memory-fact" style="word-break: break-all;">${escHtml(fmtBotMeetingUrl(b.meeting_url) || '(no meeting URL)')}</div>
              <div class="memory-meta">${escHtml(fmtBotStatus(b.status))}${b.join_at ? ' · joins ' + escHtml(new Date(b.join_at).toLocaleString()) : ''} · ${escHtml(b.id)}</div>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
              <button class="btn btn-danger" onclick="removeBot('${escHtml(b.id)}', '${escHtml(fmtBotMeetingUrl(b.meeting_url))}')">Remove</button>
            </div>
          </div>
        `).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load active bots.</p>';
      }
    }
    async function removeBot(botId, label) {
      if (!confirm(`Remove Nora from "${label || botId}"?`)) return;
      const s = document.getElementById('active-bots-toast');
      try {
        const r = await api('/admin/bots/' + botId + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          s.className = 'toast err'; s.textContent = 'Remove failed: ' + (d.error ? JSON.stringify(d.error) : r.status);
          return;
        }
        s.className = 'toast ok'; s.textContent = 'Removed.';
        loadActiveBots();
        setTimeout(() => s.style.display = 'none', 2500);
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    // Scheduled bots - list with duplicate detection + remove
    async function loadScheduledBots() {
      const list = document.getElementById('scheduled-bots-list');
      const dedupeBtn = document.getElementById('scheduled-dedupe-btn');
      try {
        const r = await api('/admin/scheduled-bots');
        const d = await r.json();
        if (!Array.isArray(d.bots) || d.bots.length === 0) {
          list.innerHTML = '<p class="empty">No scheduled bots.</p>';
          if (dedupeBtn) dedupeBtn.style.display = 'none';
          return;
        }
        // Show the bulk-dedupe button only when there are duplicates to clear.
        if (dedupeBtn) dedupeBtn.style.display = d.duplicate_count > 0 ? '' : 'none';
        const dupNote = d.duplicate_count > 0
          ? `<div style="background:var(--danger-soft);color:var(--danger);padding:8px 10px;border-radius:6px;margin-bottom:10px;font-size:12px;">${d.duplicate_count} duplicate bot${d.duplicate_count === 1 ? '' : 's'} detected - two or more bots queued for the same meeting within an hour. Remove individually below, or use Remove all duplicates above.</div>`
          : '';
        list.innerHTML = dupNote + d.bots.map(b => {
          const dupBadge = b.is_duplicate
            ? ' <span style="background:var(--danger-soft);color:var(--danger);padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:0.5px;">DUPLICATE</span>'
            : '';
          const joinAt = b.join_at ? new Date(b.join_at).toLocaleString() : 'unknown';
          return `
            <div class="memory-item">
              <div style="flex: 1; min-width: 0;">
                <div class="memory-fact" style="word-break: break-all;">${escHtml(fmtBotMeetingUrl(b.meeting_url) || '(no meeting URL)')}${dupBadge}</div>
                <div class="memory-meta">joins ${escHtml(joinAt)} · ${escHtml(fmtBotStatus(b.status))} · ${escHtml(b.id)}</div>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="btn btn-danger" onclick="removeScheduledBot('${escHtml(b.id)}', '${escHtml(fmtBotMeetingUrl(b.meeting_url))}')">Remove</button>
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load scheduled bots.</p>';
      }
    }
    async function removeScheduledBot(botId, label) {
      if (!confirm(`Cancel the scheduled bot for "${label || botId}"?`)) return;
      const s = document.getElementById('scheduled-bots-toast');
      try {
        const r = await api('/admin/bots/' + botId + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          s.className = 'toast err'; s.textContent = 'Remove failed: ' + (d.error ? JSON.stringify(d.error) : r.status);
          return;
        }
        s.className = 'toast ok'; s.textContent = 'Removed.';
        loadScheduledBots();
        setTimeout(() => s.style.display = 'none', 2500);
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }
    async function dedupeScheduledBots() {
      if (!confirm('Remove all duplicate scheduled bots? One bot is kept per meeting (the earliest-joining one); the rest are cancelled.')) return;
      const s = document.getElementById('scheduled-bots-toast');
      s.className = 'toast ok'; s.textContent = 'Removing duplicates…';
      try {
        const r = await api('/admin/scheduled-bots/dedupe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json();
        if (!r.ok || d.error) {
          s.className = 'toast err'; s.textContent = 'Dedupe failed: ' + (d.error ? JSON.stringify(d.error) : r.status);
          return;
        }
        const failedCount = Array.isArray(d.failed) ? d.failed.length : 0;
        const failedNote = failedCount > 0 ? ` (${failedCount} failed - see logs)` : '';
        s.className = failedCount > 0 ? 'toast err' : 'toast ok';
        s.textContent = `Removed ${d.removed} duplicate bot${d.removed === 1 ? '' : 's'}${failedNote}.`;
        loadScheduledBots();
        setTimeout(() => s.style.display = 'none', 4000);
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    // Calendar auto-join
    async function loadCalendarStatus() {
      const el = document.getElementById('calendar-status');
      try {
        const r = await api('/calendar/status');
        const d = await r.json();
        if (!d.connected) {
          el.innerHTML = `
            <p class="empty" style="margin-bottom: 10px;">No calendar connected.</p>
            <button class="btn btn-primary btn-sm" onclick="connectCalendar()">Connect Nora's Google Calendar</button>`;
          return;
        }
        const connectedAt = d.connected_at ? new Date(d.connected_at).toLocaleString() : 'unknown';
        const lastSync = d.last_sync ? new Date(d.last_sync).toLocaleString() : 'never';
        el.innerHTML = `
          <div class="memory-item">
            <div style="flex: 1;">
              <div class="memory-fact">${escHtml(d.google_email)}</div>
              <div class="memory-meta">Connected ${escHtml(connectedAt)} · Last sync ${escHtml(lastSync)}</div>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
              <button class="btn btn-danger" onclick="disconnectCalendar()">Disconnect</button>
            </div>
          </div>`;
      } catch (e) {
        el.innerHTML = '<p class="empty">Failed to load calendar status.</p>';
      }
    }

    async function connectCalendar() {
      const s = document.getElementById('calendar-status-toast');
      try {
        const r = await api('/calendar/connect');
        const d = await r.json();
        if (d.authorize_url) {
          // Top-level redirect to Google's consent screen. After consent, Google bounces
          // back to /calendar/oauth/callback which then redirects to '/?calendar_connected=1'.
          window.location.href = d.authorize_url;
        } else {
          s.className = 'toast err'; s.textContent = d.error || 'Failed to start OAuth';
        }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function disconnectCalendar() {
      if (!confirm("Disconnect Nora's calendar? She'll stop auto-joining meetings until you reconnect.")) return;
      const s = document.getElementById('calendar-status-toast');
      try {
        await api('/calendar', { method: 'DELETE' });
        s.className = 'toast ok'; s.textContent = 'Calendar disconnected';
        loadCalendarStatus();
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    // After the OAuth callback bounces back to '/?calendar_connected=1', show a toast
    // and refresh the admin view (if visible).
    (function handleCalendarConnectedRedirect() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('calendar_connected') === '1') {
        // Clean the URL so a refresh doesn't re-toast.
        history.replaceState({}, '', window.location.pathname);
        setTimeout(() => {
          const s = document.getElementById('calendar-status-toast');
          if (s) { s.className = 'toast ok'; s.textContent = 'Calendar connected - Nora will start auto-joining invited meetings.'; }
          showTab('admin');
        }, 200);
      }
    })();

    // Financial-approved Slack users
    async function loadFinancialApproved() {
      const list = document.getElementById('financial-approved-list');
      try {
        const r = await api('/slack/financial-approved');
        const d = await r.json();
        if (!d.approved || d.approved.length === 0) {
          list.innerHTML = '<p class="empty">No users on the approved list yet - every Slack user is currently treated as unapproved (fail-closed).</p>';
          return;
        }
        list.innerHTML = d.approved.map(u => `
          <div class="memory-item">
            <div style="flex: 1;">
              <div class="memory-fact">${escHtml(u.name || '(no name recorded)')}</div>
              <div class="memory-meta">${escHtml(u.user_id)}</div>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
              <button class="btn btn-danger" onclick="removeApprovedUser('${escHtml(u.user_id)}', '${escHtml(u.name || u.user_id)}')">Remove</button>
            </div>
          </div>
        `).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load approved list.</p>';
      }
    }

    async function addApprovedUser() {
      const s = document.getElementById('approved-status');
      const userId = document.getElementById('new-approved-userid').value.trim();
      const name = document.getElementById('new-approved-name').value.trim();
      if (!userId) { s.className = 'toast err'; s.textContent = 'Slack user ID required (starts with U)'; return; }
      if (!/^U[A-Z0-9]+$/.test(userId)) { s.className = 'toast err'; s.textContent = 'User IDs start with U and are alphanumeric (e.g. U07ABC123)'; return; }
      try {
        const r = await api('/slack/financial-approved/' + encodeURIComponent(userId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(name ? { name } : {})
        });
        const d = await r.json();
        if (d.ok) {
          s.className = 'toast ok'; s.textContent = `Added ${name || userId}`;
          document.getElementById('new-approved-userid').value = '';
          document.getElementById('new-approved-name').value = '';
          loadFinancialApproved();
          setTimeout(() => s.className = 'toast', 2500);
        } else {
          s.className = 'toast err'; s.textContent = d.error || 'Failed to add';
        }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function removeApprovedUser(userId, displayName) {
      if (!confirm(`Remove ${displayName} from the financial-approved list? They'll start getting redirected on financial questions.`)) return;
      try {
        await api('/slack/financial-approved/' + encodeURIComponent(userId), { method: 'DELETE' });
        loadFinancialApproved();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    // Proactive Slack channels
    async function loadProactiveChannels() {
      const list = document.getElementById('proactive-channels-list');
      try {
        const r = await api('/slack/proactive-channels');
        const d = await r.json();
        if (!d.channels || d.channels.length === 0) {
          list.innerHTML = '<p class="empty">No channels enabled. Nora only responds to @mentions and DMs by default.</p>';
          return;
        }
        list.innerHTML = d.channels.map(c => {
          const lastPost = c.last_proactive_post ? new Date(c.last_proactive_post).toLocaleString() : 'never';
          const cooldownLabel = c.cooldown_active ? '<span style="color: var(--warn);">cooldown active</span>' : '<span style="color: var(--success);">ready</span>';
          const heading = c.channel_name
            ? `<span>#${escHtml(c.channel_name)}</span> <span style="color: var(--dim); font-weight: 400; font-family: monospace; font-size: 11px; margin-left: 6px;">${escHtml(c.channel)}</span>`
            : `<span style="font-family: monospace;">${escHtml(c.channel)}</span>`;
          return `
            <div class="memory-item">
              <div style="flex: 1;">
                <div class="memory-fact">${heading}</div>
                <div class="memory-meta">${cooldownLabel} · last proactive post: ${lastPost}</div>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="btn btn-danger" onclick="removeProactiveChannel('${escHtml(c.channel)}')">Disable</button>
              </div>
            </div>
          `;
        }).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load proactive channels.</p>';
      }
    }

    async function addProactiveChannel() {
      const s = document.getElementById('proactive-status');
      const channel = document.getElementById('new-proactive-channel').value.trim();
      if (!channel) { s.className = 'toast err'; s.textContent = 'Channel ID required'; return; }
      if (!/^[CG][A-Z0-9]+$/.test(channel)) { s.className = 'toast err'; s.textContent = 'Channel IDs start with C (public) or G (private) and are alphanumeric'; return; }
      try {
        const r = await api('/slack/proactive-channels/' + encodeURIComponent(channel), { method: 'POST' });
        const d = await r.json();
        if (d.ok) {
          s.className = 'toast ok'; s.textContent = `Enabled ${channel}`;
          document.getElementById('new-proactive-channel').value = '';
          loadProactiveChannels();
          setTimeout(() => s.className = 'toast', 2500);
        } else {
          s.className = 'toast err'; s.textContent = d.error || 'Failed to enable';
        }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function removeProactiveChannel(channel) {
      if (!confirm(`Disable proactive speaking in ${channel}? Nora will go back to @mention-only there.`)) return;
      try {
        await api('/slack/proactive-channels/' + encodeURIComponent(channel), { method: 'DELETE' });
        loadProactiveChannels();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    // Joined Slack threads
    async function loadJoinedThreads() {
      const list = document.getElementById('joined-threads-list');
      const summary = document.getElementById('joined-threads-summary');
      try {
        const r = await api('/slack/threads');
        const d = await r.json();
        const t = d.stale_thresholds || {};
        summary.textContent = `${d.count || 0} total · ${d.active || 0} active · ${d.stale || 0} stale (stale = ${t.msg_count || 5} msgs unaddressed or ${t.age_minutes || 30}+ min idle)`;
        if (!d.threads || d.threads.length === 0) {
          list.innerHTML = '<p class="empty">No threads currently being followed.</p>';
          return;
        }
        list.innerHTML = d.threads.map(th => {
          const last = th.last_addressed ? new Date(th.last_addressed).toLocaleString() : 'unknown';
          const stalePill = th.stale
            ? '<span style="color: var(--warn); font-weight: 600;">STALE</span>'
            : '<span style="color: var(--success); font-weight: 600;">active</span>';
          const channelLabel = th.channel_name
            ? `#${escHtml(th.channel_name)}`
            : escHtml(th.channel);
          const heading = `<span style="font-size: 14px;">${channelLabel}</span> <span style="font-family: monospace; font-size: 11px; color: var(--dim); margin-left: 6px;">${escHtml(th.thread_ts)}</span>`;
          return `
            <div class="memory-item">
              <div style="flex: 1;">
                <div class="memory-fact">${heading}</div>
                <div class="memory-meta">${stalePill} · last addressed: ${last} · ${th.msgs_since_addressed || 0} msgs since</div>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="btn btn-danger" onclick="unjoinThread('${escHtml(th.channel)}', '${escHtml(th.thread_ts)}')">Untrack</button>
              </div>
            </div>
          `;
        }).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load joined threads.</p>';
      }
    }

    async function unjoinThread(channel, ts) {
      if (!confirm('Untrack this thread? Nora will require a re-mention to engage there again.')) return;
      try {
        await api('/slack/threads/' + encodeURIComponent(channel) + '/' + encodeURIComponent(ts), { method: 'DELETE' });
        loadJoinedThreads();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    // Teamwork project sync
    async function runTeamworkSync(dryRun) {
      const s = document.getElementById('sync-status');
      const out = document.getElementById('sync-result');
      s.className = 'toast ok'; s.textContent = dryRun ? 'Running dry-run...' : 'Syncing from Teamwork...';
      out.style.display = 'none';
      try {
        const r = await api('/projects/sync-from-teamwork', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: !!dryRun })
        });
        const d = await r.json();
        if (d.ok) {
          const verb = dryRun ? 'Would create' : 'Created';
          s.className = 'toast ok';
          s.textContent = `${verb} ${d.created}, promoted ${d.promoted}, ${d.unchanged} unchanged · scanned ${d.after_filter} of ${d.teamwork_total} TW projects (${d.pages_fetched} page${d.pages_fetched === 1 ? '' : 's'})`;
          out.textContent = JSON.stringify(d, null, 2);
          out.style.display = 'block';
          // Refresh projects tab data if user clicks back
          if (typeof loadProjects === 'function') loadProjects();
        } else {
          s.className = 'toast err'; s.textContent = d.error || 'Sync failed';
          out.textContent = JSON.stringify(d, null, 2);
          out.style.display = 'block';
        }
      } catch (e) {
        s.className = 'toast err'; s.textContent = 'Failed: ' + e.message;
      }
    }
