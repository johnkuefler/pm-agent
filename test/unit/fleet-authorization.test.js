'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  explicitFleetMutationRequest,
  requestedFleetTools,
  createFleetRequestAuthority,
  allowedFleetWriteTool,
  validateFleetWrite,
} = require('../../src/mcp/fleet-authorization');

const NOW = Date.parse('2026-08-09T15:00:00.000Z');
const identity = { id: 'UTEAM', name: 'Team Member', fullMember: true,
  isBot: false, isAppUser: false, deleted: false };

function authority(overrides = {}) {
  const requesterId = overrides.requesterId || 'UTEAM';
  return createFleetRequestAuthority({
    identity, requesterId, ownerId: 'UJOHN', interactionRef: 'slack:D1:1.2',
    requestText: 'Push a task through to the content agent', conversationText: '', direct: true,
    sourceAttestation: { provider: 'slack', status: 'provider_verified',
      receipt: { cryptographically_verified_at_ingress: true },
      source_snapshot: { event: { user: requesterId, channel: 'D1', ts: '1.2' } } },
    now: NOW, expiresAt: NOW + 60_000, ...overrides,
  });
}

test('recognizes an explicit Fleet change and a contextual confirmation', () => {
  assert.equal(explicitFleetMutationRequest('Update the agent cadence to daily'), true);
  assert.equal(explicitFleetMutationRequest('How is the fleet doing?'), false);
  assert.equal(explicitFleetMutationRequest('do it', 'Nora: I can update the agent config now.'), true);
  assert.equal(explicitFleetMutationRequest('do it', 'Nora: I can send the status report.'), false);
  assert.deepEqual(requestedFleetTools('Update the content agent cadence'), ['update_agent_config']);
  assert.deepEqual(requestedFleetTools('Push a task through to the content agent'), ['set_agent_once_instructions']);
  assert.deepEqual(requestedFleetTools('Pause the content agent'), ['pause_agent']);
});

test('authority requires a current direct request from a full human workspace member', () => {
  assert.ok(authority());
  assert.equal(authority({ direct: false }), null);
  assert.equal(authority({ sourceAttestation: { provider: 'email' } }), null);
  assert.equal(authority({ identity: { ...identity, fullMember: false } }), null);
  assert.equal(authority({ identity: { ...identity, isBot: true } }), null);
  assert.equal(authority({ requestText: 'Show me the latest run' }), null);
});

test('team authority exposes only bounded Fleet operations and expires with the turn', () => {
  const permit = authority();
  assert.equal(allowedFleetWriteTool('set_agent_once_instructions', permit, NOW), true);
  assert.equal(allowedFleetWriteTool('update_agent_config', permit, NOW), false);
  assert.equal(allowedFleetWriteTool('resume_agent', permit, NOW), false);
  assert.equal(allowedFleetWriteTool('rotate_agent_token', permit, NOW), false);
  assert.equal(allowedFleetWriteTool('set_agent_once_instructions', permit, NOW + 60_001), false);
});

test('owner can resume while destructive, identity, secret, and permission tools stay blocked', () => {
  const ownerIdentity = { ...identity, id: 'UJOHN', name: 'John Kuefler' };
  const permit = authority({ identity: ownerIdentity, requesterId: 'UJOHN',
    requestText: 'Resume the content agent' });
  assert.equal(allowedFleetWriteTool('resume_agent', permit, NOW), true);
  for (const tool of ['delete_agent', 'rotate_agent_token', 'set_agent_identity',
    'set_agent_skill_permission', 'write_agent_memory']) {
    assert.equal(allowedFleetWriteTool(tool, permit, NOW), false, tool);
  }
});

test('bounded config and one-time instructions are validated again at execution', () => {
  const permit = authority({ requestText: 'Update the content agent cadence and Teamwork binding' });
  assert.equal(validateFleetWrite('update_agent_config', {
    slug: 'content-agent', cadence: 'daily', twTasklistId: '42',
  }, permit, NOW).allowed, true);
  assert.equal(validateFleetWrite('update_agent_config', {
    slug: 'content-agent', writablePaths: ['C:/'],
  }, permit, NOW).allowed, false);
  const queuePermit = authority();
  assert.equal(validateFleetWrite('set_agent_once_instructions', {
    slug: 'content-agent', onceInstructions: 'Complete task 52 and report the acceptance checks.',
  }, queuePermit, NOW).allowed, true);
  assert.equal(validateFleetWrite('set_agent_once_instructions', {
    slug: 'content-agent', onceInstructions: 'Use this bearer token to deploy it.',
  }, queuePermit, NOW).allowed, false);
});
