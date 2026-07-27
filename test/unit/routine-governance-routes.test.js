'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-routine-governance-'));
const routinePath = path.join(dataDir, 'nora-routine.md');
const proposalsPath = path.join(dataDir, 'nora-routine-proposals.json');
const routine = [
  '# Nora Routine',
  '',
  '## Step 0: Load Nora',
  'Protected startup and authority rules.',
  '',
  '## Step 5: Check Slack for Missed Messages (Safety Net)',
  'Read missed messages.',
  '',
  '## Step 8: End-of-Run Summary',
  'Write the summary.',
  '',
].join('\n');

Object.assign(process.env, {
  NORA_DATA_DIR: dataDir,
  NORA_TEST_MODE: '1',
  NORA_API_KEY: 'routine-shared-key',
  NORA_AUTONOMY_KEY: 'routine-autonomy-key',
  NORA_INTERNAL_KEY: 'routine-internal-key',
  DASHBOARD_PASSWORD: 'routine-dashboard-password',
  DATABASE_URL: '',
});

for (const [name, contents] of Object.entries({
  'nora-routine.md': routine,
  'nora-memory.json': '[]',
  'nora-projects.json': '[]',
  'nora-markers.json': '{}',
  'nora-dreams.json': '[]',
  'nora-interactions.json': '[]',
  'nora-tasks.json': JSON.stringify([{
    id: 'task-routine-evidence',
    status: 'completed',
    created: '2026-07-25T12:00:00.000Z',
    completed: '2026-07-25T13:00:00.000Z',
    action: 'Review repeated Slack pagination misses.',
  }]),
})) {
  fs.writeFileSync(path.join(dataDir, name), contents);
}

const routineGovernance = require('../../src/governance/routine-governance');
const { createOperatorToken } = require('../../src/middleware/auth');
const runtime = require('../../server');
let baseUrl;

async function request(url, {
  method = 'GET',
  bearer = 'routine-shared-key',
  headers = {},
  body,
} = {}) {
  const requestHeaders = { ...headers };
  if (bearer) requestHeaders.Authorization = `Bearer ${bearer}`;
  let requestBody = body;
  if (body && typeof body !== 'string') {
    requestHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
  });
  return { response, body: await response.json() };
}

test.before(async () => {
  const server = await runtime.start({ port: 0, background: false });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('routine proposals require scoped authority and recover an exact committed apply without replay', async () => {
  const section = routineGovernance.allowedSectionManifest(routine)
    .find(item => item.heading === 'Step 5: Check Slack for Missed Messages (Safety Net)');
  const proposalInput = {
    base_commitment: routineGovernance.commitment(routine),
    section_heading: section.heading,
    expected_section_commitment: section.content_commitment,
    replacement: `## ${section.heading}\nRead missed messages with a bounded second-page check.\n`,
    note: 'Repeated reviewed runs found missed messages on the second page.',
    evidence_refs: [{ type: 'task', id: 'task-routine-evidence' }],
    proposed_by: 'forged-nora-self-improvement',
  };

  const sharedProposal = await request('/routine/proposals', {
    method: 'POST',
    body: proposalInput,
  });
  assert.equal(sharedProposal.response.status, 401);
  assert.match(sharedProposal.body.error, /signed dashboard session/);

  const legacyProposal = await request('/routine/proposals?key=routine-shared-key', {
    method: 'POST',
    bearer: null,
    body: proposalInput,
  });
  assert.equal(legacyProposal.response.status, 401);

  const created = await request('/routine/proposals', {
    method: 'POST',
    bearer: 'routine-autonomy-key',
    body: proposalInput,
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.proposal.proposed_by, 'nora-cowork');
  assert.deepEqual(created.body.proposal.proposal_authority, {
    kind: 'nora_autonomy',
    id: 'nora-cowork',
    authentication: 'bearer',
    authority: 'autonomous_internal',
  });

  const proposalId = created.body.proposal.id;
  const deniedApply = await request(`/routine/proposals/${proposalId}/apply`, {
    method: 'POST',
  });
  assert.equal(deniedApply.response.status, 401);

  const stagedLedger = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  stagedLedger[0].earliest_apply_at = new Date(Date.now() - 60_000).toISOString();
  stagedLedger[0].expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(proposalsPath, JSON.stringify(stagedLedger, null, 2));

  const originalRenameSync = fs.renameSync;
  let proposalLedgerWrites = 0;
  fs.renameSync = function failFinalProposalStatusWrite(source, destination) {
    if (path.resolve(String(destination)) === path.resolve(proposalsPath)) {
      proposalLedgerWrites += 1;
      if (proposalLedgerWrites === 2) {
        const error = new Error('simulated final proposal ledger failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalRenameSync.apply(this, arguments);
  };
  let interrupted;
  try {
    interrupted = await request(`/routine/proposals/${proposalId}/apply`, {
      method: 'POST',
      bearer: 'routine-autonomy-key',
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(interrupted.response.status, 503);
  assert.match(interrupted.body.error, /retrying this exact request is safe/);
  const committedContent = fs.readFileSync(routinePath, 'utf8');
  assert.match(committedContent, /bounded second-page check/);
  const interruptedLedger = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  assert.equal(interruptedLedger[0].status, 'applying');
  assert.equal(interruptedLedger[0].applied_by, 'nora-cowork');
  assert.equal(interruptedLedger[0].apply_authority.kind, 'nora_autonomy');

  const originalWriteFileSync = fs.writeFileSync;
  let routineRewrites = 0;
  fs.writeFileSync = function countRoutineWrites(destination) {
    if (path.resolve(String(destination)) === path.resolve(routinePath)) routineRewrites += 1;
    return originalWriteFileSync.apply(this, arguments);
  };
  let recovered;
  try {
    recovered = await request(`/routine/proposals/${proposalId}/apply`, {
      method: 'POST',
      headers: { 'x-nora-operator-token': createOperatorToken() },
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.idempotent, true);
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.applied_by, 'nora-cowork');
  assert.equal(routineRewrites, 0);
  assert.equal(fs.readFileSync(routinePath, 'utf8'), committedContent);

  const recoveredLedger = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  assert.equal(recoveredLedger[0].status, 'applied');
  assert.equal(recoveredLedger[0].applied_content_commitment,
    routineGovernance.commitment(committedContent));
  assert.equal(recoveredLedger[0].recovery_authority.kind, 'dashboard_operator');
  assert.equal(recoveredLedger[0].recovery_authority.authentication,
    'signed_operator_session');

  const governance = await request('/routine/governance');
  const publicProposal = governance.body.proposals
    .find(item => item.id === proposalId);
  assert.equal(publicProposal.proposed_by, 'nora-cowork');
  assert.equal(publicProposal.proposal_authority.kind, 'nora_autonomy');
  assert.equal(publicProposal.applied_by, 'nora-cowork');
  assert.equal(publicProposal.apply_authority.kind, 'nora_autonomy');
  assert.equal(publicProposal.recovery_authority.kind, 'dashboard_operator');

  const replayed = await request(`/routine/proposals/${proposalId}/apply`, {
    method: 'POST',
    bearer: 'routine-internal-key',
  });
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.body.idempotent, true);
  assert.equal(replayed.body.recovered, false);
  assert.equal(fs.readFileSync(routinePath, 'utf8'), committedContent);

  const expiredLedger = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  expiredLedger[0].status = 'expired';
  fs.writeFileSync(proposalsPath, JSON.stringify(expiredLedger, null, 2));
  const refusedExpiredRecovery = await request(`/routine/proposals/${proposalId}/apply`, {
    method: 'POST',
    bearer: 'routine-internal-key',
  });
  assert.equal(refusedExpiredRecovery.response.status, 400);
  assert.match(refusedExpiredRecovery.body.error, /not staged/);
  assert.equal(JSON.parse(fs.readFileSync(proposalsPath, 'utf8'))[0].status, 'expired');
});
