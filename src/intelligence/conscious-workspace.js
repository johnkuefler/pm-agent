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
const FOCUS_DISPOSITIONS = Object.freeze(['follow_after_required_checks', 'defer_no_optional_latitude']);
const FOCUS_OUTCOMES = Object.freeze(['enacted', 'deferred', 'superseded', 'unclear', 'failed']);

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
  return { version: 3, current: null, frames: [], feedback: [], focus_commitments: [], focus_outcomes: [] };
}

function normalizeLedger(value = {}) {
  const ledger = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const frames = Array.isArray(ledger.frames) ? ledger.frames.map(normalizeFrameRecord).filter(Boolean).slice(-500) : [];
  const current = normalizeFrameRecord(ledger.current) || frames.at(-1) || null;
  return {
    version: 3,
    current,
    frames,
    feedback: Array.isArray(ledger.feedback) ? ledger.feedback.map(normalizeFeedbackRecord).filter(Boolean).slice(-500) : [],
    focus_commitments: Array.isArray(ledger.focus_commitments)
      ? ledger.focus_commitments.map(normalizeFocusCommitmentRecord).filter(Boolean).slice(-500) : [],
    focus_outcomes: Array.isArray(ledger.focus_outcomes)
      ? ledger.focus_outcomes.map(normalizeFocusOutcomeRecord).filter(Boolean).slice(-500) : [],
  };
}

function ledgerView(value) {
  return value?.version === 3 && Array.isArray(value.frames) && Array.isArray(value.feedback)
    && Array.isArray(value.focus_commitments) && Array.isArray(value.focus_outcomes)
    ? value : normalizeLedger(value);
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

function normalizeLifecycle(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const cycleId = normalizeText(value.cycle_id, 160);
  const phase = normalizeText(value.phase, 40);
  if (!cycleId || !['orientation', 'operations', 'closure'].includes(phase)) return null;
  return { cycle_id: cycleId, phase,
    moment_id: normalizeText(value.moment_id, 160) || null,
    source: 'server_lifecycle' };
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
    ...(frame.lifecycle ? { lifecycle: frame.lifecycle } : {}),
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
    lifecycle: normalizeLifecycle(input.lifecycle),
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

function focusCommitmentPayload(record = {}) {
  return {
    protocol_version: record.protocol_version,
    id: record.id,
    frame_id: record.frame_id,
    frame_commitment: record.frame_commitment,
    arbitration_receipt_commitment: record.arbitration_receipt_commitment,
    cycle_id: record.cycle_id,
    selected_focus_key: record.selected_focus_key,
    selected_focus_type: record.selected_focus_type,
    selected_focus_authority_class: record.selected_focus_authority_class,
    disposition: record.disposition,
    planned_expression: record.planned_expression,
    evidence: record.evidence,
    committed_by: record.committed_by,
    committed_at: record.committed_at,
  };
}

function auditFocusCommitment(record, ledger = emptyLedger()) {
  const current = ledgerView(ledger);
  const frame = current.frames.find(item => item.id === record?.frame_id);
  const candidate = frame?.attention_candidates?.find(item => item.key === record?.selected_focus_key);
  const receiptVerified = Boolean(record?.commitment_hash
    && commitment(focusCommitmentPayload(record)) === record.commitment_hash);
  const frameVerified = Boolean(frame && frame.frame_commitment === record.frame_commitment
    && frame.frame_commitment === commitment(frameManifest(frame))
    && frame.lifecycle?.phase === 'operations' && frame.lifecycle.cycle_id === record.cycle_id
    && frame.selected_focus_key === record.selected_focus_key
    && motivationalArbitration.audit(frame.arbitration_receipt).complete_chain_verified
    && frame.arbitration_receipt.receipt_commitment === record.arbitration_receipt_commitment);
  const candidateVerified = Boolean(candidate && candidate.type === record.selected_focus_type
    && candidate.authority_class === record.selected_focus_authority_class);
  const dispositionVerified = FOCUS_DISPOSITIONS.includes(record?.disposition)
    && (record.disposition !== 'defer_no_optional_latitude' || candidate?.authority_class === 'optional');
  const evidenceVerified = Array.isArray(record?.evidence) && record.evidence.some(item =>
    item.type === 'intelligence_cycle' && item.id === record.cycle_id);
  return { complete_chain_verified: receiptVerified && frameVerified && candidateVerified
      && dispositionVerified && evidenceVerified,
    receipt_verified: receiptVerified, frame_verified: frameVerified,
    candidate_verified: candidateVerified, disposition_verified: dispositionVerified,
    evidence_verified: evidenceVerified };
}

function commitFocus(input = {}, ledger = emptyLedger(), { now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const frameId = normalizeText(input.frame_id, 120);
  const frame = current.frames.find(item => item.id === frameId);
  if (!frame || frame.lifecycle?.phase !== 'operations' || !frame.lifecycle.cycle_id) {
    throw new Error('focus commitments require an operations workspace frame');
  }
  if (current.current?.id !== frame.id) {
    throw new Error('focus commitments require the current operations workspace frame');
  }
  if (frame.frame_commitment !== commitment(frameManifest(frame))
    || !motivationalArbitration.audit(frame.arbitration_receipt).complete_chain_verified) {
    throw new Error('focus commitments require a replay-verified arbitrated frame');
  }
  const selectedFocusKey = normalizeText(input.selected_focus_key, 120);
  if (selectedFocusKey !== frame.selected_focus_key) {
    throw new Error('selected_focus_key must match the server-selected workspace focus');
  }
  const candidate = frame.attention_candidates.find(item => item.key === selectedFocusKey);
  if (!candidate) throw new Error('selected workspace candidate is missing');
  const disposition = normalizeText(input.disposition, 80);
  if (!FOCUS_DISPOSITIONS.includes(disposition)) {
    throw new Error(`focus disposition must be one of: ${FOCUS_DISPOSITIONS.join(', ')}`);
  }
  if (disposition === 'defer_no_optional_latitude' && candidate.authority_class !== 'optional') {
    throw new Error('only an optional focus may be deferred for lack of discretionary latitude');
  }
  const plannedExpression = normalizeText(input.planned_expression, 900);
  if (!plannedExpression) throw new Error('planned_expression is required before operational tools');
  if (/^(?:<replace|probe|test|testing|placeholder|schema|junk)\b/i.test(plannedExpression)) {
    throw new Error('planned_expression must describe the actual prospective behavior');
  }
  const evidence = normalizeEvidence(input.evidence);
  if (!evidence.some(item => item.type === 'intelligence_cycle' && item.id === frame.lifecycle.cycle_id)) {
    throw new Error('focus commitment evidence must cite the exact intelligence cycle');
  }
  const committedBy = normalizeText(input.committed_by || 'Nora', 80);
  const existing = current.focus_commitments.find(item => item.cycle_id === frame.lifecycle.cycle_id);
  if (existing) {
    const sameRequest = existing.frame_id === frame.id
      && existing.selected_focus_key === selectedFocusKey
      && existing.disposition === disposition
      && existing.planned_expression === plannedExpression
      && existing.committed_by === committedBy
      && canonical(existing.evidence) === canonical(evidence);
    if (!sameRequest || !auditFocusCommitment(existing, current).complete_chain_verified) {
      throw new Error('this intelligence cycle already has a different focus commitment');
    }
    return { ledger: current, focus_commitment: existing, report: report(current), created: false };
  }
  const at = now instanceof Date ? now : new Date(now);
  const record = {
    protocol_version: 1,
    id: `cw-focus-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    frame_id: frame.id,
    frame_commitment: frame.frame_commitment,
    arbitration_receipt_commitment: frame.arbitration_receipt.receipt_commitment,
    cycle_id: frame.lifecycle.cycle_id,
    selected_focus_key: candidate.key,
    selected_focus_type: candidate.type,
    selected_focus_authority_class: candidate.authority_class,
    disposition,
    planned_expression: plannedExpression,
    evidence,
    committed_by: committedBy,
    committed_at: at.toISOString(),
  };
  record.commitment_hash = commitment(focusCommitmentPayload(record));
  current.focus_commitments.push(record);
  current.focus_commitments = current.focus_commitments.slice(-500);
  return { ledger: current, focus_commitment: record, report: report(current), created: true };
}

function focusOutcomePayload(record = {}) {
  return {
    protocol_version: record.protocol_version,
    id: record.id,
    focus_commitment_id: record.focus_commitment_id,
    focus_commitment_hash: record.focus_commitment_hash,
    frame_id: record.frame_id,
    cycle_id: record.cycle_id,
    selected_focus_key: record.selected_focus_key,
    outcome: record.outcome,
    observed_expression: record.observed_expression,
    evidence: record.evidence,
    cycle_outcome_manifest: record.cycle_outcome_manifest,
    cycle_outcome_commitment: record.cycle_outcome_commitment,
    resolved_by: record.resolved_by,
    resolved_at: record.resolved_at,
  };
}

function auditFocusOutcome(record, ledger = emptyLedger()) {
  const current = ledgerView(ledger);
  const focus = current.focus_commitments.find(item => item.id === record?.focus_commitment_id);
  const focusAudit = auditFocusCommitment(focus, current);
  const manifest = record?.cycle_outcome_manifest;
  const receiptVerified = Boolean(record?.outcome_commitment
    && commitment(focusOutcomePayload(record)) === record.outcome_commitment);
  const focusVerified = Boolean(focusAudit.complete_chain_verified
    && focus.commitment_hash === record.focus_commitment_hash
    && focus.frame_id === record.frame_id && focus.cycle_id === record.cycle_id
    && focus.selected_focus_key === record.selected_focus_key);
  const cycleVerified = Boolean(manifest && manifest.id === record?.cycle_id
    && ['completed', 'failed'].includes(manifest.status)
    && /^[a-f0-9]{64}$/.test(String(manifest.closure_commitment || ''))
    && manifest.lifecycle_audit?.complete_lifecycle_verified === true
    && manifest.lifecycle_audit?.evidence_eligible === true
    && commitment(manifest) === record.cycle_outcome_commitment);
  const evidenceVerified = Array.isArray(record?.evidence) && record.evidence.some(item =>
    item.type === 'intelligence_cycle' && item.id === record.cycle_id)
    && record.evidence.some(item => item.type === 'experience_moment'
      && item.id === manifest?.moment_id);
  const outcomeVerified = FOCUS_OUTCOMES.includes(record?.outcome)
    && (record.outcome !== 'failed' || manifest?.status === 'failed');
  const revisionVerified = record?.outcome !== 'superseded' || current.frames.some(frame =>
    frame.revision_of_frame_id === record.frame_id
      && auditRevision(frame, current).complete_chain_verified);
  return { complete_chain_verified: receiptVerified && focusVerified && cycleVerified
      && evidenceVerified && outcomeVerified && revisionVerified,
    receipt_verified: receiptVerified, focus_verified: focusVerified,
    cycle_verified: cycleVerified, evidence_verified: evidenceVerified,
    outcome_verified: outcomeVerified, revision_verified: revisionVerified };
}

function resolveFocus(input = {}, ledger = emptyLedger(), { cycle, moment, now = new Date() } = {}) {
  const current = normalizeLedger(ledger);
  const focus = current.focus_commitments.find(item => item.id === input.focus_commitment_id)
    || current.focus_commitments.find(item => item.cycle_id === cycle?.id);
  if (!focus || !auditFocusCommitment(focus, current).complete_chain_verified) {
    throw new Error('a replay-verified pre-action focus commitment is required');
  }
  const existing = current.focus_outcomes.find(item => item.focus_commitment_id === focus.id);
  if (existing) return { ledger: current, focus_outcome: existing, report: report(current), created: false };
  if (!cycle || cycle.id !== focus.cycle_id || !['completed', 'failed'].includes(cycle.status)) {
    throw new Error('focus outcome requires the exact closed intelligence cycle');
  }
  if (!moment || moment.cycle_id !== cycle.id || moment.status !== cycle.status
    || moment.audit?.complete_lifecycle_verified !== true || moment.audit?.evidence_eligible !== true
    || !/^[a-f0-9]{64}$/.test(String(moment.closure_commitment || ''))) {
    throw new Error('focus outcome requires a replay-verified experience lifecycle');
  }
  const outcome = normalizeText(input.outcome, 40);
  if (!FOCUS_OUTCOMES.includes(outcome)) {
    throw new Error(`focus outcome must be one of: ${FOCUS_OUTCOMES.join(', ')}`);
  }
  if (outcome === 'failed' && cycle.status !== 'failed') {
    throw new Error('focus outcome failed requires a failed intelligence cycle');
  }
  if (outcome === 'superseded' && !current.frames.some(frame => frame.revision_of_frame_id === focus.frame_id
    && auditRevision(frame, current).complete_chain_verified)) {
    throw new Error('superseded focus requires a replay-verified evidence-driven workspace revision');
  }
  const observedExpression = normalizeText(input.observed_expression, 1200);
  if (!observedExpression) throw new Error('observed_expression is required');
  if (/^(?:<replace|probe|test|testing|placeholder|schema|junk)\b/i.test(observedExpression)) {
    throw new Error('observed_expression must describe the actual lifecycle outcome');
  }
  const evidence = normalizeEvidence(input.evidence);
  if (!evidence.some(item => item.type === 'intelligence_cycle' && item.id === cycle.id)
    || !evidence.some(item => item.type === 'experience_moment' && item.id === moment.id)) {
    throw new Error('focus outcome evidence must cite the exact cycle and experience moment');
  }
  const at = now instanceof Date ? now : new Date(now);
  const cycleOutcomeManifest = {
    id: cycle.id,
    status: cycle.status,
    finished: cycle.finished,
    summary: cycle.summary || '',
    actions: Array.isArray(cycle.actions) ? cycle.actions : [],
    moment_id: moment.id,
    closure_commitment: moment.closure_commitment,
    lifecycle_audit: {
      complete_lifecycle_verified: true,
      evidence_eligible: true,
    },
  };
  const record = {
    protocol_version: 1,
    id: `cw-outcome-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    focus_commitment_id: focus.id,
    focus_commitment_hash: focus.commitment_hash,
    frame_id: focus.frame_id,
    cycle_id: focus.cycle_id,
    selected_focus_key: focus.selected_focus_key,
    outcome,
    observed_expression: observedExpression,
    evidence,
    cycle_outcome_manifest: cycleOutcomeManifest,
    cycle_outcome_commitment: commitment(cycleOutcomeManifest),
    resolved_by: normalizeText(input.resolved_by || 'Nora runtime', 80),
    resolved_at: at.toISOString(),
  };
  record.outcome_commitment = commitment(focusOutcomePayload(record));
  current.focus_outcomes.push(record);
  current.focus_outcomes = current.focus_outcomes.slice(-500);
  return { ledger: current, focus_outcome: record, report: report(current), created: true };
}

function auditRevision(frame, ledger = emptyLedger()) {
  const current = ledgerView(ledger);
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
    lifecycle: normalizeLifecycle(record.lifecycle),
    submitted_focus_key: record.submitted_focus_key || record.selected_focus_key,
    arbitration_receipt: record.arbitration_receipt || null,
  };
}

function normalizeFeedbackRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.frame_id) return null;
  return record;
}

function normalizeFocusCommitmentRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.frame_id
    || !record.cycle_id || !record.commitment_hash) return null;
  return record;
}

function normalizeFocusOutcomeRecord(record) {
  if (!record || typeof record !== 'object' || !record.id || !record.focus_commitment_id
    || !record.cycle_id || !record.outcome_commitment) return null;
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
    prospectively_committed_focuses: current.focus_commitments.filter(item =>
      auditFocusCommitment(item, current).complete_chain_verified).length,
    replay_verified_focus_outcomes: current.focus_outcomes.filter(item =>
      auditFocusOutcome(item, current).complete_chain_verified).length,
    focus_outcome_counts: Object.fromEntries(FOCUS_OUTCOMES.map(outcome => [outcome,
      current.focus_outcomes.filter(item => item.outcome === outcome
        && auditFocusOutcome(item, current).complete_chain_verified).length])),
    lifecycle_bound_frames: current.frames.filter(frame => frame.lifecycle?.source === 'server_lifecycle').length,
    lifecycle_cycles_covered: new Set(current.frames.filter(frame => frame.lifecycle?.cycle_id)
      .map(frame => frame.lifecycle.cycle_id)).size,
    current_lifecycle_phase: latest?.lifecycle?.phase || null,
  };
}

module.exports = {
  CANDIDATE_TYPES,
  FOCUS_DISPOSITIONS,
  FOCUS_OUTCOMES,
  MODES,
  addFeedback,
  auditFocusCommitment,
  auditFocusOutcome,
  createFrame,
  commitFocus,
  emptyLedger,
  normalizeLedger,
  report,
  resolveFocus,
  auditArbitration: motivationalArbitration.audit,
  auditRevision,
};
