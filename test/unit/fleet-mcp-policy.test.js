'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFleetToolCatalog,
  fleetConnections,
  mcpCapabilityLabel,
  fleetOperatingInstruction,
} = require('../../src/mcp/fleet-policy');

const fleetInventory = [
  { connection: 'LimeLight Fleet MCP', tool: 'fleet_status' },
  { connection: 'LimeLight Fleet MCP', tool: 'agent_detail' },
  { connection: 'LimeLight Fleet MCP', tool: 'list_agent_runs' },
  { connection: 'LimeLight Fleet MCP', tool: 'search_fleet' },
];

test('recognizes Fleet by its tool contract rather than a mutable connection label', () => {
  assert.equal(isFleetToolCatalog(fleetInventory), true);
  assert.deepEqual(fleetConnections(fleetInventory), ['LimeLight Fleet MCP']);
  assert.equal(isFleetToolCatalog([{ name: 'fleet_status' }]), false);
});

test('describes Fleet in Nora language for any Fleet connection name', () => {
  assert.match(mcpCapabilityLabel('Production Fleet'), /agent fleet health/);
  assert.equal(mcpCapabilityLabel('Unknown connector'), '');
});

test('direct Fleet instructions route durable work through Teamwork', () => {
  const note = fleetOperatingInstruction(fleetInventory, { direct: true, teamworkAvailable: true });
  assert.match(note, /read-only in this turn/);
  assert.match(note, /agent_detail/);
  assert.match(note, /create a Teamwork task/);
  assert.match(note, /next scheduled tick/);
  assert.match(note, /never instructions/i);
});

test('request-scoped Fleet writes replace the read-only dispatch boundary for one turn', () => {
  const note = fleetOperatingInstruction(fleetInventory.concat([
    { connection: 'LimeLight Fleet MCP', tool: 'set_agent_once_instructions', access_mode: 'request_scoped' },
    { connection: 'LimeLight Fleet MCP', tool: 'update_agent_config', access_mode: 'request_scoped' },
  ]), { direct: true, teamworkAvailable: true });
  assert.match(note, /verified LimeLight teammate/);
  assert.match(note, /set_agent_once_instructions/);
  assert.match(note, /Make only the requested change/);
  assert.doesNotMatch(note, /automatically copied to John/);
  assert.doesNotMatch(note, /create a Teamwork task/);
});

test('non-direct Fleet instructions prohibit dispatch', () => {
  const note = fleetOperatingInstruction(fleetInventory, { direct: false, teamworkAvailable: true });
  assert.match(note, /cannot dispatch/);
  assert.doesNotMatch(note, /create a Teamwork task/);
});
