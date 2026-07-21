'use strict';

const consequenceReview = require('../intelligence/consequence-review');

function publicAction(action) {
  if (!action) return null;
  return {
    id: action.id,
    status: action.status,
    action_type: action.action_type,
    description: action.description,
    intended_effect: action.intended_effect,
    success_criteria: action.success_criteria,
    expected_signal: action.expected_signal || '',
    beneficiary: action.beneficiary || '',
    target_ref: action.target_ref || '',
    source_ref: action.source_ref || '',
    workspace_frame_id: action.workspace_frame_id || '',
    epistemic_claim_refs: action.epistemic_claim_refs || [],
    evidence: action.evidence || [],
    consequence_due: action.consequence_due,
    latest_review_due: action.latest_review_due || null,
    effective_review_due: action.latest_review_due || action.consequence_due,
    latest_outcome: action.latest_outcome || null,
    latest_observation_id: action.latest_observation_id || null,
    latest_observation_at: action.latest_observation_at || null,
    behavior_update: action.behavior_update || '',
    action_commitment: action.action_commitment,
    created_by: action.created_by,
    created_at: action.created_at,
    closed_reason: action.closed_reason || '',
    closed_by: action.closed_by || '',
    closed_at: action.closed_at || '',
    close_commitment: action.close_commitment || '',
  };
}

function publicObservation(observation) {
  if (!observation) return null;
  return {
    id: observation.id,
    action_id: observation.action_id,
    outcome: observation.outcome,
    observed_effect: observation.observed_effect,
    evidence: observation.evidence || [],
    should_change_behavior: Boolean(observation.should_change_behavior),
    behavior_update: observation.behavior_update || '',
    followup_action: observation.followup_action || '',
    next_review_due: observation.next_review_due || null,
    observation_commitment: observation.observation_commitment,
    observed_by: observation.observed_by,
    observed_at: observation.observed_at,
  };
}

function registerConsequenceReviewRoutes(app, deps) {
  const { requireAuth, loadConsequenceReviews, saveConsequenceReviews } = deps;

  app.get('/consequence-reviews/report', requireAuth, (req, res) => {
    res.json(consequenceReview.report(loadConsequenceReviews()));
  });

  app.get('/consequence-reviews/actions', requireAuth, (req, res) => {
    const ledger = loadConsequenceReviews();
    const status = req.query.status ? String(req.query.status) : '';
    const type = req.query.type ? String(req.query.type) : '';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const includeFuture = String(req.query.include_future || '').toLowerCase() === 'true';
    let actions = ledger.actions;
    if (status === 'due') actions = consequenceReview.dueActions(ledger, { limit });
    else if (status) actions = actions.filter(action => action.status === status);
    if (type) actions = actions.filter(action => action.action_type === type);
    if (!includeFuture && (status === 'open' || status === 'due')) {
      actions = actions.filter(action => new Date(action.latest_review_due
        || action.consequence_due).getTime() <= Date.now());
    }
    res.json({
      report: consequenceReview.report(ledger),
      actions: actions
        .sort((a, b) => String(a.latest_review_due || a.consequence_due)
          .localeCompare(String(b.latest_review_due || b.consequence_due)))
        .slice(0, limit)
        .map(publicAction),
    });
  });

  app.get('/consequence-reviews/actions/:id', requireAuth, (req, res) => {
    const ledger = loadConsequenceReviews();
    const action = ledger.actions.find(item => item.id === req.params.id);
    if (!action) return res.status(404).json({ error: 'consequence action not found' });
    res.json({
      action: publicAction(action),
      observations: ledger.observations
        .filter(item => item.action_id === action.id)
        .map(publicObservation),
    });
  });

  app.post('/consequence-reviews/actions', requireAuth, async (req, res) => {
    try {
      const result = consequenceReview.createAction(req.body || {}, loadConsequenceReviews());
      await saveConsequenceReviews(result.ledger);
      res.json({ ok: true, action: publicAction(result.action), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/consequence-reviews/actions/:id/observe', requireAuth, async (req, res) => {
    try {
      const result = consequenceReview.observeAction(loadConsequenceReviews(), req.params.id, req.body || {});
      await saveConsequenceReviews(result.ledger);
      res.json({
        ok: true,
        action: publicAction(result.action),
        observation: publicObservation(result.observation),
        report: result.report,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/consequence-reviews/actions/:id/close', requireAuth, async (req, res) => {
    try {
      const result = consequenceReview.closeAction(loadConsequenceReviews(), req.params.id, req.body || {});
      await saveConsequenceReviews(result.ledger);
      res.json({ ok: true, action: publicAction(result.action), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicAction, publicObservation, registerConsequenceReviewRoutes };
