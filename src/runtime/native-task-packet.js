'use strict';

function boundedNativeTask(task) {
  if (!task) return null;
  const text = (value, maximum) => String(value || '').slice(0, maximum);
  const metadata = task.metadata && typeof task.metadata === 'object'
    ? Object.fromEntries(Object.entries(task.metadata).slice(0, 20).map(([key, value]) => [
      text(key, 120),
      value == null || ['string', 'number', 'boolean'].includes(typeof value)
        ? (typeof value === 'string' ? text(value, 1000) : value)
        : text(JSON.stringify(value), 1000),
    ])) : null;
  return {
    id: text(task.id, 160),
    action: text(task.action, 1200),
    detail: text(task.detail, 4000),
    context: text(task.context, 3000),
    due: text(task.due, 80),
    scheduled_for: text(task.scheduled_for, 80),
    recurrence: text(task.recurrence, 120),
    source_channel: text(task.source_channel, 160),
    source_user: text(task.source_user, 160),
    source_thread_ts: text(task.source_thread_ts, 160),
    source_bot_id: text(task.source_bot_id, 200),
    source_external_id: text(task.source_external_id, 200),
    metadata,
  };
}

async function buildNativeTaskPacket(task, { resolveChannelName = async () => null } = {}) {
  const packet = boundedNativeTask(task);
  const channelId = String(packet?.metadata?.destination_channel || '').trim();
  if (!channelId) return packet;
  let channelName = null;
  try {
    channelName = String(await resolveChannelName(channelId) || '').trim() || null;
  } catch {}
  return {
    ...packet,
    delivery_destination: {
      channel_id: channelId,
      channel_name: channelName,
      display_name: channelName ? `#${channelName}` : channelId,
      verified_same_destination: Boolean(channelName),
    },
  };
}

module.exports = { boundedNativeTask, buildNativeTaskPacket };
