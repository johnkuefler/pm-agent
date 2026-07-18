'use strict';

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const REQUIRED_ROUTINE_MARKERS = Object.freeze([
  '## Step 0.5: Start the Intelligence Cycle',
  '## Step 0.7: EXPECT',
  '## Step 0.75: Consume the Subject Research Inbox',
  'DIALS phase two is a blinded causal measurement',
]);

function assessRoutineContract(routine = {}) {
  const content = typeof routine.content === 'string' ? routine.content : '';
  const missingMarkers = REQUIRED_ROUTINE_MARKERS.filter(marker => !content.includes(marker));
  const orderedSteps = REQUIRED_ROUTINE_MARKERS.slice(0, 3).map(marker => content.indexOf(marker));
  const stepOrderValid = orderedSteps.every(index => index >= 0)
    && orderedSteps.every((index, position) => position === 0 || index > orderedSteps[position - 1]);
  return { valid: Boolean(content) && missingMarkers.length === 0 && stepOrderValid,
    missing_markers: missingMarkers, step_order_valid: stepOrderValid,
    updated_at: routine.updated_at || null, updated_by: routine.updated_by || null };
}

function assessDeployReadiness({ lock = {}, activeBots = {}, routine = null } = {}) {
  const blockers = [];
  if (lock.locked) blockers.push({ kind: 'run_lock', holder: lock.holder || null,
    cycle_id: lock.lifecycle?.cycle_id || null, cycle_status: lock.lifecycle?.cycle_status || null });
  if (lock.expired_lease_pending_recovery) {
    blockers.push({ kind: 'run_recovery_pending' });
  }
  const bots = Array.isArray(activeBots.bots) ? activeBots.bots : [];
  if (Number(activeBots.count) > 0 || bots.length > 0) {
    blockers.push({ kind: 'active_meeting', count: Math.max(Number(activeBots.count) || 0, bots.length),
      bots: bots.map(item => ({ id: item.id || null, status: item.status || null,
        meeting_url: item.meeting_url || null })) });
  }
  if (routine) {
    const contract = assessRoutineContract(routine);
    if (!contract.valid) blockers.push({ kind: 'routine_contract', ...contract });
  }
  return { ready: blockers.length === 0, blockers };
}

async function fetchJson(path, { baseUrl, apiKey, fetchImpl, timeoutMs = 30000 }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${path} readiness probe failed with HTTP ${response.status}`);
  return response.json();
}

async function checkDeployReadiness({
  baseUrl = process.env.NORA_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.NORA_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('NORA_API_KEY is required for the deployment readiness check');
  if (typeof fetchImpl !== 'function') throw new Error('deployment readiness check requires fetch');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const [lock, activeBots, routine] = await Promise.all([
    fetchJson('/run-lock', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/admin/active-bots', { baseUrl: normalizedBase, apiKey, fetchImpl }),
    fetchJson('/routine', { baseUrl: normalizedBase, apiKey, fetchImpl, timeoutMs: 90000 }),
  ]);
  return { ...assessDeployReadiness({ lock, activeBots, routine }), checked_at: new Date().toISOString(),
    base_url: normalizedBase };
}

async function main() {
  try {
    const result = await checkDeployReadiness();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Deployment readiness failed closed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { DEFAULT_BASE_URL, REQUIRED_ROUTINE_MARKERS, assessRoutineContract,
  assessDeployReadiness, checkDeployReadiness };
