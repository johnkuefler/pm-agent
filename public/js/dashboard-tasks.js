// Tasks
    let taskDataCache = new Map();
    let taskRowCache = new Map();
    let taskLoadToken = 0;

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
      const token = ++taskLoadToken;
      list.setAttribute('aria-busy', 'true');
      list.innerHTML = '<p class="empty" role="status">Loading tasks...</p>';
      // Dashboard always shows scheduled tasks (include=all bypasses the eligibility filter).
      const url = currentFilter === 'all'
        ? '/tasks?include=all'
        : `/tasks?status=${currentFilter}&include=all`;
      try {
        const r = await api(url);
        const tasks = await r.json();
        if (token !== taskLoadToken) return;
        taskDataCache = new Map();
        taskRowCache = new Map();
        if (tasks.length === 0) {
          const message = currentFilter === 'pending' ? 'No pending tasks.'
            : currentFilter === 'done' ? 'No completed tasks.' : 'No tasks yet.';
          list.innerHTML = `<p class="empty" role="status">${message}</p>`;
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
        tasks.forEach(t => { taskDataCache.set(String(t.id), {
          action: t.action, detail: t.detail || '', assignee: t.assignee || '',
          due: t.due || '', scheduled_for: t.scheduled_for || '', recurrence: t.recurrence || ''
        }); });
        list.innerHTML = tasks.map((t, index) => {
          const transcriptLink = t.source_bot_id
            ? ' · <a href="#" class="task-transcript-link" style="color: #1d4ed8; text-decoration: none;">View transcript</a>'
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
          <div class="task-item ${t.status === 'done' ? 'done' : ''}" data-task-index="${index}">
            <div class="task-action">${escHtml(t.action)}</div>
            ${t.detail ? `<div class="task-detail">${escHtml(t.detail)}</div>` : ''}
            ${lastRunNote}
            <div class="task-meta">
              <span class="task-badge ${t.status === 'done' ? 'badge-done' : 'badge-pending'}">${escHtml(t.status)}</span>
              ${t.assignee ? ' · ' + escHtml(t.assignee) : ''}
              ${t.due ? ' · due ' + escHtml(t.due) : ''}
              · ${new Date(t.created).toLocaleDateString()}${schedBadge}${recurBadge}${transcriptLink}
            </div>
            <div class="task-buttons">
              <button class="btn btn-success task-edit-btn" type="button">Edit</button>
              ${t.status === 'pending' ? `<button class="btn btn-success task-complete-btn" type="button">${t.recurrence ? 'Mark Run' : 'Mark Done'}</button>` : ''}
              <button class="btn btn-danger task-delete-btn" type="button">Delete</button>
            </div>
          </div>`;
        }).join('');
        list.querySelectorAll('[data-task-index]').forEach(row => {
          const task = tasks[Number(row.dataset.taskIndex)];
          if (!task) return;
          taskRowCache.set(String(task.id), row);
          row.querySelector('.task-edit-btn')?.addEventListener('click', () => editTask(task.id, row));
          row.querySelector('.task-complete-btn')?.addEventListener('click', () => completeTask(task.id));
          row.querySelector('.task-delete-btn')?.addEventListener('click', () => deleteTask(task.id));
          row.querySelector('.task-transcript-link')?.addEventListener('click', event => {
            event.preventDefault();
            showTab('transcripts');
            setTimeout(() => viewTranscript(task.source_bot_id), 100);
          });
        });
      } catch (e) {
        if (token === taskLoadToken) list.innerHTML = '<p class="empty" role="alert">Failed to load tasks.</p>';
      } finally {
        if (token === taskLoadToken) list.setAttribute('aria-busy', 'false');
      }
    }

    function filterTasks(status, btn) {
      currentFilter = status;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
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
      await api('/tasks/' + encodeURIComponent(id) + '/complete', { method: 'PATCH' });
      loadTasks();
    }

    async function deleteTask(id) {
      if (!confirm('Delete this task?')) return;
      await api('/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
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

    function editTask(id, row = taskRowCache.get(String(id))) {
      const data = taskDataCache.get(String(id));
      if (!data) return;
      if (!row) return;
      row.innerHTML = `
        <input data-task-field="action" aria-label="Task action" placeholder="Action..." style="margin-bottom: 6px;" />
        <input data-task-field="detail" aria-label="Task detail" placeholder="Detail (optional)" style="margin-bottom: 6px;" />
        <div style="display: flex; gap: 8px; margin-bottom: 6px;">
          <input data-task-field="assignee" aria-label="Task assignee" placeholder="Assignee" style="flex: 1;" />
          <input data-task-field="due" aria-label="Task due note" placeholder="Due note" style="flex: 1;" />
        </div>
        <div style="display: flex; gap: 8px; margin-bottom: 6px;">
          <input data-task-field="scheduled" type="datetime-local" aria-label="Task schedule" style="flex: 1;" title="Leave empty to clear schedule" />
          <input data-task-field="recurrence" aria-label="Task recurrence" placeholder="Recurrence (e.g. weekly:friday:16:00)" style="flex: 1;" />
        </div>
        <div class="task-buttons">
          <button class="btn btn-primary btn-sm task-save-btn" type="button">Save</button>
          <button class="btn btn-danger btn-sm task-cancel-btn" type="button">Cancel</button>
        </div>`;
      const values = {
        action: data.action,
        detail: data.detail,
        assignee: data.assignee,
        due: data.due,
        scheduled: isoToLocalInput(data.scheduled_for),
        recurrence: data.recurrence,
      };
      Object.entries(values).forEach(([field, value]) => {
        const input = row.querySelector(`[data-task-field="${field}"]`);
        if (input) input.value = value || '';
      });
      row.querySelector('.task-save-btn')?.addEventListener('click', () => saveTaskEdit(id, row));
      row.querySelector('.task-cancel-btn')?.addEventListener('click', () => loadTasks());
      row.querySelector('[data-task-field="action"]')?.focus();
    }

    async function saveTaskEdit(id, row = taskRowCache.get(String(id))) {
      if (!row) return;
      const value = field => row.querySelector(`[data-task-field="${field}"]`).value.trim();
      const action = value('action');
      if (!action) return;
      const detail = value('detail');
      const assignee = value('assignee');
      const due = value('due');
      const schedRaw = value('scheduled');
      const recurrence = value('recurrence');
      const scheduled_for = schedRaw ? new Date(schedRaw).toISOString() : null;
      const r = await api('/tasks/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, detail, assignee, due, scheduled_for, recurrence: recurrence || null }) });
      const d = await r.json();
      if (d.error) { alert(d.error); return; }
      loadTasks();
    }
