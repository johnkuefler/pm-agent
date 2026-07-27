'use strict';

const consciousWorkspace = require('../intelligence/conscious-workspace');
const interactionOutcomeReview = require('../intelligence/interaction-outcome-review-autopilot');

const PRIVILEGED_AUTHORITY_CLASSES = new Set(['bounded', 'required']);
const REVIEW_OUTCOME_EFFECT = Object.freeze({
  landed: 'supported',
  appreciated: 'supported',
  neutral: 'unclear',
  ignored: 'unclear',
  corrected: 'contradicted',
});

function unavailableOperatorAuth(_req, res) {
  return res.status(503).json({ error: 'operator authentication is not configured' });
}

function frameRequestsPrivilegedAuthority(input = {}) {
  return (Array.isArray(input.attention_candidates) ? input.attention_candidates : [])
    .some(candidate => PRIVILEGED_AUTHORITY_CLASSES.has(
      String(candidate?.authority_class || '').trim().toLowerCase()));
}

function frameWriteGuard(requireOperatorAuth) {
  return (req, res, next) => {
    const input = req.body || {};
    const candidateKeys = (Array.isArray(input.attention_candidates)
      ? input.attention_candidates : [])
      .map(candidate => String(candidate?.key || candidate?.id || '').trim())
      .filter(Boolean);
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      return res.status(400).json({
        error: 'workspace attention candidate keys must be unique',
      });
    }
    if (input.lifecycle != null) {
      return res.status(400).json({
        error: 'workspace lifecycle is server-derived and cannot be supplied through the API',
      });
    }
    if (/^cw-lifecycle-/i.test(String(input.id || '').trim())) {
      return res.status(400).json({
        error: 'workspace lifecycle frame ids are reserved for the server runtime',
      });
    }
    if (frameRequestsPrivilegedAuthority(input)) {
      return requireOperatorAuth(req, res, next);
    }
    return next();
  };
}

function frameInputForAuthority(input = {}, operatorApproved = false, ledger = null) {
  const { lifecycle: _lifecycle, created_by: _createdBy, ...safeInput } = input;
  const priorFrameId = String(input.revision_of_frame_id || '').trim();
  const priorFrame = !operatorApproved && priorFrameId
    ? (Array.isArray(ledger?.frames) ? ledger.frames : [])
      .find(frame => String(frame?.id || '') === priorFrameId)
    : null;
  const priorSelected = priorFrame?.attention_candidates?.find(candidate =>
    candidate.key === priorFrame.selected_focus_key);
  const inheritedAuthority = PRIVILEGED_AUTHORITY_CLASSES.has(priorSelected?.authority_class)
    ? priorSelected : null;
  return {
    ...safeInput,
    attention_candidates: (Array.isArray(input.attention_candidates)
      ? input.attention_candidates : []).map(candidate => {
      if (inheritedAuthority
        && String(candidate?.key || candidate?.id || '').trim() === inheritedAuthority.key) {
        return { ...inheritedAuthority };
      }
      return {
        ...candidate,
        authority_class: operatorApproved
          ? (candidate?.authority_class || 'optional')
          : 'optional',
      };
    }),
    created_by: operatorApproved ? 'Dashboard operator' : 'Nora autonomous',
  };
}

function verifiedAutonomousFeedback(input = {}, interactions = [],
  verifyReceipt = interactionOutcomeReview.verifyAutomatedReviewReceipt, ledger = null) {
  const refs = Array.isArray(input.evidence) ? input.evidence : [];
  const interactionRefs = refs.filter(ref =>
    ['interaction', 'reviewed_interaction'].includes(String(ref?.type || '').trim())
      && String(ref?.id || '').trim());
  if (interactionRefs.length !== 1) return null;
  const interactionId = String(interactionRefs[0].id).trim();
  const interaction = (Array.isArray(interactions) ? interactions : [])
    .find(item => String(item?.id || '') === interactionId);
  const frameId = String(input.frame_id || ledger?.current?.id || '').trim();
  const frame = (Array.isArray(ledger?.frames) ? ledger.frames : [])
    .find(item => String(item?.id || '') === frameId);
  const frameCreatedAt = new Date(frame?.created_at || '').getTime();
  const reviewedAt = new Date(interaction?.reviewed_at || '').getTime();
  if (!interaction || interaction.reviewed !== true || !interaction.automated_review_receipt
    || !Number.isFinite(frameCreatedAt) || !Number.isFinite(reviewedAt)
    || reviewedAt < frameCreatedAt
    || verifyReceipt(interaction, interaction.automated_review_receipt) !== true) return null;
  const defaultEffect = REVIEW_OUTCOME_EFFECT[interaction.outcome];
  if (!defaultEffect || !String(interaction.signal || '').trim()) return null;
  const requestedEffect = String(input.effect || '').trim().toLowerCase();
  const effect = interaction.outcome === 'corrected'
    && ['contradicted', 'redirected'].includes(requestedEffect)
    ? requestedEffect : defaultEffect;
  return {
    frame_id: frame.id,
    signal: String(interaction.signal).trim(),
    effect,
    evidence: [{
      type: 'interaction',
      id: interactionId,
      note: `replay-verified automated review ${interaction.automated_review_receipt.receipt_commitment}`,
    }],
    recorded_by: 'Nora verified outcome',
  };
}

function feedbackWriteGuard({ requireOperatorAuth, loadConsciousWorkspace,
  loadInteractions, verifyReceipt }) {
  return (req, res, next) => {
    let verified = null;
    try {
      verified = verifiedAutonomousFeedback(req.body || {}, loadInteractions(), verifyReceipt,
        loadConsciousWorkspace());
    } catch {
      verified = null;
    }
    if (verified) {
      req.verifiedWorkspaceFeedback = verified;
      return next();
    }
    return requireOperatorAuth(req, res, next);
  };
}

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
  const { requireAuth, requireOperatorAuth = unavailableOperatorAuth,
    loadConsciousWorkspace, saveConsciousWorkspace,
    getWants = () => [], getWantHistoryIntegrity = () => null,
    loadConsequenceReviews = () => ({ actions: [], observations: [], applications: [] }),
    getSoma = () => ({}), getEpistemicAgenda = () => ({}),
    getRelationalContext = () => ({}), recordMindChange = null,
    loadInteractions = () => [],
    verifyAutomatedReviewReceipt = interactionOutcomeReview.verifyAutomatedReviewReceipt } = deps;

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

  app.post('/conscious-workspace/frames', requireAuth,
    frameWriteGuard(requireOperatorAuth), async (req, res) => {
    try {
      const ledger = loadConsciousWorkspace();
      const input = frameInputForAuthority(req.body || {},
        req.operatorAuthority === 'dashboard', ledger);
      const result = consciousWorkspace.createFrame(input, ledger, {
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

  app.post('/conscious-workspace/feedback', requireAuth,
    feedbackWriteGuard({ requireOperatorAuth, loadConsciousWorkspace, loadInteractions,
      verifyReceipt: verifyAutomatedReviewReceipt }), async (req, res) => {
    try {
      const operatorApproved = req.operatorAuthority === 'dashboard';
      const input = operatorApproved
        ? { ...(req.body || {}), recorded_by: 'Dashboard operator' }
        : { ...(req.body || {}), ...req.verifiedWorkspaceFeedback };
      const result = consciousWorkspace.addFeedback(input, loadConsciousWorkspace());
      await saveConsciousWorkspace(result.ledger);
      res.json({ ok: true, feedback: publicFeedback(result.feedback), report: result.report });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/conscious-workspace/focus-commitments', requireAuth, async (req, res) => {
    try {
      const result = consciousWorkspace.commitFocus({
        ...(req.body || {}),
        committed_by: 'Nora autonomous',
      }, loadConsciousWorkspace());
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
  durableMindChangeInput, frameInputForAuthority, frameRequestsPrivilegedAuthority,
  frameWriteGuard, feedbackWriteGuard, verifiedAutonomousFeedback,
  registerConsciousWorkspaceRoutes };
