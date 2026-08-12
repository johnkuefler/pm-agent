'use strict';

const firewall = require('./firewall');
const { createExecutiveFirewallPersistence } = require('./persistence');
const { registerExecutiveFirewallRoutes } = require('../routes/executive-firewall');

const EXPLICIT_DECISION_TITLE = /\b(?:approve|approval|authorize|authorization|decision|sign[ -]?off|choose|confirm)\b/i;
const LEGACY_TEAMWORK_RECOMMENDATION = 'Accept the project owner recommendation unless it crosses the named executive gate.';

function teamworkCandidateExecutiveGate(candidate = {}) {
  const title = String(candidate.title || '');
  if (!EXPLICIT_DECISION_TITLE.test(title)) return null;
  return firewall.gateFromText(title);
}

function createExecutiveFirewallRuntime({ db, dataDirectory, databaseReady, writeThrough,
  intelligence, resolveOwner, postMessage, loadProjectControl, loadFleetSupervisor } = {}) {
  const persistence = createExecutiveFirewallPersistence({ db, dataDirectory, databaseReady,
    writeThrough });
  let state = firewall.emptyState();
  let mutationQueue = Promise.resolve();

  async function hydrate() {
    state = await persistence.hydrate();
    return snapshot();
  }

  function snapshot() {
    return { state: firewall.normalizeState(state), metrics: firewall.metrics(state),
      brief: firewall.dailyBrief(state) };
  }

  function mutate(operation) {
    const queued = mutationQueue.then(async () => {
      const result = await operation(firewall.normalizeState(state));
      state = firewall.normalizeState(result.state);
      await persistence.save(state);
      return { ...result, metrics: firewall.metrics(state) };
    });
    mutationQueue = queued.catch(() => {});
    return queued;
  }

  function intake(input, options) {
    return mutate(current => firewall.intakeCase(input, { state: current, ...options }));
  }

  function attempt(caseId, input, options) {
    return mutate(current => firewall.recordAttempt(current, caseId, input, options));
  }

  function prepareDecision(caseId, input, options) {
    return mutate(current => firewall.prepareDecision(current, caseId, input, options));
  }

  function decide(caseId, input, options) {
    return mutate(current => firewall.recordDecision(current, caseId, input, options));
  }

  function close(caseId, input, options) {
    return mutate(current => firewall.verifyClosure(current, caseId, input, options));
  }

  function dismiss(caseId, input, options) {
    return mutate(current => firewall.dismissCase(current, caseId, input, options));
  }

  function feedback(caseId, input, options) {
    return mutate(current => firewall.recordFeedback(current, caseId, input, options));
  }

  function policy(input, options) {
    return mutate(current => firewall.updatePolicy(current, input, options));
  }

  async function ingestFleetCandidates(candidates = []) {
    const accepted = [];
    for (const incident of candidates) {
      const result = await intake({
        source: 'fleet',
        source_ref: incident.id,
        category: 'fleet_recovery',
        authority_class: 'fleet_recovery',
        severity: incident.severity,
        summary: incident.title || incident.summary || `Fleet incident ${incident.id}`,
        detail: incident.detail || incident.reason || '',
        owner: incident.agent_name || incident.agent || 'Nora',
        resolution_plan: 'Coordinate recovery with the responsible agent or owner, verify the next healthy run, and close silently.',
        next_action: incident.recommended_action || 'Verify the failure, assign recovery, and observe the next run.',
        evidence: incident.evidence || [{ type: 'fleet_incident', ref: incident.id }],
      });
      accepted.push(result.case.id);
    }
    return { accepted: true, case_ids: accepted };
  }

  async function reconcileSources({ now = new Date() } = {}) {
    const baseline = !state.baseline_at;
    let dismissedTeamworkFalsePositives = 0;
    const projectLedger = typeof loadProjectControl === 'function' ? loadProjectControl() : null;
    if (projectLedger) {
      const projects = new Map((projectLedger.projects || []).map(item => [item.key, item]));
      for (const risk of projectLedger.risks || []) {
        if (!['open', 'monitoring'].includes(risk.status)) continue;
        const project = projects.get(risk.project_key);
        const decisionNeeded = String(risk.decision_needed || '').trim();
        // A risk title can mention money, scope, or a client without presenting a decision. Treating
        // those nouns as a John gate created silent executive obligations with no answerable packet.
        const gate = decisionNeeded
          ? firewall.gateFromText(`${decisionNeeded} ${risk.title || ''}`) : null;
        // A risk record names the issue, not the answer. Auto-building a packet from it produced
        // generic approve/override/defer messages and forced John to parse the underlying schedule.
        // Keep the risk in Nora's resolving queue until the owner supplies concrete alternatives.
        const packet = null;
        const nextAction = gate
          ? `Get the project owner's recommended answer and at least two concrete choices for: ${decisionNeeded}`
          : risk.next_action || 'Confirm an owner and mitigation path.';
        await intake({ source: 'project_risk', source_ref: risk.id, category: 'project_delivery',
          authority_class: 'coordination', project_key: risk.project_key,
          severity: risk.severity || 'medium', summary: risk.title,
          detail: risk.impact || risk.description, owner: risk.owner || project?.pm || 'Nora',
          next_action: nextAction,
          resolution_plan: 'Work through the project owner and PM, update Teamwork, and verify the risk is mitigated.',
          executive_gate: gate, requires_executive: false, decision_packet: packet,
          infer_executive_gate: false,
          evidence: risk.evidence || [{ type: 'project_risk', ref: risk.id }] }, { now });
      }
      for (const risk of projectLedger.risks || []) {
        if (!['mitigated', 'resolved', 'accepted'].includes(risk.status)) continue;
        const item = state.cases.find(entry => entry.source_key === `project_risk:${String(risk.id).toLowerCase()}`
          && !['verified_closed', 'dismissed'].includes(entry.state));
        if (item) await close(item.id, { outcome: `Project risk is now ${risk.status}.`,
          evidence: risk.evidence?.length ? risk.evidence
            : [{ type: 'project_risk', ref: risk.id, note: `status:${risk.status}` }] }, { now });
      }
      const executiveCandidates = [];
      for (const project of projectLedger.projects || []) {
        for (const candidate of project.decision_state?.candidates || []) {
          const gate = teamworkCandidateExecutiveGate(candidate);
          if (!gate) continue;
          executiveCandidates.push({ project, candidate, gate });
        }
      }
      const activeCandidateRefs = new Set(executiveCandidates.map(item => String(item.candidate.id).toLowerCase()));
      for (const item of state.cases.filter(entry => entry.source === 'teamwork_decision'
        && !['verified_closed', 'dismissed'].includes(entry.state))) {
        const stale = !activeCandidateRefs.has(String(item.source_ref).toLowerCase());
        const legacyPacket = item.decision_packet?.recommendation === LEGACY_TEAMWORK_RECOMMENDATION;
        if (!stale && !legacyPacket) continue;
        await dismiss(item.id, { reason: stale
          ? 'Automated Teamwork text did not establish a concrete executive decision.'
          : 'Removed a legacy heuristic decision packet that lacked a concrete owner recommendation.' },
        { now, operator: true });
        dismissedTeamworkFalsePositives += 1;
      }
      for (const { project, candidate, gate } of executiveCandidates) {
          const evidence = [{ type: 'teamwork_decision_candidate',
            ref: candidate.evidence_ref || candidate.id }];
          await intake({ source: 'teamwork_decision', source_ref: candidate.id,
            category: 'project_decision', authority_class: 'coordination', project_key: project.key,
            severity: candidate.out_of_sequence ? 'high' : 'medium', summary: candidate.title,
            detail: candidate.description, owner: candidate.assignees?.[0] || project.pm || 'Nora',
            next_action: 'Get the project owner recommendation, alternatives, and consequence before preparing an executive packet.',
            resolution_plan: 'Resolve with the assigned owner first, then prepare a concrete executive packet only if the fixed gate remains.',
            executive_gate: gate, requires_executive: Boolean(gate),
            evidence }, { now });
      }
    }
    const fleet = typeof loadFleetSupervisor === 'function' ? await loadFleetSupervisor() : null;
    if (fleet?.incidents) {
      await ingestFleetCandidates(fleet.incidents.filter(item => !item.resolved_at));
      for (const incident of fleet.incidents.filter(item => item.resolved_at)) {
        const item = state.cases.find(entry => entry.source_key === `fleet:${String(incident.id).toLowerCase()}`
          && !['verified_closed', 'dismissed'].includes(entry.state));
        if (item) await close(item.id, { outcome: 'Fleet recovery was observed in a later healthy scan.',
          evidence: [{ type: 'fleet_recovery', ref: incident.id,
            observed_at: incident.resolved_at }] }, { now });
      }
    }
    state.last_reconciled_at = now.toISOString();
    if (baseline) {
      const pending = firewall.notificationCandidates(state);
      for (const item of pending) item.notified_revision = item.material_revision;
      state.quiet.baseline_suppressions += pending.length;
      state.baseline_at = now.toISOString();
    }
    await persistence.save(state);
    return { ...snapshot(), reconciliation: { baseline,
      baseline_suppressions: baseline ? state.quiet.baseline_suppressions : 0,
      dismissed_teamwork_false_positives: dismissedTeamworkFalsePositives } };
  }

  async function dispatch() {
    await mutationQueue;
    const candidates = firewall.notificationCandidates(state);
    if (!candidates.length) return { sent: false, reason: 'none' };
    const emergency = candidates.some(item => item.severity === 'critical'
      && state.policy.emergency_budget_override_categories.includes(item.executive_gate));
    let budget = intelligence.initiativeStatus(state.policy.executive_budget_scope);
    if (!emergency) {
      if (!budget || Number(budget.remaining) <= 0) {
        state.quiet.budget_suppressions += candidates.length;
        await persistence.save(state);
        return { sent: false, reason: 'budget_exhausted', budget };
      }
      budget = intelligence.spendInitiative(state.policy.executive_budget_scope, {
        kind: 'executive_firewall', case_ids: candidates.map(item => item.id),
      });
      if (!budget?.allowed) return { sent: false, reason: 'budget_reservation_failed', budget };
    }
    const target = resolveOwner();
    if (!target) return { sent: false, reason: 'executive_unavailable', budget };
    const delivery = await postMessage(target, firewall.decisionMessage(candidates));
    if (!delivery) return { sent: false, reason: 'delivery_failed', budget };
    const marked = await mutate(current => firewall.markNotified(current,
      candidates.map(item => item.id), { delivery_ref: cleanDeliveryRef(delivery) }));
    return { sent: true, reason: emergency ? 'emergency' : 'budgeted',
      case_ids: marked.cases.map(item => item.id), budget };
  }

  function cleanDeliveryRef(value) {
    if (typeof value === 'string') return value;
    return value?.ts || value?.id || value?.data?.ts || 'slack-delivered';
  }

  async function cycle(options = {}) {
    const reconciled = await reconcileSources(options);
    const delivery = reconciled.reconciliation.baseline
      ? { sent: false, reason: 'silent_baseline' }
      : options.notify === false ? { sent: false, reason: 'disabled' } : await dispatch();
    return { ...snapshot(), reconciliation: reconciled.reconciliation, delivery };
  }

  function promptContext(options) {
    return firewall.promptContext(state, options);
  }

  function register(app, { requireAuth, requireOperatorAuth }) {
    registerExecutiveFirewallRoutes(app, { requireAuth, requireOperatorAuth, runtime: api });
  }

  const api = { hydrate, snapshot, intake, attempt, prepareDecision, decide, close, dismiss,
    feedback, policy, ingestFleetCandidates, reconcileSources, dispatch, cycle, promptContext, register };
  return api;
}

module.exports = { createExecutiveFirewallRuntime, teamworkCandidateExecutiveGate };
