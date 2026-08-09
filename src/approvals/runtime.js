'use strict';

const approvals = require('./teammate-actions');
const { createTeammateApprovalPersistence } = require('./persistence');

function compact(value, max = 1000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function liveValue(task, field) {
  if (field === 'due_date') {
    const digits = task?.due ? String(task.due).replace(/[^0-9]/g, '').slice(0, 8) : '';
    return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}` : null;
  }
  if (field === 'priority' || field === 'status') return task?.[field] == null ? null : String(task[field]).toLowerCase();
  if (field === 'progress') return task?.progress == null ? null : Number(task.progress);
  return task?.[field] == null ? null : compact(task[field], field === 'name' ? 500 : 1000);
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function actionLine(action) {
  const changes = Object.entries(action.changes).map(([field, value]) => {
    const before = action.expected_before[field];
    return `${field.replaceAll('_', ' ')}: ${before == null ? '(none)' : before} to ${value}`;
  });
  return `• ${action.task_name} (#${action.task_id}): ${changes.join('; ')}`;
}

function proposalMessage(proposal) {
  return [
    `Nora project-plan proposal ${proposal.id}`,
    '',
    proposal.issue_summary,
    '',
    `Verified evidence: ${proposal.evidence_summary}`,
    `Recommendation: ${proposal.recommendation}`,
    '',
    'Exact Teamwork update:',
    ...proposal.actions.map(actionLine),
    '',
    `You are the approver because: ${proposal.approver.basis}`,
    `Reply "approve ${proposal.id}" to authorize only this exact version. Reply "reject ${proposal.id}" or "defer ${proposal.id}" to decline or hold it. If Teamwork changes before execution, I will stop instead of overwriting it.`,
  ].join('\n');
}

function createTeammateApprovalRuntime({ db, dataDirectory, databaseReady, writeThrough,
  readTask, updateTask, resolveSlackIdentity, sendProposal, postMessage,
  onProposed, onVerified, onInvalidated } = {}) {
  const persistence = createTeammateApprovalPersistence({ db, dataDirectory, databaseReady, writeThrough });
  let state = approvals.emptyState();
  let mutationQueue = Promise.resolve();

  async function hydrate() { state = await persistence.hydrate(); return snapshot(); }
  function snapshot() { return approvals.publicSnapshot(state); }
  function mutate(operation) {
    const queued = mutationQueue.then(async () => {
      const result = await operation(approvals.normalizeState(state));
      state = approvals.normalizeState(result.state); await persistence.save(state); return result;
    });
    mutationQueue = queued.catch(() => {}); return queued;
  }

  async function preflight(proposal) {
    const checks = [];
    for (const action of proposal.actions) {
      const task = await readTask(action.task_id);
      if (!task?.id) throw new Error(`Teamwork task ${action.task_id} could not be verified`);
      if (compact(task.name, 500) !== action.task_name) {
        const error = new Error(`Task ${action.task_id} changed name before approval`); error.code = 'source_changed'; throw error;
      }
      for (const [field, expected] of Object.entries(action.expected_before)) {
        if (!same(liveValue(task, field), expected)) {
          const error = new Error(`Task ${action.task_id} ${field} changed from the proposed before-state`);
          error.code = 'source_changed'; throw error;
        }
      }
      checks.push({ action, task });
    }
    return checks;
  }

  async function propose(input = {}) {
    const identity = await resolveSlackIdentity(input.approver?.slack_user_id);
    if (!identity?.fullMember || identity.id !== input.approver?.slack_user_id
      || identity.isBot || identity.isAppUser || identity.deleted) {
      throw new Error('teammate approval requires a current full LimeLight Slack member');
    }
    const prepared = approvals.normalizeInput({ ...input,
      approver: { ...(input.approver || {}), name: identity.name || input.approver?.name } });
    await preflight(prepared);
    const created = await mutate(current => approvals.createProposal(current, prepared));
    if (!created.created && created.proposal.delivery?.ts) return { ...created, sent: false, reason: 'duplicate_suppressed' };
    const delivery = await sendProposal(created.proposal.approver.slack_user_id, proposalMessage(created.proposal));
    if (!delivery?.ok || !delivery.channel || !delivery.ts) {
      const failed = await mutate(current => approvals.markDeliveryFailed(current,
        created.proposal.id, delivery?.error || 'Slack did not return a delivery receipt'));
      return { ...created, proposal: failed.proposal, sent: false, reason: 'delivery_failed' };
    }
    const delivered = await mutate(current => approvals.markDelivered(current,
      created.proposal.id, delivery));
    if (typeof onProposed === 'function') await Promise.resolve(onProposed(delivered.proposal)).catch(() => {});
    return { ...created, proposal: delivered.proposal, sent: true, reason: 'delivered' };
  }

  async function setTerminal(id, status, detail) {
    return mutate(current => approvals.transition(current, id, status, detail));
  }

  async function executeApproved(id) {
    let proposal = snapshot().state.proposals.find(item => item.id === id);
    if (!proposal || proposal.status !== 'approved') throw new Error('proposal is not approved for execution');
    try { await preflight(proposal); }
    catch (error) {
      if (error.code === 'source_changed') {
        const invalidated = await setTerminal(id, 'invalidated', { reason: error.message });
        await postMessage(proposal.delivery.channel,
          `${proposal.id} stopped safely because ${error.message}. I did not apply any Teamwork changes.`);
        if (typeof onInvalidated === 'function') await Promise.resolve(onInvalidated(invalidated.proposal, error.message)).catch(() => {});
        return invalidated.proposal;
      }
      const uncertain = await setTerminal(id, 'execution_uncertain', {
        error: compact(error.message, 1000), receipts: [], manual_review_required: true });
      await postMessage(proposal.delivery.channel,
        `${proposal.id} was approved, but I could not verify the current Teamwork state. I made no changes and will not retry automatically: ${compact(error.message, 500)}`);
      return uncertain.proposal;
    }
    proposal = (await setTerminal(id, 'executing')).proposal;
    const receipts = [];
    try {
      for (const action of proposal.actions) {
        const result = await updateTask({ task_id: action.task_id, ...action.changes });
        if (!result?.ok) throw new Error(`Teamwork did not confirm task ${action.task_id}`);
        receipts.push({ task_id: action.task_id, result });
      }
      const verification = [];
      for (const action of proposal.actions) {
        const task = await readTask(action.task_id); const observed = {};
        for (const [field, expected] of Object.entries(action.changes)) {
          observed[field] = liveValue(task, field);
          if (!same(observed[field], expected)) throw new Error(`post-write verification failed for task ${action.task_id} ${field}`);
        }
        verification.push({ task_id: action.task_id, observed });
      }
      const closed = await setTerminal(id, 'verified_closed', { receipts, verification });
      await postMessage(proposal.delivery.channel,
        `${proposal.id} is complete. I applied and reread ${proposal.actions.length} Teamwork task update${proposal.actions.length === 1 ? '' : 's'}; the approved values are now verified.`);
      if (typeof onVerified === 'function') await Promise.resolve(onVerified(closed.proposal)).catch(() => {});
      return closed.proposal;
    } catch (error) {
      const uncertain = await setTerminal(id, 'execution_uncertain', {
        error: compact(error.message, 1000), receipts, manual_review_required: true });
      await postMessage(proposal.delivery.channel,
        `${proposal.id} could not be verified after execution started. I will not retry automatically. Manual Teamwork review is required: ${compact(error.message, 500)}`);
      return uncertain.proposal;
    }
  }

  async function handleSlackDecision({ text, rawText = text, user, userName, channel, eventTs, attestation } = {}) {
    const candidate = approvals.decisionCandidate(state, { user, channel, text });
    if (!candidate.parsed) return false;
    if (candidate.ambiguous) {
      await postMessage(channel, 'I have more than one open proposal for you. Please include the proposal id after approve, reject, or defer.');
      return true;
    }
    if (!candidate.proposal) {
      if (candidate.parsed.proposal_id) await postMessage(channel, 'That proposal is not open for your approval in this conversation.');
      return Boolean(candidate.parsed.proposal_id);
    }
    let decided;
    try {
      decided = await mutate(current => approvals.recordDecision(current, candidate.proposal.id, {
        decision: candidate.parsed.decision, user, user_name: userName || candidate.proposal.approver.name,
        channel, event_ts: eventTs, text, raw_text: rawText, attestation,
      }));
    } catch (error) {
      if (/approval window expired/i.test(error.message)) {
        const expired = await setTerminal(candidate.proposal.id, 'invalidated', { reason: error.message });
        await postMessage(channel, `${candidate.proposal.id} expired without approval. I made no Teamwork changes.`);
        if (typeof onInvalidated === 'function') await Promise.resolve(
          onInvalidated(expired.proposal, error.message)).catch(() => {});
        return true;
      }
      await postMessage(channel, `I could not bind that decision: ${compact(error.message, 500)}`);
      return true;
    }
    if (candidate.parsed.decision === 'approve') await executeApproved(decided.proposal.id);
    else await postMessage(channel, `${decided.proposal.id} recorded as ${decided.proposal.status}. No Teamwork changes were made.`);
    return true;
  }

  async function cancel(id, reason) {
    const proposal = snapshot().state.proposals.find(item => item.id === id);
    if (!proposal || !['proposed', 'delivery_failed'].includes(proposal.status)) throw new Error('only an unapproved proposal can be cancelled');
    return setTerminal(id, 'invalidated', { reason: compact(reason, 1000) || 'Cancelled by Nora.' });
  }

  return { hydrate, snapshot, propose, executeApproved, handleSlackDecision, cancel,
    proposalMessage, preflight };
}

module.exports = { liveValue, actionLine, proposalMessage, createTeammateApprovalRuntime };
