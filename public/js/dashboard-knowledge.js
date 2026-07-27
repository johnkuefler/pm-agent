// Transcripts
    let transcriptReturnFocus = null;
    async function loadTranscripts() {
      const list = document.getElementById('transcript-list');
      list.setAttribute('aria-busy', 'true');
      list.innerHTML = '<p class="empty" role="status">Loading transcripts...</p>';
      document.getElementById('transcript-detail').style.display = 'none';
      list.style.display = 'block';
      try {
        const r = await api('/transcripts');
        const transcripts = await r.json();
        if (transcripts.length === 0) {
          list.innerHTML = '<p class="empty">No transcripts yet. Transcripts are saved when meetings end.</p>';
          return;
        }
        list.innerHTML = transcripts.map((t, index) => `
          <div class="task-item" data-transcript-index="${index}" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
            <button class="dashboard-row-action transcript-view-btn" type="button">
              <div class="task-action">${escHtml(t.bot_id)}</div>
              <div class="task-meta">
                ${Number(t.utterance_count) || 0} utterances · ${t.ended ? 'ended ' + new Date(t.ended).toLocaleString() : '<span style="color: var(--warn);">In progress</span>'}
              </div>
            </button>
            <button class="btn btn-danger btn-sm transcript-delete-btn" type="button" style="margin-left: 12px; flex-shrink: 0;">Delete</button>
          </div>
        `).join('');
        list.querySelectorAll('[data-transcript-index]').forEach(row => {
          const transcript = transcripts[Number(row.dataset.transcriptIndex)];
          if (!transcript) return;
          row.querySelector('.transcript-view-btn')?.addEventListener('click', () => viewTranscript(transcript.bot_id));
          row.querySelector('.transcript-delete-btn')?.addEventListener('click', () => deleteTranscript(transcript.bot_id));
        });
      } catch (e) { list.innerHTML = '<p class="empty" role="alert">Failed to load transcripts.</p>'; }
      finally { list.setAttribute('aria-busy', 'false'); }
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
        sel.replaceChildren();
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = 'All categories';
        sel.appendChild(allOption);
        cats.forEach(category => {
          const option = document.createElement('option');
          option.value = category;
          option.textContent = `${category} (${_allMarkers.filter(m => m.category === category).length})`;
          sel.appendChild(option);
        });
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
      const visibleItems = items.slice(0, _markersRenderCap);
      list.innerHTML = visibleItems.map((m, index) => {
        const color = MARKER_CAT_COLOR[m.category] || 'var(--muted)';
        const summary = markerSummary(m.data);
        const when = m.set_at ? new Date(m.set_at).toLocaleDateString() : '';
        return `<div class="memory-item" data-marker-index="${index}">
          <div style="flex:1; min-width:0;">
            <div class="memory-fact" style="font-family:ui-monospace,monospace; font-size:13px; color:var(--text-2); word-break:break-all;">
              <span style="color:${color};">${escHtml(m.category)}</span><span style="color:var(--dim);">${escHtml(m.key.slice(m.category.length))}</span>
            </div>
            ${summary ? `<div class="memory-meta" style="word-break:break-word;">${escHtml(summary)}</div>` : ''}
            <div class="memory-meta" style="color:var(--dim);">${when}</div>
          </div>
          <button class="btn btn-danger marker-delete-btn" type="button">Delete</button>
        </div>`;
      }).join('') || '<p class="empty">No markers match your search.</p>';
      list.querySelectorAll('[data-marker-index]').forEach(row => {
        const marker = visibleItems[Number(row.dataset.markerIndex)];
        if (!marker) return;
        row.querySelector('.marker-delete-btn')?.addEventListener('click', () => deleteMarker(marker.key));
      });

      const rendered = Math.min(matched, _markersRenderCap);
      countEl.textContent = (q || cat)
        ? `Showing ${rendered} of ${matched} match${matched === 1 ? '' : 'es'} (${total} total)`
        : `Showing ${rendered} of ${total}`;
      moreEl.innerHTML = matched > _markersRenderCap
        ? `<button class="btn btn-sm markers-show-more-btn" type="button" style="background:var(--surface-2); color:#55535f; border:1px solid var(--border);">Show ${Math.min(200, matched - _markersRenderCap)} more</button>`
        : '';
      moreEl.querySelector('.markers-show-more-btn')?.addEventListener('click', () => {
        _markersRenderCap += 200;
        renderMarkers();
      });
    }

    async function deleteMarker(key) {
      if (!confirm('Delete marker "' + key + '"?\n\nThe cowork loop may redo whatever this was tracking.')) return;
      await api('/markers/' + encodeURIComponent(key), { method: 'DELETE' });
      loadMarkers();
    }

    // ===== Dreams tab =====
    function dreamStat(label, value, color) {
      if (value === undefined || value === null) return '';
      return `<span style="display:inline-block; margin-right:14px; font-size:12px; color:var(--muted);">${escHtml(label)} <strong style="color:${color || 'var(--text-2)'};">${escHtml(value)}</strong></span>`;
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
            ? `<span style="color:var(--accent-ink); font-weight:600;">${escHtml(c.memories_before)} → ${escHtml(c.memories_after)}</span> memories`
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
              <span style="color:var(--muted); margin-right:10px;">Reviewed ${escHtml(reviewedCount)} message${reviewedCount === 1 ? '' : 's'} - how they landed:</span>
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
    let currentTranscriptUtterances = [];

    async function viewTranscript(botId, { preserveReturnFocus = false } = {}) {
      if (!preserveReturnFocus) transcriptReturnFocus = document.activeElement;
      currentTranscriptBotId = botId;
      document.getElementById('transcript-list').style.display = 'none';
      const detail = document.getElementById('transcript-detail');
      const content = document.getElementById('transcript-content');
      detail.style.display = 'block';
      document.getElementById('transcript-detail-title').textContent = 'Transcript: ' + botId;
      document.getElementById('transcript-delete-btn').onclick = () => deleteTranscript(botId);
      content.innerHTML = 'Loading...';
      content.setAttribute('aria-busy', 'true');
      focusDashboardRegionHeading(document.getElementById('transcript-detail-title'));
      try {
        const r = await api('/transcripts/' + encodeURIComponent(botId));
        if (!r.ok) { content.innerHTML = '<p class="empty" role="alert">Transcript not found.</p>'; return; }
        const data = await r.json();
        renderUtterances(data.transcript);
      } catch (e) { content.innerHTML = '<p class="empty" role="alert">Failed to load transcript.</p>'; }
      finally { content.setAttribute('aria-busy', 'false'); }
    }

    function renderUtterances(transcript) {
      const content = document.getElementById('transcript-content');
      currentTranscriptUtterances = Array.isArray(transcript) ? transcript : [];
      content.innerHTML = currentTranscriptUtterances.map((u, i) => `
        <div id="utt-${i}" data-utterance-index="${i}" style="padding: 4px 0; border-bottom: 1px solid var(--surface); display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div style="flex: 1;">
            <strong style="color: var(--accent-ink);">${escHtml(u.speaker)}</strong>
            <span style="color: var(--dim); font-size: 11px; margin-left: 8px;">${new Date(u.timestamp).toLocaleTimeString()}</span>
            <div style="color: var(--text-2);">${escHtml(u.text)}</div>
          </div>
          <div style="display: flex; gap: 4px; flex-shrink: 0; padding-top: 2px;">
            <button class="btn btn-success btn-sm utterance-edit-btn" type="button">Edit</button>
            <button class="btn btn-danger btn-sm utterance-delete-btn" type="button">Del</button>
          </div>
        </div>
      `).join('');
      content.querySelectorAll('[data-utterance-index]').forEach(row => {
        const idx = Number(row.dataset.utteranceIndex);
        row.querySelector('.utterance-edit-btn')?.addEventListener('click', () => editUtterance(idx));
        row.querySelector('.utterance-delete-btn')?.addEventListener('click', () => deleteUtterance(idx));
      });
    }

    function editUtterance(idx) {
      const el = document.getElementById('utt-' + idx);
      const utterance = currentTranscriptUtterances[idx];
      if (!el || !utterance) return;
      el.innerHTML = `
        <div style="flex: 1;">
          <input data-utterance-field="speaker" aria-label="Speaker" placeholder="Speaker" style="margin-bottom: 4px; font-size: 13px;" />
          <textarea data-utterance-field="text" aria-label="Transcript text" placeholder="Text" style="font-size: 13px; min-height: 40px;"></textarea>
        </div>
        <div style="display: flex; gap: 4px; flex-shrink: 0; align-self: center;">
          <button class="btn btn-primary btn-sm utterance-save-btn" type="button">Save</button>
          <button class="btn btn-danger btn-sm utterance-cancel-btn" type="button">Cancel</button>
        </div>`;
      const speakerInput = el.querySelector('[data-utterance-field="speaker"]');
      const textInput = el.querySelector('[data-utterance-field="text"]');
      speakerInput.value = utterance.speaker || '';
      textInput.value = utterance.text || '';
      el.querySelector('.utterance-save-btn')?.addEventListener('click', () => saveUtterance(idx, el));
      el.querySelector('.utterance-cancel-btn')?.addEventListener('click', () => viewTranscript(currentTranscriptBotId, { preserveReturnFocus: true }));
      speakerInput.focus();
    }

    async function saveUtterance(idx, row = document.getElementById('utt-' + idx)) {
      if (!row) return;
      const speaker = row.querySelector('[data-utterance-field="speaker"]').value.trim();
      const text = row.querySelector('[data-utterance-field="text"]').value.trim();
      if (!speaker || !text) return;
      await api('/transcripts/' + encodeURIComponent(currentTranscriptBotId) + '/utterances/' + idx, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker, text })
      });
      viewTranscript(currentTranscriptBotId, { preserveReturnFocus: true });
    }

    async function deleteUtterance(idx) {
      if (!confirm('Delete this utterance?')) return;
      await api('/transcripts/' + encodeURIComponent(currentTranscriptBotId) + '/utterances/' + idx, { method: 'DELETE' });
      viewTranscript(currentTranscriptBotId, { preserveReturnFocus: true });
    }

    function closeTranscript() {
      document.getElementById('transcript-detail').style.display = 'none';
      document.getElementById('transcript-list').style.display = 'block';
      const returnFocus = transcriptReturnFocus;
      transcriptReturnFocus = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    }

    async function deleteTranscript(botId) {
      if (!confirm('Delete this transcript? This cannot be undone.')) return;
      try {
        const r = await api('/transcripts/' + encodeURIComponent(botId), { method: 'DELETE' });
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
    let projectReturnFocus = null;

    async function loadProjects() {
      const list = document.getElementById('project-list');
      list.setAttribute('aria-busy', 'true');
      list.innerHTML = '<p class="empty" role="status">Loading projects...</p>';
      document.getElementById('project-detail').style.display = 'none';
      document.getElementById('project-edit').style.display = 'none';
      document.getElementById('project-add-section').style.display = 'block';
      list.style.display = 'block';
      try {
        const r = await api('/projects');
        const projects = await r.json();
        if (projects.length === 0) {
          list.innerHTML = '<p class="empty">No projects yet. Add one to help Nora organize her knowledge.</p>';
          return;
        }
        list.innerHTML = projects.map((p, index) => `
          <button class="task-item dashboard-row-action project-view-btn" data-project-index="${index}" type="button">
            <div class="task-action">${escHtml(p.name)}</div>
            <div class="task-detail">${escHtml((p.details || '').substring(0, 120))}${(p.details || '').length > 120 ? '...' : ''}</div>
            <div class="task-meta">${new Date(p.created).toLocaleDateString()}</div>
          </button>
        `).join('');
        list.querySelectorAll('[data-project-index]').forEach(button => {
          const project = projects[Number(button.dataset.projectIndex)];
          if (!project) return;
          button.addEventListener('click', () => viewProject(project.name));
        });
      } catch (e) { list.innerHTML = '<p class="empty" role="alert">Failed to load projects.</p>'; }
      finally { list.setAttribute('aria-busy', 'false'); }
    }

    async function viewProject(name, { preserveReturnFocus = false } = {}) {
      if (!preserveReturnFocus) projectReturnFocus = document.activeElement;
      document.getElementById('project-list').style.display = 'none';
      document.getElementById('project-add-section').style.display = 'none';
      document.getElementById('project-edit').style.display = 'none';
      const detail = document.getElementById('project-detail');
      detail.style.display = 'block';
      document.getElementById('project-detail-name').textContent = name;
      document.getElementById('project-detail-title').setAttribute('aria-label', name);
      document.getElementById('project-detail-info').textContent = 'Loading...';
      document.getElementById('project-detail-info').setAttribute('aria-busy', 'true');
      document.getElementById('project-memories').innerHTML = '';
      focusDashboardRegionHeading(document.getElementById('project-detail-title'));
      try {
        const r = await api('/projects/' + encodeURIComponent(name));
        if (!r.ok) { document.getElementById('project-detail-info').textContent = 'Project not found.'; return; }
        const data = await r.json();
        document.getElementById('project-detail-info').textContent = data.details || 'No details.';
        const mems = data.memories || [];
        if (mems.length > 0) {
          document.getElementById('project-memories').innerHTML =
            '<div style="color: var(--accent-ink); font-size: 12px; font-weight: 600; margin-bottom: 8px; text-transform: uppercase;">Memories (' + mems.length + ')</div>' +
            mems.map(m => `<div style="padding: 6px 0; border-bottom: 1px solid var(--surface-2); font-size: 13px; color: var(--text-2);">- ${escHtml(m.fact)}<span style="color: var(--dim); font-size: 11px; margin-left: 8px;">${escHtml(m.added || '')}</span></div>`).join('');
        } else {
          document.getElementById('project-memories').innerHTML = '<p class="empty">No memories tagged to this project yet.</p>';
        }
      } catch (e) {
        document.getElementById('project-detail-info').textContent = 'Failed to load project.';
      } finally {
        document.getElementById('project-detail-info').setAttribute('aria-busy', 'false');
      }
    }

    function closeProject() {
      document.getElementById('project-detail').style.display = 'none';
      document.getElementById('project-list').style.display = 'block';
      document.getElementById('project-add-section').style.display = 'block';
      const returnFocus = projectReturnFocus;
      projectReturnFocus = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    }

    function showAddProject() {
      projectReturnFocus = document.activeElement;
      editingProjectName = null;
      document.getElementById('project-edit-title').textContent = 'Add Project';
      document.getElementById('project-edit-name').value = '';
      document.getElementById('project-edit-details').value = '';
      document.getElementById('project-edit-name').disabled = false;
      document.getElementById('project-edit').style.display = 'block';
      document.getElementById('project-add-section').style.display = 'none';
      document.getElementById('project-status').className = 'toast';
      focusDashboardRegionHeading(document.getElementById('project-edit-title'));
      requestAnimationFrame(() => document.getElementById('project-edit-name').focus({ preventScroll: true }));
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
      focusDashboardRegionHeading(document.getElementById('project-edit-title'));
      requestAnimationFrame(() => document.getElementById('project-edit-name').focus({ preventScroll: true }));
    }

    function cancelEditProject() {
      document.getElementById('project-edit').style.display = 'none';
      if (editingProjectName) {
        viewProject(editingProjectName, { preserveReturnFocus: true });
      } else {
        document.getElementById('project-add-section').style.display = 'block';
        const returnFocus = projectReturnFocus;
        projectReturnFocus = null;
        if (returnFocus?.isConnected) returnFocus.focus();
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
          setTimeout(() => { viewProject(name, { preserveReturnFocus: true }); }, 500);
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
          setTimeout(() => {
            loadProjects();
            const returnFocus = projectReturnFocus;
            projectReturnFocus = null;
            if (returnFocus?.isConnected) returnFocus.focus();
          }, 500);
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
