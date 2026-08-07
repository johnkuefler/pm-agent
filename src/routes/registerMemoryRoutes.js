'use strict';

function registerMemoryRoutes(app, deps) {
  const { requireAuth, loadMemory, mutateMemory, ensureProject, bumpProjectActivity, newMemoryId, db, isDbReady,
    normalizeMemoryRecord, getExpectationSurprise = () => null,
    getCognitiveParameters = () => ({ expectation: { surprising_memory_salience_floor: 0.6 } }),
    memoryLifecycle = null, getMemoryDigest = () => null } = deps;

  // Memory API — view and edit Nora's memory
  app.get('/memory', requireAuth, (req, res) => {
    const memory = loadMemory();
    const view = String(req.query?.view || '').trim().toLowerCase();
    if (view === 'digest') return res.json(getMemoryDigest());
    if (memoryLifecycle && ['working', 'long_term', 'archive'].includes(view)) {
      return res.json(memoryLifecycle.partitionMemory(memory)[view]);
    }
    if (view === 'stats' && memoryLifecycle) {
      const partition = memoryLifecycle.partitionMemory(memory);
      return res.json({ total: memory.length, working: partition.working.length,
        long_term: partition.long_term.length, archive: partition.archive.length,
        digest: getMemoryDigest()?.counts || null, policy: memoryLifecycle.DEFAULT_MEMORY_POLICY });
    }
    return res.json(memory);
  });

  // Vectorization status: how many memories are embedded, and with which model.
  app.get('/memory/embedding-stats', requireAuth, async (req, res) => {
    if (!isDbReady()) return res.json({ db: false, total: loadMemory().length, embedded: 0, model: null });
    try {
      const s = await db.embeddingStats();
      res.json({ db: true, total: s.total, embedded: s.embedded, model: db.EMBED_MODEL });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Force a re-vectorize: clear embeddings so the backfiller recomputes them (~16 rows / 20s).
  // Optional body { source, project } to scope it. No-op-safe when the DB is off.
  app.post('/memory/reembed', requireAuth, async (req, res) => {
    if (!isDbReady()) return res.status(503).json({ error: 'Postgres not active — embeddings are only stored in DB mode' });
    try {
      const { source, project } = req.body || {};
      const queued = await db.clearEmbeddings({ source, project });
      console.log(`🧠 Re-vectorize requested (${source || project ? `source=${source || '*'} project=${project || '*'}` : 'all'}): cleared ${queued} embeddings`);
      res.json({ ok: true, queued, note: 'cleared; the backfiller re-embeds ~16 rows every 20s' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/memory', requireAuth, async (req, res) => {
    const { fact, source, project } = req.body;
    if (!fact) return res.status(400).json({ error: 'fact is required' });
    const memorySource = source || 'manual';
    if (memoryLifecycle) {
      const admission = memoryLifecycle.autonomousMemoryAdmission(loadMemory(), {
        ...req.body, source: memorySource,
      });
      if (!admission.allowed) {
        return res.status(429).json({ error: 'daily autonomous memory budget reached',
          used: admission.used, limit: admission.limit, retry_after: admission.retry_after });
      }
    }
    // Memory CAN contain financial content. Distribution is gated at the live handler's
    // output side. Memory is the source of truth; output is where the approval check happens.
    const canonicalProject = project ? ensureProject(project) : '';
    const expectationSurprise = req.body.expectation_surprise_id
      ? getExpectationSurprise(req.body.expectation_surprise_id) : null;
    if (req.body.expectation_surprise_id && !expectationSurprise) {
      return res.status(400).json({ error: 'expectation_surprise_id must reference a replay-verified source-bound EXPECT miss' });
    }
    const entry = normalizeMemoryRecord({ ...req.body, id: newMemoryId(), fact, project: canonicalProject,
      added: new Date().toISOString().split('T')[0], source: memorySource,
      ...(expectationSurprise ? {
        salience: Math.max(getCognitiveParameters().expectation.surprising_memory_salience_floor,
          Number(req.body.salience) || 0),
        expectation_surprise: { id: expectationSurprise.id, forecast_id: expectationSurprise.forecast_id,
          claim_id: expectationSurprise.prediction_id, scope: expectationSurprise.scope },
      } : {}) });
    await mutateMemory(m => { m.push(entry); });
    if (canonicalProject) bumpProjectActivity(canonicalProject);
    console.log('🧠 Memory added:', fact);
    res.json({ ok: true, id: entry.id, memory: entry });
  });

  // PREFERRED delete path: by stable id, immune to array-shift. The cowork loop (esp. the
  // dream's batch pruning) MUST use this, not the index endpoint below.
  app.delete('/memory/by-id/:id', requireAuth, async (req, res) => {
    const { result } = await mutateMemory(m => {
      const i = m.findIndex(x => x.id === req.params.id);
      if (i === -1) return null;
      return m.splice(i, 1)[0];
    });
    if (!result) return res.status(404).json({ error: 'id not found' });
    console.log('🧠 Memory removed (by id):', result.fact);
    res.json({ ok: true, removed: result });
  });

  // Atomic bulk delete by id — the dream prunes a whole set in ONE serialized operation
  // against current state, so there's no multi-call window for the array to shift underneath.
  // Body: { ids: ["m-...", ...] }. Returns the entries actually removed.
  app.post('/memory/bulk-delete', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
    const idset = new Set(ids);
    const { result } = await mutateMemory(m => {
      const removed = m.filter(x => idset.has(x.id));
      const kept = m.filter(x => !idset.has(x.id));
      m.length = 0; m.push(...kept);
      return removed;
    });
    console.log(`🧠 Memory bulk-deleted ${result.length}/${ids.length} by id`);
    res.json({ ok: true, removed_count: result.length, removed: result });
  });

  // LEGACY index delete — kept for back-compat but UNSAFE under concurrency (the index may
  // not point at what the caller thinks once the array shifts). Now serialized through the
  // mutation lock at least, but callers should migrate to /memory/by-id/:id.
  app.delete('/memory/:index', requireAuth, async (req, res) => {
    const idx = parseInt(req.params.index);
    const { result, memory } = await mutateMemory(m => {
      if (idx < 0 || idx >= m.length) return null;
      return m.splice(idx, 1)[0];
    });
    if (!result) return res.status(404).json({ error: 'index out of range' });
    console.log('🧠 Memory removed (by index — legacy):', result.fact);
    res.json({ ok: true, memory });
  });

  // Update by id (preferred) — falls back to index if the param isn't an id.
  app.put('/memory/:idOrIndex', requireAuth, async (req, res) => {
    const { fact, project } = req.body;
    if (!fact) return res.status(400).json({ error: 'fact is required' });
    const key = req.params.idOrIndex;
    const { result } = await mutateMemory(m => {
      let target = m.find(x => x.id === key);
      if (!target) {
        const idx = parseInt(key);
        if (!isNaN(idx) && idx >= 0 && idx < m.length) target = m[idx];
      }
      if (!target) return null;
      const next = normalizeMemoryRecord({ ...target, ...req.body, fact });
      if (project !== undefined) next.project = project ? ensureProject(project) : '';
      Object.assign(target, next);
      return target;
    });
    if (!result) return res.status(404).json({ error: 'memory not found' });
    if (result.project) bumpProjectActivity(result.project);
    console.log('🧠 Memory updated:', fact);
    res.json({ ok: true, memory: result });
  });

  app.delete('/memory', requireAuth, async (req, res) => {
    await mutateMemory(m => { m.length = 0; });
    console.log('🧠 Memory cleared');
    res.json({ ok: true, memory: [] });
  });

  app.post('/memory/:id/verify', requireAuth, async (req, res) => {
    const { result } = await mutateMemory(items => {
      const target = items.find(item => item.id === req.params.id);
      if (!target) return null;
      target.last_verified = req.body?.verified_at || new Date().toISOString();
      target.verification_count = (Number(target.verification_count) || 0) + 1;
      if (req.body?.confidence !== undefined) target.confidence = Math.min(1, Math.max(0, Number(req.body.confidence)));
      if (target.status === 'disputed' && req.body?.resolve === true) target.status = 'active';
      return target;
    });
    if (!result) return res.status(404).json({ error: 'memory not found' });
    res.json({ ok: true, memory: result });
  });

  app.post('/memory/:id/contradict', requireAuth, async (req, res) => {
    const { contradicts, fact } = req.body || {};
    if (!contradicts && !fact) return res.status(400).json({ error: 'contradicts memory id or fact is required' });
    const { result } = await mutateMemory(items => {
      const target = items.find(item => item.id === req.params.id);
      if (!target) return null;
      target.status = 'disputed';
      target.contradicted_by = [...new Set([...(target.contradicted_by || []), contradicts || fact])];
      return target;
    });
    if (!result) return res.status(404).json({ error: 'memory not found' });
    res.json({ ok: true, memory: result });
  });
}

module.exports = { registerMemoryRoutes };
