async function loadSelfTab() {
      try {
        const s = await (await api('/self')).json();
        if (s.soma && s.soma.feel) {
          document.getElementById('self-soma').textContent = s.soma.feel;
          const v = s.soma.vitals || {};
          document.getElementById('self-soma-vitals').textContent = `errors(10m): ${v.errors10 ?? '?'} · warns: ${v.warns10 ?? '?'} · loop lag: ${v.loopLag ?? '?'}ms · uptime: ${v.uptimeMin ?? '?'}m · memories: ${v.memCount ?? '?'} · embed backlog: ${v.embedBacklog ?? '?'}${v.onBackup ? ' · ON BACKUP (JSON fallback)' : ''}`;
        } else {
          document.getElementById('self-soma').textContent = '(not sensing yet)';
        }
        document.getElementById('self-inner').textContent = (s.inner_thread && s.inner_thread.content) || '(nothing yet)';
        document.getElementById('self-inner-meta').textContent = s.inner_thread && s.inner_thread.updated_at ? 'as of ' + new Date(s.inner_thread.updated_at).toLocaleString() : '';
        const wants = (s.wants && s.wants.items) || [];
        const active = wants.filter(w => w.status === 'active');
        const done = wants.filter(w => w.status !== 'active');
        document.getElementById('self-wants').innerHTML = (active.length || done.length)
          ? active.map(w => `<div style="padding:10px 0; border-bottom:1px solid var(--border);"><div style="font-weight:600; font-size:14px;">${escHtml(w.want)}</div>${w.why ? `<div style="font-size:12.5px; color:var(--muted); margin-top:2px;">because: ${escHtml(w.why)}</div>` : ''}${(w.progress || []).slice(-2).map(p => `<div style="font-size:11.5px; color:var(--dim); margin-top:3px; font-family:var(--mono);">${escHtml(p.date || '')} ${escHtml(p.note || '')}</div>`).join('')}</div>`).join('') +
            (done.length ? `<div style="font-size:11.5px; color:var(--dim); margin-top:8px;">${done.length} retired/done</div>` : '')
          : '<p class="empty">No wants yet. The dream forms them.</p>';
        const bio = s.autobiography || {};
        document.getElementById('self-bio').value = bio.content || '';
        document.getElementById('self-bio-meta').textContent = bio.updated_at ? `Revision ${bio.sequence || '?'} · ${bio.provenance_status || 'unclassified'} · last updated ${new Date(bio.updated_at).toLocaleString()} by ${bio.updated_by || '?'} · ${(bio.content || '').length.toLocaleString()} chars · ${bio.audit?.projection_usable ? 'integrity verified' : 'integrity unavailable'}` : (bio.projection_integrity_failure ? 'Autobiography withheld: revision or evidence integrity failed.' : '');
        const p = await (await api('/prompt?json=1')).json();
        document.getElementById('persona-content').value = p.content || '';
        document.getElementById('persona-meta').textContent = p.updated_at ? `Last updated ${new Date(p.updated_at).toLocaleString()} by ${p.updated_by || '?'}${p.note ? ` · "${p.note}"` : ''} · ${(p.content || '').length.toLocaleString()} chars` : `${(p.content || '').length.toLocaleString()} chars (seed)`;
      } catch (e) { document.getElementById('self-inner').textContent = 'Failed to load.'; }
    }

    async function savePersona() {
      const content = document.getElementById('persona-content').value; const s = document.getElementById('persona-status');
      if (!content.trim()) { s.className = 'toast err'; s.textContent = 'Cannot be empty.'; return; }
      if (!confirm('Approve and save this persona revision? This signed operator action changes her voice everywhere immediately (Slack, calls, the hourly loop).')) return;
      try {
        const r = await operatorApi('/prompt', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, updated_by: 'dashboard-operator' }) });
        const d = await r.json();
        if (d.ok) { s.className = 'toast ok'; s.textContent = `Saved (${(d.length || 0).toLocaleString()} chars).`; loadSelfTab(); } else { s.className = 'toast err'; s.textContent = d.error || 'failed'; }
      } catch (e) { s.className = 'toast err'; s.textContent = e.message; }
    }

    async function loadCharterEditor() {
      const ta = document.getElementById('charter-content');
      const meta = document.getElementById('charter-meta');
      try {
        const r = await (await api('/charter')).json();
        ta.value = r.content || '';
        meta.textContent = r.updated_at
          ? `Last updated ${new Date(r.updated_at).toLocaleString()} by ${r.updated_by || '?'} · ${(r.content || '').length.toLocaleString()} chars`
          : `${(r.content || '').length.toLocaleString()} chars`;
      } catch (e) { meta.textContent = 'Failed to load charter.'; }
    }

    async function saveCharter() {
      const content = document.getElementById('charter-content').value;
      const s = document.getElementById('charter-status');
      if (!content.trim()) { s.className = 'toast err'; s.textContent = 'Charter cannot be empty.'; return; }
      if (!confirm("Approve and save this charter revision? This signed operator action changes Nora's authority everywhere (Slack, calls, hourly loop) immediately.")) return;
      try {
        const r = await operatorApi('/charter', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, updated_by: 'dashboard-operator' }) });
        const d = await r.json();
        if (d.ok) { s.className = 'toast ok'; s.textContent = `Saved (${(d.length || 0).toLocaleString()} chars).`; loadCharterEditor(); }
        else { s.className = 'toast err'; s.textContent = 'Save failed: ' + (d.error || 'unknown'); }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Save failed: ' + e.message; }
    }

    async function loadRoutineEditor() {
      const ta = document.getElementById('routine-content');
      const meta = document.getElementById('routine-meta');
      try {
        const r = await (await api('/routine')).json();
        ta.value = r.content || '';
        const chars = (r.content || '').length.toLocaleString();
        meta.textContent = r.updated_at
          ? `Last updated ${new Date(r.updated_at).toLocaleString()} by ${r.updated_by || '?'}${r.note ? ` · "${r.note}"` : ''} · ${chars} chars`
          : `${chars} chars`;
      } catch (e) { meta.textContent = 'Failed to load routine.'; }
    }

    async function saveRoutine() {
      const content = document.getElementById('routine-content').value;
      const s = document.getElementById('routine-status');
      if (!content.trim()) { s.className = 'toast err'; s.textContent = 'Routine cannot be empty.'; return; }
      if (!confirm('Approve and save this routine? This signed operator action replaces the current one and takes effect on the next hourly run.')) return;
      try {
        const r = await operatorApi('/routine', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, updated_by: 'dashboard-operator' }) });
        const d = await r.json();
        if (d.ok) { s.className = 'toast ok'; s.textContent = `Saved (${(d.length || 0).toLocaleString()} chars). Takes effect on the next hourly run.`; loadRoutineEditor(); }
        else { s.className = 'toast err'; s.textContent = 'Save failed: ' + (d.error || 'unknown'); }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Save failed: ' + e.message; }
    }
