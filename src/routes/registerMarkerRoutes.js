'use strict';

function registerMarkerRoutes(app, deps) {
  const { requireAuth, loadMarkers, mutateMarkers, loadMemory, mutateMemory, markerKeyForFact } = deps;

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
  
  // POST /markers/migrate — one-time cleanup: scan /memory for marker-shaped entries, move
  // them into /markers (keyed canonically), and remove them from /memory. ?dry_run=true to
  // preview without changing anything. Idempotent — re-running finds nothing new. This is what
  // drains the thousands of bookkeeping entries out of the knowledge store.
  app.post('/markers/migrate', requireAuth, async (req, res) => {
    const dryRun = req.query.dry_run === 'true' || (req.body && req.body.dry_run === true);
    const memory = loadMemory();
    const toMove = [];   // { id, key, fact, added }
    for (const m of memory) {
      // Never migrate real knowledge classes, even if a fact happens to look marker-ish.
      if (m.source === 'opinion' || m.source === 'learning') continue;
      const key = markerKeyForFact(m.fact);
      if (key) toMove.push({ id: m.id, key, fact: m.fact, added: m.added });
    }
    const byCategory = {};
    for (const t of toMove) { const cat = t.key.split(':')[0]; byCategory[cat] = (byCategory[cat] || 0) + 1; }
  
    if (dryRun) {
      return res.json({ dry_run: true, would_move: toMove.length, by_category: byCategory, sample: toMove.slice(0, 10).map(t => ({ key: t.key, fact: t.fact.slice(0, 80) })) });
    }
  
    // Write markers first (so even if the delete half is interrupted, no idempotency is lost).
    await mutateMarkers(markers => {
      for (const t of toMove) {
        if (!markers[t.key]) markers[t.key] = { set_at: t.added ? `${t.added}T00:00:00.000Z` : new Date().toISOString(), migrated_from_memory: true, note: t.fact.slice(0, 200) };
      }
    });
    // Then remove the migrated entries from memory, by id, atomically.
    const moveIds = new Set(toMove.map(t => t.id));
    const { result: removed } = await mutateMemory(mem => {
      const kept = mem.filter(x => !moveIds.has(x.id));
      const gone = mem.length - kept.length;
      mem.length = 0; mem.push(...kept);
      return gone;
    });
    console.log(`📦 Markers migration: moved ${toMove.length} markers out of memory, removed ${removed} memory entries`);
    res.json({ ok: true, moved: toMove.length, removed_from_memory: removed, by_category: byCategory });
  });
}

module.exports = { registerMarkerRoutes };
