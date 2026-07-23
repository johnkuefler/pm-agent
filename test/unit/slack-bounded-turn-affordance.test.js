const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NORA_TEST_MODE = '1';
process.env.DATABASE_URL = '';
process.env.NORA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bounded-turn-'));

const { __test } = require('../../server');
const { createIntelligenceStore } = require('../../src/intelligence/store');

test.after(() => fs.rmSync(process.env.NORA_DATA_DIR, { recursive: true, force: true }));

// "Good morning" takes the bounded social lane: no live tools, no MCP inventory. Every capability
// in that frame was therefore unavailable, so the receipt validator rejected it on every single
// greeting and the frame never reached the prompt.
test('a bounded social Slack turn still reports a present capability', () => {
  const policy = __test.slackConversationPolicy('Good morning', 'normal');
  assert.equal(policy.attachLiveTools, false, 'a greeting should take the bounded social lane');

  const capabilities = __test.runtimeSituationalCapabilities({ surface: 'slack', direct: true,
    financialApproved: false, mcp: null, toolsAttached: policy.attachLiveTools });

  assert.ok(capabilities.some(item => item.availability === 'available'),
    'a bounded turn must still name what she can actually do');
  assert.ok(capabilities.some(item => item.availability !== 'available'),
    'a bounded turn must still name a boundary');
});

test('the bounded social frame is accepted by the receipt validator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bounded-affordance-'));
  let tick = 0;
  const store = createIntelligenceStore({ filePath: path.join(dir, 'state.json'), db: {},
    isDbReady: () => false,
    clock: () => new Date(Date.parse('2026-07-23T13:00:00.000Z') + tick++ * 1000) });
  await store.init();

  const capabilities = __test.runtimeSituationalCapabilities({ surface: 'slack', direct: true,
    financialApproved: false, mcp: null, toolsAttached: false });
  const frame = store.recordSituationalAffordanceFrame({ surface: 'slack', context_kind: 'direct',
    context_key: 'slack:direct:UJYKB4788:financial-restricted', capabilities,
    constraints: ['Tool availability never expands delegated authority'],
    evidence: [{ type: 'runtime_policy', id: 'server-affordance-schema-88' },
      { type: 'tool_inventory_commitment', id: 'a'.repeat(64) }] });

  assert.ok(frame?.id, 'the greeting frame must be recorded rather than rejected');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A turn that spends its budget on context enrichment must still get a real window to answer,
// and must still be able to post what it wrote.
test('the conversational budget leaves room to answer and to deliver', () => {
  const { SLACK_CONVERSATIONAL_TERMINAL_MS, SLACK_MIN_MODEL_MS,
    SLACK_CONVERSATIONAL_DELIVERY_RESERVE_MS, SLACK_DELIVERY_FLOOR_MS } = __test;
  assert.ok(SLACK_MIN_MODEL_MS >= 5000, 'the guaranteed model window must be usable');
  assert.ok(SLACK_MIN_MODEL_MS + SLACK_CONVERSATIONAL_DELIVERY_RESERVE_MS
    < SLACK_CONVERSATIONAL_TERMINAL_MS,
  'the guaranteed window plus the delivery reserve must fit inside the conversational budget');
  assert.ok(SLACK_DELIVERY_FLOOR_MS >= 2000,
    'delivery needs its own floor so an expired thinking deadline cannot silence a written reply');
});
