// Transcripts
    async function loadTranscripts() {
      const list = document.getElementById('transcript-list');
      document.getElementById('transcript-detail').style.display = 'none';
      list.style.display = 'block';
      try {
        const r = await api('/transcripts');
        const transcripts = await r.json();
        if (transcripts.length === 0) {
          list.innerHTML = '<p class="empty">No transcripts yet. Transcripts are saved when meetings end.</p>';
          return;
        }
        list.innerHTML = transcripts.map(t => `
          <div class="task-item" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1;" onclick="viewTranscript('${escHtml(t.bot_id)}')">
              <div class="task-action">${escHtml(t.bot_id)}</div>
              <div class="task-meta">
                ${t.utterance_count} utterances · ${t.ended ? 'ended ' + new Date(t.ended).toLocaleString() : '<span style="color: var(--warn);">In progress</span>'}
              </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteTranscript('${escHtml(t.bot_id)}')" style="margin-left: 12px; flex-shrink: 0;">Delete</button>
          </div>
        `).join('');
      } catch (e) { list.innerHTML = '<p class="empty">Failed to load transcripts.</p>'; }
    }

    // ===== Markers tab =====
    let _allMarkers = [];        // [{ key, category, set_at, data }]
    let _markersRenderCap = 100;

    // Per-category accent so the list scans fast.
    const MARKER_CAT_COLOR = {
      'filed-transcript': '#1d4ed8', 'skipped-transcript': 'var(--dim)', 'dreamed': 'var(--accent-ink)',
      'memory-dedup': 'var(--accent-ink)', 'reflection-done': 'var(--accent-ink)', 'stale-tasks-flagged': 'var(--warn)',
      'warmth': '#e11d48', 'task-completed': 'var(--success)', 'slack-file-done': 'var(--success)',
      'slack-responded': 'var(--success)', 'bootstrap': 'var(--accent-ink)'
    };

    // Render a marker's data object as a short readable summary (prefer a `note`).
    function markerSummary(data) {
      if (!data || typeof data !== 'object') return '';
      if (typeof data.note === 'string' && data.note.trim()) return data.note.trim();
      const skip = new Set(['set_at', 'updated_at', 'migrated_from_memory']);
      const parts = [];
      for (const k of Object.keys(data)) {
        if (skip.has(k)) continue;
        let v = data[k];
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'object') v = JSON.stringify(v);
        parts.push(`${k}: ${v}`);
      }
      return parts.join(' · ');
    }

    async function loadMarkers() {
      const list = document.getElementById('markers-list');
      try {
        const r = await api('/markers');
        const data = await r.json();
        const obj = (data && data.markers) || {};
        _allMarkers = Object.keys(obj).map(key => ({
          key,
          category: key.split(':')[0],
          set_at: obj[key] && (obj[key].set_at || obj[key].updated_at) || '',
          data: obj[key] || {}
        }));
        // Populate category dropdown (preserve current selection)
        const sel = document.getElementById('markers-category');
        const prev = sel.value;
        const cats = [...new Set(_allMarkers.map(m => m.category))].sort();
        sel.innerHTML = '<option value="">All categories</option>' +
          cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)} (${_allMarkers.filter(m => m.category === c).length})</option>`).join('');
        if (prev) sel.value = prev;
        _markersRenderCap = 100;
        renderMarkers();
      } catch (e) { list.innerHTML = '<p class="empty">Failed to load markers.</p>'; }
    }

    function renderMarkers() {
      const list = document.getElementById('markers-list');
      const countEl = document.getElementById('markers-count');
      const moreEl = document.getElementById('markers-more');
      if (!list) return;
      if (_allMarkers.length === 0) {
        list.innerHTML = '<p class="empty">No markers yet.</p>';
        countEl.textContent = ''; moreEl.innerHTML = '';
        return;
      }
      const q = (document.getElementById('markers-search').value || '').trim().toLowerCase();
      const cat = document.getElementById('markers-category').value;

      let items = _allMarkers;
      if (cat) items = items.filter(m => m.category === cat);
      if (q) items = items.filter(m => m.key.toLowerCase().includes(q) || markerSummary(m.data).toLowerCase().includes(q));
      // Newest first by set_at
      items = items.slice().sort((a, b) => (a.set_at < b.set_at ? 1 : a.set_at > b.set_at ? -1 : 0));

      const total = _allMarkers.length, matched = items.length;
      list.innerHTML = items.slice(0, _markersRenderCap).map(m => {
        const color = MARKER_CAT_COLOR[m.category] || 'var(--muted)';
        const summary = markerSummary(m.data);
        const when = m.set_at ? new Date(m.set_at).toLocaleDateString() : '';
        return `<div class="memory-item">
          <div style="flex:1; min-width:0;">
            <div class="memory-fact" style="font-family:ui-monospace,monospace; font-size:13px; color:var(--text-2); word-break:break-all;">
              <span style="color:${color};">${escHtml(m.category)}</span><span style="color:var(--dim);">${escHtml(m.key.slice(m.category.length))}</span>
            </div>
            ${summary ? `<div class="memory-meta" style="word-break:break-word;">${escHtml(summary)}</div>` : ''}
            <div class="memory-meta" style="color:var(--dim);">${when}</div>
          </div>
          <button class="btn btn-danger" onclick="deleteMarker('${escHtml(m.key).replace(/'/g, "\\'")}')">Delete</button>
        </div>`;
      }).join('') || '<p class="empty">No markers match your search.</p>';

      const rendered = Math.min(matched, _markersRenderCap);
      countEl.textContent = (q || cat)
        ? `Showing ${rendered} of ${matched} match${matched === 1 ? '' : 'es'} (${total} total)`
        : `Showing ${rendered} of ${total}`;
      moreEl.innerHTML = matched > _markersRenderCap
        ? `<button class="btn btn-sm" style="background:var(--surface-2); color:#55535f; border:1px solid var(--border);" onclick="_markersRenderCap += 200; renderMarkers();">Show ${Math.min(200, matched - _markersRenderCap)} more</button>`
        : '';
    }

    async function deleteMarker(key) {
      if (!confirm('Delete marker "' + key + '"?\n\nThe cowork loop may redo whatever this was tracking.')) return;
      await api('/markers/' + encodeURIComponent(key), { method: 'DELETE' });
      loadMarkers();
    }

    // ===== Dreams tab =====
    function dreamStat(label, value, color) {
      if (value === undefined || value === null) return '';
      return `<span style="display:inline-block; margin-right:14px; font-size:12px; color:var(--muted);">${label} <strong style="color:${color || 'var(--text-2)'};">${value}</strong></span>`;
    }

    async function loadDreams() {
      const list = document.getElementById('dreams-list');
      list.innerHTML = 'Loading…';
      try {
        const r = await api('/dreams');
        const dreams = await r.json();
        if (!Array.isArray(dreams) || dreams.length === 0) {
          list.innerHTML = '<p class="empty">No dreams yet. Nora dreams nightly once the cowork loop runs the Dreaming Round.</p>';
          return;
        }
        list.innerHTML = dreams.map(d => {
          const c = d.consolidation || {};
          const ref = d.reflection || {};
          const when = d.finished || d.started || d.date;
          const whenStr = when ? new Date(when).toLocaleString() : (d.date || '');
          const beforeAfter = (c.memories_before != null && c.memories_after != null)
            ? `<span style="color:var(--accent-ink); font-weight:600;">${c.memories_before} → ${c.memories_after}</span> memories`
            : '';
          const rev = d.review || {};
          const takesAdded = (ref.takes_added || []);
          const takesRetired = (ref.takes_retired || []);
          const ideas = (ref.ideas || []);
          const examples = (c.examples || []);
          const learningsAdded = (rev.learnings_added || []);
          const learningsRetired = (rev.learnings_retired || []);
          const outcomes = rev.outcomes || {};
          const reviewedCount = rev.interactions_reviewed || 0;

          const takesHtml = takesAdded.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">New takes formed</div>
              ${takesAdded.map(t => `<div style="font-size:13px; color:var(--accent-ink); border-left:2px solid #7c3aed; padding-left:10px; margin-bottom:6px;">${escHtml(t)}</div>`).join('')}
            </div>` : '';
          const ideasHtml = ideas.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">Ideas / sparks</div>
              ${ideas.map(t => `<div style="font-size:13px; color:#1d4ed8; border-left:2px solid #2563eb; padding-left:10px; margin-bottom:6px;">${escHtml(t)}</div>`).join('')}
            </div>` : '';
          const retiredHtml = takesRetired.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">Takes retired</div>
              ${takesRetired.map(t => `<div style="font-size:13px; color:var(--muted); border-left:2px solid #cfcdd9; padding-left:10px; margin-bottom:6px; text-decoration:line-through;">${escHtml(t)}</div>`).join('')}
            </div>` : '';
          const examplesHtml = examples.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">Consolidation examples</div>
              ${examples.map(t => `<div style="font-size:12px; color:var(--muted); margin-bottom:4px;">• ${escHtml(t)}</div>`).join('')}
            </div>` : '';

          // Review movement - learnings (green = her own behavioral self-improvement) + outcome mix
          const learningsHtml = learningsAdded.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">New learnings (how she works better)</div>
              ${learningsAdded.map(t => `<div style="font-size:13px; color:var(--success); border-left:2px solid #16a34a; padding-left:10px; margin-bottom:6px;">${escHtml(t)}</div>`).join('')}
            </div>` : '';
          const learningsRetiredHtml = learningsRetired.length ? `
            <div style="margin-top:12px;">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); margin-bottom:6px;">Learnings retired</div>
              ${learningsRetired.map(t => `<div style="font-size:13px; color:var(--muted); border-left:2px solid #cfcdd9; padding-left:10px; margin-bottom:6px; text-decoration:line-through;">${escHtml(t)}</div>`).join('')}
            </div>` : '';
          const outcomeChips = Object.keys(outcomes).length ? `
            <div style="margin-top:10px; font-size:12px;">
              <span style="color:var(--muted); margin-right:10px;">Reviewed ${reviewedCount} message${reviewedCount === 1 ? '' : 's'} - how they landed:</span>
              ${dreamStat('appreciated', outcomes.appreciated, 'var(--success)')}
              ${dreamStat('landed', outcomes.landed, 'var(--success)')}
              ${dreamStat('neutral', outcomes.neutral, 'var(--muted)')}
              ${dreamStat('ignored', outcomes.ignored, 'var(--danger)')}
              ${dreamStat('corrected', outcomes.corrected, 'var(--warn)')}
            </div>` : '';

          return `
            <div class="section" style="background:var(--accent-soft); border:1px solid var(--border); margin-bottom:14px;">
              <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
                <div style="font-size:15px; font-weight:600; color:var(--accent-ink);">${escHtml(d.date || '')}</div>
                <div style="font-size:11px; color:var(--dim);">${escHtml(whenStr)}</div>
              </div>
              ${d.narrative ? `<div style="font-size:14px; line-height:1.6; color:var(--text-2); font-style:italic; border-left:3px solid #7c3aed; padding:4px 0 4px 14px; margin-bottom:12px;">"${escHtml(d.narrative)}"</div>` : ''}
              <div style="margin-bottom:4px;">
                ${beforeAfter ? `<span style="font-size:12px; margin-right:14px;">${beforeAfter}</span>` : ''}
                ${dreamStat('merged', c.duplicates_removed, '#a21caf')}
                ${dreamStat('fragments', c.fragments_merged, '#a21caf')}
                ${dreamStat('pruned', c.stale_pruned, 'var(--danger)')}
                ${dreamStat('contradictions', c.contradictions_resolved, 'var(--warn)')}
                ${dreamStat('+takes', takesAdded.length || undefined, 'var(--accent-ink)')}
                ${dreamStat('+learnings', learningsAdded.length || undefined, 'var(--success)')}
              </div>
              ${outcomeChips}
              ${takesHtml}${ideasHtml}${learningsHtml}${learningsRetiredHtml}${retiredHtml}${examplesHtml}
            </div>`;
        }).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load dreams.</p>';
      }
    }

    let currentTranscriptBotId = null;

    async function viewTranscript(botId) {
      currentTranscriptBotId = botId;
      document.getElementById('transcript-list').style.display = 'none';
      const detail = document.getElementById('transcript-detail');
      const content = document.getElementById('transcript-content');
      detail.style.display = 'block';
      document.getElementById('transcript-detail-title').textContent = 'Transcript: ' + botId;
      document.getElementById('transcript-delete-btn').onclick = () => deleteTranscript(botId);
      content.innerHTML = 'Loading...';
      try {
        const r = await api('/transcripts/' + botId);
        if (!r.ok) { content.innerHTML = '<p class="empty">Transcript not found.</p>'; return; }
        const data = await r.json();
        renderUtterances(data.transcript);
      } catch (e) { content.innerHTML = '<p class="empty">Failed to load transcript.</p>'; }
    }

    function renderUtterances(transcript) {
      const content = document.getElementById('transcript-content');
      content.innerHTML = transcript.map((u, i) => `
        <div id="utt-${i}" style="padding: 4px 0; border-bottom: 1px solid var(--surface); display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div style="flex: 1;">
            <strong style="color: var(--accent-ink);">${escHtml(u.speaker)}</strong>
            <span style="color: var(--dim); font-size: 11px; margin-left: 8px;">${new Date(u.timestamp).toLocaleTimeString()}</span>
            <div style="color: var(--text-2);">${escHtml(u.text)}</div>
          </div>
          <div style="display: flex; gap: 4px; flex-shrink: 0; padding-top: 2px;">
            <button class="btn btn-success btn-sm" onclick="editUtterance(${i}, '${escHtml(u.speaker).replace(/'/g, "\\'")}', '${escHtml(u.text).replace(/'/g, "\\'")}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteUtterance(${i})">Del</button>
          </div>
        </div>
      `).join('');
    }

    function editUtterance(idx, speaker, text) {
      const el = document.getElementById('utt-' + idx);
      if (!el) return;
      el.innerHTML = `
        <div style="flex: 1;">
          <input id="edit-utt-speaker-${idx}" value="${escHtml(speaker)}" placeholder="Speaker" style="margin-bottom: 4px; font-size: 13px;" />
          <textarea id="edit-utt-text-${idx}" placeholder="Text" style="font-size: 13px; min-height: 40px;">${escHtml(text)}</textarea>
        </div>
        <div style="display: flex; gap: 4px; flex-shrink: 0; align-self: center;">
          <button class="btn btn-primary btn-sm" onclick="saveUtterance(${idx})">Save</button>
          <button class="btn btn-danger btn-sm" onclick="viewTranscript(currentTranscriptBotId)">Cancel</button>
        </div>`;
      document.getElementById('edit-utt-speaker-' + idx).focus();
    }

    async function saveUtterance(idx) {
      const speaker = document.getElementById('edit-utt-speaker-' + idx).value.trim();
      const text = document.getElementById('edit-utt-text-' + idx).value.trim();
      if (!speaker || !text) return;
      await api('/transcripts/' + currentTranscriptBotId + '/utterances/' + idx, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker, text })
      });
      viewTranscript(currentTranscriptBotId);
    }

    async function deleteUtterance(idx) {
      if (!confirm('Delete this utterance?')) return;
      await api('/transcripts/' + currentTranscriptBotId + '/utterances/' + idx, { method: 'DELETE' });
      viewTranscript(currentTranscriptBotId);
    }

    function closeTranscript() {
      document.getElementById('transcript-detail').style.display = 'none';
      document.getElementById('transcript-list').style.display = 'block';
    }

    async function deleteTranscript(botId) {
      if (!confirm('Delete this transcript? This cannot be undone.')) return;
      try {
        const r = await api('/transcripts/' + botId, { method: 'DELETE' });
        if (r.ok) {
          loadTranscripts();
        } else {
          const data = await r.json();
          alert('Failed to delete: ' + (data.error || 'unknown error'));
        }
      } catch (e) { alert('Failed: ' + e.message); }
    }

    // (Proactive and One-on-One modes removed - OpenAI Realtime VAD handles turn-taking)

    // Projects
    let editingProjectName = null; // null = adding new, string = editing existing

    async function loadProjects() {
      const list = document.getElementById('project-list');
      const controlStats = document.getElementById('pm-control-stats');
      const controlRisks = document.getElementById('pm-control-risks');
      document.getElementById('project-detail').style.display = 'none';
      document.getElementById('project-edit').style.display = 'none';
      document.getElementById('project-add-section').style.display = 'block';
      list.style.display = 'block';
      try {
        const [r, controlResponse, evaluationResponse] = await Promise.all([
          api('/projects'), api('/pm-control'), api('/pm-control/evaluation'),
        ]);
        const [projects, control, evaluation] = await Promise.all([
          r.json(), controlResponse.json(), evaluationResponse.json(),
        ]);
        const report = control.report || {};
        const quality = evaluation.quality || {};
        const openRisks = (control.ledger?.risks || []).filter(item =>
          item.status === 'open' || item.status === 'monitoring');
        controlStats.innerHTML = [
          ['Controlled projects', report.projects?.total || 0],
          ['Open high risks', report.risks?.high || 0],
          ['Unowned risks', report.risks?.unowned || 0],
          ['PM quality', `${Math.round((quality.score || 0) * 100)}%`],
          ['Rollout', String(quality.rollout_stage || 'shadow_calibration').replaceAll('_', ' ')],
          ['Observed outcomes', evaluation.observed || 0],
        ].map(([label, value]) => `<div class="intelligence-stat"><strong>${escHtml(value)}</strong><span>${escHtml(label)}</span></div>`).join('');
        controlRisks.innerHTML = openRisks.length
          ? `<div class="intelligence-meta">Highest current risks</div>${openRisks
            .sort((a, b) => ['low', 'medium', 'high', 'critical'].indexOf(b.severity)
              - ['low', 'medium', 'high', 'critical'].indexOf(a.severity))
            .slice(0, 6).map(item => `<div class="intelligence-card"><strong>${escHtml(item.title)}</strong><div class="intelligence-meta">${escHtml(item.severity)} risk · ${escHtml(item.owner || 'unowned')} · ${escHtml(item.next_action || item.decision_needed || 'next action not recorded')}</div></div>`).join('')}`
          : '<p class="empty">No open project-control risks.</p>';
        const controlByName = new Map((control.ledger?.projects || [])
          .map(item => [String(item.name || '').toLowerCase(), item]));
        if (projects.length === 0) {
          list.innerHTML = '<p class="empty">No projects yet. Add one to help Nora organize her knowledge.</p>';
          return;
        }
        list.innerHTML = projects.map(p => {
          const controlled = controlByName.get(String(p.name || '').toLowerCase());
          return `
          <div class="task-item" style="cursor: pointer;" onclick="viewProject('${escHtml(p.name)}')">
            <div class="task-action">${escHtml(p.name)}</div>
            <div class="task-detail">${escHtml((p.details || '').substring(0, 120))}${(p.details || '').length > 120 ? '...' : ''}</div>
            <div class="task-meta">${controlled ? `${escHtml(controlled.health)} · ${escHtml(controlled.next_milestone || 'milestone missing')}` : 'control record missing'} · ${new Date(p.created).toLocaleDateString()}</div>
          </div>
        `; }).join('');
      } catch (e) {
        list.innerHTML = '<p class="empty">Failed to load projects.</p>';
        if (controlStats) controlStats.innerHTML = '<div class="error">PM control unavailable.</div>';
      }
    }

    async function viewProject(name) {
      document.getElementById('project-list').style.display = 'none';
      document.getElementById('project-add-section').style.display = 'none';
      document.getElementById('project-edit').style.display = 'none';
      const detail = document.getElementById('project-detail');
      detail.style.display = 'block';
      document.getElementById('project-detail-name').textContent = name;
      document.getElementById('project-detail-info').textContent = 'Loading...';
      document.getElementById('project-memories').innerHTML = '';
      try {
        const r = await api('/projects/' + encodeURIComponent(name));
        if (!r.ok) { document.getElementById('project-detail-info').textContent = 'Project not found.'; return; }
        const data = await r.json();
        document.getElementById('project-detail-info').textContent = data.details || 'No details.';
        const mems = data.memories || [];
        if (mems.length > 0) {
          document.getElementById('project-memories').innerHTML =
            '<div style="color: var(--accent-ink); font-size: 12px; font-weight: 600; margin-bottom: 8px; text-transform: uppercase;">Memories (' + mems.length + ')</div>' +
            mems.map(m => `<div style="padding: 6px 0; border-bottom: 1px solid var(--surface-2); font-size: 13px; color: var(--text-2);">- ${escHtml(m.fact)}<span style="color: var(--dim); font-size: 11px; margin-left: 8px;">${m.added || ''}</span></div>`).join('');
        } else {
          document.getElementById('project-memories').innerHTML = '<p class="empty">No memories tagged to this project yet.</p>';
        }
      } catch (e) {
        document.getElementById('project-detail-info').textContent = 'Failed to load project.';
      }
    }

    function closeProject() {
      document.getElementById('project-detail').style.display = 'none';
      document.getElementById('project-list').style.display = 'block';
      document.getElementById('project-add-section').style.display = 'block';
    }

    function showAddProject() {
      editingProjectName = null;
      document.getElementById('project-edit-title').textContent = 'Add Project';
      document.getElementById('project-edit-name').value = '';
      document.getElementById('project-edit-details').value = '';
      document.getElementById('project-edit-name').disabled = false;
      document.getElementById('project-edit').style.display = 'block';
      document.getElementById('project-add-section').style.display = 'none';
      document.getElementById('project-status').className = 'toast';
    }

    function editProject() {
      const name = document.getElementById('project-detail-name').textContent;
      const details = document.getElementById('project-detail-info').textContent;
      editingProjectName = name;
      document.getElementById('project-edit-title').textContent = 'Edit Project';
      document.getElementById('project-edit-name').value = name;
      document.getElementById('project-edit-details').value = details === 'No details.' ? '' : details;
      document.getElementById('project-edit-name').disabled = false;
      document.getElementById('project-detail').style.display = 'none';
      document.getElementById('project-edit').style.display = 'block';
      document.getElementById('project-add-section').style.display = 'none';
      document.getElementById('project-status').className = 'toast';
    }

    function cancelEditProject() {
      document.getElementById('project-edit').style.display = 'none';
      if (editingProjectName) {
        viewProject(editingProjectName);
      } else {
        document.getElementById('project-add-section').style.display = 'block';
      }
      editingProjectName = null;
    }

    async function saveProject() {
      const s = document.getElementById('project-status');
      const name = document.getElementById('project-edit-name').value.trim();
      const details = document.getElementById('project-edit-details').value.trim();
      if (!name) { s.className = 'toast err'; s.textContent = 'Project name is required'; return; }
      try {
        if (editingProjectName) {
          // Update existing
          await api('/projects/' + encodeURIComponent(editingProjectName), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, details })
          });
          s.className = 'toast ok'; s.textContent = 'Project updated';
          setTimeout(() => { viewProject(name); }, 500);
        } else {
          // Create new
          const r = await api('/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, details })
          });
          const data = await r.json();
          if (data.error) { s.className = 'toast err'; s.textContent = data.error; return; }
          s.className = 'toast ok'; s.textContent = 'Project created';
          setTimeout(() => { loadProjects(); }, 500);
        }
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function deleteProject() {
      const name = document.getElementById('project-detail-name').textContent;
      if (!confirm(`Delete project "${name}"? Memories tagged to it will not be deleted.`)) return;
      try {
        await api('/projects/' + encodeURIComponent(name), { method: 'DELETE' });
        loadProjects();
      } catch (e) { alert('Failed to delete: ' + e.message); }
    }
