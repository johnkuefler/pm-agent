'use strict';

const { createHash } = require('node:crypto');

// Bind a prepared result to both its occurrence and the instructions/destination it was made for.
function taskDeliveryScope(task) {
  return createHash('sha256').update(JSON.stringify([
    task.id, task.scheduled_for, task.created, task.action, task.detail, task.context,
    task.recurrence, task.metadata, task.source_channel, task.source_thread_ts,
  ])).digest('hex');
}

function nextTaskOccurrence(task, now, computeNextRun) {
  const due = new Date(task.scheduled_for || '');
  if (!/^every:\d+:weeks:/i.test(task.recurrence || '') || !Number.isFinite(due.getTime())) {
    return computeNextRun(task.recurrence, now);
  }
  // A Tuesday recovery of a Monday agenda must not move every future agenda to Tuesday.
  let cursor = due;
  for (let i = 0; i < 1000; i++) {
    const next = computeNextRun(task.recurrence, cursor);
    if (!next) return null;
    const date = new Date(next);
    if (date > now) return next;
    if (!(date > cursor)) throw new Error('Task recurrence did not advance');
    cursor = date;
  }
  throw new Error('Task recurrence recovery exceeded its bound');
}

function createScheduledResultDelivery(task, { loadMarkers, mutateMarkers, deliver }) {
  const scope = taskDeliveryScope(task);
  const key = `scheduled-result:${task.id}`;
  let prepared = loadMarkers()[key];
  if (prepared?.scope !== scope || prepared?.status !== 'ready') prepared = null;
  return {
    hasPrepared: () => Boolean(prepared),
    // Memory only: this terminal tool must not consume the remote-write time reserve.
    prepare({ text }) {
      const value = String(text || '').trim();
      if (!value || value.length > 35000) return { error: 'Provide a finished result between 1 and 35000 characters.' };
      prepared = { scope, status: 'ready', text: value, set_at: new Date().toISOString() };
      return { ok: true, prepared: true, delivered: false };
    },
    async flush() {
      if (!prepared) return null;
      try {
        // A failed delivery can resume without paying for all the source lookups again.
        await mutateMarkers(markers => { markers[key] = prepared; }, { strict: true });
        const result = await deliver({ text: prepared.text, scope });
        if (!result?.ok || !result.delivery?.ts) throw new Error(result?.error || 'Missing Slack delivery receipt');
        // The delivery endpoint owns the durable receipt and occurrence rollover. Its receipt
        // also deduplicates a retry if this cleanup fails after Slack accepted the message.
        await mutateMarkers(markers => { delete markers[key]; }, { strict: true }).catch(() => {});
        return { status: 'completed', task_id: task.id, completed: true,
          tools_executed: ['nora_deliver_task_result'], delivery: result.delivery };
      } catch (error) {
        return { status: 'degraded', task_id: task.id, completed: false,
          reason: 'scheduled_delivery_pending',
          detail: String(error.response?.data?.error || error.message || error).slice(0, 500),
          tools_executed: [] };
      }
    },
  };
}

module.exports = { createScheduledResultDelivery, taskDeliveryScope, nextTaskOccurrence };
