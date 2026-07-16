'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validEvidenceRefs(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => ref && typeof ref === 'object'
    && String(ref.type || '').trim() && String(ref.id || ref.url || '').trim());
}

function dreamInsights(dreams) {
  return dreams.flatMap(dream => (Array.isArray(dream.reflection?.insight_candidates)
    ? dream.reflection.insight_candidates : [])
    .map(insight => ({ dream, insight })));
}

function insightAudit(insight, dreams) {
  const formation = insight?.formation_record;
  const sources = Array.isArray(formation?.source_ideas) ? formation.source_ideas : [];
  const sourceDreams = sources.map(source => dreams.find(dream => dream.id === source.dream_id));
  const sourceIdeasVerified = sources.length >= 2 && sourceDreams.every((dream, index) => dream
    && dream.date === sources[index].dream_date
    && dream.reflection?.ideas?.[sources[index].idea_index] === sources[index].idea);
  const sourceDateSeparationVerified = new Set(sources.map(source => source.dream_id)).size === sources.length
    && new Set(sources.map(source => source.dream_date)).size === sources.length;
  const formationCommitmentVerified = Boolean(formation && insight.formation_commitment
    && commitment(formation) === insight.formation_commitment);
  const resolutionPresent = Boolean(insight.resolution_record || insight.resolution_commitment);
  const resolutionVerified = !resolutionPresent || Boolean(insight.resolution_record
    && insight.resolution_commitment
    && insight.resolution_record.formation_commitment === insight.formation_commitment
    && commitment(insight.resolution_record) === insight.resolution_commitment);
  const independentReviewPresent = Boolean(insight.independent_review || insight.independent_review_commitment);
  const independentReviewVerified = !independentReviewPresent || Boolean(insight.independent_review
    && insight.independent_review_commitment
    && insight.independent_review.formation_commitment === insight.formation_commitment
    && insight.independent_review.resolution_commitment === insight.resolution_commitment
    && commitment(insight.independent_review) === insight.independent_review_commitment);
  return {
    formation_commitment_verified: formationCommitmentVerified,
    source_ideas_verified: sourceIdeasVerified,
    source_date_separation_verified: sourceDateSeparationVerified,
    resolution_present: resolutionPresent,
    resolution_verified: resolutionVerified,
    independent_review_present: independentReviewPresent,
    independent_review_verified: independentReviewVerified,
    final_evidence_eligible: ['independently_supported', 'independently_contradicted', 'inconclusive'].includes(insight.status)
      && formationCommitmentVerified && sourceIdeasVerified && sourceDateSeparationVerified
      && resolutionVerified && independentReviewVerified,
    complete_chain_verified: formationCommitmentVerified && sourceIdeasVerified
      && sourceDateSeparationVerified && resolutionVerified && independentReviewVerified,
  };
}

function registerDreamRoutes(app, deps) {
  const { requireAuth, requireEvaluatorAuth = requireAuth, loadDreams, saveDreams, MAX_DREAMS_KEPT, onDream } = deps;

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

  // Repeated dream ideas remain fallible sparks until Nora explicitly binds the exact date-separated
  // source ideas, a usefulness prediction, and a falsifier into one candidate. This records a
  // functional insight lifecycle; it does not certify originality, consciousness, or authorship.
  app.get('/dream-insights', requireAuth, (req, res) => {
    const dreams = loadDreams();
    const status = String(req.query.status || '').trim();
    const allInsights = dreamInsights(dreams)
      .map(({ dream, insight }) => ({ ...insight, anchor_dream_id: dream.id, audit: insightAudit(insight, dreams) }))
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
      },
    });
  });

  app.post('/dream-insights', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const dreams = loadDreams();
      const statement = String(body.statement || '').trim();
      const rationale = String(body.rationale || '').trim();
      const expectedUsefulness = String(body.expected_usefulness || '').trim();
      const nextObservation = String(body.next_observation || '').trim();
      const falsificationCriteria = Array.isArray(body.falsification_criteria)
        ? body.falsification_criteria.map(value => String(value).trim()).filter(Boolean).slice(0, 8) : [];
      const sourceRefs = Array.isArray(body.source_ideas) ? body.source_ideas.slice(0, 8) : [];
      const confidence = Number(body.confidence);
      const scopes = new Set(['project', 'process', 'team']);
      if (statement.length < 20 || rationale.length < 20 || expectedUsefulness.length < 10
        || nextObservation.length < 10 || !falsificationCriteria.length) {
        throw new Error('statement, rationale, expected_usefulness, falsification_criteria, and next_observation are required');
      }
      if (/\b(conscious(?:ness)?|sentien(?:t|ce)|qualia|phenomenal|subjective experience)\b/i.test(statement)) {
        throw new Error('dream insight candidates cannot assert phenomenal status');
      }
      if (!scopes.has(body.scope)) throw new Error('dream insight scope must be project, process, or team');
      if (!Number.isFinite(confidence) || confidence < 0.1 || confidence > 0.7) {
        throw new Error('dream insight confidence must be between 0.1 and 0.7');
      }
      if (sourceRefs.length < 2) throw new Error('dream insights require ideas from at least two date-separated dream records');
      const sourceIdeas = sourceRefs.map(ref => {
        const dream = dreams.find(candidate => candidate.id === ref.dream_id);
        const index = Number(ref.idea_index);
        const idea = Number.isInteger(index) ? dream?.reflection?.ideas?.[index] : null;
        if (!dream || typeof idea !== 'string' || !idea.trim() || idea.length > 1600) throw new Error('each source idea must resolve to an exact bounded stored dream idea');
        return { dream_id: dream.id, dream_date: dream.date, idea_index: index, idea };
      });
      if (new Set(sourceIdeas.map(source => source.dream_id)).size !== sourceIdeas.length
        || new Set(sourceIdeas.map(source => source.dream_date)).size !== sourceIdeas.length) {
        throw new Error('dream insight sources must come from distinct dreams on distinct dates');
      }
      const existing = dreamInsights(dreams).map(({ insight }) => insight);
      if (existing.filter(insight => insight.status === 'candidate').length >= 10) {
        throw new Error('at most ten open dream insight candidates are allowed');
      }
      if (existing.some(insight => insight.status === 'candidate'
        && String(insight.statement).trim().toLowerCase() === statement.toLowerCase())) {
        throw new Error('an open dream insight candidate already has this statement');
      }
      const formedAt = new Date().toISOString();
      const id = body.id || `dream-insight-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
      if (existing.some(insight => insight.id === id)) throw new Error('dream insight id already exists');
      const formationRecord = {
        id, statement: statement.slice(0, 1200), scope: body.scope, confidence,
        rationale: rationale.slice(0, 1600), expected_usefulness: expectedUsefulness.slice(0, 1200),
        falsification_criteria: falsificationCriteria, next_observation: nextObservation.slice(0, 1200),
        source_ideas: sourceIdeas, provenance_claim: 'submitted_as_nora_nightly_reflection', formed_at: formedAt,
      };
      const insight = {
        id, statement: formationRecord.statement, scope: formationRecord.scope, confidence,
        status: 'candidate', formed_at: formedAt, formation_record: formationRecord,
        formation_commitment: commitment(formationRecord), resolution_record: null, resolution_commitment: null,
        independent_review: null, independent_review_commitment: null,
      };
      const anchor = sourceIdeas.map(source => dreams.find(dream => dream.id === source.dream_id))
        .sort((a, b) => new Date(b.finished || b.started || 0) - new Date(a.finished || a.started || 0))[0];
      anchor.reflection = anchor.reflection || {};
      anchor.reflection.insight_candidates = anchor.reflection.insight_candidates || [];
      anchor.reflection.insight_candidates.push(insight);
      saveDreams(dreams);
      res.json({ ok: true, insight: { ...insight, anchor_dream_id: anchor.id, audit: insightAudit(insight, dreams) } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/dream-insights/:id/resolve', requireAuth, (req, res) => {
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
      const resolutionRecord = {
        formation_commitment: found.insight.formation_commitment, outcome: body.outcome,
        observation: String(body.observation).trim().slice(0, 1600), evidence: body.evidence.slice(0, 20),
        confounds: Array.isArray(body.confounds) ? body.confounds.map(String).slice(0, 10) : [],
        resolved_at: new Date().toISOString(),
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
        subject_observation: {
          observation: insight.resolution_record.observation,
          evidence: insight.resolution_record.evidence,
          confounds: insight.resolution_record.confounds,
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
        reviewed_at: new Date().toISOString(),
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
