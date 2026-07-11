'use strict';

const crypto = require('crypto');

function registerDreamRoutes(app, deps) {
  const { requireAuth, loadDreams, saveDreams, MAX_DREAMS_KEPT, onDream } = deps;

  // GET /dreams — list dreams, newest first. Returns the full objects (they're small) so the
  // dashboard can render without a second round-trip per dream.
  app.get('/dreams', requireAuth, (req, res) => {
    const dreams = loadDreams().slice(); // copy before sorting: in DB mode loadDreams() returns the live cache ref
    dreams.sort((a, b) => new Date(b.finished || b.started || 0).getTime() - new Date(a.finished || a.started || 0).getTime());
    res.json(dreams);
  });

  // GET /dreams/:id — a single dream's full detail.
  app.get('/dreams/:id', requireAuth, (req, res) => {
    const dream = loadDreams().find(d => d.id === req.params.id);
    if (!dream) return res.status(404).json({ error: 'dream not found' });
    res.json(dream);
  });

  // POST /dreams — record a completed dream. The cowork loop calls this at the end of its
  // Dreaming Round with the consolidation stats, reflection results, and a first-person
  // narrative ("what I dreamed about"). Server stamps id + finished if absent.
  app.post('/dreams', requireAuth, (req, res) => {
    const body = req.body || {};
    const now = new Date().toISOString();
    const dream = {
      id: body.id || `dream-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      date: body.date || now.split('T')[0],
      started: body.started || now,
      finished: body.finished || now,
      // { memories_before, memories_after, duplicates_removed, fragments_merged,
      //   stale_pruned, contradictions_resolved, examples: [..] }
      consolidation: body.consolidation || {},
      // { takes_added: [..], takes_retired: [..], ideas: [..] }
      reflection: body.reflection || {},
      // { interactions_reviewed, outcomes: {appreciated,landed,neutral,ignored,corrected},
      //   learnings_added: [..], learnings_retired: [..] } — the RSI Review movement's results.
      review: body.review || {},
      // First-person "what I dreamed about" summary in Nora's voice.
      narrative: body.narrative || ''
    };
    const dreams = loadDreams();
    dreams.push(dream);
    // Trim oldest beyond the cap.
    dreams.sort((a, b) => new Date(b.finished || b.started || 0).getTime() - new Date(a.finished || a.started || 0).getTime());
    const trimmed = dreams.slice(0, MAX_DREAMS_KEPT);
    saveDreams(trimmed);
    if (onDream) onDream(dream);
    console.log(`💤 Dream recorded ${dream.date}: ${dream.consolidation.memories_before ?? '?'}→${dream.consolidation.memories_after ?? '?'} memories, +${(dream.reflection.takes_added || []).length} takes, +${(dream.review.learnings_added || []).length} learnings`);
    res.json({ ok: true, dream });
  });

  // DELETE /dreams/:id — admin cleanup of a single dream entry.
  app.delete('/dreams/:id', requireAuth, (req, res) => {
    const dreams = loadDreams();
    const idx = dreams.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'dream not found' });
    dreams.splice(idx, 1);
    saveDreams(dreams);
    res.json({ ok: true });
  });
}

module.exports = { registerDreamRoutes };
