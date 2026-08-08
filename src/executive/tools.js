'use strict';

function createExecutiveFirewallTools(runtime, context = {}) {
  const source = context.source || 'slack';
  const sourceRef = context.sourceRef || `${source}:${Date.now()}`;
  const baseEvidence = [{ type: source, ref: sourceRef }];
  return [
    {
      definition: {
        name: 'executive_firewall_intake',
        description: 'Accept durable PM responsibility for an operational matter that needs follow-through beyond this reply. This does not notify John. Use it when a project, teammate, meeting, Fleet, or coordination issue needs an owner, next action, and verified closure. Do not use it for casual questions or work fully completed in this reply.',
        input_schema: { type: 'object', properties: {
          summary: { type: 'string' }, detail: { type: 'string' }, category: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          owner: { type: 'string' }, project_key: { type: 'string' },
          authority_class: { type: 'string' }, resolution_plan: { type: 'string' },
          next_action: { type: 'string' }, executive_gate: { type: 'string' },
          requires_executive: { type: 'boolean' },
        }, required: ['summary', 'next_action'] },
      },
      execute: async input => {
        const result = await runtime.intake({ ...input, source, source_ref: sourceRef,
          owner: input.owner || 'Nora', evidence: baseEvidence });
        return { case_id: result.case.id, state: result.case.state, created: result.created,
          next_action: result.case.next_action };
      },
    },
    {
      definition: {
        name: 'executive_firewall_record_attempt',
        description: 'Record a real resolution step on a firewall case after contacting an owner, changing a project record, coordinating a meeting, or observing a result. A plan is not an attempt.',
        input_schema: { type: 'object', properties: {
          case_id: { type: 'string' }, action: { type: 'string' }, result: { type: 'string' },
          target: { type: 'string' }, channel: { type: 'string' }, next_action: { type: 'string' },
          next_check_at: { type: 'string' }, executive_required: { type: 'boolean' },
          executive_gate: { type: 'string' },
        }, required: ['case_id', 'action', 'result'] },
      },
      execute: async input => {
        const result = await runtime.attempt(input.case_id, { ...input, actor: 'Nora',
          evidence: baseEvidence });
        return { case_id: result.case.id, state: result.case.state,
          next_action: result.case.next_action };
      },
    },
    {
      definition: {
        name: 'executive_firewall_prepare_decision',
        description: 'Prepare a complete decision packet only when a fixed executive gate applies or delegated team resolution is genuinely exhausted. This does not directly message John. The firewall groups and budgets delivery.',
        input_schema: { type: 'object', properties: {
          case_id: { type: 'string' }, question: { type: 'string' },
          recommendation: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
          consequence: { type: 'string' }, deadline: { type: 'string' },
          executive_gate: { type: 'string' },
        }, required: ['case_id', 'question', 'recommendation', 'options', 'consequence'] },
      },
      execute: async input => {
        const result = await runtime.prepareDecision(input.case_id,
          { ...input, evidence: baseEvidence });
        return { case_id: result.case.id, state: result.case.state,
          decision_ready: true };
      },
    },
    {
      definition: {
        name: 'executive_firewall_verify_closure',
        description: 'Close a firewall case only after the intended real-world outcome is observed. A sent message, created task, or acknowledgment alone is not closure.',
        input_schema: { type: 'object', properties: {
          case_id: { type: 'string' }, outcome: { type: 'string' },
          evidence_ref: { type: 'string' }, evidence_type: { type: 'string' },
        }, required: ['case_id', 'outcome', 'evidence_ref'] },
      },
      execute: async input => {
        const result = await runtime.close(input.case_id, { outcome: input.outcome,
          evidence: [{ type: input.evidence_type || source, ref: input.evidence_ref }] });
        return { case_id: result.case.id, state: result.case.state,
          handled_without_executive: result.case.handled_without_executive };
      },
    },
  ];
}

module.exports = { createExecutiveFirewallTools };
