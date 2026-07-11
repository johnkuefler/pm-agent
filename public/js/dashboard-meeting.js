async function joinMeeting() {
      const s = document.getElementById('join-status');
      const u = document.getElementById('url').value.trim();
      const project = document.getElementById('project-hint').value;
      if (!u) { s.className = 'toast err'; s.textContent = 'Paste a Zoom link first'; return; }
      s.className = 'toast ok'; s.textContent = 'Sending Nora...';
      try {
        const body = { meeting_url: u };
        if (project) body.project = project;
        const mandate = (document.getElementById('join-mandate') || {}).value;
        if (mandate && mandate.trim()) body.mandate = mandate.trim();
        // Pass who's sending Nora so the realtime prompt knows who she's about to
        // talk to. John is the primary dashboard operator; in 90%+ of manual sends
        // he is also the person on the call. The realtime prompt frames this as
        // "most likely talking to" so it's still correct when he sends her elsewhere.
        body.sender = 'John Kuefler';
        const r = await api('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.bot_id) {
          const hint = d.project_hint ? ` (project: ${d.project_hint})` : '';
          s.className = 'toast ok'; s.textContent = 'Nora joined (muted by default - use the button below to unmute). Bot ID: ' + d.bot_id + hint;
          document.getElementById('mute-controls').style.display = 'block';
          checkMuteState();
        }
        else { s.className = 'toast err'; s.textContent = 'Error: ' + (d.error ? JSON.stringify(d.error) : JSON.stringify(d)); }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function joinDummy() {
      const s = document.getElementById('dummy-status');
      const u = document.getElementById('dummy-url').value.trim();
      const name = document.getElementById('dummy-name').value.trim();
      const prompt = document.getElementById('dummy-prompt').value.trim();
      if (!u) { s.className = 'toast err'; s.textContent = 'Paste a meeting link first'; return; }
      s.className = 'toast ok'; s.textContent = 'Sending test bot...';
      try {
        const body = { meeting_url: u };
        if (name) body.bot_name = name;
        if (prompt) body.prompt = prompt;
        const r = await api('/dummy/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.bot_id) {
          s.className = 'toast ok'; s.textContent = `Test bot "${d.bot_name}" joined (unmuted). Bot ID: ${d.bot_id}. Remove it from Admin → Active Bots when done.`;
        } else {
          s.className = 'toast err'; s.textContent = 'Error: ' + (d.error ? JSON.stringify(d.error) : JSON.stringify(d));
        }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function loadProjectHintOptions() {
      const sel = document.getElementById('project-hint');
      if (!sel) return;
      try {
        const r = await api('/projects');
        const projects = await r.json();
        if (!Array.isArray(projects)) return;
        const prev = sel.value;
        // Active first, then alpha
        projects.sort((a, b) => {
          const aa = (a.status || '').toLowerCase() === 'active' ? 0 : 1;
          const bb = (b.status || '').toLowerCase() === 'active' ? 0 : 1;
          if (aa !== bb) return aa - bb;
          return (a.name || '').localeCompare(b.name || '');
        });
        sel.innerHTML = '<option value="">No project hint (general meeting)</option>' +
          projects.map(p => {
            const label = p.status && p.status.toLowerCase() !== 'active' ? `${p.name} (${p.status})` : p.name;
            return `<option value="${p.name.replace(/"/g, '&quot;')}">${label}</option>`;
          }).join('');
        if (prev) sel.value = prev;
      } catch (e) { /* dropdown is optional - leave empty on failure */ }
    }
    loadProjectHintOptions();

    async function toggleMute() {
      try {
        const r = await api('/mute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json();
        updateMuteUI(d.muted);
      } catch (e) { console.error('Mute toggle failed:', e); }
    }

    async function checkMuteState() {
      try {
        const r = await api('/mute');
        const d = await r.json();
        const controls = document.getElementById('mute-controls');
        if (d.active_session === false || !d.bot_id) {
          // No active meeting - hide the mute UI so it doesn't show stale state
          // after a meeting ends or before one starts.
          controls.style.display = 'none';
          return;
        }
        controls.style.display = 'block';
        updateMuteUI(d.muted);
        refreshMeetingControls();
      } catch {}
    }

    // The three in-meeting behavior toggles (1:1 / lean-in / proactive). Each has a
    // GET (returns { <flag>, active_session }) and a POST that flips it, mirroring /mute.
    const MEETING_FLAGS = [
      { ep: 'one-on-one', key: 'oneOnOne', pill: 'pill-oneonone' },
      { ep: 'lean-in',    key: 'leanIn',   pill: 'pill-leanin' },
      { ep: 'proactive',  key: 'proactive', pill: 'pill-proactive' },
    ];
    async function toggleFlag(ep) {
      try {
        await api('/' + ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        refreshMeetingControls();
      } catch (e) { console.error(ep + ' toggle failed:', e); }
    }
    async function refreshMeetingControls() {
      for (const f of MEETING_FLAGS) {
        try {
          const r = await api('/' + f.ep);
          const d = await r.json();
          const el = document.getElementById(f.pill);
          if (el) el.classList.toggle('on', !!d[f.key]);
        } catch {}
      }
    }

    function updateMuteUI(muted) {
      const btn = document.getElementById('mute-btn');
      const status = document.getElementById('mute-status');
      if (muted) {
        btn.textContent = 'Unmute Nora';
        btn.style.background = '#7c3aed';
        btn.style.borderColor = '#7c3aed';
        status.textContent = 'Muted - listening only, no voice responses';
        status.style.color = 'var(--warn)';
      } else {
        btn.textContent = 'Mute Nora';
        btn.style.background = 'var(--border)';
        btn.style.borderColor = '#cfcdd9';
        status.textContent = '';
      }
    }

    // Check mute state on page load (in case a meeting is already active), and
    // poll every 20s so calendar-auto-joined meetings surface the mute control
    // without requiring a manual page refresh.
    checkMuteState();
    setInterval(checkMuteState, 20000);
