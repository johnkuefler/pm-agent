// Tasks
    let taskDataCache = {};

    function fmtScheduledFor(iso) {
      try {
        const d = new Date(iso);
        // Show in viewer's local time. Suffix indicates relation to now.
        const txt = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        const diffMs = d.getTime() - Date.now();
        if (diffMs > 0) {
          const hrs = Math.round(diffMs / 3600000);
          const tag = hrs < 24 ? `in ${hrs}h` : `in ${Math.round(hrs / 24)}d`;
          return `${txt} (${tag})`;
        }
        return `${txt} (ready)`;
      } catch { return iso; }
    }

    async function loadTasks() {
      const list = document.getElementById('task-list');
      // Dashboard always shows scheduled tasks (include=all bypasses the eligibility filter).
      const url = currentFilter === 'all'
        ? '/tasks?include=all'
        : `/tasks?status=${currentFilter}&include=all`;
      try {
        const r = await api(url);
        const tasks = await r.json();
        if (tasks.length === 0) {
          list.innerHTML = '<p class="empty">No tasks yet.</p>';
          return;
        }
        // Sort: scheduled-future last (sorted by fire time ascending), then everything else by created desc.
        const now = Date.now();
        const isFuture = t => t.scheduled_for && new Date(t.scheduled_for).getTime() > now;
        tasks.sort((a, b) => {
          const af = isFuture(a), bf = isFuture(b);
          if (af && bf) return new Date(a.scheduled_for) - new Date(b.scheduled_for);
          if (af) return 1;
          if (bf) return -1;
          return new Date(b.created) - new Date(a.created);
        });
        taskDataCache = {};
        tasks.forEach(t => { taskDataCache[t.id] = {
          action: t.action, detail: t.detail || '', assignee: t.assignee || '',
          due: t.due || '', scheduled_for: t.scheduled_for || '', recurrence: t.recurrence || ''
        }; });
        list.innerHTML = tasks.map(t => {
          const transcriptLink = t.source_bot_id
            ? ` · <a href="#" onclick="event.preventDefault(); showTab('transcripts'); setTimeout(() => viewTranscript('${escHtml(t.source_bot_id)}'), 100);" style="color: #1d4ed8; text-decoration: none;">View transcript</a>`
            : '';
          const future = isFuture(t);
          const schedBadge = t.scheduled_for
            ? ` · <span style="color: ${future ? 'var(--warn)' : 'var(--success)'};">${escHtml(fmtScheduledFor(t.scheduled_for))}</span>`
            : '';
          const recurBadge = t.recurrence
            ? ` · <span style="color: var(--accent-ink);">${escHtml(t.recurrence)}</span>`
            : '';
          const lastRunNote = t.last_run
            ? `<div class="task-detail" style="color: var(--muted); font-size: 12px;">Last ran ${escHtml(new Date(t.last_run).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }))}</div>`
            : '';
          return `
          <div class="task-item ${t.status === 'done' ? 'done' : ''}" id="task-${escHtml(t.id)}">
            <div class="task-action">${escHtml(t.action)}</div>
            ${t.detail ? `<div class="task-detail">${escHtml(t.detail)}</div>` : ''}
            ${lastRunNote}
            <div class="task-meta">
              <span class="task-badge ${t.status === 'done' ? 'badge-done' : 'badge-pending'}">${t.status}</span>
              ${t.assignee ? ' · ' + escHtml(t.assignee) : ''}
              ${t.due ? ' · due ' + escHtml(t.due) : ''}
              · ${new Date(t.created).toLocaleDateString()}${schedBadge}${recurBadge}${transcriptLink}
            </div>
            <div class="task-buttons">
              <button class="btn btn-success" onclick="editTask('${escHtml(t.id)}')">Edit</button>
              ${t.status === 'pending' ? `<button class="btn btn-success" onclick="completeTask('${t.id}')">${t.recurrence ? 'Mark Run' : 'Mark Done'}</button>` : ''}
              <button class="btn btn-danger" onclick="deleteTask('${t.id}')">Delete</button>
            </div>
          </div>`;
        }).join('');
      } catch (e) { list.innerHTML = '<p class="empty">Failed to load tasks.</p>'; }
    }

    function filterTasks(status, btn) {
      currentFilter = status;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTasks();
    }

    async function addTask() {
      const s = document.getElementById('task-status');
      const action = document.getElementById('new-task-action').value.trim();
      if (!action) { s.className = 'toast err'; s.textContent = 'Describe the task first'; return; }
      const assignee = document.getElementById('new-task-assignee').value.trim();
      const due = document.getElementById('new-task-due').value.trim();
      const schedRaw = document.getElementById('new-task-scheduled').value.trim();
      const recurrence = document.getElementById('new-task-recurrence').value.trim();
      // <input type="datetime-local"> gives e.g. "2026-05-15T16:00" with no zone - convert to ISO
      const scheduled_for = schedRaw ? new Date(schedRaw).toISOString() : null;
      try {
        const r = await api('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, assignee, due, scheduled_for, recurrence: recurrence || null }) });
        const d = await r.json();
        if (d.error) { s.className = 'toast err'; s.textContent = d.error; return; }
        document.getElementById('new-task-action').value = '';
        document.getElementById('new-task-assignee').value = '';
        document.getElementById('new-task-due').value = '';
        document.getElementById('new-task-scheduled').value = '';
        document.getElementById('new-task-recurrence').value = '';
        s.className = 'toast ok';
        s.textContent = d.scheduled_for
          ? `Scheduled for ${new Date(d.scheduled_for).toLocaleString()}`
          : 'Task added';
        loadTasks();
        setTimeout(() => s.style.display = 'none', 3000);
      } catch (e) { s.className = 'toast err'; s.textContent = 'Failed: ' + e.message; }
    }

    async function completeTask(id) {
      await api('/tasks/' + id + '/complete', { method: 'PATCH' });
      loadTasks();
    }

    async function deleteTask(id) {
      if (!confirm('Delete this task?')) return;
      await api('/tasks/' + id, { method: 'DELETE' });
      loadTasks();
    }

    function isoToLocalInput(iso) {
      // <input type="datetime-local"> expects "YYYY-MM-DDTHH:MM" in local time, no zone.
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function editTask(id) {
      const data = taskDataCache[id];
      if (!data) return;
      const el = document.getElementById('task-' + id);
      if (!el) return;
      el.innerHTML = `
        <input id="edit-task-action-${id}" value="${escHtml(data.action)}" placeholder="Action..." style="margin-bottom: 6px;" />
        <input id="edit-task-detail-${id}" value="${escHtml(data.detail)}" placeholder="Detail (optional)" style="margin-bottom: 6px;" />
        <div style="display: flex; gap: 8px; margin-bottom: 6px;">
          <input id="edit-task-assignee-${id}" value="${escHtml(data.assignee)}" placeholder="Assignee" style="flex: 1;" />
          <input id="edit-task-due-${id}" value="${escHtml(data.due)}" placeholder="Due note" style="flex: 1;" />
        </div>
        <div style="display: flex; gap: 8px; margin-bottom: 6px;">
          <input id="edit-task-scheduled-${id}" type="datetime-local" value="${escHtml(isoToLocalInput(data.scheduled_for))}" style="flex: 1;" title="Leave empty to clear schedule" />
          <input id="edit-task-recurrence-${id}" value="${escHtml(data.recurrence)}" placeholder="Recurrence (e.g. weekly:friday:16:00)" style="flex: 1;" />
        </div>
        <div class="task-buttons">
          <button class="btn btn-primary btn-sm" onclick="saveTaskEdit('${escHtml(id)}')">Save</button>
          <button class="btn btn-danger btn-sm" onclick="loadTasks()">Cancel</button>
        </div>`;
      document.getElementById('edit-task-action-' + id).focus();
    }

    async function saveTaskEdit(id) {
      const action = document.getElementById('edit-task-action-' + id).value.trim();
      if (!action) return;
      const detail = document.getElementById('edit-task-detail-' + id).value.trim();
      const assignee = document.getElementById('edit-task-assignee-' + id).value.trim();
      const due = document.getElementById('edit-task-due-' + id).value.trim();
      const schedRaw = document.getElementById('edit-task-scheduled-' + id).value.trim();
      const recurrence = document.getElementById('edit-task-recurrence-' + id).value.trim();
      const scheduled_for = schedRaw ? new Date(schedRaw).toISOString() : null;
      const r = await api('/tasks/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, detail, assignee, due, scheduled_for, recurrence: recurrence || null }) });
      const d = await r.json();
      if (d.error) { alert(d.error); return; }
      loadTasks();
    }
