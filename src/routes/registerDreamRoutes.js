'use strict';

const crypto = require('crypto');
const dreamIdeaSeed = require('../intelligence/dream-idea-seed');
const dreamInsight = require('../intelligence/dream-insight');
const dreamInsightFormation = require('../intelligence/dream-insight-formation');
const { commitment, dreamInsights, insightAudit, validEvidenceRefs } = dreamInsight;

function registerDreamRoutes(app, deps) {
  const { requireAuth, requireEvaluatorAuth = requireAuth, loadDreams, saveDreams,
    listExperiments = () => [], dreamInsightStudyActive = () => false,
    MAX_DREAMS_KEPT, onDream, clock = () => new Date() } = deps;
  const sealed = res => res.status(423).json({
    error: 'dream insight access is sealed during an active blinded synthesis study',
    experimental_access_sealed: true,
  });

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

  // POST /dreams — record a completed dream. The cowork loop calls this at the end of its
  // Dreaming Round with the consolidation stats, reflection results, and a first-person
  // narrative ("what I dreamed about"). Server stamps id + finished if absent.
  app.post('/dreams', requireAuth, (req, res) => {
    if (dreamInsightStudyActive()) return sealed(res);
    const body = req.body || {};
    const now = new Date(clock()).toISOString();
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
    if (dreamInsightStudyActive()) return sealed(res);
    const dreams = loadDreams();
    const idx = dreams.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'dream not found' });
    dreams.splice(idx, 1);
    saveDreams(dreams);
    res.json({ ok: true });
  });
}

module.exports = { registerDreamRoutes };
