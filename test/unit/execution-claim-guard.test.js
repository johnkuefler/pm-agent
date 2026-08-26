'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../../src/runtime/execution-claim-guard');
const { createOperationStore } = require('../../src/runtime/operation-store');

function execution(overrides = {}) {
  return {
    id: 'execution-1', tool_name: 'tw_update_task', tool_family: 'teamwork',
    actor_class: 'model_selected', access_mode: 'write', status: 'succeeded',
    content_commitment: 'a'.repeat(64), audit: { complete_chain_verified: true },
    ...overrides,
  };
}

test('completion claims require a successful same-family write receipt', () => {
  const candidate = 'I updated the Teamwork task and its due date.';
  const verified = guard.apply({ task: 'Please update the task due date.', candidate,
    executions: [execution()] });
  assert.equal(verified.disposition, 'verified');
  assert.equal(verified.response, candidate);
  assert.deepEqual(verified.claim_families, ['update']);
  assert.equal(verified.claim_receipt_bindings[0].execution_id, 'execution-1');

  for (const receipt of [
    execution({ status: 'failed' }),
    execution({ access_mode: 'read' }),
    execution({ tool_name: 'tw_send_message' }),
    execution({ audit: { complete_chain_verified: false } }),
  ]) {
    const blocked = guard.apply({ task: 'Please update the task due date.', candidate,
      executions: [receipt] });
    assert.equal(blocked.disposition, 'blocked');
    assert.equal(blocked.response, guard.BLOCKED_RESPONSE);
  }
  const twoClaimsOneReceipt = guard.apply({ task: 'Update both Teamwork tasks.',
    candidate: 'I updated the first Teamwork task. I updated the second Teamwork task.',
    executions: [execution()] });
  assert.equal(twoClaimsOneReceipt.disposition, 'blocked');
  assert.equal(twoClaimsOneReceipt.detected_claim_count, 2);
});
test('guard distinguishes external execution from ordinary thinking and handles terse completion claims', () => {
  const reflection = guard.apply({ task: 'What do you recommend?',
    candidate: 'I updated my recommendation after considering the risk.', executions: [] });
  assert.equal(reflection.disposition, 'no_claim');
  assert.equal(reflection.response, 'I updated my recommendation after considering the risk.');

  const teamObservation = guard.apply({ task: 'What is the project status?',
    candidate: 'We completed the project milestone yesterday.', executions: [] });
  assert.equal(teamObservation.disposition, 'no_claim');

  const done = guard.apply({ task: 'Please update the Teamwork task.', candidate: 'Done.',
    executions: [execution()] });
  assert.equal(done.disposition, 'verified');
  assert.deepEqual(done.claim_families, ['update']);

  const unverifiedDone = guard.apply({ task: 'Please update the Teamwork task.', candidate: 'All set!',
    executions: [] });
  assert.equal(unverifiedDone.disposition, 'blocked');
});

test('a verified Google Workspace manage_event receipt supports calendar creation and updates', () => {
  const receipt = execution({ tool_name: 'manage_event', tool_family: 'Google Workspace MCP' });
  const created = guard.apply({ task: 'Create a calendar meeting for tomorrow.',
    candidate: 'I created the calendar meeting for tomorrow at noon.', executions: [receipt] });
  assert.equal(created.disposition, 'verified');
  assert.deepEqual(created.claim_families, ['create']);

  const updated = guard.apply({ task: 'Move the calendar meeting one hour later.',
    candidate: 'I moved the calendar meeting one hour later.', executions: [receipt] });
  assert.equal(updated.disposition, 'verified');
  assert.deepEqual(updated.claim_families, ['update']);
});

test('claim attestations retain commitments rather than response text and fail closed under tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-action-claim-'));
  let tick = 0;
  const store = createOperationStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-16T20:00:00.000Z') + tick++ * 1000) });
  await store.init();
  const selected = store.beginActionExecution({ id: 'claim-write-1', tool_use_id: 'claim-use-1',
    tool_name: 'tw_update_task', tool_family: 'teamwork', actor_class: 'model_selected',
    surface: 'slack', interaction_ref: 'thread-claim', access_mode: 'write',
    arguments: { secret_task_name: 'CLIENT SECRET TASK' } });
  store.completeActionExecution(selected.id, { status: 'succeeded',
    result: { secret_result: 'PRIVATE PROVIDER RESULT' } });
  const candidate = 'I updated the Teamwork task with the revised due date.';
  const result = guard.apply({ task: 'Update the Teamwork task due date.', candidate,
    executions: store.actionExecutionsById([selected.id]) });
  const attestation = store.recordActionClaimAttestation({ ...result,
    surface: 'slack', interaction_ref: 'thread-claim', final_response: result.response });
  assert.equal(attestation.disposition, 'verified');
  assert.equal(attestation.audit.complete_chain_verified, true);
  assert.equal(attestation.candidate_commitment, guard.commitment(candidate));
  assert.equal(store.recordActionClaimAttestation({ ...result,
    surface: 'slack', interaction_ref: 'thread-claim', final_response: result.response }).id,
  attestation.id, 'same-turn retries are idempotent');

  const blocked = guard.apply({ task: 'Delete the Teamwork task.',
    candidate: 'I deleted the Teamwork task.', executions: [] });
  const blockedAttestation = store.recordActionClaimAttestation({ ...blocked,
    surface: 'slack', interaction_ref: 'thread-blocked', final_response: blocked.response });
  assert.equal(blockedAttestation.disposition, 'blocked');
  assert.equal(blockedAttestation.audit.complete_chain_verified, true);

  const noClaim = guard.apply({ task: 'What do you recommend?',
    candidate: 'I would keep the current deadline.', executions: [] });
  const noClaimAttestation = store.recordActionClaimAttestation({ ...noClaim,
    surface: 'slack', interaction_ref: 'thread-no-claim', final_response: noClaim.response });
  assert.equal(noClaimAttestation.disposition, 'no_claim');
  assert.equal(noClaimAttestation.audit.complete_chain_verified, true);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /CLIENT SECRET TASK|PRIVATE PROVIDER RESULT|revised due date/);

  const agency = store.actionSnapshot();
  assert.equal(agency.report.replay_valid_action_claim_attestations, 3);
  assert.equal(agency.report.verified_completion_claims, 1);
  assert.equal(agency.report.blocked_unverified_completion_claims, 1);
  const tampered = structuredClone(attestation);
  tampered.disposition = 'blocked';
  assert.equal(store.actionClaimAttestationAudit(tampered).complete_chain_verified, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
