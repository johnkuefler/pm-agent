'use strict';

const crypto = require('crypto');

function registerInteractionRoutes(app, deps) {
  const { requireAuth, loadInteractions, saveInteractions, MAX_INTERACTIONS_KEPT } = deps;

  // GET /interactions — the dream's worklist. ?reviewed=false for un-assessed ones; ?since=ISO
  // to bound the window; ?limit=N (default 100). Newest first.
  app.get('/interactions', requireAuth, (req, res) => {
    let items = loadInteractions().slice(); // copy: in DB mode loadInteractions() returns the live cache ref; sorting it in place would scramble ord and make the next logInteraction trim the newest rows
    if (req.query.reviewed === 'false') items = items.filter(i => !i.reviewed);
    if (req.query.reviewed === 'true') items = items.filter(i => i.reviewed);
    if (req.query.since) items = items.filter(i => (i.created || '') >= req.query.since);
    items.sort((a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime());
    const limit = Math.min(parseInt(req.query.limit) || 100, MAX_INTERACTIONS_KEPT);
    res.json(items.slice(0, limit));
  });
  
  // POST /interactions/:id/outcome — the dream writes back how an interaction landed.
  // Body: { outcome: "landed"|"appreciated"|"neutral"|"ignored"|"corrected", signal: "<what
  // the replies/reactions/adjacent messages showed>" }. Marks the interaction reviewed.
  app.post('/interactions/:id/outcome', requireAuth, (req, res) => {
    const items = loadInteractions();
    const ix = items.find(i => i.id === req.params.id);
    if (!ix) return res.status(404).json({ error: 'interaction not found' });
    ix.outcome = req.body.outcome || ix.outcome || null;
    if (req.body.signal !== undefined) ix.signal = req.body.signal;
    ix.reviewed = true;
    ix.reviewed_at = new Date().toISOString();
    saveInteractions(items);
    res.json({ ok: true, interaction: ix });
  });
  
  // ============================================================
}

module.exports = { registerInteractionRoutes };
