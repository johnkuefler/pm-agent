'use strict';

const consciousWorkspace = require('../intelligence/conscious-workspace');

function publicFrame(frame, ledger = null) {
  if (!frame) return null;
  return {
    id: frame.id,
    mode: frame.mode,
    current_activity: frame.current_activity,
    why_this: frame.why_this,
    attention_candidates: frame.attention_candidates || [],
    selected_focus_key: frame.selected_focus_key,
    submitted_focus_key: frame.submitted_focus_key || frame.selected_focus_key,
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
    lifecycle: frame.lifecycle || null,
    changed_mind: frame.changed_mind || null,
    revision_of_frame_id: frame.revision_of_frame_id || null,
    revision_audit: frame.changed_mind && ledger
      ? consciousWorkspace.auditRevision(frame, ledger) : null,
    arbitration_receipt: frame.arbitration_receipt || null,
    arbitration_audit: frame.arbitration_receipt
      ? consciousWorkspace.auditArbitration(frame.arbitration_receipt) : null,
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

function publicFocusCommitment(record, ledger) {
  return { ...record, audit: consciousWorkspace.auditFocusCommitment(record, ledger) };
}

function publicFocusOutcome(record, ledger) {
  const manifest = record.cycle_outcome_manifest || {};
  return {
    id: record.id,
    focus_commitment_id: record.focus_commitment_id,
    frame_id: record.frame_id,
    cycle_id: record.cycle_id,
    selected_focus_key: record.selected_focus_key,
    outcome: record.outcome,
    observed_expression: record.observed_expression,
    evidence: record.evidence || [],
    cycle_outcome: {
      status: manifest.status || null,
      finished: manifest.finished || null,
      moment_id: manifest.moment_id || null,
      closure_commitment: manifest.closure_commitment || null,
      action_count: Array.isArray(manifest.actions) ? manifest.actions.length : 0,
    },
    cycle_outcome_commitment: record.cycle_outcome_commitment,
    outcome_commitment: record.outcome_commitment,
    resolved_by: record.resolved_by,
    resolved_at: record.resolved_at,
    audit: consciousWorkspace.auditFocusOutcome(record, ledger),
  };
}

function durableMindChangeInput(frame, ledger) {
  const changed = frame?.changed_mind;
  const receipt = changed?.revision_receipt;
  if (!receipt || !consciousWorkspace.auditRevision(frame, ledger).complete_chain_verified) return null;
  const prior = ledger.frames.find(item => item.id === receipt.prior_frame_id);
  const priorScore = prior?.arbitration_receipt?.scored_candidates
    ?.find(item => item.key === receipt.from_key)?.final_score;
  const nextScore = frame.arbitration_receipt?.scored_candidates
    ?.find(item => item.key === receipt.to_key)?.final_score;
  return {
    id: `mind-workspace-${receipt.receipt_commitment.slice(0, 32)}`,
    prior_belief: changed.from,
    prior_confidence: priorScore,
    new_belief: changed.to,
    new_confidence: nextScore,
    reason: changed.because,
    evidence: [
      { type: 'conscious_workspace_frame', id: prior.id },
      ...receipt.feedback.map(item => ({ type: 'workspace_feedback', id: item.id })),
      { type: 'conscious_workspace_frame', id: frame.id },
    ],
    created: prior.created_at,
    resolved: frame.created_at,
  };
}

function registerConsciousWorkspaceRoutes(app, deps) {
  const { requireAuth, loadConsciousWorkspace, saveConsciousWorkspace,
    getWants = () => [], getWantHistoryIntegrity = () => null,
    loadConsequenceReviews = () => ({ actions: [], observations: [], applications: [] }),
    getSoma = () => ({}), getEpistemicAgenda = () => ({}),
    getRelationalContext = () => ({}), recordMindChange = null } = deps;

  app.get('/conscious-workspace', requireAuth, (req, res) => {
    const ledger = loadConsciousWorkspace();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json({
      report: consciousWorkspace.report(ledger),
      current: publicFrame(ledger.current, ledger),
      recent_frames: ledger.frames.slice(-limit).map(frame => publicFrame(frame, ledger)),
      recent_feedback: ledger.feedback.slice(-limit).map(publicFeedback),
      recent_focus_commitments: ledger.focus_commitments.slice(-limit)
        .map(record => publicFocusCommitment(record, ledger)),
      recent_focus_outcomes: ledger.focus_outcomes.slice(-limit)
        .map(record => publicFocusOutcome(record, ledger)),
    });
  });

  app.post('/conscious-workspace/frames', requireAuth, async (req, res) => {
    try {
      const result = consciousWorkspace.createFrame(req.body || {}, loadConsciousWorkspace(), {
        context: {
          wants: getWants(),
          wantHistoryIntegrity: getWantHistoryIntegrity(),
          consequenceLedger: loadConsequenceReviews(),
          soma: getSoma(),
          epistemicAgendaSnapshot: getEpistemicAgenda(),
          relationalContext: getRelationalContext(),
        },
      });
      await saveConsciousWorkspace(result.ledger);
      let durableMindChange = null;
      const mindChangeInput = durableMindChangeInput(result.frame, result.ledger);
      if (mindChangeInput && typeof recordMindChange === 'function') {
        durableMindChange = recordMindChange(mindChangeInput);
      }
      res.json({ ok: true, frame: publicFrame(result.frame, result.ledger),
        durable_mind_change: durableMindChange, report: result.report });
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

  app.post('/conscious-workspace/focus-commitments', requireAuth, async (req, res) => {
    try {
      const result = consciousWorkspace.commitFocus(req.body || {}, loadConsciousWorkspace());
      if (result.created) await saveConsciousWorkspace(result.ledger);
      res.json({ ok: true,
        focus_commitment: publicFocusCommitment(result.focus_commitment, result.ledger),
        report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

module.exports = { publicFrame, publicFeedback, publicFocusCommitment, publicFocusOutcome,
  durableMindChangeInput,
  registerConsciousWorkspaceRoutes };
