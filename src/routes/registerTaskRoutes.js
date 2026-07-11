'use strict';

function registerTaskRoutes(app, deps) {
  const { requireAuth, loadTasks, saveTasks, addTask, isTaskEligibleNow, isValidRecurrence, computeNextRun } = deps;

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

  app.post('/tasks', requireAuth, (req, res) => {
    const { action, detail, assignee, due, scheduled_for, recurrence } = req.body;
    if (!action) return res.status(400).json({ error: 'action is required' });
    if (recurrence && !isValidRecurrence(recurrence)) {
      return res.status(400).json({ error: 'invalid recurrence — expected daily:HH:MM, weekdays:HH:MM, weekly:dayname:HH:MM, or monthly:N:HH:MM' });
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
      recurrence: recurrence || null
    });
    res.json({ ok: true, id, scheduled_for: effectiveScheduledFor, recurrence: recurrence || null });
  });

  app.patch('/tasks/:id/complete', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status === 'done') return res.json({ ok: true, already: true, task });
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
        console.log(`🔁 Recurring task fired and rolled: ${task.id} ${task.action} → next ${next}`);
        return res.json({ ok: true, task, rolled_to: next });
      }
      // If recurrence somehow fails to compute, fall through to a normal completion.
      console.warn(`⚠️ Recurring task ${task.id} has unparseable recurrence "${task.recurrence}" — completing as one-shot`);
    }
    task.status = 'done';
    task.completed = completedAt;
    saveTasks(tasks);
    console.log('✅ Task completed:', task.id, task.action);
    res.json({ ok: true, task });
  });

  app.delete('/tasks/:id', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'task not found' });
    const removed = tasks.splice(idx, 1);
    saveTasks(tasks);
    console.log('🗑️ Task deleted:', removed[0].id);
    res.json({ ok: true });
  });

  app.put('/tasks/:id', requireAuth, (req, res) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { action, detail, assignee, due, scheduled_for, recurrence } = req.body;
    if (recurrence !== undefined && recurrence !== null && recurrence !== '' && !isValidRecurrence(recurrence)) {
      return res.status(400).json({ error: 'invalid recurrence — expected daily:HH:MM, weekdays:HH:MM, weekly:dayname:HH:MM, or monthly:N:HH:MM' });
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

module.exports = { registerTaskRoutes };
