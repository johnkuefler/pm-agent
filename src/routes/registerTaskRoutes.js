'use strict';

const { isValidScheduledFor } = require('../lib/scheduling');

function cleanTaskResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (input, max = 2000) => String(input || '').trim().slice(0, max);
  const status = text(value.status, 40).toLowerCase() || 'review_ready';
  const allowedStatuses = new Set(['review_ready', 'completed', 'blocked', 'failed']);
  if (!allowedStatuses.has(status)) throw new Error('invalid task result status');
  const deliverables = Array.isArray(value.deliverables) ? value.deliverables.slice(0, 10).map(item => {
    const url = text(item && item.url, 2000);
    if (url && !/^https?:\/\//i.test(url)) throw new Error('deliverable URLs must use http or https');
    return {
      title: text(item && item.title, 200) || 'Deliverable',
      url,
      type: text(item && item.type, 80) || 'document',
    };
  }).filter(item => item.url) : [];
  return {
    status,
    summary: text(value.summary, 4000),
    deliverables,
    open_items: Array.isArray(value.open_items)
      ? value.open_items.slice(0, 20).map(item => text(item, 500)).filter(Boolean) : [],
    completed_by: text(value.completed_by, 120) || 'Nora',
    reported_at: new Date().toISOString(),
  };
}

function registerTaskRoutes(app, deps) {
  const { requireAuth, loadTasks, saveTasks, addTask, isTaskEligibleNow, isValidRecurrence, computeNextRun,
    onTaskCreated, onTaskCompleted, onTaskDeleted } = deps;

  // Task queue API
  app.get('/tasks', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const status = req.query.status; // ?status=pending or ?status=done
    // ?include=all returns everything (used by the dashboard). Default behavior for
    // ?status=pending hides tasks whose scheduled_for is still in the future — those
    // aren't eligible yet and would noise the cowork loop's queue.
    const includeAll = req.query.include === 'all';
    let result = tasks;
    if (status) result = result.filter(t => t.status === status);
    if (status === 'pending' && !includeAll) {
      const now = new Date();
      result = result.filter(t => isTaskEligibleNow(t, now));
    }
    res.json(result);
  });

  app.get('/tasks/:id', requireAuth, (req, res) => {
    const task = loadTasks().find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  });

  app.post('/tasks', requireAuth, (req, res) => {
    const { action, detail, assignee, due, scheduled_for, recurrence,
      source_channel, source_user, source_external_id, context, metadata } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });
    if (recurrence && !isValidRecurrence(recurrence)) {
      return res.status(400).json({ error: 'invalid recurrence — expected daily:HH:MM, weekdays:HH:MM, weekly:dayname:HH:MM, monthly:N:HH:MM, or every:N:weeks:HH:MM' });
    }
    if (!isValidScheduledFor(scheduled_for)) {
      return res.status(400).json({ error: 'invalid scheduled_for - expected an ISO datetime with a timezone offset' });
    }
    let effectiveScheduledFor = scheduled_for || null;
    // If a recurrence is set but no explicit first-fire time, seed scheduled_for from the rule.
    if (recurrence && !effectiveScheduledFor) {
      effectiveScheduledFor = computeNextRun(recurrence);
    }
    const id = addTask({
      action,
      detail: detail || '',
      assignee: assignee || '',
      due: due || '',
      scheduled_for: effectiveScheduledFor,
      recurrence: recurrence || null,
      source_channel: source_channel || '',
      source_user: source_user || '',
      source_external_id: source_external_id || '',
      context: context || '',
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null,
    });
    if (onTaskCreated) onTaskCreated({ id, action, detail: detail || '', assignee: assignee || '', due: due || '', scheduled_for: effectiveScheduledFor, recurrence: recurrence || null });
    res.json({ ok: true, id, scheduled_for: effectiveScheduledFor, recurrence: recurrence || null });
  });

  app.patch('/tasks/:id/complete', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status === 'done') return res.json({ ok: true, already: true, task });
    try {
      if (req.body && req.body.result) task.result = cleanTaskResult(req.body.result);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const completedAt = new Date().toISOString();
    // Recurring tasks recycle: same row, next scheduled_for, status back to pending.
    // last_run records the most recent completion for audit.
    if (task.recurrence) {
      const next = computeNextRun(task.recurrence, new Date());
      if (next) {
        task.last_run = completedAt;
        task.scheduled_for = next;
        task.completed = null;
        task.status = 'pending';
      saveTasks(tasks);
      if (onTaskCompleted) onTaskCompleted(task, { recurring: true, completed_at: completedAt });
        console.log(`🔁 Recurring task fired and rolled: ${task.id} ${task.action} → next ${next}`);
        return res.json({ ok: true, task, rolled_to: next });
      }
      // If recurrence somehow fails to compute, fall through to a normal completion.
      console.warn(`⚠️ Recurring task ${task.id} has unparseable recurrence "${task.recurrence}" — completing as one-shot`);
    }
    task.status = 'done';
    task.completed = completedAt;
  saveTasks(tasks);
  if (onTaskCompleted) onTaskCompleted(task, { recurring: false, completed_at: completedAt });
    console.log('✅ Task completed:', task.id, task.action);
    res.json({ ok: true, task });
  });

  app.patch('/tasks/:id/result', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    try {
      task.result = cleanTaskResult(req.body && (req.body.result || req.body));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    saveTasks(tasks);
    res.json({ ok: true, task });
  });

  app.delete('/tasks/:id', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'task not found' });
    const removed = tasks.splice(idx, 1);
    saveTasks(tasks);
    if (onTaskDeleted) onTaskDeleted(removed[0], { deleted_at: new Date().toISOString() });
    console.log('🗑️ Task deleted:', removed[0].id);
    res.json({ ok: true });
  });

  app.put('/tasks/:id', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { action, detail, assignee, due, scheduled_for, recurrence } = req.body;
    if (recurrence !== undefined && recurrence !== null && recurrence !== '' && !isValidRecurrence(recurrence)) {
      return res.status(400).json({ error: 'invalid recurrence — expected daily:HH:MM, weekdays:HH:MM, weekly:dayname:HH:MM, monthly:N:HH:MM, or every:N:weeks:HH:MM' });
    }
    if (scheduled_for !== undefined && !isValidScheduledFor(scheduled_for)) {
      return res.status(400).json({ error: 'invalid scheduled_for - expected an ISO datetime with a timezone offset' });
    }
    if (action !== undefined) task.action = action;
    if (detail !== undefined) task.detail = detail;
    if (assignee !== undefined) task.assignee = assignee;
    if (due !== undefined) task.due = due;
    if (scheduled_for !== undefined) task.scheduled_for = scheduled_for || null;
    if (recurrence !== undefined) task.recurrence = recurrence || null;
    saveTasks(tasks);
    console.log('✏️ Task updated:', task.id, task.action);
    res.json({ ok: true, task });
  });
}

module.exports = { registerTaskRoutes, cleanTaskResult };
