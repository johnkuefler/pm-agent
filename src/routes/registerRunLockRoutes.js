'use strict';

function normalizeLock(value) {
  if (!value || typeof value !== 'object') return null;
  const acquiredAt = Number(value.acquired_at);
  const expiresAt = Number(value.expires_at);
  if (!String(value.holder || '').trim() || !Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)
    || expiresAt < acquiredAt) return null;
  return {
    holder: String(value.holder), acquired_at: acquiredAt, expires_at: expiresAt,
    lifecycle: value.lifecycle && typeof value.lifecycle === 'object' ? value.lifecycle : null,
  };
}

function registerRunLockRoutes(app, requireAuth, {
  onAcquire = null, onRelease = null, projectLifecycle = null,
  loadLock = null, saveLock = null, clock = () => Date.now(), activityStream = null,
} = {}) {
  let _runLock = null; // Default in-memory store when persistence is not injected.
  const readLock = async () => {
    const loaded = typeof loadLock === 'function' ? await loadLock() : _runLock;
    _runLock = normalizeLock(loaded);
    return _runLock;
  };
  const writeLock = async value => {
    const normalized = normalizeLock(value);
    if (typeof saveLock === 'function') await saveLock(normalized);
    _runLock = normalized;
    return _runLock;
  };
  const persistenceFailure = (res, operation, error) => {
    console.error(`Run lock persistence ${operation} failed: ${error.message}`);
    return res.status(503).json({ acquired: false, released: false,
      reason: `lock_persistence_${operation}_failed`, error: error.message });
  };
  const visibleLifecycle = async (lifecycle, context = {}) => {
    if (!lifecycle || typeof projectLifecycle !== 'function') return lifecycle || null;
    try {
      const projected = await projectLifecycle({ lifecycle, ...context });
      return projected && typeof projected === 'object' ? projected : lifecycle;
    } catch (error) {
      console.error(`Run lock lifecycle projection failed: ${error.message}`);
      return {
        ...lifecycle,
        lifecycle_projection_integrity_verified: false,
        lifecycle_stage: 'projection_failure',
        projection_error: String(error.message || error).slice(0, 240),
        next_required_action: 'Stop and report the lifecycle projection failure; do not infer the current stage.',
      };
    }
  };

  app.post('/run-lock', requireAuth, async (req, res) => {
    const now = Number(clock());
    const holder = (req.body && req.body.holder) || `run-${now}`;
    const ttl = Math.min(Math.max(parseInt(req.body && req.body.ttl_seconds) || 3000, 60), 5400);
    let current;
    try { current = await readLock(); }
    catch (error) { return persistenceFailure(res, 'read', error); }
    const active = current && current.expires_at > now;
    if (active && current.holder !== holder) {
      let visible;
      visible = await visibleLifecycle(current.lifecycle, { holder: current.holder });
      activityStream?.record({ lane: 'work', kind: 'hourly_run_deferred',
        label: 'An overlapping hourly run was held back',
        detail: 'The active run kept exclusive ownership of the operational ledger.',
        status: 'deferred', source: 'run-lock', meta: { reason: 'active_run_lock' } });
      return res.json({ acquired: false, held_by: current.holder,
        expires_at: new Date(current.expires_at).toISOString(), lifecycle: visible });
    }

    // Expiry is a lifecycle boundary, not permission to forget an open run. Close the expired
    // lifecycle explicitly before opening a successor, then clear its durable lease.
    if (current && !active) {
      try {
        if (typeof onRelease === 'function') await onRelease({
          holder: current.holder, lifecycle: current.lifecycle || null,
          released_at: new Date(now).toISOString(), expired: true,
        });
        await writeLock(null);
        activityStream?.finish(`hourly:${current.holder}`, { status: 'failed',
          detail: 'The hourly lease expired before a clean release.',
          outcome: 'The lifecycle was gap-closed before a successor started.' });
      } catch (error) {
        console.error(`Run lock expiry recovery failed for ${current.holder}: ${error.message}`);
        return res.status(503).json({ acquired: false, reason: 'expired_lifecycle_recovery_failed',
          error: error.message });
      }
      current = null;
    }

    let lifecycle = active ? current.lifecycle || null : null;
    if (!active && typeof onAcquire === 'function') {
      try {
        lifecycle = await onAcquire({
          holder,
          acquired_at: new Date(now).toISOString(),
          expires_at: new Date(now + ttl * 1000).toISOString(),
        }) || null;
      } catch (error) {
        console.error(`Run lock lifecycle start failed for ${holder}: ${error.message}`);
        activityStream?.record({ id: `hourly:${holder}:start-failed`, lane: 'work',
          kind: 'hourly_run', label: 'Hourly run could not start',
          detail: 'The run-bound lifecycle failed before operational work began.', status: 'failed',
          source: 'run-lock', meta: { reason: 'lifecycle_start_failed' } });
        return res.status(503).json({ acquired: false, reason: 'lifecycle_start_failed', error: error.message });
      }
    }
    const next = { holder, acquired_at: active ? current.acquired_at : now,
      expires_at: now + ttl * 1000, lifecycle };
    try { await writeLock(next); }
    catch (error) {
      if (!active && lifecycle && typeof onRelease === 'function') {
        try {
          await onRelease({ holder, lifecycle, released_at: new Date(now).toISOString(),
            persistence_failed: true });
        } catch (_) { /* The persistence failure remains the primary error. */ }
      }
      return persistenceFailure(res, 'write', error);
    }
    console.log(`Run lock ${active ? 'refreshed' : 'acquired'} by ${holder} (ttl ${ttl}s)`);
    if (active) {
      const refreshedActivity = activityStream?.progress(`hourly:${holder}`, {
        detail: 'The active hourly run renewed its exclusive operational lease.',
      });
      if (activityStream && !refreshedActivity) {
        activityStream.begin({ id: `hourly:${holder}`, lane: 'work', kind: 'hourly_run',
          label: 'Resuming the active hourly run',
          detail: 'The durable operational lease survived a server process change.',
          source: 'run-lock', meta: { phase: 'orientation' } });
      }
    } else {
      activityStream?.begin({ id: `hourly:${holder}`, lane: 'work', kind: 'hourly_run',
        label: 'Orienting to the hour',
        detail: 'Loading identity, continuity, current commitments, and operating context.',
        source: 'run-lock', meta: { phase: 'orientation' } });
    }
    let visible;
    visible = await visibleLifecycle(lifecycle, { holder });
    return res.json({ acquired: true, holder, expires_at: new Date(next.expires_at).toISOString(), lifecycle: visible });
  });

  app.get('/run-lock', requireAuth, async (_req, res) => {
    let current;
    try { current = await readLock(); }
    catch (error) { return persistenceFailure(res, 'read', error); }
    const now = Number(clock());
    const active = current && current.expires_at > now;
    let lifecycle = null;
    if (active) {
      lifecycle = await visibleLifecycle(current.lifecycle, { holder: current.holder });
    }
    return res.json({
      locked: !!active,
      holder: active ? current.holder : null,
      expires_at: active ? new Date(current.expires_at).toISOString() : null,
      lifecycle,
      expired_lease_pending_recovery: Boolean(current && !active),
    });
  });

  app.delete('/run-lock', requireAuth, async (req, res) => {
    const holder = req.query.holder || (req.body && req.body.holder);
    let current;
    try { current = await readLock(); }
    catch (error) { return persistenceFailure(res, 'read', error); }
    // Only the holder releases (so a late finisher doesn't release the next run's lock).
    if (current && holder && current.holder !== holder) {
      return res.json({ released: false, reason: 'not lock holder', held_by: current.holder });
    }
    let lifecycle = current?.lifecycle || null;
    if (current && typeof onRelease === 'function') {
      try {
        lifecycle = await onRelease({
          holder: current.holder,
          lifecycle,
          released_at: new Date(Number(clock())).toISOString(),
          expired: current.expires_at <= Number(clock()),
        }) || lifecycle;
      } catch (error) {
        console.error(`Run lock lifecycle release failed for ${current.holder}: ${error.message}`);
        activityStream?.progress(`hourly:${current.holder}`, {
          detail: 'Waiting for the run-bound cycle to close cleanly before releasing the lease.',
          meta: { reason: error.code || 'lifecycle_release_failed' },
        });
        return res.status(503).json({ released: false, reason: 'lifecycle_release_failed',
          ...(error.code ? { code: error.code } : {}),
          ...(error.next_required_action ? { next_required_action: error.next_required_action } : {}),
          held_by: current.holder,
          lifecycle: { ...(lifecycle || {}), release_error: error.message } });
      }
    }
    try { await writeLock(null); }
    catch (error) { return persistenceFailure(res, 'write', error); }
    console.log(`Run lock released${holder ? ` by ${holder}` : ''}`);
    if (current?.holder) {
      activityStream?.finish(`hourly:${current.holder}`, { status: 'completed',
        detail: 'The hourly run closed its lifecycle and released the operational lease.',
        outcome: 'Ready for the next scheduled pass.' });
    }
    return res.json({ released: true, lifecycle });
  });
}

module.exports = { registerRunLockRoutes };
