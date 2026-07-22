'use strict';

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const DEFAULT_PATHS = Object.freeze([
  '/self',
  '/intelligence/dashboard-summary',
  '/nora-bench',
  '/self-model?allow_stale=1&view=dashboard',
  '/consciousness-research/status',
  '/runtime/performance',
  '/runtime-activity',
]);

async function probePath(baseUrl, path, { apiKey, fetchImpl = globalThis.fetch,
  timeoutMs = 30000, budgetMs = 2000 } = {}) {
  const started = performance.now();
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.arrayBuffer();
    return {
      path,
      status: response.status,
      duration_ms: Math.round(performance.now() - started),
      response_kb: Math.round(body.byteLength / 1024),
      within_interactive_budget: response.ok && performance.now() - started <= budgetMs,
    };
  } catch (error) {
    return { path, error: error.message, duration_ms: Math.round(performance.now() - started),
      within_interactive_budget: false };
  }
}

async function probeRuntimePerformance({
  baseUrl = process.env.NORA_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.NORA_API_KEY,
  paths = DEFAULT_PATHS,
  fetchImpl = globalThis.fetch,
  budgetMs = 2000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('runtime probe requires fetch');
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const results = await Promise.all(paths.map(path => probePath(normalizedBase, path,
    { apiKey, fetchImpl, budgetMs })));
  return {
    ok: results.every(result => result.within_interactive_budget),
    checked_at: new Date().toISOString(),
    base_url: normalizedBase,
    results,
  };
}

if (require.main === module) {
  probeRuntimePerformance().then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_PATHS, probePath, probeRuntimePerformance };
