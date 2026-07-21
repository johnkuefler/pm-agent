'use strict';

const consciousWorkspace = require('../intelligence/conscious-workspace');

function publicFrame(frame) {
  if (!frame) return null;
  return {
    id: frame.id,
    mode: frame.mode,
    current_activity: frame.current_activity,
    why_this: frame.why_this,
    attention_candidates: frame.attention_candidates || [],
    selected_focus_key: frame.selected_focus_key,
    selected_focus_label: frame.selected_focus_label || '',
    active_want_refs: frame.active_want_refs || [],
    aversions: frame.aversions || [],
    uncertainties: frame.uncertainties || [],
    inhibited_actions: frame.inhibited_actions || [],
    intended_next_action: frame.intended_next_action || '',
    soma_constraints: frame.soma_constraints || [],
    epistemic_claim_refs: frame.epistemic_claim_refs || [],
    relationship_refs: frame.relationship_refs || [],
    consequence_watchlist: frame.consequence_watchlist || [],
    changed_mind: frame.changed_mind || null,
    evidence: frame.evidence || [],
    frame_commitment: frame.frame_commitment,
    created_by: frame.created_by,
    created_at: frame.created_at,
  };
}

function publicFeedback(feedback) {
  return {
    id: feedback.id,
    frame_id: feedback.frame_id,
    signal: feedback.signal,
    effect: feedback.effect,
    evidence: feedback.evidence || [],
    feedback_commitment: feedback.feedback_commitment,
    recorded_by: feedback.recorded_by,
    recorded_at: feedback.recorded_at,
  };
}

function registerConsciousWorkspaceRoutes(app, deps) {
  const { requireAuth, loadConsciousWorkspace, saveConsciousWorkspace } = deps;

  app.get('/conscious-workspace', requireAuth, (req, res) => {
    const ledger = loadConsciousWorkspace();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({
      report: consciousWorkspace.report(ledger),
      current: publicFrame(ledger.current),
      recent_frames: ledger.frames.slice(-limit).map(publicFrame),
      recent_feedback: ledger.feedback.slice(-limit).map(publicFeedback),
    });
  });

  app.post('/conscious-workspace/frames', requireAuth, async (req, res) => {
    try {
      const result = consciousWorkspace.createFrame(req.body || {}, loadConsciousWorkspace());
      await saveConsciousWorkspace(result.ledger);
      res.json({ ok: true, frame: publicFrame(result.frame), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/conscious-workspace/feedback', requireAuth, async (req, res) => {
    try {
      const result = consciousWorkspace.addFeedback(req.body || {}, loadConsciousWorkspace());
      await saveConsciousWorkspace(result.ledger);
      res.json({ ok: true, feedback: publicFeedback(result.feedback), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicFrame, publicFeedback, registerConsciousWorkspaceRoutes };
