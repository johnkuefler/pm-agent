// Memory
    let _allMemories = [];      // full set, fetched once; each carries _idx (original position)
    let _memoryRenderCap = 80;  // cap rendered rows so 2,000+ memories don't choke the DOM

    async function loadMemory() {
      const list = document.getElementById('memory-list');
      try {
        const [memRes, projRes] = await Promise.all([api('/memory'), api('/projects')]);
        const memories = await memRes.json();
        const projects = await projRes.json();

        // Populate project dropdown (Add Memory section)
        const select = document.getElementById('new-fact-project');
        select.innerHTML = '<option value="">General (no project)</option>' +
          projects.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');

        // Stamp original index (used as a tiebreaker for newest/oldest since `added` is date-only)
        _allMemories = memories.map((m, i) => ({ ...m, _idx: i }));
        _memoryRenderCap = 80;
        renderMemory();
        loadEmbeddingStats();
      } catch (e) { list.innerHTML = '<p class="empty">Failed to load memory.</p>'; }
    }

    async function loadEmbeddingStats() {
      const el = document.getElementById('vectorize-stats');
      if (!el) return;
      try {
        const s = await (await api('/memory/embedding-stats')).json();
        if (!s.db) { el.textContent = 'Vectorization: off (JSON mode)'; return; }
        const pct = s.total ? Math.round((s.embedded / s.total) * 100) : 100;
        el.textContent = `Vectorized: ${s.embedded.toLocaleString()} / ${s.total.toLocaleString()} (${pct}%) · ${s.model}`;
      } catch { el.textContent = 'Vectorization: unavailable'; }
    }

    async function reembedAll() {
      if (!confirm('Re-vectorize all memories? This clears the embeddings and recomputes them with the current model in the background (~16 rows every 20 seconds). Only needed after a model change.')) return;
      try {
        const r = await api('/memory/reembed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await r.json();
        if (d.ok) { alert(`Queued ${d.queued.toLocaleString()} memories for re-vectorization. They will re-embed in the background.`); loadEmbeddingStats(); }
        else alert('Re-vectorize failed: ' + (d.error || 'unknown'));
      } catch (e) { alert('Re-vectorize failed: ' + e.message); }
    }

    // Apply search + source filter + sort + render cap. Cheap to re-run on every keystroke.
    function renderMemory() {
      const list = document.getElementById('memory-list');
      const countEl = document.getElementById('memory-count');
      const moreEl = document.getElementById('memory-more');
      if (!list) return;

      if (_allMemories.length === 0) {
        list.innerHTML = '<p class="empty">No memories yet.</p>';
        countEl.textContent = ''; moreEl.innerHTML = '';
        return;
      }

      const q = (document.getElementById('memory-search').value || '').trim().toLowerCase();
      const sourceFilter = document.getElementById('memory-source').value;
      const sort = document.getElementById('memory-sort').value;

      let items = _allMemories;
      if (sourceFilter) items = items.filter(m => (m.source || '') === sourceFilter);
      if (q) items = items.filter(m =>
        (m.fact || '').toLowerCase().includes(q) ||
        (m.project || '').toLowerCase().includes(q) ||
        (m.source || '').toLowerCase().includes(q));

      const total = _allMemories.length, matched = items.length;

      let html = '';
      if (sort === 'project') {
        // Grouped view: General first, then projects alpha; within a group, newest first.
        const general = items.filter(m => !m.project).sort((a, b) => byNewest(a, b));
        const groups = {};
        items.filter(m => m.project).forEach(m => { (groups[m.project] = groups[m.project] || []).push(m); });
        let shown = 0;
        const cap = _memoryRenderCap;
        if (general.length) {
          html += groupHeader('General', 'var(--muted)');
          for (const m of general) { if (shown++ >= cap) break; html += memoryItemHtml(m); }
        }
        for (const proj of Object.keys(groups).sort()) {
          if (shown >= cap) break;
          html += groupHeader(proj, 'var(--accent-ink)');
          for (const m of groups[proj].sort((a, b) => byNewest(a, b))) { if (shown++ >= cap) break; html += memoryItemHtml(m); }
        }
      } else {
        items = items.slice().sort((a, b) => sort === 'oldest' ? -byNewest(a, b) : byNewest(a, b));
        html = items.slice(0, _memoryRenderCap).map(m => memoryItemHtml(m)).join('');
      }
      list.innerHTML = html || '<p class="empty">No memories match your search.</p>';

      const rendered = Math.min(matched, _memoryRenderCap);
      countEl.textContent = q || sourceFilter
        ? `Showing ${rendered} of ${matched} match${matched === 1 ? '' : 'es'} (${total.toLocaleString()} total)`
        : `Showing ${rendered} of ${total.toLocaleString()}`;
      moreEl.innerHTML = matched > _memoryRenderCap
        ? `<button class="btn btn-sm" style="background:var(--surface-2); color:#55535f; border:1px solid var(--border);" onclick="_memoryRenderCap += 200; renderMemory();">Show ${Math.min(200, matched - _memoryRenderCap)} more</button>`
        : '';
    }

    // Newest-first comparator: by `added` date desc, tiebreak by original index desc
    // (later in the array = added later within the same date).
    function byNewest(a, b) {
      const da = a.added || '', db = b.added || '';
      if (da !== db) return da < db ? 1 : -1;
      return (b._idx || 0) - (a._idx || 0);
    }
    function groupHeader(label, color) {
      return `<div style="color:${color}; font-size:12px; font-weight:600; margin:16px 0 4px; text-transform:uppercase;">${escHtml(label)}</div>`;
    }

    function memoryItemHtml(m) {
      const transcriptLink = m.source_bot_id
        ? ` · <a href="#" onclick="event.preventDefault(); showTab('transcripts'); setTimeout(() => viewTranscript('${escHtml(m.source_bot_id)}'), 100);" style="color: #1d4ed8; text-decoration: none;">View transcript</a>`
        : '';
      const key = m.id || m._idx; // prefer stable id; fall back to index for any legacy entry
      return `<div class="memory-item" id="memory-${key}">
        <div style="flex: 1;">
          <div class="memory-fact">${escHtml(m.fact)}</div>
          <div class="memory-meta">${m.added || ''}${m.source ? ' · ' + m.source : ''}${m.project ? ' · ' + escHtml(m.project) : ''}${m.kind ? ' · ' + escHtml(m.kind) : ''}${m.confidence != null ? ' · ' + Math.round(m.confidence * 100) + '% confidence' : ''}${m.status && m.status !== 'active' ? ' · ' + escHtml(m.status) : ''}${m.last_verified ? ' · verified ' + new Date(m.last_verified).toLocaleDateString() : ''}${transcriptLink}</div>
        </div>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          <button class="btn btn-success" onclick="editMemory('${key}', '${escHtml(m.fact).replace(/'/g, "\\'")}', '${escHtml(m.project || '').replace(/'/g, "\\'")}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteMemory('${key}')">Remove</button>
        </div>
      </div>`;
    }

    function editMemory(idx, currentFact, currentProject) {
      const el = document.getElementById('memory-' + idx);
      if (!el) return;
      const projects = document.getElementById('new-fact-project').innerHTML;
      el.innerHTML = `
        <div style="flex: 1;">
          <input id="edit-memory-fact-${idx}" value="${escHtml(currentFact)}" style="margin-bottom: 6px;" />
          <select id="edit-memory-project-${idx}" style="width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 13px;">
            ${projects}
          </select>
        </div>
        <div style="display: flex; gap: 6px; flex-shrink: 0; align-self: center;">
          <button class="btn btn-primary btn-sm" onclick="saveMemoryEdit(${idx})">Save</button>
          <button class="btn btn-danger btn-sm" onclick="loadMemory()">Cancel</button>
        </div>`;
      const sel = document.getElementById('edit-memory-project-' + idx);
      if (sel) sel.value = currentProject;
      document.getElementById('edit-memory-fact-' + idx).focus();
    }

    async function saveMemoryEdit(idx) {
      const fact = document.getElementById('edit-memory-fact-' + idx).value.trim();
      const project = document.getElementById('edit-memory-project-' + idx).value;
      if (!fact) return;
      await api('/memory/' + idx, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fact, project }) });
      loadMemory();
    }

    async function addMemory() {
      const s = document.getElementById('memory-status');
      const fact = document.getElementById('new-fact').value.trim();
      const project = document.getElementById('new-fact-project').value;
      const kind = document.getElementById('new-fact-kind').value;
      const confidence = Number(document.getElementById('new-fact-confidence').value);
      if (!fact) { s.className = 'toast err'; s.textContent = 'Type something first'; return; }
      try {
        await api('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fact, project, kind, confidence, last_verified: new Date().toISOString() }) });
        document.getElementById('new-fact').value = '';
        s.className = 'toast ok'; s.textContent = 'Memory added';
        loadMemory();
        setTimeout(() => s.style.display = 'none', 2000);
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function deleteMemory(key) {
      if (!confirm('Remove this memory?')) return;
      // Prefer the safe by-id endpoint; fall back to the legacy index path only for a
      // numeric key (a pre-id legacy entry). Stable ids look like "m-...".
      const path = /^\d+$/.test(String(key)) ? ('/memory/' + key) : ('/memory/by-id/' + key);
      await api(path, { method: 'DELETE' });
      loadMemory();
    }

    async function clearMemory() {
      if (!confirm('Clear ALL of Nora\'s memory? This cannot be undone.')) return;
      await api('/memory', { method: 'DELETE' });
      loadMemory();
    }
