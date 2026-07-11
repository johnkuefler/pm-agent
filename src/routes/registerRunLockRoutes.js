'use strict';

function registerRunLockRoutes(app, requireAuth) {
  let _runLock = null; // { holder, acquired_at, expires_at }
  app.post('/run-lock', requireAuth, (req, res) => {
    const now = Date.now();
    const holder = (req.body && req.body.holder) || `run-${now}`;
    const ttl = Math.min(Math.max(parseInt(req.body && req.body.ttl_seconds) || 3000, 60), 5400);
    const active = _runLock && _runLock.expires_at > now;
    if (active && _runLock.holder !== holder) {
      return res.json({ acquired: false, held_by: _runLock.holder, expires_at: new Date(_runLock.expires_at).toISOString() });
    }
    // Free, expired, or re-acquired by same holder → grant (and refresh the TTL).
    _runLock = { holder, acquired_at: now, expires_at: now + ttl * 1000 };
    console.log(`🔒 Run lock ${active ? 'refreshed' : 'acquired'} by ${holder} (ttl ${ttl}s)`);
    res.json({ acquired: true, holder, expires_at: new Date(_runLock.expires_at).toISOString() });
  });
  app.get('/run-lock', requireAuth, (req, res) => {
    const now = Date.now();
    const active = _runLock && _runLock.expires_at > now;
    res.json({ locked: !!active, holder: active ? _runLock.holder : null, expires_at: active ? new Date(_runLock.expires_at).toISOString() : null });
  });
  app.delete('/run-lock', requireAuth, (req, res) => {
    const holder = req.query.holder || (req.body && req.body.holder);
    // Only the holder releases (so a late finisher doesn't release the next run's lock).
    if (_runLock && holder && _runLock.holder !== holder) {
      return res.json({ released: false, reason: 'not lock holder', held_by: _runLock.holder });
    }
    _runLock = null;
    console.log(`🔓 Run lock released${holder ? ` by ${holder}` : ''}`);
    res.json({ released: true });
  });
}

module.exports = { registerRunLockRoutes };
