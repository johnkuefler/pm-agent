'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_ROUTINE_MARKERS, assessRoutineContract,
  assessDeployReadiness, checkDeployReadiness } = require('../../scripts/check-deploy-readiness');

const validRoutine = { content: REQUIRED_ROUTINE_MARKERS.join('\n\n'),
  updated_at: '2026-07-18T05:00:00.000Z', updated_by: 'test' };

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

test('deployment readiness requires both an idle run lifecycle and no active meeting', async () => {
  const calls = [];
  const result = await checkDeployReadiness({ apiKey: 'test-key', baseUrl: 'https://nora.example/',
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/run-lock')) return response({ locked: false,
        expired_lease_pending_recovery: false });
      if (url.endsWith('/routine')) return response(validRoutine);
      return response({ count: 0, bots: [] });
    } });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(calls.map(item => item.url).sort(), [
    'https://nora.example/admin/active-bots', 'https://nora.example/routine',
    'https://nora.example/run-lock',
  ]);
  assert.ok(calls.every(item => item.authorization === 'Bearer test-key'));
});

test('deployment readiness fails closed on missing or misordered live cognition protocols', () => {
  const missing = assessRoutineContract({ content: '## Step 0.5: Start the Intelligence Cycle' });
  assert.equal(missing.valid, false);
  assert.ok(missing.missing_markers.includes('## Step 0.7: EXPECT'));
  const misordered = assessRoutineContract({ content: [...REQUIRED_ROUTINE_MARKERS]
    .reverse().join('\n\n') });
  assert.equal(misordered.valid, false);
  assert.equal(misordered.step_order_valid, false);
  const result = assessDeployReadiness({ lock: { locked: false },
    activeBots: { count: 0, bots: [] }, routine: { content: 'stale routine' } });
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].kind, 'routine_contract');
});

test('deployment readiness reports active lifecycle, recovery, and meeting blockers', () => {
  const result = assessDeployReadiness({
    lock: { locked: true, holder: 'run-1', expired_lease_pending_recovery: true,
      lifecycle: { cycle_id: 'cycle-1', cycle_status: 'running' } },
    activeBots: { count: 1, bots: [{ id: 'bot-1', status: 'in_call_recording',
      meeting_url: 'zoom:123' }] },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(item => item.kind),
    ['run_lock', 'run_recovery_pending', 'active_meeting']);
});

test('deployment readiness fails closed when either authoritative probe fails', async () => {
  await assert.rejects(checkDeployReadiness({ apiKey: 'test-key',
    fetchImpl: async url => url.endsWith('/run-lock')
      ? response({}, 503) : response({ count: 0, bots: [] }) }), /failed with HTTP 503/);
  await assert.rejects(checkDeployReadiness({ apiKey: '', fetchImpl: async () => response({}) }),
    /NORA_API_KEY is required/);
});
