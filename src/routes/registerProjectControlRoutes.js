'use strict';

const projectControl = require('../intelligence/project-control');
const projectAutopilot = require('../intelligence/project-autopilot');
const runSummaryPolicy = require('../intelligence/run-summary-policy');

function registerProjectControlRoutes(app, deps) {
  const {
    requireAuth,
    requireOperatorAuth,
    loadProjectControl,
    saveProjectControl,
    getInitiativeStatus,
    spendInitiative,
    hydrateProjectStories,
    getProjectHydrationStatus,
  } = deps;
  const mutateProjectControl = deps.mutateProjectControl || (async operation => {
    const result = await operation(loadProjectControl());
    await saveProjectControl(result.ledger);
    return result;
  });

  app.get('/pm-control/report', requireAuth, (_req, res) => {
    res.json(projectControl.report(loadProjectControl()));
  });

  app.get('/pm-control', requireAuth, (_req, res) => {
    const ledger = loadProjectControl();
    res.json({ report: projectControl.report(ledger), ledger });
  });

  app.get('/pm-control/projects', requireAuth, (req, res) => {
    const ledger = loadProjectControl();
    const health = req.query.health ? String(req.query.health).toLowerCase() : '';
    const projects = health ? ledger.projects.filter(item => item.health === health) : ledger.projects;
    res.json({ count: projects.length, projects });
  });

  app.put('/pm-control/projects/:key', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.upsertProject(ledger,
        { ...(req.body || {}), key: req.params.key }));
      res.json({ ok: true, project: result.project, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/risks', requireAuth, (req, res) => {
    const ledger = loadProjectControl();
    const status = req.query.status ? String(req.query.status).toLowerCase() : '';
    const projectKey = req.query.project_key ? String(req.query.project_key).toLowerCase() : '';
    let risks = ledger.risks;
    if (status) risks = risks.filter(item => item.status === status);
    if (projectKey) risks = risks.filter(item => item.project_key === projectKey);
    res.json({ count: risks.length, risks });
  });

  app.post('/pm-control/risks', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.createRisk(ledger, req.body || {}));
      res.json({ ok: true, risk: result.risk, idempotent: result.idempotent, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/pm-control/risks/:id', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.updateRisk(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, risk: result.risk, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/decisions', requireAuth, (req, res) => {
    const ledger = loadProjectControl();
    const projectKey = req.query.project_key ? String(req.query.project_key).toLowerCase() : '';
    const decisions = projectKey
      ? ledger.decisions.filter(item => item.project_key === projectKey) : ledger.decisions;
    res.json({ count: decisions.length, decisions });
  });

  app.post('/pm-control/decisions', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.recordDecision(ledger, req.body || {}));
      res.json({ ok: true, decision: result.decision, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/interventions', requireAuth, (req, res) => {
    const ledger = loadProjectControl();
    const status = req.query.status ? String(req.query.status).toLowerCase() : '';
    const lane = req.query.lane ? String(req.query.lane).toLowerCase() : '';
    let interventions = ledger.interventions;
    if (status) interventions = interventions.filter(item => item.status === status);
    if (lane) interventions = interventions.filter(item => item.lane === lane);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ count: interventions.length, interventions: interventions.slice(-limit) });
  });

  app.post('/pm-control/interventions/plan', requireAuth, async (req, res) => {
    try {
      const initiative = getInitiativeStatus('cowork:proactive');
      const result = await mutateProjectControl(ledger => projectControl.planIntervention(
        ledger, req.body || {}, { initiative }));
      res.json({ ok: true, intervention: result.intervention, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/interventions/:id/authorize', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => {
        const intervention = ledger.interventions.find(item => item.id === req.params.id);
        if (!intervention) throw new Error('project intervention not found');
        const scope = ledger.policy.human_budget_scope || 'cowork:proactive';
        const initiative = getInitiativeStatus(scope);
        const evaluation = projectControl.evaluateIntervention(ledger, intervention, { initiative });
        let reservation = null;
        if (evaluation.allowed && evaluation.uses_human_budget) {
          reservation = spendInitiative(scope, {
            kind: 'pm_intervention',
            intervention_id: intervention.id,
            project_key: intervention.project_key,
            recipient: intervention.recipient,
            subject_ref: intervention.subject_ref,
          });
        }
        return projectControl.authorizeIntervention(ledger, intervention.id,
          { initiative_reservation: reservation }, { initiative });
      });
      const status = result.intervention.status === 'authorized' ? 200 : 409;
      res.status(status).json({ ok: status === 200, intervention: result.intervention, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/interventions/:id/execute', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.executeIntervention(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, intervention: result.intervention, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/interventions/:id/observe', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.observeIntervention(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, intervention: result.intervention, outcome: result.outcome,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/evaluation', requireAuth, (_req, res) => {
    const ledger = loadProjectControl();
    res.json({ ...projectControl.shadowEvaluation(ledger),
      quality: projectControl.qualityEvaluation(ledger) });
  });

  app.get('/pm-control/hydration', requireAuth, (_req, res) => {
    res.json(getProjectHydrationStatus ? getProjectHydrationStatus() : { state: 'unavailable' });
  });

  app.post('/pm-control/hydrate/teamwork', requireAuth, async (req, res) => {
    try {
      if (!hydrateProjectStories) throw new Error('Teamwork project hydration is unavailable');
      const result = await hydrateProjectStories({ dryRun: req.body?.dry_run === true,
        signal: req.deadlineSignal });
      const { ledger: _ledger, ...response } = result;
      res.json({ ok: true, ...response });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/run-summary/evaluate', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => runSummaryPolicy.recordRunSummaryEvaluation(
        ledger, req.body || {}));
      res.json(result.evaluation);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/syncs', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.recordSync(ledger, req.body || {}));
      res.json({ ok: true, sync: result.sync, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/autopilot/report', requireAuth, (_req, res) => {
    res.json(projectAutopilot.report(loadProjectControl()));
  });

  app.get('/pm-control/autopilot/charters', requireAuth, (_req, res) => {
    const ledger = loadProjectControl();
    const charters = projectAutopilot.normalizeState(ledger.autopilot).charters;
    res.json({ count: charters.length, charters });
  });

  app.get('/pm-control/autopilot/projects/:key', requireAuth, (req, res) => {
    res.json(projectAutopilot.projectView(loadProjectControl(), req.params.key));
  });

  app.put('/pm-control/autopilot/charters/:key', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.upsertCharter(
        ledger, req.params.key, req.body || {}, { actor: 'operator-dashboard' }));
      res.json({ ok: true, charter: result.charter, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/charters/:key/activate', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.activateCharter(
        ledger, req.params.key, req.body || {}, { actor: 'operator-dashboard' }));
      res.json({ ok: true, charter: result.charter, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/charters/:key/pause', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.pauseCharter(
        ledger, req.params.key, req.body || {}, { actor: 'operator-dashboard' }));
      res.json({ ok: true, charter: result.charter, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/reconcile', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.reconcilePortfolio(
        ledger, { project_key: req.body?.project_key || '', source: req.body?.source || 'requested_reconcile' }));
      res.json({ ok: true, reconciliation: result.reconciliation, events: result.events,
        actions: result.actions, resolved_events: result.resolved_events, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/autopilot/actions', requireAuth, (req, res) => {
    const actions = projectAutopilot.normalizeState(loadProjectControl().autopilot).actions;
    const projectKey = req.query.project_key ? String(req.query.project_key).toLowerCase() : '';
    const state = req.query.state ? String(req.query.state).toLowerCase() : '';
    const filtered = actions.filter(item => (!projectKey || item.project_key === projectKey)
      && (!state || item.state === state));
    res.json({ count: filtered.length, actions: filtered.slice(-500) });
  });

  app.post('/pm-control/autopilot/actions/:id/authorize', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.authorizeAction(
        ledger, req.params.id, req.body || {}, { actor: 'Nora' }));
      res.json({ ok: true, action: result.action, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/actions/:id/approve', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.authorizeAction(
        ledger, req.params.id, req.body || {}, { operator: true, actor: 'operator-dashboard' }));
      res.json({ ok: true, action: result.action, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/actions/:id/execute', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.executeAction(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, action: result.action, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/actions/:id/observe', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.observeAction(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, action: result.action, observation: result.observation,
        idempotent: result.idempotent, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/pm-control/autopilot/meetings', requireAuth, (req, res) => {
    const meetings = projectAutopilot.normalizeState(loadProjectControl().autopilot).meetings;
    const projectKey = req.query.project_key ? String(req.query.project_key).toLowerCase() : '';
    const state = req.query.state ? String(req.query.state).toLowerCase() : '';
    const filtered = meetings.filter(item => (!projectKey || item.project_key === projectKey)
      && (!state || item.state === state));
    res.json({ count: filtered.length, meetings: filtered.slice(-500) });
  });

  app.post('/pm-control/autopilot/meetings', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.planMeeting(
        ledger, req.body || {}));
      res.json({ ok: true, meeting: result.meeting, report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/authorize', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.authorizeMeeting(
        ledger, req.params.id, req.body || {}, { actor: 'Nora' }));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/approve', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.authorizeMeeting(
        ledger, req.params.id, req.body || {}, { operator: true, actor: 'operator-dashboard' }));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/schedule', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.scheduleMeeting(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/join', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.joinMeeting(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/complete', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.completeMeeting(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/pm-control/autopilot/meetings/:id/reconcile', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectAutopilot.reconcileMeeting(
        ledger, req.params.id, req.body || {}));
      res.json({ ok: true, meeting: result.meeting, idempotent: result.idempotent,
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/pm-control/policy', requireOperatorAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.updatePolicy(ledger, req.body || {}));
      res.json({ ok: true, policy: result.policy });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { registerProjectControlRoutes };
