// Meeting transcripts
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
