'use strict';

const dreamIdeaSeed = require('../intelligence/dream-idea-seed');

function registerIntelligenceRoutes(app, { requireAuth, requireResearchAuth = requireAuth, requireEvaluatorAuth = requireAuth, store, getDreams = () => [], getPredictions = () => [], getCognitiveInputs = () => ({}), getCognitivePulseRuntimeStatus = () => null, getResearchAutopilotStatus = () => null, runSelfInquirySelectionSubject = null, runSelfInductionSubject = null, runCognitiveInitiationStudySubject = null, runCognitiveInitiationPolicyProbe = null }) {
  app.get('/intelligence', requireAuth, (req, res) => {
    const state = store.snapshot();
    res.json({
      commitments: { total: state.commitments.length, open: state.commitments.filter(item => item.status === 'open').length },
      episodes: state.episodes.length,
      relationships: state.relationships.length,
      traces: state.traces.length,
      cycles: { total: state.cycles.length, running: state.cycles.filter(item => item.status === 'running').length },
      experiments: { total: state.experiments.length, active: state.experiments.filter(item => item.status === 'active').length },
      experience_moments: state.cognition.experience_stream.length,
      initiative: state.initiative,
    });
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

  app.get('/relationships', requireAuth, (req, res) => res.json(store.list('relationships').sort((a, b) => a.name.localeCompare(b.name))));
  app.post('/relationships/observe', requireAuth, (req, res) => {
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
    try { res.json({ ok: true, perspective: store.observePerspective({ ...(req.body || {}), name: req.params.name }) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.patch('/relationships/perspectives/:id', requireAuth, (req, res) => {
    const perspective = store.updatePerspective(req.params.id, req.body || {});
    if (!perspective) return res.status(404).json({ error: 'perspective not found' });
    res.json({ ok: true, perspective });
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
    res.json(store.experienceStreamSnapshot({ limit: req.query.limit }));
  });
  app.get('/continuity-handoffs', requireAuth, (req, res) => {
    res.json(store.continuityHandoffSnapshot());
  });
  app.post('/intelligence/cycles', requireAuth, (req, res) => {
    try {
      const authoritativeInputs = getCognitiveInputs();
      const cognitiveInput = { ...authoritativeInputs, ...(req.body || {}),
        inner_thread: authoritativeInputs.inner_thread || null,
        soma: authoritativeInputs.soma || null, wants: authoritativeInputs.wants || [], predictions: getPredictions(),
        resume_active: true };
      store.refreshCognition(cognitiveInput);
      const started = store.startCycle(cognitiveInput);
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
      res.json({ ok: true, ...visibleStarted, cognition: store.cognitionSnapshot(getPredictions()) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/intelligence/cycles/:id/reenter', requireAuth, (req, res) => {
    try {
      const result = store.reenterCycle(req.params.id, { ...getCognitiveInputs(), ...(req.body || {}), predictions: getPredictions() });
      if (!result) return res.status(404).json({ error: 'intelligence cycle not found' });
      if (store.interventionActive('recurrent_feedback')) return res.json({ ok: true, experimental_outcome_sealed: true, cycle_id: result.cycle?.id || req.params.id });
      res.json({ ok: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/intelligence/cycles/:id/self-forecast', requireAuth, async (req, res) => {
    let forecast = null;
    try {
      forecast = store.preregisterCycleSelfForecast(req.params.id, req.body || {});
      if (!forecast) return res.status(404).json({ error: 'intelligence cycle not found' });
      await store.persistStrict();
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
  app.patch('/intelligence/cycles/:id/complete', requireAuth, (req, res) => {
    try {
      const authoritativeInputs = getCognitiveInputs();
      const cycle = store.completeCycle(req.params.id, {
        ...(req.body || {}), substrate_at_close: authoritativeInputs.soma || null,
      });
      if (!cycle) return res.status(404).json({ error: 'intelligence cycle not found' });
      if (store.interventionActive('integrated_self_binding')) return res.json({ ok: true, cycle: { id: cycle.id, status: cycle.status, experimental_access_sealed: true } });
      res.json({ ok: true, cycle });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/cognition', requireAuth, (req, res) => res.json(store.cognitionSnapshot(getPredictions())));
  app.get('/goal-affect', requireAuth, (req, res) => res.json(store.goalAffectSnapshot()));
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
  app.get('/consciousness-research/status', requireAuth, (req, res) => res.json(store.consciousnessResearchStatus()));
  app.get('/consciousness-research/ledger', requireAuth, (req, res) => res.json(store.researchLedgerSnapshot()));
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
  app.get('/attention-schema', requireAuth, (req, res) => res.json(store.attentionSchemaSnapshot()));
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
  app.get('/agency', requireAuth, (req, res) => res.json(store.agencySnapshot()));
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
  app.get('/counterfactual-agency/experiments', requireAuth, (req, res) => res.json(store.counterfactualAgencySnapshot()));
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
  app.get('/interoception', requireAuth, (req, res) => res.json(store.interoceptionSnapshot()));
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
  app.post('/epistemic-ledger/positions', requireAuth, (req, res) => {
    try { res.json({ ok: true, proposition: store.recordEpistemicPosition(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
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
  app.get('/self-model', requireAuth, (req, res) => res.json(store.selfModelSnapshot()));
  app.get('/self-model/forecast-prior', requireAuth,
    (req, res) => res.json(store.behavioralSelfForecastPriorSnapshot()));
  app.get('/self-model/cycle-calibration', requireAuth,
    (req, res) => res.json(store.behavioralSelfCalibrationSnapshot()));
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
    try { res.json(getResearchAutopilotStatus()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
}

module.exports = { registerIntelligenceRoutes };
