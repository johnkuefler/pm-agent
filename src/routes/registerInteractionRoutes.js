'use strict';

const REVIEW_OUTCOMES = new Set(['landed', 'appreciated', 'neutral', 'ignored', 'corrected']);
const PROJECTION_PROTOCOL_VERSION = 1;

function projectionError(error) {
  return String(error?.message || error).slice(0, 300);
}

function projectionReceipt(result) {
  if (result === undefined) return { acknowledged: true, result: null };
  try {
    const serialized = JSON.stringify(result);
    if (serialized && serialized.length > 8000) {
      return {
        acknowledged: true,
        result: { truncated: true, preview: serialized.slice(0, 8000) },
      };
    }
    return {
      acknowledged: true,
      result: serialized === undefined ? String(result).slice(0, 1200) : JSON.parse(serialized),
    };
  } catch (_error) {
    return { acknowledged: true, result: String(result).slice(0, 1200) };
  }
}

function pendingProjection(previous, at) {
  const priorAttempts = Number.isInteger(previous?.attempts) && previous.attempts >= 0
    ? previous.attempts : 0;
  return {
    protocol_version: PROJECTION_PROTOCOL_VERSION,
    status: 'pending',
    attempts: priorAttempts + 1,
    requested_at: previous?.requested_at || at,
    last_attempt_at: at,
    updated_at: at,
    error: null,
    receipt: null,
  };
}

function notRequiredProjection(at) {
  return {
    protocol_version: PROJECTION_PROTOCOL_VERSION,
    status: 'not_required',
    attempts: 0,
    requested_at: at,
    last_attempt_at: null,
    updated_at: at,
    completed_at: at,
    error: null,
    receipt: { acknowledged: false, reason: 'no_projection_handler' },
  };
}

function callbackInteraction(interaction) {
  const copy = JSON.parse(JSON.stringify(interaction));
  delete copy.downstream_projection;
  return copy;
}

function registerInteractionRoutes(app, deps) {
  const { requireAuth, loadInteractions, saveInteractions, MAX_INTERACTIONS_KEPT, onOutcome,
    saveInteractionsStrict = async items => saveInteractions(items),
    clock = () => new Date() } = deps;

  async function runOutcomeProjection(items, ix, res, {
    replayed = false, sourceCommitted = false,
  } = {}) {
    const at = new Date(clock()).toISOString();
    ix.downstream_projection = pendingProjection(ix.downstream_projection, at);
    try {
      // The durable pending state is the retry receipt. The callback must never run before it.
      await saveInteractionsStrict(items);
    } catch (error) {
      return res.status(503).json({
        error: `interaction outcome projection was not queued: ${projectionError(error)}`,
        code: 'interaction_outcome_projection_failed',
        retryable: true,
        source_committed: sourceCommitted,
      });
    }

    let result;
    try {
      result = await onOutcome(callbackInteraction(ix), {
        projection: {
          idempotency_key: `interaction-outcome:${ix.id}:v1`,
          attempt: ix.downstream_projection.attempts,
        },
      });
    } catch (error) {
      const failedAt = new Date(clock()).toISOString();
      const callbackFailure = projectionError(error);
      ix.downstream_projection = {
        ...ix.downstream_projection,
        status: 'failed',
        updated_at: failedAt,
        error: callbackFailure,
        receipt: null,
      };
      try {
        await saveInteractionsStrict(items);
      } catch (persistenceError) {
        return res.status(503).json({
          error: `interaction outcome projection failed (${callbackFailure}); retry state was not committed: ${projectionError(persistenceError)}`,
          code: 'interaction_outcome_projection_failed',
          retryable: true,
          source_committed: true,
        });
      }
      return res.status(503).json({
        error: `interaction outcome projection failed: ${callbackFailure}`,
        code: 'interaction_outcome_projection_failed',
        retryable: true,
        source_committed: true,
        interaction: ix,
      });
    }

    const completedAt = new Date(clock()).toISOString();
    ix.downstream_projection = {
      ...ix.downstream_projection,
      status: 'completed',
      updated_at: completedAt,
      completed_at: completedAt,
      error: null,
      receipt: projectionReceipt(result),
    };
    try {
      await saveInteractionsStrict(items);
    } catch (error) {
      return res.status(503).json({
        error: `interaction outcome projection completed but its receipt was not committed: ${projectionError(error)}`,
        code: 'interaction_outcome_projection_failed',
        retryable: true,
        source_committed: true,
      });
    }
    return res.json({ ok: true, interaction: ix, ...(replayed ? { replayed: true } : {}) });
  }

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
  app.post('/interactions/:id/outcome', requireAuth, async (req, res) => {
    // Work on a copy so a failed strict commit cannot leave a cache-only reviewed source that
    // downstream learning would accept as canonical evidence.
    const items = JSON.parse(JSON.stringify(loadInteractions()));
    const ix = items.find(i => i.id === req.params.id);
    if (!ix) return res.status(404).json({ error: 'interaction not found' });
    const outcome = String(req.body?.outcome || '').trim().toLowerCase();
    const signal = String(req.body?.signal || '').trim().slice(0, 1200);
    if (!REVIEW_OUTCOMES.has(outcome) || signal.length < 10) {
      return res.status(400).json({ error: 'interaction review requires a supported outcome and observable signal' });
    }
    if (ix.reviewed === true) {
      if (ix.outcome === outcome && String(ix.signal || '') === signal) {
        const projection = ix.downstream_projection;
        if (!projection || ['completed', 'not_required'].includes(projection.status)) {
          return res.json({ ok: true, interaction: ix, idempotent: true });
        }
        if (['pending', 'failed'].includes(projection.status) && typeof onOutcome === 'function') {
          return runOutcomeProjection(items, ix, res, { replayed: true, sourceCommitted: true });
        }
        if (['pending', 'failed'].includes(projection.status)) {
          return res.status(503).json({
            error: 'interaction outcome projection handler is unavailable',
            code: 'interaction_outcome_projection_failed',
            retryable: true,
            source_committed: true,
          });
        }
        return res.status(409).json({
          error: 'reviewed interaction has an invalid downstream projection state',
          code: 'interaction_outcome_projection_invalid',
        });
      }
      return res.status(409).json({ error: 'reviewed interaction outcomes are immutable' });
    }
    const reviewedAt = new Date(clock()).toISOString();
    ix.outcome = outcome;
    ix.signal = signal;
    ix.reviewed = true;
    ix.reviewed_at = reviewedAt;
    if (typeof onOutcome === 'function') {
      return runOutcomeProjection(items, ix, res);
    }
    ix.downstream_projection = notRequiredProjection(reviewedAt);
    try {
      await saveInteractionsStrict(items);
    } catch (error) {
      return res.status(503).json({
        error: `interaction outcome was not committed: ${String(error?.message || error).slice(0, 300)}`,
        code: 'interaction_outcome_persistence_failed',
        retryable: true,
        source_committed: false,
      });
    }
    res.json({ ok: true, interaction: ix });
  });

  // ============================================================
}

module.exports = { REVIEW_OUTCOMES, registerInteractionRoutes };
