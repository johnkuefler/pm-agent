'use strict';

function createWebSocketLivenessMonitor({ intervalMs = 15000, maxMisses = 1,
  clock = () => new Date(), setTimer = setInterval, clearTimer = clearInterval,
  logger = console } = {}) {
  const active = new Map();
  let sequence = 0;
  let staleTerminations = 0;
  let pingFailures = 0;
  const recentStale = [];

  function attach(socket, label, { onStale = null } = {}) {
    const id = ++sequence;
    const entry = { id, label, attached_at: clock().toISOString(), last_activity_at: clock().toISOString(),
      awaiting_pong: false, missed: 0 };
    active.set(id, entry);
    let detached = false;

    const markAlive = () => {
      entry.awaiting_pong = false;
      entry.missed = 0;
      entry.last_activity_at = clock().toISOString();
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      clearTimer(timer);
      active.delete(id);
      socket.off?.('pong', markAlive);
      socket.off?.('message', markAlive);
      socket.off?.('error', socketError);
    };
    const terminateStale = reason => {
      if (detached) return;
      staleTerminations += 1;
      recentStale.push({ label, reason, at: clock().toISOString() });
      while (recentStale.length > 20) recentStale.shift();
      logger.warn?.(`${label} WebSocket became stale; terminating (${reason})`);
      try { onStale?.(reason); } catch {}
      try { socket.terminate?.(); } catch {}
      detach();
    };
    const socketError = error => terminateStale(`socket_error:${error?.message || error || 'unknown'}`);
    const timer = setTimer(() => {
      // ws.OPEN is 1; avoid coupling this small runtime helper to a particular WS package.
      if (socket.readyState !== 1) return;
      if (entry.awaiting_pong) {
        entry.missed += 1;
        if (entry.missed >= maxMisses) return terminateStale('pong_timeout');
      }
      entry.awaiting_pong = true;
      try {
        socket.ping(error => {
          if (!error) return;
          pingFailures += 1;
          terminateStale(`ping_failed:${error.message || error}`);
        });
      } catch (error) {
        pingFailures += 1;
        terminateStale(`ping_failed:${error.message || error}`);
      }
    }, intervalMs);
    timer.unref?.();
    socket.on?.('pong', markAlive);
    socket.on?.('message', markAlive);
    socket.once?.('close', detach);
    socket.once?.('error', socketError);
    return { detach, markAlive };
  }

  function snapshot() {
    return { protocol_version: 1, heartbeat_interval_ms: intervalMs, maximum_missed_heartbeats: maxMisses,
      active: [...active.values()].map(item => ({ ...item })), active_count: active.size,
      stale_terminations: staleTerminations, ping_failures: pingFailures,
      recent_stale: [...recentStale].reverse() };
  }

  return { attach, snapshot };
}

module.exports = { createWebSocketLivenessMonitor };
