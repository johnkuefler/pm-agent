'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');

test('credential-aware MCP bindings are attached to Slack, Zoom chat, and Zoom voice', () => {
  assert.match(server, /const mcpBindings = mcpManager\.bindings\(\{ financialApproved: isDirect \? financialApproved : false, allowWrites: isDirect \}\)/);
  assert.match(server, /const zoomMcp = mcpManager\.bindings\(\{ financialApproved: false, allowWrites: true \}\)/);
  assert.match(server, /const mcp = mcpManager\.bindings\(\{ financialApproved: false, voice: true \}\)/);
  assert.match(server, /handleRealtimeVoiceTool\([^\n]+voiceBundle\.executors\)/);
});

test('deprecated hosted connector payload is no longer used for managed MCPs', () => {
  assert.doesNotMatch(server, /mcp-client-2025-11-20/);
  assert.doesNotMatch(server, /function liveMcpServers/);
});
