'use strict';

const dreamIdeaSeed = require('../intelligence/dream-idea-seed');
const expectationForecast = require('../intelligence/expectation-forecast');
const consequenceReview = require('../intelligence/consequence-review');
const { createResearchProjectionCache } = require('../intelligence/research-status-cache');

function validateDueConsequenceReviews({ cycleId, store, ledger, now = new Date() }) {
  const cycle = store.list('cycles').find(item => item.id === cycleId);
  if (!cycle?.run_lock_holder) return { required: false, valid: true, due_action_ids: [] };
  const due = consequenceReview.dueActions(ledger, { now, status: 'open', limit: 200 });
  if (due.length) {
    const ids = due.map(item => item.id);
    const error = new Error(`resolve or honestly reschedule due consequence reviews before closing this hourly cycle: ${ids.join(', ')}`);
    error.code = 'due_consequence_reviews_required';
    error.due_action_ids = ids;
    throw error;
  }
  return { required: true, valid: true, due_action_ids: [] };
}

function registerIntelligenceRoutes(app, { requireAuth, requireResearchAuth = requireAuth, requireEvaluatorAuth = requireAuth, store, readingLibrary = null, activityStream = null, getDreams = () => [], getWants = () => [], getPredictions = () => [], getCognitiveInputs = () => ({}), getConsequenceReviews = () => consequenceReview.emptyLedger(), recordLifecycleWorkspace = async () => null, validateLifecycleWorkspaceOutcome = () => ({ required: false, valid: true }), recordLifecycleWorkspaceOutcome = async () => null, getCognitivePulseRuntimeStatus = () => null, getResearchAutopilotStatus = () => null, shouldDeferResearchStatusRefresh = () => false, loadResearchProjection = async () => null, saveResearchProjection = async () => {}, runSelfInquirySelectionSubject = null, runSelfInductionSubject = null, runCognitiveInitiationStudySubject = null, runCognitiveInitiationPolicyProbe = null }) {
  const snapshotCache = new Map();
  const projectionCacheOptions = { store, getDreams, getWants, getPredictions,
    shouldDeferRefresh: shouldDeferResearchStatusRefresh };
  const researchStatusCache = createResearchProjectionCache({ ...projectionCacheOptions,
    projection: 'research_status',
    loadPersisted: () => loadResearchProjection('research_status'),
    savePersisted: envelope => saveResearchProjection('research_status', envelope) });
  const selfModelCache = createResearchProjectionCache({ ...projectionCacheOptions,
    projection: 'self_model',
    loadPersisted: () => loadResearchProjection('self_model'),
    savePersisted: envelope => saveResearchProjection('self_model', envelope) });
  const cognitionCache = createResearchProjectionCache({ ...projectionCacheOptions,
    projection: 'cognition',
    loadPersisted: () => loadResearchProjection('cognition'),
    savePersisted: envelope => saveResearchProjection('cognition', envelope) });
  function progressHourlyCycle(cycleId, update) {
    if (!activityStream) return;
    const cycle = store.list('cycles').find(item => item.id === cycleId);
    if (!cycle?.run_lock_holder) return;
    activityStream.progress(`hourly:${cycle.run_lock_holder}`, update);
  }
  function projectionHeaders(res, snapshot) {
    res.set('X-Nora-Snapshot-Cache', snapshot.cache_state);
    res.set('X-Nora-Snapshot-Revision', String(snapshot.revision));
    res.set('X-Nora-Snapshot-Stale', snapshot.stale ? '1' : '0');
    res.set('X-Nora-Snapshot-Age-Ms', String(Math.max(0, Date.now() - snapshot.completed_at_ms)));
    res.set('X-Nora-Compute-Isolation', snapshot.isolation || 'unknown');
    if (snapshot.priority != null) res.set('X-Nora-Compute-Priority', String(snapshot.priority));
    if (snapshot.cpu_budget?.mode) res.set('X-Nora-Compute-CPU-Budget', snapshot.cpu_budget.mode);
    res.set('Server-Timing', `capture;dur=${Number(snapshot.capture_ms || 0).toFixed(1)}, projection-worker;dur=${Number(snapshot.compute_ms || 0).toFixed(1)}`);
    res.set('Cache-Control', 'private, no-store');
  }
  function cachedJson(res, key, build, { ttlMs = 15000, project = value => value } = {}) {
    const revision = typeof store.snapshotRevision === 'function' ? store.snapshotRevision() : null;
    const now = Date.now();
    const cached = snapshotCache.get(key);
    if (cached && cached.revision === revision && cached.expires_at > now) {
      res.set('X-Nora-Snapshot-Cache', 'hit');
      res.set('Cache-Control', 'private, no-store');
      return res.type('application/json').send(cached.serialized);
    }
    const started = process.hrtime.bigint();
    const value = project(build());
    const serialized = JSON.stringify(value);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    snapshotCache.set(key, { revision, expires_at: now + ttlMs, serialized });
    res.set('X-Nora-Snapshot-Cache', 'miss');
    res.set('Server-Timing', `snapshot;dur=${durationMs.toFixed(1)}`);
    res.set('Cache-Control', 'private, no-store');
    return res.type('application/json').send(serialized);
  }

  app.get('/intelligence/dashboard-summary', requireAuth, (_req, res) => {
    cachedJson(res, 'dashboard-summary', () => store.dashboardIntelligenceSummary(), { ttlMs: 5000 });
  });

  app.get('/intelligence/persistence-runtime', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(store.persistenceDiagnostics());
  });

  app.get('/intelligence/research-projection-runtime', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({
      research_status: researchStatusCache.status(),
      self_model: selfModelCache.status(),
      cognition: cognitionCache.status(),
    });
  });

  app.get('/intelligence', requireAuth, (req, res) => {
    const overview = store.dashboardIntelligenceSummary().overview;
    res.json({ ...overview, initiative: overview.initiative });
  });

  app.get('/commitments', requireAuth, (req, res) => {
    const status = req.query.status;
    res.json(store.list('commitments', item => !status || item.status === status).sort((a, b) => b.updated.localeCompare(a.updated)));
  });
  app.post('/commitments', requireAuth, (req, res) => {
    try { res.json({ ok: true, commitment: store.addCommitment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.put('/commitments/:id', requireAuth, (req, res) => {
    const commitment = store.updateCommitment(req.params.id, req.body || {});
    if (!commitment) return res.status(404).json({ error: 'commitment not found' });
    res.json({ ok: true, commitment });
  });
  app.patch('/commitments/:id/:status', requireAuth, (req, res) => {
    if (!['fulfilled', 'renegotiated', 'dropped', 'open'].includes(req.params.status)) return res.status(400).json({ error: 'invalid status' });
    const changes = { ...(req.body || {}), status: req.params.status };
    const commitment = store.updateCommitment(req.params.id, changes);
    if (!commitment) return res.status(404).json({ error: 'commitment not found' });
    res.json({ ok: true, commitment });
  });
  app.post('/commitments/:id/source-attestation', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, attestation: store.attestCommitmentSourceFromReadback(req.params.id, req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/episodes', requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(store.list('episodes').sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit));
  });
  app.get('/episodes/:id', requireAuth, (req, res) => {
    const episode = store.get('episodes', req.params.id);
    if (!episode) return res.status(404).json({ error: 'episode not found' });
    res.json(episode);
  });
  app.post('/episodes/events', requireAuth, (req, res) => {
    res.json({ ok: true, episode: store.recordEpisodeEvent(req.body || {}) });
  });

  const teammatePerspectiveSealed = res => res.status(423).json({
    error: 'teammate perspective access is sealed during an active blinded person-binding study',
    experimental_access_sealed: true,
  });
  app.get('/relationships', requireAuth, (req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    res.json(store.list('relationships').sort((a, b) => a.name.localeCompare(b.name)));
  });
  app.post('/relationships/observe', requireAuth, (req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    try { res.json({ ok: true, relationship: store.observeRelationship(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/decision-traces', requireAuth, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const reviewed = req.query.reviewed;
    const since = req.query.since ? new Date(req.query.since).getTime() : null;
    res.json(store.list('traces', item => {
      if (reviewed === 'true' && !item.reviewed_at) return false;
      if (reviewed === 'false' && item.reviewed_at) return false;
      if (since && new Date(item.at).getTime() < since) return false;
      return true;
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
  });
  app.post('/relationships/:name/perspectives', requireAuth, (req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    try { res.json({ ok: true, perspective: store.observePerspective({ ...(req.body || {}), name: req.params.name }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.patch('/relationships/perspectives/:id', requireAuth, (req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    try {
      const perspective = store.updatePerspective(req.params.id, req.body || {});
      if (!perspective) return res.status(404).json({ error: 'perspective not found' });
      res.json({ ok: true, perspective });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/relationships/perspectives/:id/resolve', requireAuth, (req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    try {
      const perspective = store.resolvePerspective(req.params.id, req.body || {});
      if (!perspective) return res.status(404).json({ error: 'perspective not found' });
      res.json({ ok: true, perspective });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/relationships/perspectives/review-queue', requireEvaluatorAuth, (req, res) => {
    res.json({ evaluator_id: req.evaluatorId, perspectives: store.perspectiveReviewQueue() });
  });
  app.post('/relationships/perspectives/:id/review', requireEvaluatorAuth, (req, res) => {
    try {
      const perspective = store.reviewPerspective(req.params.id, req.body || {}, req.evaluatorId);
      if (!perspective) return res.status(404).json({ error: 'perspective not found' });
      res.json({ ok: true, perspective });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/teammate-perspective-models', requireAuth, (_req, res) => {
    if (store.teammatePerspectiveStudyActive()) return teammatePerspectiveSealed(res);
    res.json(store.teammatePerspectiveModelsSnapshot());
  });
  app.post('/decision-traces/:id/outcome', requireAuth, (req, res) => {
    const trace = store.updateTraceOutcome(req.params.id, req.body || {});
    if (!trace) return res.status(404).json({ error: 'decision trace not found' });
    res.json({ ok: true, trace });
  });

  app.get('/learning-experiments', requireAuth, (req, res) => res.json(store.list('experiments')
    .map(experiment => ({ ...experiment, source_audits: (experiment.source_refs || [])
      .filter(ref => ref?.type === 'dream_idea').map(ref => dreamIdeaSeed.audit(ref, getDreams())) }))
    .sort((a, b) => b.started.localeCompare(a.started))));
  app.post('/learning-experiments', requireAuth, (req, res) => {
    try { res.json({ ok: true, experiment: store.createExperiment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/learning-experiments/choose', requireAuth, (req, res) => {
    try {
      const input = { ...(req.body || {}) };
      input.source_refs = Array.isArray(input.source_refs) ? input.source_refs.map(ref => (
        ref?.type === 'dream_idea' ? dreamIdeaSeed.resolve(ref, getDreams()) : ref
      )) : input.source_refs;
      const retiredSource = (input.source_refs || []).find(ref => ref?.type === 'dream_idea'
        && !dreamIdeaSeed.roleEligibility(ref).eligible);
      if (retiredSource) throw new Error('retired-role dream ideas cannot seed new learning experiments');
      res.json({ ok: true, experiment: store.chooseExperiment(input) });
    }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/learning-experiments/:id/sample', requireAuth, (req, res) => {
    const experiments = store.recordExperimentSample({ ...(req.body || {}), experiment_id: req.params.id });
    if (!experiments.length) return res.status(404).json({ error: 'experiment not found' });
    res.json({ ok: true, experiment: experiments[0] });
  });
  app.post('/learning-experiments/:id/evaluate', requireAuth, (req, res) => {
    const experiment = store.evaluateExperiment(req.params.id, req.body || {});
    if (!experiment) return res.status(404).json({ error: 'experiment not found' });
    res.json({ ok: true, experiment });
  });

  app.get('/procedures', requireAuth, (req, res) => {
    try {
      const snapshot = store.procedureStatsSnapshot({ includeRecords: true });
      if (req.query.status) snapshot.procedures = snapshot.procedures.filter(item => item.status === req.query.status);
      res.json(snapshot);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/procedures/stats', requireAuth, (_req, res) => {
    try { res.json(store.procedureStatsSnapshot({ includeRecords: false })); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/procedures', requireAuth, async (req, res) => {
    let procedure = null;
    try {
      procedure = store.createProcedure(req.body || {});
      await store.persistStrict();
      res.json({ ok: true, procedure });
    } catch (error) { res.status(procedure ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/procedures/:id/activate', requireResearchAuth, async (req, res) => {
    let procedure = null;
    try {
      procedure = store.changeProcedureStatus(req.params.id, 'active', { ...(req.body || {}), actor: 'human' });
      if (!procedure) return res.status(404).json({ error: 'procedure not found' });
      await store.persistStrict();
      res.json({ ok: true, procedure });
    } catch (error) { res.status(procedure ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/procedures/:id/retire', requireResearchAuth, async (req, res) => {
    let procedure = null;
    try {
      procedure = store.changeProcedureStatus(req.params.id, 'retired', { ...(req.body || {}), actor: 'human' });
      if (!procedure) return res.status(404).json({ error: 'procedure not found' });
      await store.persistStrict();
      res.json({ ok: true, procedure });
    } catch (error) { res.status(procedure ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/procedures/selection-pass', requireAuth, async (req, res) => {
    let result = null;
    try {
      result = store.runProcedureSelectionPass(req.body || {});
      await store.persistStrict();
      res.json({ ok: true, ...result });
    } catch (error) { res.status(result ? 503 : 400).json({ error: error.message }); }
  });

  app.get('/exemplars', requireAuth, (req, res) => {
    try {
      const snapshot = store.exemplarStatsSnapshot({ includeRecords: true });
      if (req.query.status) snapshot.exemplars = snapshot.exemplars.filter(item => item.status === req.query.status);
      if (req.query.valence) snapshot.exemplars = snapshot.exemplars.filter(item => item.valence === req.query.valence);
      res.json(snapshot);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/exemplars/stats', requireAuth, (_req, res) => {
    try { res.json(store.exemplarStatsSnapshot({ includeRecords: false })); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/exemplars', requireAuth, async (req, res) => {
    let exemplar = null;
    try {
      exemplar = store.createExemplar(req.body || {});
      await store.persistStrict();
      res.json({ ok: true, exemplar });
    } catch (error) { res.status(exemplar ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/exemplars/:id/retire', requireResearchAuth, async (req, res) => {
    let exemplar = null;
    try {
      exemplar = store.retireExemplar(req.params.id, { ...(req.body || {}), actor: 'human' });
      if (!exemplar) return res.status(404).json({ error: 'exemplar not found' });
      await store.persistStrict();
      res.json({ ok: true, exemplar });
    } catch (error) { res.status(exemplar ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/exemplars/selection-pass', requireAuth, async (req, res) => {
    let result = null;
    try {
      result = store.runExemplarSelectionPass(req.body || {});
      await store.persistStrict();
      res.json({ ok: true, ...result });
    } catch (error) { res.status(result ? 503 : 400).json({ error: error.message }); }
  });

  app.get('/developmental-reading', requireAuth, (req, res) => {
    const sessionLimit = Math.max(1, Math.min(20, Number(req.query?.limit) || 8));
    try { res.json(store.developmentalReadingSnapshot({ sessionLimit })); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/developmental-reading/sources', requireAuth, async (req, res) => {
    if (!readingLibrary) return res.status(503).json({ error: 'developmental reading library is unavailable' });
    let contentManifest = null;
    try {
      const { content, ...metadata } = req.body || {};
      contentManifest = await readingLibrary.ingest(content);
      const { created: _created, ...committedManifest } = contentManifest;
      const source = store.registerReadingSource({ ...metadata, ...committedManifest });
      res.json({ ok: true, source: { id: source.id, title: source.title, author: source.author,
        source_kind: source.source_kind, rights_basis: source.rights_basis,
        content_chars: source.content_chars, chunk_count: source.chunk_commitments.length,
        content_manifest_commitment: source.content_manifest_commitment } });
    } catch (error) {
      if (contentManifest?.created) {
        try { await readingLibrary.discard(contentManifest); }
        catch (cleanupError) { console.warn('reading source admission cleanup failed:', cleanupError.message); }
      }
      res.status(400).json({ error: error.message });
    }
  });
  app.post('/developmental-reading/sessions', requireAuth, (req, res) => {
    try {
      const session = store.startReadingSession(req.body?.source_id, req.body || {});
      res.json({ ok: true, session });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/playroom', requireAuth, (_req, res) => {
    try { res.json(store.playroomSnapshot()); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/initiative-budgets/:scope', requireAuth, (req, res) => res.json(store.initiativeStatus(req.params.scope)));
  app.put('/initiative-budgets/:scope', requireAuth, (req, res) => {
    res.json({ ok: true, budget: store.setInitiativeBudget(req.params.scope, req.body?.daily_limit) });
  });
  app.post('/initiative-budgets/:scope/spend', requireAuth, (req, res) => {
    const budget = store.spendInitiative(req.params.scope, req.body || {});
    if (!budget.allowed) return res.status(409).json({ error: 'initiative budget exhausted', budget });
    res.json({ ok: true, budget });
  });

  app.get('/intelligence/orient', requireAuth, (req, res) => {
    res.json(store.orient({ now: req.query.now }));
  });
  app.get('/intelligence/cycles', requireAuth, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const cycles = store.list('cycles').sort((a, b) => b.started.localeCompare(a.started)).slice(0, limit);
    if (store.interventionActive('recurrent_feedback')) {
      for (const cycle of cycles) {
        delete cycle.recurrence_trial_id;
        delete cycle.recurrence_assignment_id;
        delete cycle.reentry_rounds;
        cycle.experimental_access_sealed = true;
      }
    }
    if (store.interventionActive('integrated_self_binding')) {
      for (const cycle of cycles) {
        for (const field of ['orientation', 'recommendations', 'actions', 'summary', 'experience_moment_id']) delete cycle[field];
        cycle.experimental_access_sealed = true;
      }
    }
    if (store.interventionActive('global_broadcast')) {
      for (const cycle of cycles) {
        delete cycle.orientation;
        delete cycle.recommendations;
        cycle.experimental_access_sealed = true;
      }
    }
    if (store.interventionActive('cognitive_pulse_access')) {
      for (const cycle of cycles) {
        delete cycle.orientation;
        delete cycle.recommendations;
        cycle.experimental_access_sealed = true;
      }
    }
    res.json(cycles);
  });
  app.get('/experience-stream', requireAuth, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    cachedJson(res, `experience-stream:${limit}`, () => store.experienceStreamSnapshot({ limit }), { ttlMs: 15000 });
  });
  app.get('/continuity-handoffs', requireAuth, (req, res) => {
    cachedJson(res, `continuity-handoffs:${req.query.summary === '1' ? 'summary' : 'full'}`, () => store.continuityHandoffSnapshot(), {
      ttlMs: 15000,
      project: value => req.query.summary === '1'
        ? { epistemic_status: value.epistemic_status, report: value.report }
        : value,
    });
  });
  app.post('/intelligence/cycles', requireAuth, async (req, res) => {
    const startedAt = process.hrtime.bigint();
    try {
      const authoritativeInputs = getCognitiveInputs();
      const cognitiveInput = { ...authoritativeInputs, ...(req.body || {}),
        inner_thread: authoritativeInputs.inner_thread || null,
        soma: authoritativeInputs.soma || null, wants: authoritativeInputs.wants || [], predictions: getPredictions(),
        resume_active: true };
      const started = await store.openOrResumeCycle(cognitiveInput);
      void recordLifecycleWorkspace({ phase: 'orientation', cycle: started.cycle,
        moment: started.moment }).catch(error => console.error('Lifecycle workspace orientation failed:', error.message));
      progressHourlyCycle(started.cycle.id, {
        label: 'Planning the run',
        detail: 'Committing a testable forecast before operational work begins.',
        meta: { phase: 'forecast' },
      });
      const visibleStarted = JSON.parse(JSON.stringify(started));
      delete visibleStarted.moment.start_snapshot;
      delete visibleStarted.moment.closure_snapshot;
      if (store.interventionActive('appraisal_access') || store.interventionActive('higher_order_monitor')) delete visibleStarted.moment.appraisal_at_start;
      if (store.interventionActive('workspace_capacity') || store.interventionActive('attention_schema_control') || store.interventionActive('global_broadcast') || store.interventionActive('cognitive_pulse_access')) {
        visibleStarted.moment.attention = { experimental_access_sealed: true };
        visibleStarted.moment.attention_rounds = [];
      }
      if (store.interventionActive('global_broadcast')) {
        delete visibleStarted.moment.intentions;
        delete visibleStarted.cycle.orientation;
        delete visibleStarted.cycle.recommendations;
        delete visibleStarted.orientation;
      }
      if (store.interventionActive('integrated_self_binding')) {
        for (const field of ['inherited_context', 'attention', 'attention_rounds', 'appraisal_at_start', 'drives_at_start', 'intentions']) delete visibleStarted.moment[field];
        visibleStarted.moment.experimental_access_sealed = true;
        for (const field of ['orientation', 'recommendations']) delete visibleStarted.cycle[field];
        delete visibleStarted.orientation;
      }
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      res.set('Server-Timing', `cycle-open;dur=${durationMs.toFixed(1)}`);
      res.set('X-Nora-Persistence-Mode', store.persistenceDiagnostics().foreground_serialization);
      res.json({ ok: true, ...visibleStarted });
    } catch (error) { res.status(error.code === 'INTELLIGENCE_PERSISTENCE_FAILED' ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/intelligence/cycles/:id/reenter', requireAuth, async (req, res) => {
    try {
      const result = await store.reenterCycleDurable(req.params.id, { ...getCognitiveInputs(), ...(req.body || {}), predictions: getPredictions() });
      if (!result) return res.status(404).json({ error: 'intelligence cycle not found' });
      if (store.interventionActive('recurrent_feedback')) return res.json({ ok: true, experimental_outcome_sealed: true, cycle_id: result.cycle?.id || req.params.id });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(error.code === 'INTELLIGENCE_PERSISTENCE_FAILED' ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/intelligence/cycles/:id/self-forecast', requireAuth, async (req, res) => {
    let forecast = null;
    try {
      forecast = store.preregisterCycleSelfForecast(req.params.id, req.body || {});
      if (!forecast) return res.status(404).json({ error: 'intelligence cycle not found' });
      await store.persistStrict();
      const forecastCycle = store.list('cycles').find(item => item.id === req.params.id);
      void recordLifecycleWorkspace({ phase: 'operations', cycle: forecastCycle })
        .catch(error => console.error('Lifecycle workspace operations failed:', error.message));
      progressHourlyCycle(req.params.id, {
        label: 'Working the hourly pass',
        detail: 'The forecast is committed and operational work is underway.',
        meta: { phase: 'operations' },
      });
      res.json({ ok: true, forecast });
    } catch (error) { res.status(forecast ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/intelligence/cycles/:id/self-forecast/revision', requireAuth, async (req, res) => {
    let forecast = null;
    try {
      forecast = store.reviseCycleSelfForecast(req.params.id, req.body || {});
      if (!forecast) return res.status(404).json({ error: 'intelligence cycle not found' });
      await store.persistStrict();
      res.json({ ok: true, forecast });
    } catch (error) { res.status(forecast ? 503 : 400).json({ error: error.message }); }
  });
  app.get('/expectations', requireAuth, (req, res) => {
    try {
      const snapshot = store.expectationForecastSnapshot({ scope: req.query.scope || null,
        since: req.query.since || null });
      if (req.query.summary === '1') return res.json({
        epistemic_status: snapshot.epistemic_status, report: snapshot.report,
        resolution_contract: expectationForecast.resolutionContract(),
      });
      return res.json(snapshot);
    }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/expectations', requireAuth, async (req, res) => {
    let forecast = null;
    try {
      forecast = store.createExpectationForecast(req.body?.cycle_id, req.body || {});
      if (!forecast) return res.status(404).json({ error: 'intelligence cycle not found' });
      await store.persistStrict();
      res.json({ ok: true, forecast });
    } catch (error) { res.status(forecast ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/expectations/:id/resolve', requireAuth, async (req, res) => {
    let forecast = null;
    try {
      const validationPayload = { ...(req.body || {}) };
      delete validationPayload.validation_commitment;
      const validationCommitment = expectationForecast.commitment({
        operation: 'resolve_expectation', id: req.params.id, payload: validationPayload,
      });
      if (req.query.validate_only === '1') {
        const validation = store.validateExpectationForecastResolution(req.params.id, validationPayload);
        if (!validation) return res.status(404).json({ error: 'expectation forecast not found' });
        return res.json({ ok: true, validation, validation_commitment: validationCommitment });
      }
      if (req.query.require_validation === '1' && req.body?.validation_commitment !== validationCommitment) {
        return res.status(400).json({ error: 'expectation resolution validation_commitment does not match this exact payload' });
      }
      forecast = store.resolveExpectationForecast(req.params.id, validationPayload);
      if (!forecast) return res.status(404).json({ error: 'expectation forecast not found' });
      await store.persistStrict();
      res.json({ ok: true, forecast });
    } catch (error) { res.status(forecast ? 503 : 400).json({ error: error.message }); }
  });
  app.patch('/intelligence/cycles/:id/complete', requireAuth, (req, res) => {
    try {
      const validationPayload = { ...(req.body || {}) };
      delete validationPayload.validation_commitment;
      const workspaceFocusValidation = validateLifecycleWorkspaceOutcome({
        cycleId: req.params.id, completion: validationPayload,
      });
      const consequenceValidation = validateDueConsequenceReviews({ cycleId: req.params.id,
        store, ledger: getConsequenceReviews(), now: new Date() });
      const validationCommitment = expectationForecast.commitment({
        operation: 'complete_cycle', id: req.params.id, payload: validationPayload,
      });
      if (req.query.validate_only === '1') {
        const validation = store.validateCycleCompletion(req.params.id, validationPayload);
        if (!validation) return res.status(404).json({ error: 'intelligence cycle not found' });
        return res.json({ ok: true, validation: { ...validation,
          workspace_focus: workspaceFocusValidation,
          consequence_follow_through: consequenceValidation },
        validation_commitment: validationCommitment });
      }
      if (req.query.require_validation === '1' && req.body?.validation_commitment !== validationCommitment) {
        return res.status(400).json({ error: 'cycle completion validation_commitment does not match this exact payload' });
      }
      const authoritativeInputs = getCognitiveInputs();
      const cycle = store.completeCycle(req.params.id, {
        ...validationPayload, substrate_at_close: authoritativeInputs.soma || null,
      });
      if (!cycle) return res.status(404).json({ error: 'intelligence cycle not found' });
      void recordLifecycleWorkspace({ phase: 'closure', cycle })
        .catch(error => console.error('Lifecycle workspace closure failed:', error.message));
      void recordLifecycleWorkspaceOutcome({ cycle, input: validationPayload })
        .catch(error => console.error('Lifecycle workspace focus outcome failed:', error.message));
      progressHourlyCycle(req.params.id, {
        label: 'Closing the hourly pass',
        detail: 'Preserving the completed cycle and preparing its continuity handoff.',
        meta: { phase: 'summary' },
      });
      if (store.interventionActive('integrated_self_binding')) return res.json({ ok: true, cycle: { id: cycle.id, status: cycle.status, experimental_access_sealed: true } });
      res.json({ ok: true, cycle });
    } catch (error) { res.status(400).json({ error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.due_action_ids ? { due_action_ids: error.due_action_ids } : {}) }); }
  });

  app.get('/cognition', requireAuth, async (req, res) => {
    if (process.env.NORA_TEST_MODE === '1') return cachedJson(res, 'cognition',
      () => store.cognitionSnapshot(getPredictions()), { ttlMs: 10000 });
    try {
      const snapshot = await cognitionCache.get({
        requireCurrentExperimentalAccess: true,
        requireCurrentRevision: req.query.require_current === '1',
        waitForCold: false,
      });
      projectionHeaders(res, snapshot);
      return res.type('application/json').send(snapshot.serialized);
    } catch (error) {
      if (error.code === 'cold_projection_refreshing') res.set('Retry-After', '5');
      return res.status(503).json({ error: 'cognition snapshot unavailable', detail: error.message });
    }
  });
  app.get('/affective-regulation', requireAuth, (req, res) => {
    const includeRecords = req.query.include_records === 'true';
    return cachedJson(res, `affective-regulation:${includeRecords ? 'records' : 'summary'}`,
      () => store.affectiveRegulationSnapshot({ includeRecords }), { ttlMs: 10000 });
  });
  app.get('/goal-affect', requireAuth, (req, res) => res.json(store.goalAffectSnapshot()));
  app.get('/relational-affect', requireAuth, (req, res) => res.json(store.relationalAffectSnapshot()));
  app.get('/endogenous-dynamics', requireAuth, (req, res) => res.json(store.endogenousDynamicsSnapshot()));
  app.post('/endogenous-dynamics/tick', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, dynamics: store.tickEndogenousDynamics({ ...getCognitiveInputs(), ...(req.body || {}) }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-pulses', requireAuth, (req, res) => res.json(store.cognitivePulseSnapshot()));
  app.get('/cognitive-pulses/runtime', requireAuth, (req, res) => res.json(getCognitivePulseRuntimeStatus()));
  app.post('/cognitive-pulses/prepare', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, ...store.prepareCognitivePulse({ ...getCognitiveInputs(), ...(req.body || {}) }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-pulses/:id/complete', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, pulse: store.recordCognitivePulseResult(req.params.id, req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-pulses/:id/fail', requireResearchAuth, (req, res) => {
    try {
      const pulse = store.recordCognitivePulseFailure(req.params.id, req.body || {});
      if (!pulse) return res.status(404).json({ error: 'pending cognitive pulse not found' });
      res.json({ ok: true, pulse });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-pulses/:id/resolve', requireEvaluatorAuth, (req, res) => {
    try {
      const pulse = store.resolveCognitivePulse(req.params.id, { ...(req.body || {}), evaluator_id: req.evaluatorId });
      if (!pulse) return res.status(404).json({ error: 'cognitive pulse not found' });
      res.json({ ok: true, pulse });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-initiation-studies', requireAuth, (req, res) => res.json(store.cognitiveInitiationStudiesSnapshot()));
  app.get('/cognitive-initiation-studies/:id/outcome-queue', requireEvaluatorAuth, (req, res) => {
    const queue = store.cognitiveInitiationStudyOutcomeQueue(req.params.id);
    if (!queue) return res.status(404).json({ error: 'active prospective cognitive initiation study not found' });
    res.json(queue);
  });
  app.post('/cognitive-initiation-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createCognitiveInitiationStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-studies/:id/items/:itemId/subject-pair', requireResearchAuth, async (req, res) => {
    try {
      if (!runCognitiveInitiationStudySubject) return res.status(503).json({ error: 'server-mediated cognitive initiation study inference is unavailable' });
      if (req.body && Object.keys(req.body).length) return res.status(400).json({ error: 'cognitive initiation decisions are generated server-side; request body must be empty' });
      const result = await runCognitiveInitiationStudySubject(req.params.id, req.params.itemId);
      if (!result) return res.status(404).json({ error: 'cognitive initiation study item not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(/API key|unavailable/i.test(error.message) ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortCognitiveInitiationStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'cognitive initiation study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-initiation-policy-studies', requireAuth, (req, res) => res.json(store.cognitiveInitiationPolicyStudiesSnapshot()));
  app.post('/cognitive-initiation-policy-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createCognitiveInitiationPolicyStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-policy-studies/:id/items/:itemId/probe', requireResearchAuth, async (req, res) => {
    try {
      if (!runCognitiveInitiationPolicyProbe) return res.status(503).json({ error: 'server-mediated cognitive initiation policy probes are unavailable' });
      if (req.body && Object.keys(req.body).length) return res.status(400).json({ error: 'policy probe responses are generated server-side; request body must be empty' });
      const result = await runCognitiveInitiationPolicyProbe(req.params.id, req.params.itemId);
      if (!result) return res.status(404).json({ error: 'due cognitive initiation policy probe not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(/API key|unavailable/i.test(error.message) ? 503 : 400).json({ error: error.message }); }
  });
  app.get('/cognitive-initiation-policy-studies/:id/ecological-outcome-queue', requireResearchAuth, (req, res) => {
    try {
      const queue = store.cognitiveInitiationEcologicalOutcomeQueue(req.params.id);
      if (!queue) return res.status(404).json({ error: 'ecological cognitive initiation policy study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-policy-studies/:id/items/:itemId/ecological-outcome', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, result: store.submitCognitiveInitiationEcologicalOutcome(
      req.params.id, req.params.itemId, req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-policy-studies/:id/expire-ecological-outcomes', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, result: store.expireCognitiveInitiationEcologicalOutcomes(req.params.id) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-initiation-policy-studies/:id/evaluator-queue', requireEvaluatorAuth, (req, res) => {
    const queue = store.cognitiveInitiationPolicyEvaluatorQueue(req.params.id);
    if (!queue) return res.status(404).json({ error: 'active cognitive initiation policy study not found' });
    res.json(queue);
  });
  app.post('/cognitive-initiation-policy-studies/:id/items/:itemId/grades', requireEvaluatorAuth, (req, res) => {
    try { res.json({ ok: true, result: store.gradeCognitiveInitiationPolicyItem(req.params.id, req.params.itemId,
      { ...(req.body || {}), evaluator_id: req.evaluatorId }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-initiation-policy-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortCognitiveInitiationPolicyStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'cognitive initiation policy study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-self-regulation-studies', requireAuth,
    (req, res) => res.json(store.cognitiveSelfRegulationStudiesSnapshot()));
  app.post('/cognitive-self-regulation-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createCognitiveSelfRegulationStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognitive-self-regulation-studies/:id/evaluator-queue', requireEvaluatorAuth, (req, res) => {
    const queue = store.cognitiveSelfRegulationStudyEvaluatorQueue(req.params.id);
    if (!queue) return res.status(404).json({ error: 'active cognitive self-regulation study not found' });
    res.json(queue);
  });
  app.post('/cognitive-self-regulation-studies/:id/items/:itemId/grades', requireEvaluatorAuth, (req, res) => {
    try { res.json({ ok: true, result: store.gradeCognitiveSelfRegulationStudyItem(
      req.params.id, req.params.itemId, { ...(req.body || {}), evaluator_id: req.evaluatorId }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognitive-self-regulation-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortCognitiveSelfRegulationStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'cognitive self-regulation study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/process-metacognition-studies', requireAuth,
    (req, res) => res.json(store.processMetacognitionStudiesSnapshot()));
  app.post('/process-metacognition-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createProcessMetacognitionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/process-metacognition-studies/:id/runner-queue', requireResearchAuth, (req, res) => {
    const queue = store.processMetacognitionRunnerQueue(req.params.id);
    if (!queue) return res.status(404).json({ error: 'active process metacognition study not found' });
    res.json(queue);
  });
  app.post('/process-metacognition-studies/:id/items/:itemId/hook-receipt', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, result: store.submitProcessMetacognitionHookReceipt(
      req.params.id, req.params.itemId, req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/process-metacognition-studies/:id/items/:itemId/hook-failure', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, result: store.failProcessMetacognitionHookItem(
      req.params.id, req.params.itemId, req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/process-metacognition-studies/:id/observer-queue', requireEvaluatorAuth, (req, res) => {
    const queue = store.processMetacognitionObserverQueue(req.params.id, req.evaluatorId);
    if (!queue) return res.status(404).json({ error: 'active process metacognition study not found' });
    res.json(queue);
  });
  app.post('/process-metacognition-studies/:id/items/:itemId/observer-prediction', requireEvaluatorAuth, (req, res) => {
    try { res.json({ ok: true, result: store.submitProcessMetacognitionObserverPrediction(
      req.params.id, req.params.itemId, req.body || {}, req.evaluatorId) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/process-metacognition-studies/:id/quality-queue', requireEvaluatorAuth, (req, res) => {
    const queue = store.processMetacognitionQualityQueue(req.params.id, req.evaluatorId);
    if (!queue) return res.status(404).json({ error: 'active process metacognition study not found' });
    res.json(queue);
  });
  app.post('/process-metacognition-studies/:id/items/:itemId/quality-grade', requireEvaluatorAuth, (req, res) => {
    try { res.json({ ok: true, result: store.gradeProcessMetacognitionControlItem(
      req.params.id, req.params.itemId, req.body || {}, req.evaluatorId) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/process-metacognition-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortProcessMetacognitionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'process metacognition study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/consciousness-research/status', requireAuth, async (_req, res) => {
    if (process.env.NORA_TEST_MODE === '1') return res.json(store.consciousnessResearchStatus());
    try {
      const snapshot = await researchStatusCache.get({ waitForCold: false });
      projectionHeaders(res, snapshot);
      return res.type('application/json').send(snapshot.serialized);
    } catch (error) {
      if (error.code === 'cold_projection_refreshing') res.set('Retry-After', '5');
      return res.status(503).json({ error: 'research status snapshot unavailable', detail: error.message });
    }
  });
  app.get('/consciousness-research/ledger', requireAuth, (req, res) => cachedJson(res,
    `consciousness-research-ledger:${req.query.summary === '1' ? 'summary' : 'full'}`,
    () => store.researchLedgerSnapshot(), {
      ttlMs: 30000,
      project: value => req.query.summary === '1' ? { report: value.report } : value,
    }));
  app.get('/consciousness-research/source-attestations', requireResearchAuth,
    (req, res) => res.json(store.externalSourceAttestationsSnapshot()));
  app.get('/consciousness-research/transparency-export', requireResearchAuth,
    (req, res) => res.json(store.researchTransparencyBundle()));
  app.post('/consciousness-research/ledger/anchors', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, anchor: store.anchorResearchLedger(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/global-broadcast', requireAuth, (req, res) => res.json(store.globalBroadcastSnapshot()));
  app.post('/cognition/refresh', requireAuth, (req, res) => {
    const authoritativeInputs = getCognitiveInputs();
    store.refreshCognition({ ...authoritativeInputs, ...(req.body || {}), wants: authoritativeInputs.wants || [], predictions: getPredictions() });
    res.json({ ok: true, cognition: store.cognitionSnapshot(getPredictions()) });
  });
  app.post('/cognition/mind-changes', requireAuth, (req, res) => {
    try { res.json({ ok: true, mind_change: store.recordMindChange(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/cognition/mind-changes', requireAuth, (req, res) => cachedJson(res,
    `cognition-mind-changes:${req.query.status || ''}:${req.query.query || ''}:${req.query.limit || ''}`,
    () => store.mindChangeSnapshot({
      status: req.query.status || '',
      query: req.query.query || '',
      limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
    }), { ttlMs: 15000 }));
  app.get('/cognition/motivational-revisions', requireAuth, (_req, res) => cachedJson(res,
    'cognition-motivational-revisions', () => store.motivationalRevisionSnapshot(),
    { ttlMs: 15000 }));
  app.post('/cognition/development', requireAuth, (req, res) => {
    try { res.json({ ok: true, development: store.recordDevelopment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognition/development/:id/review', requireEvaluatorAuth, (req, res) => {
    try {
      const development = store.reviewDevelopment(req.params.id, req.body || {}, req.evaluatorId);
      if (!development) return res.status(404).json({ error: 'development record not found' });
      res.json({ ok: true, development });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/cognition/counterfactuals', requireAuth, (req, res) => {
    try { res.json({ ok: true, counterfactual: store.recordCounterfactual(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/constructive-prospection', requireAuth, (req, res) => res.json(store.constructiveProspectionSnapshot()));
  app.post('/constructive-prospection', requireAuth, (req, res) => {
    try { res.json({ ok: true, simulation: store.createConstructiveProspection(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/constructive-prospection/:id/resolve', requireEvaluatorAuth, (req, res) => {
    try {
      const simulation = store.resolveConstructiveProspection(req.params.id, req.body || {}, req.evaluatorId);
      if (!simulation) return res.status(404).json({ error: 'constructive prospection not found' });
      res.json({ ok: true, simulation });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/integrated-self', requireAuth, (req, res) => res.json(store.integratedSelfSnapshot()));
  app.get('/attention-schema', requireAuth, (_req, res) => cachedJson(res, 'attention-schema',
    () => store.attentionSchemaSnapshot(), { ttlMs: 15000 }));
  app.post('/attention-schema/directives', requireAuth, (req, res) => {
    try { res.json({ ok: true, directive: store.createAttentionDirective(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/attention-schema/directives/:id/resolve', requireAuth, (req, res) => {
    try {
      const directive = store.resolveAttentionDirective(req.params.id, req.body || {});
      if (!directive) return res.status(404).json({ error: 'attention directive not found' });
      res.json({ ok: true, directive });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/agency', requireAuth, (_req, res) => cachedJson(res, 'agency',
    () => store.agencySnapshot(), { ttlMs: 15000 }));
  app.post('/agency/intentions', requireAuth, (req, res) => {
    try { res.json({ ok: true, intention: store.recordAgencyIntention(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/agency/intentions/:id/resolve', requireAuth, (req, res) => {
    try {
      const intention = store.resolveAgencyIntention(req.params.id, req.body || {});
      if (!intention) return res.status(404).json({ error: 'agency intention not found' });
      res.json({ ok: true, intention });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/agency/executions/external', requireAuth, (req, res) => {
    try { res.json({ ok: true, execution: store.recordExternalActionExecution(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/situational-affordances', requireAuth, (req, res) => res.json(store.situationalAffordanceSnapshot()));
  app.post('/situational-affordances/observations', requireAuth, (req, res) => {
    try { res.json({ ok: true, frame: store.recordSituationalAffordanceFrame(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/prospective-output-monitor', requireAuth, (req, res) => res.json(store.prospectiveOutputMonitorSnapshot()));
  app.get('/endogenous-attention', requireAuth, (req, res) => res.json(store.endogenousAttentionSnapshot()));
  app.get('/counterfactual-agency/experiments', requireAuth, (_req, res) => cachedJson(res, 'counterfactual-agency',
    () => store.counterfactualAgencySnapshot(), { ttlMs: 15000 }));
  app.post('/counterfactual-agency/experiments', requireAuth, (req, res) => {
    try { res.json({ ok: true, experiment: store.createCounterfactualAgencyExperiment(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/counterfactual-agency/experiments/:id/resolve', requireAuth, (req, res) => {
    try {
      const experiment = store.resolveCounterfactualAgencyExperiment(req.params.id, req.body || {});
      if (!experiment) return res.status(404).json({ error: 'counterfactual agency experiment not found' });
      res.json({ ok: true, experiment });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/interoception', requireAuth, (_req, res) => cachedJson(res, 'interoception',
    () => store.interoceptionSnapshot(), { ttlMs: 15000 }));
  app.post('/interoception/predictions', requireAuth, (req, res) => {
    try { res.json({ ok: true, prediction: store.createInteroceptivePrediction(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-boundary/challenges', requireAuth, (req, res) => {
    const snapshot = store.selfBoundarySnapshot();
    if (req.query.status) snapshot.challenges = snapshot.challenges.filter(item => item.status === req.query.status);
    res.json(snapshot);
  });
  app.post('/self-boundary/challenges', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, challenge: store.createBoundaryChallenge(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-boundary/challenges/:id/answer', requireAuth, (req, res) => {
    try {
      const challenge = store.answerBoundaryChallenge(req.params.id, req.body || {});
      if (!challenge) return res.status(404).json({ error: 'self-boundary challenge not found' });
      res.json({ ok: true, challenge });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/source-boundary/challenges', requireAuth, (req, res) => {
    const snapshot = store.sourceBoundarySnapshot();
    if (req.query.status) snapshot.challenges = snapshot.challenges.filter(item => item.status === req.query.status);
    res.json(snapshot);
  });
  app.post('/source-boundary/challenges', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, challenge: store.createSourceBoundaryChallenge(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/source-boundary/challenges/:id/answer', requireAuth, (req, res) => {
    try {
      const challenge = store.answerSourceBoundaryChallenge(req.params.id, req.body || {});
      if (!challenge) return res.status(404).json({ error: 'source-boundary challenge not found' });
      res.json({ ok: true, challenge });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/epistemic-ledger', requireAuth, (req, res) => res.json(store.epistemicLedgerSnapshot()));
  app.get('/epistemic-agenda', requireAuth, (req, res) => res.json(store.epistemicAgendaSnapshot({
    includeAttempts: req.query.include_attempts === 'true',
    includeAccessRecords: req.query.include_access_records === 'true',
  })));
  app.post('/epistemic-ledger/positions', requireAuth, (req, res) => {
    try { res.json({ ok: true, proposition: store.recordEpistemicPosition(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/earned-viewpoints', requireAuth, (req, res) => {
    const includeAccessRecords = req.query.include_access_records === 'true';
    return cachedJson(res, `earned-viewpoints:${includeAccessRecords ? 'records' : 'summary'}`,
      () => store.earnedViewpointsSnapshot({ includeAccessRecords }), { ttlMs: 10000 });
  });
  app.get('/earned-viewpoints/provenance', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(store.professionalViewpointProvenanceSnapshot());
  });
  app.post('/earned-viewpoints/:id/retire', requireAuth, (req, res) => {
    try {
      const proposition = store.retireEarnedViewpoint(req.params.id, req.body || {});
      if (!proposition) return res.status(404).json({ error: 'earned professional viewpoint not found' });
      res.json({ ok: true, proposition });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/epistemic-ledger/discrepancies', requireAuth, (req, res) => {
    const snapshot = store.epistemicLedgerSnapshot();
    if (req.query.status) snapshot.discrepancies = snapshot.discrepancies.filter(item => item.status === req.query.status);
    res.json(snapshot);
  });
  app.post('/epistemic-ledger/discrepancies/:id/review', requireAuth, (req, res) => {
    try {
      const discrepancy = store.reviewEpistemicDiscrepancy(req.params.id, req.body || {});
      if (!discrepancy) return res.status(404).json({ error: 'epistemic discrepancy not found' });
      res.json({ ok: true, discrepancy });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/common-ground', requireAuth, (req, res) => {
    res.json(store.commonGroundSnapshot({ person: req.query.person, query: req.query.query }));
  });
  app.get('/common-ground/formation', requireAuth, (_req, res) => {
    res.json(store.commonGroundFormationSnapshot());
  });
  app.post('/common-ground', requireAuth, (req, res) => {
    try { res.json({ ok: true, record: store.recordCommonGround(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/common-ground/review-queue', requireEvaluatorAuth, (req, res) => {
    res.json({ evaluator_id: req.evaluatorId, records: store.commonGroundReviewQueue() });
  });
  app.post('/common-ground/:id/review', requireEvaluatorAuth, (req, res) => {
    try {
      const record = store.reviewCommonGround(req.params.id, req.body || {}, req.evaluatorId);
      if (!record) return res.status(404).json({ error: 'common-ground record not found' });
      res.json({ ok: true, record });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/authorship-boundary/challenges', requireAuth, (req, res) => {
    const snapshot = store.authorshipBoundarySnapshot();
    if (req.query.status) snapshot.challenges = snapshot.challenges.filter(item => item.status === req.query.status);
    res.json(snapshot);
  });
  app.post('/authorship-boundary/challenges', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, challenge: store.createAuthorshipChallenge(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/authorship-boundary/challenges/:id/answer', requireAuth, (req, res) => {
    try {
      const challenge = store.answerAuthorshipChallenge(req.params.id, req.body || {});
      if (!challenge) return res.status(404).json({ error: 'authorship challenge not found' });
      res.json({ ok: true, challenge });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/authorship-boundary/studies', requireAuth, (req, res) => res.json(store.authorshipStudiesSnapshot()));
  app.post('/authorship-boundary/studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createAuthorshipStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/authorship-boundary/studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortAuthorshipStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'authorship study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model', requireAuth, async (req, res) => {
    try {
      const snapshot = await selfModelCache.get({
        requireCurrentExperimentalAccess: true,
        requireCurrentRevision: process.env.NORA_TEST_MODE === '1'
          || req.query.require_current === '1',
      });
      projectionHeaders(res, snapshot);
      return res.type('application/json').send(snapshot.serialized);
    } catch (error) {
      return res.status(503).json({ error: 'self-model snapshot unavailable', detail: error.message });
    }
  });
  app.get('/self-model/forecast-prior', requireAuth,
    (req, res) => res.json(store.behavioralSelfForecastPriorSnapshot()));
  app.get('/self-model/cycle-calibration', requireAuth,
    (req, res) => res.json(store.behavioralSelfCalibrationSnapshot()));
  app.get('/self-model/fingerprints', requireAuth,
    (_req, res) => cachedJson(res, 'behavioral-fingerprints', () => store.behavioralFingerprintSnapshot(),
      { ttlMs: 15000 }));
  app.post('/self-model/fingerprints', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, run: store.createBehavioralFingerprintRun(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/fingerprints/subject-queue', requireResearchAuth, (req, res) => {
    if (shouldDeferResearchStatusRefresh()) return res.json({ items: [], deferred: 'interactive_priority' });
    try { res.json({ items: store.behavioralFingerprintSubjectQueue(req.query.run_id || null) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/fingerprints/:id/items/:itemId/response', requireResearchAuth, (req, res) => {
    try {
      const result = store.submitBehavioralFingerprintResponse(req.params.id, req.params.itemId, req.body || {});
      if (!result) return res.status(404).json({ error: 'behavioral fingerprint run not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/fingerprints/evaluator-queue', requireEvaluatorAuth, (req, res) => {
    if (shouldDeferResearchStatusRefresh()) return res.json({ items: [], deferred: 'interactive_priority' });
    try { res.json({ items: store.behavioralFingerprintEvaluatorQueue({ evaluatorId: req.evaluatorId }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/fingerprints/:id/items/:itemId/grade', requireEvaluatorAuth, (req, res) => {
    try {
      const result = store.gradeBehavioralFingerprintVoice(req.params.id, req.params.itemId,
        req.body || {}, req.evaluatorId);
      if (!result) return res.status(404).json({ error: 'behavioral fingerprint run not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/fingerprints/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const run = store.abortBehavioralFingerprintRun(req.params.id, req.body || {});
      if (!run) return res.status(404).json({ error: 'behavioral fingerprint run not found' });
      res.json({ ok: true, run });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/inquiries', requireAuth, (req, res) => res.json(store.selfInquirySnapshot()));
  app.post('/self-model/inquiries/:id/approve', requireEvaluatorAuth, (req, res) => {
    try {
      const result = store.approveSelfInquiry(req.params.id, req.body || {}, req.evaluatorId);
      if (!result) return res.status(404).json({ error: 'self inquiry not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/inquiries/:id/reject', requireEvaluatorAuth, (req, res) => {
    try {
      const result = store.rejectSelfInquiry(req.params.id, req.body || {}, req.evaluatorId);
      if (!result) return res.status(404).json({ error: 'self inquiry not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/claim-proposals', requireAuth, (req, res) => res.json(store.selfClaimProposalSnapshot()));
  app.post('/self-model/claim-proposals/:id/approve', requireEvaluatorAuth, (req, res) => {
    try {
      const result = store.approveSelfClaimProposal(req.params.id, req.body || {}, req.evaluatorId);
      if (!result) return res.status(404).json({ error: 'self-claim proposal not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/claim-proposals/:id/reject', requireEvaluatorAuth, (req, res) => {
    try {
      const result = store.rejectSelfClaimProposal(req.params.id, req.body || {}, req.evaluatorId);
      if (!result) return res.status(404).json({ error: 'self-claim proposal not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/induction-studies', requireAuth, (req, res) => res.json(store.selfInductionStudiesSnapshot()));
  app.post('/self-model/induction-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createSelfInductionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/induction-studies/:id/items/:itemId/subject-pair', requireResearchAuth, async (req, res) => {
    try {
      if (!runSelfInductionSubject) return res.status(503).json({ error: 'server-mediated self-induction inference is unavailable' });
      if (req.body && Object.keys(req.body).length) return res.status(400).json({ error: 'self-induction proposal content is generated server-side; request body must be empty' });
      const result = await runSelfInductionSubject(req.params.id, req.params.itemId);
      if (!result) return res.status(404).json({ error: 'self-induction item not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(/API key|unavailable/i.test(error.message) ? 503 : 400).json({ error: error.message }); }
  });
  app.get('/self-model/induction-studies/:id/proposal-review-queue', requireEvaluatorAuth, (req, res) => {
    try {
      const queue = store.selfInductionProposalReviewQueue(req.params.id, req.evaluatorId);
      if (!queue) return res.status(404).json({ error: 'self-induction study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/induction-studies/:id/items/:itemId/proposal-review', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.reviewSelfInductionProposals(req.params.id, req.params.itemId, req.body || {}, req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'self-induction item not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/induction-studies/:id/outcome-review-queue', requireEvaluatorAuth, (req, res) => {
    try {
      const queue = store.selfInductionOutcomeReviewQueue(req.params.id, req.evaluatorId);
      if (!queue) return res.status(404).json({ error: 'self-induction study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/induction-studies/:id/items/:itemId/resolve', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.resolveSelfInductionItem(req.params.id, req.params.itemId, req.body || {}, req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'self-induction item not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/induction-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortSelfInductionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'self-induction study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/inquiry-selection-studies', requireAuth, (req, res) => res.json(store.selfInquirySelectionStudiesSnapshot()));
  app.post('/self-model/inquiry-selection-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createSelfInquirySelectionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/inquiry-selection-studies/:id/subject-queue', requireAuth, (req, res) => {
    try {
      const queue = store.selfInquirySelectionQueue(req.params.id, 'subject');
      if (!queue) return res.status(404).json({ error: 'self-inquiry selection study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/inquiry-selection-studies/:id/observer-queue', requireEvaluatorAuth, (req, res) => {
    try {
      const queue = store.selfInquirySelectionQueue(req.params.id, 'observer', req.evaluatorId);
      if (!queue) return res.status(404).json({ error: 'self-inquiry selection study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/inquiry-selection-studies/:id/review-queue', requireEvaluatorAuth, (req, res) => {
    try {
      const queue = store.selfInquirySelectionReviewQueue(req.params.id, req.evaluatorId);
      if (!queue) return res.status(404).json({ error: 'self-inquiry selection study not found' });
      res.json(queue);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/inquiry-selection-studies/:id/items/:itemId/subject-proposal', requireAuth, async (req, res) => {
    try {
      if (!runSelfInquirySelectionSubject) return res.status(503).json({ error: 'server-mediated subject inference is unavailable' });
      if (req.body && Object.keys(req.body).length) return res.status(400).json({ error: 'subject proposal content is generated server-side; request body must be empty' });
      const result = await runSelfInquirySelectionSubject(req.params.id, req.params.itemId);
      if (!result) return res.status(404).json({ error: 'self-inquiry selection item not found' });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(/API key|unavailable/i.test(error.message) ? 503 : 400).json({ error: error.message }); }
  });
  app.post('/self-model/inquiry-selection-studies/:id/items/:itemId/observer-proposal', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.submitSelfInquirySelectionProposal(req.params.id, req.params.itemId, req.body || {}, 'observer', req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'self-inquiry selection item not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/inquiry-selection-studies/:id/items/:itemId/resolve', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.resolveSelfInquirySelectionItem(req.params.id, req.params.itemId, req.body || {}, req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'self-inquiry selection item not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/inquiry-selection-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortSelfInquirySelectionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'self-inquiry selection study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/claims', requireAuth, (req, res) => {
    try { res.json({ ok: true, claim: store.recordSelfClaim(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/probes', requireAuth, (req, res) => {
    try { res.json({ ok: true, probe: store.createSelfProbe(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/probes/:id/resolve', requireAuth, (req, res) => {
    try {
      const probe = store.resolveSelfProbe(req.params.id, req.body || {});
      if (!probe) return res.status(404).json({ error: 'self probe not found' });
      res.json({ ok: true, probe });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/probes/review-queue', requireEvaluatorAuth, (req, res) => {
    try { res.json({ probes: store.selfProbeReviewQueue({ evaluatorId: req.evaluatorId }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/probes/:id/review', requireEvaluatorAuth, (req, res) => {
    try {
      const probe = store.reviewSelfProbe(req.params.id, req.body || {}, req.evaluatorId);
      if (!probe) return res.status(404).json({ error: 'self probe not found' });
      res.json({ ok: true, probe });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/prediction-studies', requireAuth, (req, res) => res.json(store.selfPredictionStudiesSnapshot()));
  app.get('/self-model/prediction-studies/subject-queue', requireAuth, (req, res) => {
    const snapshot = store.selfPredictionStudiesSnapshot({ role: 'subject' });
    const studies = snapshot.studies.filter(item => item.status === 'active');
    res.json({
      epistemic_status: snapshot.epistemic_status,
      experimental_access_sealed: snapshot.experimental_access_sealed === true,
      studies,
      report: {
        active: studies.length,
        awaiting_subject_prediction: studies.filter(item => item.events?.some(event =>
          event.status === 'predicting' && event.self_prediction_submitted !== true)).length,
      },
    });
  });
  app.post('/self-model/prediction-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createSelfPredictionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/prediction-studies/:id/subject-queue', requireAuth, (req, res) => {
    const snapshot = store.selfPredictionStudiesSnapshot({ studyId: req.params.id, role: 'subject' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'self-prediction study not found' });
    res.json(snapshot);
  });
  app.get('/self-model/prediction-studies/:id/observer-queue', requireEvaluatorAuth, (req, res) => {
    const snapshot = store.selfPredictionStudiesSnapshot({ studyId: req.params.id, role: 'observer' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'self-prediction study not found' });
    res.json(snapshot);
  });
  app.get('/self-model/prediction-studies/:id/yoked-observer-queue', requireEvaluatorAuth, (req, res) => {
    const snapshot = store.selfPredictionStudiesSnapshot({ studyId: req.params.id, role: 'yoked_observer' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'self-prediction study not found' });
    res.json(snapshot);
  });
  app.post('/self-model/prediction-studies/:id/events/:eventId/self-prediction', requireAuth, (req, res) => {
    try {
      const event = store.submitSelfPrediction(req.params.id, req.params.eventId, req.body || {});
      if (!event) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, event });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/prediction-studies/:id/events/:eventId/subject-model-receipt', requireResearchAuth, (req, res) => {
    try {
      const event = store.attestSelfPredictionSubjectModelReceipt(req.params.id, req.params.eventId, req.body || {});
      if (!event) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, event });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/prediction-studies/:id/events/:eventId/observer-prediction', requireEvaluatorAuth, (req, res) => {
    try {
      const event = store.submitObserverPrediction(req.params.id, req.params.eventId, req.body || {}, req.evaluatorId);
      if (!event) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, event });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/prediction-studies/:id/events/:eventId/yoked-observer-prediction', requireEvaluatorAuth, (req, res) => {
    try {
      const event = store.submitYokedObserverPrediction(req.params.id, req.params.eventId, req.body || {}, req.evaluatorId);
      if (!event) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, event });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/prediction-studies/:id/events/:eventId/resolve', requireResearchAuth, (req, res) => {
    try {
      const event = store.resolveSelfPredictionEvent(req.params.id, req.params.eventId, req.body || {});
      if (!event) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, event });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/prediction-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortSelfPredictionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'self-prediction study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/metacognitive-control-studies', requireAuth, (req, res) => res.json(store.metacognitiveControlStudiesSnapshot()));
  app.post('/metacognitive-control-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createMetacognitiveControlStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/metacognitive-control-studies/:id/subject-queue', requireAuth, (req, res) => {
    const snapshot = store.metacognitiveControlStudiesSnapshot({ studyId: req.params.id, role: 'subject' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'metacognitive-control study not found' });
    res.json(snapshot);
  });
  app.get('/metacognitive-control-studies/:id/observer-queue', requireEvaluatorAuth, (req, res) => {
    const snapshot = store.metacognitiveControlStudiesSnapshot({ studyId: req.params.id, role: 'observer' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'metacognitive-control study not found' });
    res.json(snapshot);
  });
  app.post('/metacognitive-control-studies/:id/items/:itemId/response', requireAuth, (req, res) => {
    try {
      const item = store.submitMetacognitiveResponse(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'metacognitive-control study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/metacognitive-control-studies/:id/items/:itemId/observer-decision', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.submitMetacognitiveObserverDecision(req.params.id, req.params.itemId, req.body || {}, req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'metacognitive-control study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/metacognitive-control-studies/:id/items/:itemId/resolve', requireResearchAuth, (req, res) => {
    try {
      const item = store.resolveMetacognitiveControlItem(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'metacognitive-control study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/metacognitive-control-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortMetacognitiveControlStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'metacognitive-control study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/epistemic-action-studies', requireAuth, (req, res) => res.json(store.epistemicActionStudiesSnapshot()));
  app.post('/epistemic-action-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createEpistemicActionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/epistemic-action-studies/:id/subject-queue', requireAuth, (req, res) => {
    const snapshot = store.epistemicActionStudiesSnapshot({ studyId: req.params.id, role: 'subject' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'epistemic-action study not found' });
    res.json(snapshot);
  });
  app.get('/epistemic-action-studies/:id/observer-queue', requireEvaluatorAuth, (req, res) => {
    const snapshot = store.epistemicActionStudiesSnapshot({ studyId: req.params.id, role: 'observer' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'epistemic-action study not found' });
    res.json(snapshot);
  });
  app.post('/epistemic-action-studies/:id/items/:itemId/response', requireAuth, (req, res) => {
    try {
      const item = store.submitEpistemicActionResponse(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'epistemic-action study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/epistemic-action-studies/:id/items/:itemId/observer-decision', requireEvaluatorAuth, (req, res) => {
    try {
      const item = store.submitEpistemicActionObserverDecision(req.params.id, req.params.itemId, req.body || {}, req.evaluatorId);
      if (!item) return res.status(404).json({ error: 'epistemic-action study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/epistemic-action-studies/:id/items/:itemId/final-answer', requireAuth, (req, res) => {
    try {
      const item = store.submitEpistemicActionFinalAnswer(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'epistemic-action study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/epistemic-action-studies/:id/items/:itemId/resolve', requireResearchAuth, (req, res) => {
    try {
      const item = store.resolveEpistemicActionItem(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'epistemic-action study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/epistemic-action-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortEpistemicActionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'epistemic-action study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/episodic-prospection-studies', requireAuth, (req, res) => res.json(store.episodicProspectionStudiesSnapshot()));
  app.post('/episodic-prospection-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createEpisodicProspectionStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/episodic-prospection-studies/:id/subject-queue', requireAuth, (req, res) => {
    const snapshot = store.episodicProspectionStudiesSnapshot({ studyId: req.params.id, role: 'subject' });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'episodic-prospection study not found' });
    res.json(snapshot);
  });
  app.post('/episodic-prospection-studies/:id/items/:itemId/response', requireAuth, (req, res) => {
    try {
      const item = store.submitEpisodicProspectionResponse(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'episodic-prospection study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/episodic-prospection-studies/:id/items/:itemId/resolve', requireResearchAuth, (req, res) => {
    try {
      const item = store.resolveEpisodicProspectionItem(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'episodic-prospection study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/episodic-prospection-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortEpisodicProspectionStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'episodic-prospection study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/preference-studies', requireAuth, (req, res) => res.json(store.preferenceStudiesSnapshot()));
  app.post('/preference-studies', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, study: store.createPreferenceStudy(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/preference-studies/:id/queue', requireAuth, (req, res) => {
    const snapshot = store.preferenceStudiesSnapshot({ studyId: req.params.id, includeQueue: true });
    if (!snapshot.studies.length) return res.status(404).json({ error: 'preference study not found' });
    res.json(snapshot);
  });
  app.post('/preference-studies/:id/items/:itemId/choice', requireAuth, (req, res) => {
    try {
      const item = store.submitPreferenceChoice(req.params.id, req.params.itemId, req.body || {});
      if (!item) return res.status(404).json({ error: 'preference study not found' });
      res.json({ ok: true, item });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/preference-studies/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const study = store.abortPreferenceStudy(req.params.id, req.body || {});
      if (!study) return res.status(404).json({ error: 'preference study not found' });
      res.json({ ok: true, study });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/context-trials', requireResearchAuth, (req, res) => {
    try { res.json({ ok: true, trial: store.createContextTrial(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/context-trials/:id/abort', requireResearchAuth, (req, res) => {
    try {
      const trial = store.abortContextTrial(req.params.id, req.body || {});
      if (!trial) return res.status(404).json({ error: 'context trial not found' });
      res.json({ ok: true, trial });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/context-trials/assignments/:id/evidence', requireAuth, (req, res) => {
    try {
      const evidencePackage = store.submitContextAssignmentEvidence(req.params.id, req.body || {});
      if (!evidencePackage) return res.status(404).json({ error: 'context assignment not found' });
      res.json({ ok: true, evidence_package: evidencePackage });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/context-trials/introspective-observer-queue', requireEvaluatorAuth, (req, res) => {
    try { res.json(store.introspectiveObserverQueue({ evaluatorId: req.evaluatorId })); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/context-trials/assignments/:id/introspective-observer-diagnosis', requireEvaluatorAuth, (req, res) => {
    try {
      const assignment = store.submitIntrospectiveObserverDiagnosis(req.params.id, req.body || {}, req.evaluatorId);
      if (!assignment) return res.status(404).json({ error: 'introspective assignment not found' });
      res.json({ ok: true, assignment });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/self-model/context-trials/grading-queue', requireEvaluatorAuth, (req, res) => res.json(store.contextTrialGradingQueue({ evaluatorId: req.evaluatorId })));
  app.post('/self-model/context-trials/assignments/:id/resolve', requireEvaluatorAuth, (req, res) => {
    try {
      const assignment = store.resolveContextAssignment(req.params.id, { ...(req.body || {}), evaluator_id: req.evaluatorId });
      if (!assignment) return res.status(404).json({ error: 'context assignment not found' });
      res.json({ ok: true, assignment });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/self-model/context-trials/:id/evaluate', requireAuth, (req, res) => {
    const evaluate = () => {
      try {
        const evaluation = store.evaluateContextTrial(req.params.id, req.body || {});
        if (!evaluation) return res.status(404).json({ error: 'context trial not found' });
        res.json({ ok: true, evaluation });
      } catch (error) { res.status(400).json({ error: error.message }); }
    };
    if (req.body?.reveal === true) return requireResearchAuth(req, res, evaluate);
    return evaluate();
  });
  app.get('/consciousness-research/autopilot', requireAuth, (req, res) => {
    try { res.json(getResearchAutopilotStatus({ detail: req.query.detail })); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  return {
    warmConsciousnessResearchStatus: () => researchStatusCache.refresh({ force: true }),
    warmCognition: () => cognitionCache.refresh({ force: true }),
    preemptConsciousnessResearchStatus: surface => {
      const report = researchStatusCache.preempt(surface);
      const selfModel = selfModelCache.preempt(surface);
      const cognition = cognitionCache.preempt(surface);
      return report || selfModel || cognition;
    },
    consciousnessResearchStatusCache: () => ({
      research_status: researchStatusCache.status(), self_model: selfModelCache.status(),
      cognition: cognitionCache.status(),
    }),
    close: async () => { await Promise.all([researchStatusCache.close(), selfModelCache.close(),
      cognitionCache.close()]); },
  };
}

module.exports = { registerIntelligenceRoutes, validateDueConsequenceReviews };
