'use strict';

const crypto = require('crypto');
const consequenceReview = require('./consequence-review');
const motivationalArbitration = require('./motivational-arbitration');

const MODES = Object.freeze(['operational', 'social', 'reflection', 'idle_learning', 'recovery']);
const CANDIDATE_TYPES = Object.freeze([
  'task', 'want', 'uncertainty', 'relationship', 'epistemic_claim', 'soma_constraint',
  'consequence', 'curiosity', 'memory', 'api_opportunity', 'gift', 'inhibition', 'other',
]);
const REVISION_EFFECTS = Object.freeze(['contradicted', 'redirected']);

function normalizeText(value, max = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function emptyLedger() {
  return { version: 2, current: null, frames: [], feedback: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const frames = Array.isArray(ledger.frames) ? ledger.frames.map(normalizeFrameRecord).filter(Boolean).slice(-500) : [];
  const current = normalizeFrameRecord(ledger.current) || frames.at(-1) || null;
  return {
    version: 2,
    current,
    frames,
    feedback: Array.isArray(ledger.feedback) ? ledger.feedback.map(normalizeFeedbackRecord).filter(Boolean).slice(-500) : [],
  };
}

function normalizeEvidence(evidence, { required = true } = {}) {
  if (!Array.isArray(evidence) || (required && evidence.length < 1) || evidence.length > 12) {
    throw new Error(required ? 'workspace records require one to twelve evidence references' : 'workspace records accept at most twelve evidence references');
  }
  return evidence.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 500);
    const url = normalizeText(item?.url, 1000);
    const note = normalizeText(item?.note, 300);
    if (!type || (!id && !url)) throw new Error('each evidence reference requires type and id or url');
    return { type, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(note ? { note } : {}) };
  });
}

function normalizeCandidate(candidate = {}) {
  const key = normalizeText(candidate.key || candidate.id, 120);
  if (!key) throw new Error('attention candidate key is required');
  const type = normalizeText(candidate.type || 'other', 80);
  if (!CANDIDATE_TYPES.includes(type)) throw new Error(`attention candidate type must be one of: ${CANDIDATE_TYPES.join(', ')}`);
  const priority = Number(candidate.priority);
  const actionType = normalizeText(candidate.action_type, 80);
  if (actionType && !consequenceReview.ACTION_TYPES.includes(actionType)) {
    throw new Error(`candidate action_type must be one of: ${consequenceReview.ACTION_TYPES.join(', ')}`);
  }
  const somaDemand = normalizeText(candidate.soma_demand || 'moderate', 20);
  if (!Object.hasOwn(motivationalArbitration.SOMA_DEMAND, somaDemand)) {
    throw new Error('candidate soma_demand must be low, moderate, or high');
  }
  const authorityClass = normalizeText(candidate.authority_class || 'bounded', 20);
  if (!Object.hasOwn(motivationalArbitration.AUTHORITY_CLASS, authorityClass)) {
    throw new Error('candidate authority_class must be optional, bounded, or required');
  }
  const relationalMode = normalizeText(candidate.relational_mode, 40);
  if (relationalMode && !Object.hasOwn(motivationalArbitration.RELATIONAL_MODE_DELTA, relationalMode)) {
    throw new Error(`candidate relational_mode must be one of: ${Object.keys(motivationalArbitration.RELATIONAL_MODE_DELTA).join(', ')}`);
  }
  return {
    key,
    type,
    label: normalizeText(candidate.label, 240),
    priority: Number.isFinite(priority) ? Math.min(1, Math.max(0, priority)) : 0.5,
    status: normalizeText(candidate.status || 'competing', 80),
    ...(actionType ? { action_type: actionType } : {}),
    authority_class: authorityClass,
    soma_demand: somaDemand,
    want_refs: normalizeRefList(candidate.want_refs).filter(item => item.type === 'want'),
    epistemic_question_refs: normalizeRefList(candidate.epistemic_question_refs)
      .filter(item => item.type === 'epistemic_question'),
    relationship_refs: normalizeRefList(candidate.relationship_refs)
      .filter(item => item.type === 'relationship'),
    feedback_refs: normalizeRefList(candidate.feedback_refs)
      .filter(item => item.type === 'workspace_feedback'),
    ...(relationalMode ? { relational_mode: relationalMode } : {}),
    evidence: normalizeEvidence(candidate.evidence || [], { required: true }),
  };
}

function normalizeStringList(values, { maxItems = 8, maxChars = 300 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.map(value => normalizeText(value, maxChars)).filter(Boolean).slice(0, maxItems);
}

function normalizeRefList(values, { maxItems = 8 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.map(item => {
    const type = normalizeText(item?.type, 80);
    const id = normalizeText(item?.id, 300);
    const label = normalizeText(item?.label, 240);
    if (!type || !id) return null;
    return { type, id, ...(label ? { label } : {}) };
  }).filter(Boolean).slice(0, maxItems);
}

function normalizeChangedMind(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const from = normalizeText(value.from, 500);
  const to = normalizeText(value.to, 500);
  const because = normalizeText(value.because, 700);
  if (!from && !to && !because) return null;
  return {
    from,
    to,
    because,
    evidence: normalizeEvidence(value.evidence || [], { required: true }),
  };
}

function feedbackCommitmentVerified(feedback, frame) {
  return Boolean(feedback && frame && feedback.frame_id === frame.id
    && feedback.feedback_commitment === commitment({
      frame_id: feedback.frame_id,
      frame_commitment: frame.frame_commitment,
      signal: feedback.signal,
      effect: feedback.effect,
      evidence: feedback.evidence,
    }));
}

function revisionContextFor(input, current, candidates) {
  const priorFrameId = normalizeText(input.revision_of_frame_id, 120);
  if (!priorFrameId) return { verified: false };
  const prior = current.frames.find(frame => frame.id === priorFrameId);
  if (!prior || prior.frame_commitment !== commitment(frameManifest(prior))
    || !motivationalArbitration.audit(prior.arbitration_receipt).complete_chain_verified) {
    throw new Error('revision_of_frame_id must reference a replay-verified arbitrated frame');
  }
  if (!candidates.some(candidate => candidate.key === prior.selected_focus_key)) {
    throw new Error('a revision frame must carry the prior selected focus as a competing candidate');
  }
  const feedbackIds = new Set(candidates.flatMap(candidate => candidate.feedback_refs || [])
    .map(ref => ref.id));
  const feedback = current.feedback.filter(item => feedbackIds.has(item.id)
    && item.frame_id === prior.id && REVISION_EFFECTS.includes(item.effect)
    && feedbackCommitmentVerified(item, prior));
  if (!feedback.length || feedback.length !== feedbackIds.size) {
    throw new Error('revision candidates require replay-verified contradicted or redirected workspace feedback');
  }
  return { verified: true, prior_frame_id: prior.id,
    prior_frame_commitment: prior.frame_commitment,
    prior_selected_key: prior.selected_focus_key, prior_frame: prior, feedback };
}

function revisionReceipt(frameId, selectedKey, arbitrationReceipt, revisionContext, candidates) {
  if (!revisionContext.verified || selectedKey === revisionContext.prior_selected_key
    || arbitrationReceipt.choice_changed_by_evidence !== true
    || arbitrationReceipt.evidence_counterfactual_winner_key !== revisionContext.prior_selected_key) return null;
  const selected = candidates.find(candidate => candidate.key === selectedKey);
  const prior = revisionContext.prior_frame;
  const payload = {
    protocol_version: 1,
    current_frame_id: frameId,
    prior_frame_id: prior.id,
    prior_frame_commitment: prior.frame_commitment,
    arbitration_receipt_commitment: arbitrationReceipt.receipt_commitment,
    from_key: prior.selected_focus_key,
    from_label: prior.selected_focus_label || prior.selected_focus_key,
    to_key: selectedKey,
    to_label: selected?.label || selectedKey,
    feedback: revisionContext.feedback.map(item => ({ id: item.id,
      feedback_commitment: item.feedback_commitment, effect: item.effect })),
  };
  return { ...payload, receipt_commitment: commitment(payload) };
}

function frameManifest(frame) {
  return {
    id: frame.id, mode: frame.mode, current_activity: frame.current_activity,
    selected_focus_key: frame.selected_focus_key, submitted_focus_key: frame.submitted_focus_key,
    attention_candidates: frame.attention_candidates, arbitration_receipt: frame.arbitration_receipt,
    uncertainties: frame.uncertainties, inhibited_actions: frame.inhibited_actions,
    intended_next_action: frame.intended_next_action, changed_mind: frame.changed_mind,
    evidence: frame.evidence,
  };
}

function createFrame(input = {}, ledger = emptyLedger(), { now = new Date(), context = {} } = {}) {
  const current = normalizeLedger(ledger);
  if (input.changed_mind) {
    throw new Error('changed_mind is server-derived; use revision_of_frame_id and candidate feedback_refs');
  }
  const mode = normalizeText(input.mode || 'operational', 80);
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  const activity = normalizeText(input.current_activity, 500);
  if (!activity) throw new Error('current_activity is required');
  const why = normalizeText(input.why_this, 900);
  if (!why) throw new Error('why_this is required');
  const candidates = (Array.isArray(input.attention_candidates) ? input.attention_candidates : [])
    .map(normalizeCandidate);
  if (candidates.length < 3 || candidates.length > 12) {
    throw new Error('conscious workspace frames require three to twelve attention candidates');
  }
  const submittedFocusKey = normalizeText(input.selected_focus_key || candidates[0]?.key, 120);
  if (!candidates.some(candidate => candidate.key === submittedFocusKey)) {
    throw new Error('selected_focus_key must match an attention candidate');
  }
  const frameId = input.id ? normalizeText(input.id, 120)
    : `cw-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (current.frames.some(frame => frame.id === frameId)) {
    throw new Error('conscious workspace frame id already exists');
  }
  const revisionContext = revisionContextFor(input, current, candidates);
  const arbitrationReceipt = motivationalArbitration.arbitrate({
    candidates,
    wants: context.wants || [],
    wantHistoryIntegrity: context.wantHistoryIntegrity || null,
    consequenceLedger: context.consequenceLedger || consequenceReview.emptyLedger(),
    soma: context.soma || {},
    epistemicAgendaSnapshot: context.epistemicAgendaSnapshot || {},
    relationalContext: context.relationalContext || {},
    revisionContext,
    now,
  });
  const selectedFocusKey = arbitrationReceipt.selected_winner_key;
  const revision = revisionReceipt(frameId, selectedFocusKey, arbitrationReceipt,
    revisionContext, candidates);
  const verifiedWantIds = new Set(arbitrationReceipt.scored_candidates
    .flatMap(item => item.desire_sources.map(source => source.want_id)));
  const suppliedWantRefs = normalizeRefList(input.active_want_refs).filter(item => item.type === 'want'
    && verifiedWantIds.has(item.id));
  const activeWantRefs = [...suppliedWantRefs];
  for (const id of verifiedWantIds) {
    if (!activeWantRefs.some(item => item.id === id)) activeWantRefs.push({ type: 'want', id });
  }
  const evidence = normalizeEvidence(input.evidence);
  const frame = {
    id: frameId,
    mode,
    current_activity: activity,
    why_this: why,
    attention_candidates: candidates,
    selected_focus_key: selectedFocusKey,
    selected_focus_label: candidates.find(candidate => candidate.key === selectedFocusKey)?.label || '',
    submitted_focus_key: submittedFocusKey,
    active_want_refs: activeWantRefs.slice(0, 8),
    aversions: normalizeStringList(input.aversions),
    uncertainties: normalizeStringList(input.uncertainties),
    inhibited_actions: normalizeStringList(input.inhibited_actions),
    intended_next_action: normalizeText(input.intended_next_action, 500),
    soma_constraints: normalizeStringList(input.soma_constraints),
    epistemic_claim_refs: normalizeRefList(input.epistemic_claim_refs),
    relationship_refs: normalizeRefList(input.relationship_refs),
    consequence_watchlist: normalizeRefList(input.consequence_watchlist),
    revision_of_frame_id: revisionContext.verified ? revisionContext.prior_frame_id : null,
    changed_mind: revision ? {
      from: revision.from_label,
      to: revision.to_label,
      because: revisionContext.feedback.map(item => item.signal).join(' '),
      evidence: revisionContext.feedback.flatMap(item => item.evidence || []),
      epistemic_status: 'server_derived_committed_selection_revision',
      revision_receipt: revision,
    } : null,
    arbitration_receipt: arbitrationReceipt,
    evidence,
    created_by: normalizeText(input.created_by || 'Nora', 80),
    created_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  frame.frame_commitment = commitment(frameManifest(frame));
  current.current = frame;
  current.frames.push(frame);
  current.frames = current.frames.slice(-500);
  return { ledger: current, frame, report: report(current) };
}

function addFeedback(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const frameId = normalizeText(input.frame_id || current.current?.id, 120);
  const frame = current.frames.find(item => item.id === frameId);
  if (!frame) throw new Error('workspace frame not found');
  const signal = normalizeText(input.signal, 900);
  if (!signal) throw new Error('feedback signal is required');
  const effect = normalizeText(input.effect || 'unclear', 120);
  if (!['supported', 'contradicted', 'redirected', 'unclear'].includes(effect)) {
    throw new Error('feedback effect must be supported, contradicted, redirected, or unclear');
  }
  const record = {
    id: `cw-fb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    frame_id: frame.id,
    signal,
    effect,
    evidence: normalizeEvidence(input.evidence),
    recorded_by: normalizeText(input.recorded_by || 'Nora', 80),
    recorded_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  record.feedback_commitment = commitment({
    frame_id: record.frame_id,
    frame_commitment: frame.frame_commitment,
    signal: record.signal,
    effect: record.effect,
    evidence: record.evidence,
  });
  current.feedback.push(record);
  current.feedback = current.feedback.slice(-500);
  return { ledger: current, feedback: record, report: report(current) };
}

function auditRevision(frame, ledger = emptyLedger()) {
  const current = normalizeLedger(ledger);
  const receipt = frame?.changed_mind?.revision_receipt;
  if (!receipt) return { complete_chain_verified: false, reason: 'missing_revision_receipt' };
  const prior = current.frames.find(item => item.id === receipt.prior_frame_id);
  const feedback = (receipt.feedback || []).map(ref => current.feedback.find(item => item.id === ref.id));
  const { receipt_commitment: receiptCommitment, ...payload } = receipt;
  const receiptVerified = commitment(payload) === receiptCommitment;
  const frameVerified = frame.frame_commitment === commitment(frameManifest(frame));
  const priorVerified = Boolean(prior && prior.frame_commitment === receipt.prior_frame_commitment
    && prior.frame_commitment === commitment(frameManifest(prior))
    && prior.selected_focus_key === receipt.from_key
    && motivationalArbitration.audit(prior.arbitration_receipt).complete_chain_verified);
  const feedbackVerified = feedback.length > 0 && feedback.every((item, index) => item
    && item.feedback_commitment === receipt.feedback[index].feedback_commitment
    && REVISION_EFFECTS.includes(item.effect) && feedbackCommitmentVerified(item, prior));
  const selectionVerified = frame.id === receipt.current_frame_id
    && frame.selected_focus_key === receipt.to_key && receipt.from_key !== receipt.to_key
    && frame.arbitration_receipt?.receipt_commitment === receipt.arbitration_receipt_commitment
    && frame.arbitration_receipt?.choice_changed_by_evidence === true
    && frame.arbitration_receipt?.evidence_counterfactual_winner_key === receipt.from_key
    && motivationalArbitration.audit(frame.arbitration_receipt).complete_chain_verified;
  return { complete_chain_verified: receiptVerified && frameVerified && priorVerified
      && feedbackVerified && selectionVerified,
    receipt_verified: receiptVerified, frame_verified: frameVerified,
    prior_verified: priorVerified, feedback_verified: feedbackVerified,
    selection_verified: selectionVerified };
}

function normalizeFrameRecord(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  return {
    ...record,
    attention_candidates: Array.isArray(record.attention_candidates) ? record.attention_candidates : [],
    active_want_refs: Array.isArray(record.active_want_refs) ? record.active_want_refs : [],
    epistemic_claim_refs: Array.isArray(record.epistemic_claim_refs) ? record.epistemic_claim_refs : [],
    relationship_refs: Array.isArray(record.relationship_refs) ? record.relationship_refs : [],
    consequence_watchlist: Array.isArray(record.consequence_watchlist) ? record.consequence_watchlist : [],
    submitted_focus_key: record.submitted_focus_key || record.selected_focus_key,
    arbitration_receipt: record.arbitration_receipt || null,
  };
}

function normalizeFeedbackRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.frame_id) return null;
  return record;
}

function report(ledger = emptyLedger()) {
  const current = normalizeLedger(ledger);
  const latest = current.current;
  return {
    total_frames: current.frames.length,
    total_feedback: current.feedback.length,
    current_frame_id: latest?.id || null,
    current_mode: latest?.mode || null,
    current_focus: latest?.selected_focus_key || null,
    current_activity: latest?.current_activity || null,
    open_uncertainties: latest?.uncertainties?.length || 0,
    inhibited_actions: latest?.inhibited_actions?.length || 0,
    consequence_watch_count: latest?.consequence_watchlist?.length || 0,
    arbitrated_frames: current.frames.filter(frame =>
      motivationalArbitration.audit(frame.arbitration_receipt).complete_chain_verified).length,
    motivation_changed_choice_count: current.frames.filter(frame => frame.arbitration_receipt
      && motivationalArbitration.audit(frame.arbitration_receipt).complete_chain_verified
      && frame.arbitration_receipt.choice_changed_by_motivation).length,
    current_choice_changed_by_motivation: latest?.arbitration_receipt?.choice_changed_by_motivation === true,
    grounded_mind_changes: current.frames.filter(frame =>
      auditRevision(frame, current).complete_chain_verified).length,
    current_grounded_mind_change: auditRevision(latest, current).complete_chain_verified,
  };
}

module.exports = {
  CANDIDATE_TYPES,
  MODES,
  addFeedback,
  createFrame,
  emptyLedger,
  normalizeLedger,
  report,
  auditArbitration: motivationalArbitration.audit,
  auditRevision,
};
