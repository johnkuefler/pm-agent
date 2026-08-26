'use strict';

function registerMarkerRoutes(app, deps) {
  const { requireAuth, loadMarkers, mutateMarkers } = deps;

  // GET /markers — all markers, or ?prefix=filed-transcript: to list a category.
  app.get('/markers', requireAuth, (req, res) => {
    const markers = loadMarkers();
    const prefix = req.query.prefix;
    if (prefix) {
      const out = {};
      for (const k of Object.keys(markers)) if (k.startsWith(prefix)) out[k] = markers[k];
      return res.json({ count: Object.keys(out).length, markers: out });
    }
    res.json({ count: Object.keys(markers).length, markers });
  });

  // GET /markers/:key — the idempotency check. 200 with { exists, marker }.
  app.get('/markers/:key', requireAuth, (req, res) => {
    const markers = loadMarkers();
    const marker = markers[req.params.key];
    res.json({ exists: !!marker, key: req.params.key, marker: marker || null });
  });

  // POST /markers — set/upsert a marker. Body: { key, data? }. Idempotent.
  app.post('/markers', requireAuth, async (req, res) => {
    const { key, data } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key (string) is required' });
    const now = new Date().toISOString();
    await mutateMarkers(m => { m[key] = { set_at: m[key]?.set_at || now, updated_at: now, ...(data && typeof data === 'object' ? data : (data !== undefined ? { value: data } : {})) }; });
    res.json({ ok: true, key });
  });

  // POST /markers/bulk — set many at once. Body: { markers: { key: data, ... } }.
  app.post('/markers/bulk', requireAuth, async (req, res) => {
    const incoming = (req.body && req.body.markers) || {};
    const keys = Object.keys(incoming);
    if (keys.length === 0) return res.status(400).json({ error: 'markers object is required' });
    const now = new Date().toISOString();
    await mutateMarkers(m => {
      for (const k of keys) {
        const d = incoming[k];
        m[k] = { set_at: m[k]?.set_at || now, updated_at: now, ...(d && typeof d === 'object' ? d : {}) };
      }
    });
    res.json({ ok: true, count: keys.length });
  });

  // DELETE /markers/:key — remove a marker.
  app.delete('/markers/:key', requireAuth, async (req, res) => {
    const { result } = await mutateMarkers(m => { const existed = !!m[req.params.key]; delete m[req.params.key]; return existed; });
    res.json({ ok: true, existed: result });
  });

}

module.exports = { registerMarkerRoutes };
