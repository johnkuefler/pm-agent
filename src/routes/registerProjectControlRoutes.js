'use strict';

const projectControl = require('../intelligence/project-control');

function registerProjectControlRoutes(app, deps) {
  const {
    requireAuth,
    requireOperatorAuth,
    loadProjectControl,
    saveProjectControl,
    getInitiativeStatus,
    spendInitiative,
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

  app.post('/pm-control/syncs', requireAuth, async (req, res) => {
    try {
      const result = await mutateProjectControl(ledger => projectControl.recordSync(ledger, req.body || {}));
      res.json({ ok: true, sync: result.sync, report: result.report });
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
