'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readServerSource } = require('../helpers/server-source');

const server = readServerSource();

test('credential-aware MCP bindings are attached to Slack', () => {
  assert.match(server, /const fleetAuthority = createFleetRequestAuthority\(\{[^\n]+sourceAttestation, expiresAt: slackTerminalAt \}\);/);
  assert.match(server, /const mcpBindings = attachLiveTools\s+\? mcpManager\.bindings\(\{ financialApproved: isDirect \? financialApproved : false, allowWrites: isDirect, fleetAuthority \}\)\s+: \{ claudeTools: \[\], executors: \{\}, inventory: \[\], meta: \{\} \}/);
  assert.doesNotMatch(server, /zoomMcp|handleRealtimeVoiceTool|voice: true/);
});

test('deprecated hosted connector payload is no longer used for managed MCPs', () => {
  assert.doesNotMatch(server, /mcp-client-2025-11-20/);
  assert.doesNotMatch(server, /function liveMcpServers/);
});
