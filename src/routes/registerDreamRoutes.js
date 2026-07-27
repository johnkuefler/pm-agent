'use strict';

function unavailableEvaluatorAuth(req, res) {
  return res.status(503).json({ error: 'evaluator authentication is not configured' });
}

function unavailableOperatorAuth(req, res) {
  return res.status(503).json({ error: 'operator authentication is not configured' });
}

const crypto = require('crypto');
const dreamIdeaSeed = require('../intelligence/dream-idea-seed');
const dreamInsight = require('../intelligence/dream-insight');
const dreamInsightFormation = require('../intelligence/dream-insight-formation');
const dreamProvenance = require('../intelligence/dream-provenance');
const { commitment, dreamInsights, insightAudit, validEvidenceRefs } = dreamInsight;
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

function notRequiredProjection(at, reason) {
  return {
    protocol_version: PROJECTION_PROTOCOL_VERSION,
    status: 'not_required',
    attempts: 0,
    requested_at: at,
    last_attempt_at: null,
    updated_at: at,
    completed_at: at,
    error: null,
    receipt: { acknowledged: false, reason },
  };
}

function callbackDream(dream) {
  const copy = JSON.parse(JSON.stringify(dream));
  delete copy.downstream_projection;
  return copy;
}

function sameSubmissionContent(existing, candidate) {
  const select = dream => {
    const snapshot = dreamProvenance.submissionSnapshot(dream);
    return {
      consolidation: snapshot.consolidation,
      reflection: snapshot.reflection,
      review: snapshot.review,
      narrative: snapshot.narrative,
    };
  };
  return dreamProvenance.canonicalJson(select(existing))
    === dreamProvenance.canonicalJson(select(candidate));
}

function controlsSubmittedTimestamp(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return false;
  if (key === 'date') {
    const value = String(body[key] || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime());
  }
  return Number.isFinite(new Date(body[key]).getTime());
}

function isExactDreamReplay(existing, candidate, body, { lifecycle, authority }) {
  if (!sameSubmissionContent(existing, candidate)) return false;
  if (lifecycle) {
    return existing.provenance?.origin === 'autonomous_nightly_cycle'
      && dreamProvenance.canonicalJson(existing.provenance?.lifecycle)
        === dreamProvenance.canonicalJson(candidate.provenance?.lifecycle);
  }
  if (existing.provenance?.origin !== 'authorized_manual_import'
    || dreamProvenance.canonicalJson(existing.provenance?.authority)
      !== dreamProvenance.canonicalJson(candidate.provenance?.authority)) return false;
  const existingSnapshot = dreamProvenance.submissionSnapshot(existing);
  const candidateSnapshot = dreamProvenance.submissionSnapshot(candidate);
  return ['date', 'started', 'finished'].every(key =>
    !controlsSubmittedTimestamp(body, key)
    || existingSnapshot[key] === candidateSnapshot[key]);
}

function registerDreamRoutes(app, deps) {
  const { requireAuth, requireOperatorAuth = unavailableOperatorAuth,
    requireEvaluatorAuth = unavailableEvaluatorAuth, loadDreams, saveDreams,
    saveDreamsStrict = async dreams => saveDreams(dreams),
    listExperiments = () => [], dreamInsightStudyActive = () => false,
    resolveAutonomousDreamLifecycle = () => null, authorizeDreamImport = () => null,
    MAX_DREAMS_KEPT, onDream, clock = () => new Date() } = deps;
  const sealed = res => res.status(423).json({
    error: 'dream insight access is sealed during an active blinded synthesis study',
    experimental_access_sealed: true,
  });

  async function runDreamProjection(dreams, dream, res, {
    replayed = false, pendingCommitted = false,
  } = {}) {
    if (!pendingCommitted) {
      const pendingAt = new Date(clock()).toISOString();
      dream.downstream_projection = pendingProjection(dream.downstream_projection, pendingAt);
      try {
        await saveDreamsStrict(dreams);
      } catch (error) {
        return res.status(503).json({
          error: `dream downstream projection was not re-queued: ${projectionError(error)}`,
          code: 'dream_downstream_projection_failed',
          retryable: true,
          source_committed: true,
        });
      }
    }

    let result;
    try {
      const projectedDream = callbackDream(dream);
      result = await onDream(projectedDream, {
        provenance: dreamProvenance.audit(projectedDream),
        projection: {
          idempotency_key: `dream:${dream.id}:v1`,
          attempt: dream.downstream_projection.attempts,
        },
      });
    } catch (error) {
      const failedAt = new Date(clock()).toISOString();
      const callbackFailure = projectionError(error);
      dream.downstream_projection = {
        ...dream.downstream_projection,
        status: 'failed',
        updated_at: failedAt,
        error: callbackFailure,
        receipt: null,
      };
      try {
        await saveDreamsStrict(dreams);
      } catch (persistenceError) {
        return res.status(503).json({
          error: `dream downstream projection failed (${callbackFailure}); retry state was not committed: ${projectionError(persistenceError)}`,
          code: 'dream_downstream_projection_failed',
          retryable: true,
          source_committed: true,
        });
      }
      return res.status(503).json({
        error: `dream downstream projection failed: ${callbackFailure}`,
        code: 'dream_downstream_projection_failed',
        retryable: true,
        source_committed: true,
        dream,
        provenance_audit: dreamProvenance.audit(dream),
        downstream_projection: dream.downstream_projection,
      });
    }

    const completedAt = new Date(clock()).toISOString();
    dream.downstream_projection = {
      ...dream.downstream_projection,
      status: 'completed',
      updated_at: completedAt,
      completed_at: completedAt,
      error: null,
      receipt: projectionReceipt(result),
    };
    try {
      await saveDreamsStrict(dreams);
    } catch (error) {
      return res.status(503).json({
        error: `dream downstream projection completed but its receipt was not committed: ${projectionError(error)}`,
        code: 'dream_downstream_projection_failed',
        retryable: true,
        source_committed: true,
      });
    }
    console.log(`💤 Dream recorded ${dream.date}: ${dream.consolidation.memories_before}→${dream.consolidation.memories_after} memories, +${dream.reflection.takes_added.length} takes, +${dream.review.learnings_added.length} learnings`);
    return res.json({
      ok: true,
      dream,
      provenance_audit: dreamProvenance.audit(dream),
      downstream_projection: dream.downstream_projection,
      ...(replayed ? { replayed: true } : {}),
    });
  }

  // GET /dreams — list dreams, newest first. Returns the full objects (they're small) so the
  // dashboard can render without a second round-trip per dream.
  app.get('/dreams', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const dreams = loadDreams().slice(); // copy before sorting: in DB mode loadDreams() returns the live cache ref
    dreams.sort((a, b) => new Date(b.finished || b.started || 0).getTime() - new Date(a.finished || a.started || 0).getTime());
    res.json(dreams);
  });

  // GET /dreams/:id — a single dream's full detail.
  app.get('/dreams/:id', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const dream = loadDreams().find(d => d.id === req.params.id);
    if (!dream) return res.status(404).json({ error: 'dream not found' });
    res.json(dream);
  });

  // Dream ideas are hypotheses, not established insights. This projection gives each exact stored
  // spark a stable, content-committed reference so Nora may test it without rewriting its origin.
  app.get('/dream-idea-seeds', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const allSeeds = dreamIdeaSeed.list(loadDreams(), listExperiments())
      .sort((a, b) => String(b.dream_date || '').localeCompare(String(a.dream_date || '')) || a.idea_index - b.idea_index);
    const status = req.query.status;
    const seeds = status ? allSeeds.filter(seed => seed.status === status) : allSeeds;
    res.json({
      seeds,
      report: {
        total: allSeeds.length,
        available: allSeeds.filter(seed => seed.status === 'available').length,
        used: allSeeds.filter(seed => seed.status === 'used').length,
        role_retired: allSeeds.filter(seed => seed.status === 'role_retired').length,
        archived: allSeeds.filter(seed => seed.status === 'archived').length,
      },
    });
  });

  // Repeated dream ideas remain fallible sparks until Nora explicitly binds the exact date-separated
  // source ideas, a usefulness prediction, and a falsifier into one candidate. This records a
  // functional insight lifecycle; it does not certify originality, consciousness, or authorship.
  app.get('/dream-insights', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const dreams = loadDreams();
    const status = String(req.query.status || '').trim();
    const allInsights = dreamInsights(dreams)
      .map(({ dream, insight }) => ({ ...insight, anchor_dream_id: dream.id,
        resolution_eligibility: dreamInsight.resolutionEligibility(insight, clock()),
        audit: insightAudit(insight, dreams) }))
      .sort((a, b) => String(b.formed_at).localeCompare(String(a.formed_at)));
    const insights = allInsights.filter(insight => !status || insight.status === status);
    res.json({
      epistemic_status: 'Date-separated, source-bound work ideas with passive outcome tests and independent review. Dream records preserve claimed reflection provenance but do not prove independent generation, model authorship, originality, or phenomenal consciousness.',
      insights,
      report: {
        total: allInsights.length,
        filtered_total: insights.length,
        candidates: allInsights.filter(insight => insight.status === 'candidate').length,
        awaiting_independent_review: allInsights.filter(insight => insight.status === 'awaiting_independent_review').length,
        independently_supported: allInsights.filter(insight => insight.status === 'independently_supported').length,
        independently_contradicted: allInsights.filter(insight => insight.status === 'independently_contradicted').length,
        inconclusive: allInsights.filter(insight => insight.status === 'inconclusive').length,
        retired: allInsights.filter(insight => insight.status === 'retired').length,
        integrity_valid: allInsights.filter(insight => insight.audit.complete_chain_verified).length,
        final_evidence_eligible: allInsights.filter(insight => insight.audit.final_evidence_eligible).length,
        prospectively_windowed: allInsights.filter(insight => insight.audit.observation_plan_present).length,
        window_eligible_candidates: allInsights.filter(insight => insight.status === 'candidate'
          && insight.resolution_eligibility.eligible).length,
        legacy_unbounded: allInsights.filter(insight => insight.audit.observation_protocol === 'legacy_unbounded').length,
        role_retired: allInsights.filter(insight => !insight.audit.role_eligibility?.eligible).length,
      },
    });
  });

  app.post('/dream-insights', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    try {
      const dreams = loadDreams();
      const { insight, anchor } = dreamInsightFormation.createCandidate({
        dreams, input: req.body || {}, now: clock(),
      });
      saveDreams(dreams);
      res.json({ ok: true, insight: { ...insight, anchor_dream_id: anchor.id, audit: insightAudit(insight, dreams) } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/dream-insights/:id/resolve', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    try {
      const dreams = loadDreams();
      const found = dreamInsights(dreams).find(({ insight }) => insight.id === req.params.id);
      if (!found) return res.status(404).json({ error: 'dream insight not found' });
      if (found.insight.status !== 'candidate') throw new Error('dream insight is already resolved');
      const formationAudit = insightAudit(found.insight, dreams);
      if (!formationAudit.formation_commitment_verified || !formationAudit.source_ideas_verified
        || !formationAudit.source_date_separation_verified) throw new Error('dream insight formation no longer verifies');
      const body = req.body || {};
      const outcomes = new Set(['supported', 'contradicted', 'unclear', 'retired']);
      if (!outcomes.has(body.outcome) || String(body.observation || '').trim().length < 10
        || !validEvidenceRefs(body.evidence)) {
        throw new Error('outcome, observation, and stable evidence are required');
      }
      const now = clock();
      const eligibility = dreamInsight.resolutionEligibility(found.insight, now, body.outcome);
      if (!eligibility.eligible) {
        throw new Error(`dream insight resolution is not eligible: ${eligibility.reason}${eligibility.resolve_not_before
          ? ` until ${eligibility.resolve_not_before}` : ''}`);
      }
      const observationPlan = found.insight.formation_record?.observation_plan || null;
      const opportunitiesObserved = Number(body.opportunities_observed);
      if (observationPlan && body.outcome !== 'retired') {
        if (!Number.isInteger(opportunitiesObserved) || opportunitiesObserved < 0
          || opportunitiesObserved > 10000) {
          throw new Error('prospective dream insight resolution requires integer opportunities_observed');
        }
        if (['supported', 'contradicted'].includes(body.outcome)
          && opportunitiesObserved < observationPlan.minimum_opportunities) {
          throw new Error(`supported or contradicted resolution requires at least ${observationPlan.minimum_opportunities} observed opportunities`);
        }
      }
      const resolutionRecord = {
        formation_commitment: found.insight.formation_commitment, outcome: body.outcome,
        observation: String(body.observation).trim().slice(0, 1600), evidence: body.evidence.slice(0, 20),
        confounds: Array.isArray(body.confounds) ? body.confounds.map(String).slice(0, 10) : [],
        ...(observationPlan ? {
          observation_plan_commitment: commitment(observationPlan),
          ...((body.outcome !== 'retired' || Number.isInteger(opportunitiesObserved))
            ? { opportunities_observed: opportunitiesObserved } : {}),
        } : {}),
        resolved_at: new Date(now).toISOString(),
      };
      found.insight.status = body.outcome === 'retired' ? 'retired' : 'awaiting_independent_review';
      found.insight.resolution_record = resolutionRecord;
      found.insight.resolution_commitment = commitment(resolutionRecord);
      saveDreams(dreams);
      res.json({ ok: true, insight: { ...found.insight, anchor_dream_id: found.dream.id,
        audit: insightAudit(found.insight, dreams) } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/dream-insights/review-queue', requireEvaluatorAuth, (req, res) => {
    const dreams = loadDreams();
    const insights = dreamInsights(dreams)
      .filter(({ insight }) => insight.status === 'awaiting_independent_review'
        && insightAudit(insight, dreams).complete_chain_verified)
      .map(({ insight }) => ({
        id: insight.id, statement: insight.statement, scope: insight.scope,
        expected_usefulness: insight.formation_record.expected_usefulness,
        falsification_criteria: insight.formation_record.falsification_criteria,
        next_observation: insight.formation_record.next_observation,
        observation_plan: insight.formation_record.observation_plan || null,
        subject_observation: {
          observation: insight.resolution_record.observation,
          evidence: insight.resolution_record.evidence,
          confounds: insight.resolution_record.confounds,
          opportunities_observed: insight.resolution_record.opportunities_observed ?? null,
          resolved_at: insight.resolution_record.resolved_at,
        },
        formation_commitment: insight.formation_commitment,
        resolution_commitment: insight.resolution_commitment,
      }));
    res.json({ evaluator_id: req.evaluatorId, insights });
  });

  app.post('/dream-insights/:id/review', requireEvaluatorAuth, (req, res) => {
    try {
      const dreams = loadDreams();
      const found = dreamInsights(dreams).find(({ insight }) => insight.id === req.params.id);
      if (!found) return res.status(404).json({ error: 'dream insight not found' });
      if (found.insight.status !== 'awaiting_independent_review') throw new Error('dream insight is not awaiting independent review');
      const audit = insightAudit(found.insight, dreams);
      if (!audit.complete_chain_verified || !audit.resolution_present) throw new Error('dream insight lifecycle no longer verifies');
      const body = req.body || {};
      if (!['supported', 'contradicted', 'unclear'].includes(body.outcome)
        || String(body.rationale || '').trim().length < 10 || !validEvidenceRefs(body.evidence)) {
        throw new Error('outcome, rationale, and independently checked evidence are required');
      }
      const review = {
        formation_commitment: found.insight.formation_commitment,
        resolution_commitment: found.insight.resolution_commitment,
        evaluator_id: req.evaluatorId, outcome: body.outcome,
        subject_outcome: found.insight.resolution_record.outcome,
        subject_agreement: body.outcome === found.insight.resolution_record.outcome,
        rationale: String(body.rationale).trim().slice(0, 1600), evidence: body.evidence.slice(0, 20),
        reviewed_at: new Date(clock()).toISOString(),
      };
      found.insight.independent_review = review;
      found.insight.independent_review_commitment = commitment(review);
      found.insight.status = body.outcome === 'supported' ? 'independently_supported'
        : body.outcome === 'contradicted' ? 'independently_contradicted' : 'inconclusive';
      saveDreams(dreams);
      res.json({ ok: true, insight: { ...found.insight, anchor_dream_id: found.dream.id,
        audit: insightAudit(found.insight, dreams) } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  // Autonomous callers prove possession of the current run-lock fencing capability. Raw imports
  // require separately verified operator or research authority. Caller-supplied lifecycle and
  // provenance objects are never trusted or copied.
  app.post('/dreams', requireAuth, async (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    try {
      const body = req.body || {};
      const now = new Date(clock());
      const manualRequested = body.import_mode === 'manual';
      const lifecycle = manualRequested ? null : resolveAutonomousDreamLifecycle(req);
      const authority = lifecycle ? null : authorizeDreamImport(req);
      if (!lifecycle && !authority) {
        return res.status(403).json({
          error: 'dream creation requires the current operational run receipt or signed operator/research authority',
          code: 'dream_provenance_required',
        });
      }

      const requestedId = String(body.id || '').trim();
      const safeRequestedId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(requestedId)
        ? requestedId : null;
      // Build against a detached snapshot so a failed strict commit cannot leak a cache-only
      // dream into canonical evidence or downstream self-improvement.
      const dreams = JSON.parse(JSON.stringify(loadDreams()));
      const existing = authority && safeRequestedId
        ? dreams.find(item => item.id === safeRequestedId)
        : lifecycle ? dreams.find(item =>
          item.provenance?.origin === 'autonomous_nightly_cycle'
          && item.provenance?.lifecycle?.cycle_id === String(lifecycle.cycle_id || '').trim()
          && item.provenance?.lifecycle?.moment_id === String(lifecycle.moment_id || '').trim())
          : null;
      const id = existing?.id || (authority && safeRequestedId
        ? safeRequestedId
        : `dream-${now.getTime()}-${crypto.randomBytes(2).toString('hex')}`);

      const dream = dreamProvenance.normalizeDreamInput(body, {
        id, now, autonomous: Boolean(lifecycle), lifecycle,
      });
      if (lifecycle) dreamProvenance.stampAutonomous(dream, lifecycle, now);
      else dreamProvenance.stampAuthorizedImport(dream, authority, now);

      if (existing) {
        // Legacy duplicate IDs retain the historical conflict contract. Records written by this
        // state machine can be replayed only when provenance identity and submitted content match.
        if (!existing.downstream_projection
          || !isExactDreamReplay(existing, dream, body, { lifecycle, authority })) {
          return res.status(409).json({ error: 'dream id already exists', code: 'dream_id_conflict' });
        }
        const projection = existing.downstream_projection;
        if (['completed', 'not_required'].includes(projection.status)) {
          return res.json({
            ok: true,
            dream: existing,
            provenance_audit: dreamProvenance.audit(existing),
            downstream_projection: projection,
            idempotent: true,
          });
        }
        if (!['pending', 'failed'].includes(projection.status)) {
          return res.status(409).json({
            error: 'dream has an invalid downstream projection state',
            code: 'dream_downstream_projection_invalid',
          });
        }
        if (dreamProvenance.isArchived(existing)) {
          return res.status(409).json({
            error: 'an archived dream downstream projection cannot be rewritten',
            code: 'dream_projection_archived',
          });
        }
        if (typeof onDream !== 'function') {
          return res.status(503).json({
            error: 'dream downstream projection handler is unavailable',
            code: 'dream_downstream_projection_failed',
            retryable: true,
            source_committed: true,
          });
        }
        return runDreamProjection(dreams, existing, res, { replayed: true });
      }
      if (dreams.some(item => item.id === id)) {
        return res.status(409).json({ error: 'dream id already exists', code: 'dream_id_conflict' });
      }
      dreams.push(dream);
      dreams.sort((a, b) =>
        new Date(b.finished || b.started || 0).getTime()
        - new Date(a.finished || a.started || 0).getTime());

      // Bound the active window without erasing records that can anchor later provenance.
      const maxActive = Math.max(1, Number(MAX_DREAMS_KEPT) || 120);
      const active = dreams.filter(item => !dreamProvenance.isArchived(item));
      const shouldProject = typeof onDream === 'function'
        && active.slice(0, maxActive).includes(dream);
      const queuedAt = now.toISOString();
      dream.downstream_projection = shouldProject
        ? pendingProjection(null, queuedAt)
        : notRequiredProjection(queuedAt,
          typeof onDream === 'function' ? 'archived_by_retention' : 'no_projection_handler');
      for (const old of active.slice(maxActive)) {
        dreamProvenance.archive(old, {
          reason: `Automatic provenance-preserving archival after the ${maxActive}-dream active window was exceeded.`,
          actor: 'server-retention',
          now,
        });
      }

      try {
        await saveDreamsStrict(dreams);
      } catch (error) {
        return res.status(503).json({
          error: `dream was not durably committed: ${String(error?.message || error).slice(0, 300)}`,
          code: 'dream_persistence_failed',
          retryable: true,
          source_committed: false,
        });
      }
      if (shouldProject) {
        return runDreamProjection(dreams, dream, res, { pendingCommitted: true });
      }
      console.log(`💤 Dream recorded ${dream.date}: ${dream.consolidation.memories_before}→${dream.consolidation.memories_after} memories, +${dream.reflection.takes_added.length} takes, +${dream.review.learnings_added.length} learnings`);
      return res.json({ ok: true, dream, provenance_audit: dreamProvenance.audit(dream),
        downstream_projection: dream.downstream_projection });
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'dream_rejected' });
    }
  });

  // DELETE remains as a compatibility verb, but it now performs operator-only archival.
  app.delete('/dreams/:id', requireAuth, requireOperatorAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const dreams = loadDreams();
    const dream = dreams.find(item => item.id === req.params.id);
    if (!dream) return res.status(404).json({ error: 'dream not found' });
    try {
      const event = dreamProvenance.archive(dream, {
        reason: req.body?.reason,
        actor: req.operatorAuthority || 'signed-operator',
        now: clock(),
      });
      saveDreams(dreams);
      return res.json({ ok: true, archived: true, dream, archive_event: event,
        archive_audit: dreamProvenance.archiveHistoryAudit(dream) });
    } catch (error) {
      return res.status(409).json({ error: error.message, code: 'dream_archive_rejected' });
    }
  });

  app.post('/dreams/:id/restore', requireAuth, requireOperatorAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const dreams = loadDreams();
    const dream = dreams.find(item => item.id === req.params.id);
    if (!dream) return res.status(404).json({ error: 'dream not found' });
    try {
      const event = dreamProvenance.restore(dream, {
        reason: req.body?.reason,
        actor: req.operatorAuthority || 'signed-operator',
        now: clock(),
      });
      saveDreams(dreams);
      return res.json({ ok: true, restored: true, dream, archive_event: event,
        archive_audit: dreamProvenance.archiveHistoryAudit(dream) });
    } catch (error) {
      return res.status(409).json({ error: error.message, code: 'dream_restore_rejected' });
    }
  });
}

module.exports = { registerDreamRoutes };
