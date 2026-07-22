'use strict';

const DEFAULT_BASE_URL = 'https://pm-agent-production-c49e.up.railway.app';
const DEFAULT_PATHS = Object.freeze([
  '/self',
  '/intelligence/dashboard-summary',
  '/nora-bench',
  '/self-model?allow_stale=1&view=dashboard',
  '/consciousness-research/status',
  '/consciousness-research/autopilot',
  '/runtime/performance',
  '/runtime-activity',
  '/decision-traces?limit=20',
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
    let diagnostics;
    if (response.ok && path === '/runtime/performance') {
      const runtime = JSON.parse(Buffer.from(body).toString('utf8'));
      diagnostics = {
        interactive_priority: runtime.interactive_priority,
        background_work: runtime.background_work,
        research_projections: runtime.research_projections,
        process_resources: runtime.process_resources,
        reliability: runtime.reliability,
        persistence: runtime.persistence ? {
          pending_revisions: runtime.persistence.pending_revisions,
          flush_running: runtime.persistence.flush_running,
          strict_waiters: runtime.persistence.strict_waiters,
          last_total_ms: runtime.persistence.last_total_ms,
          failures: runtime.persistence.failures,
        } : null,
      };
    } else if (response.ok && path === '/consciousness-research/autopilot') {
      const runtime = JSON.parse(Buffer.from(body).toString('utf8'));
      const cycle = runtime.background_intelligence_cycle;
      diagnostics = {
        background_intelligence_cycle: cycle ? {
          state: cycle.state,
          trigger: cycle.trigger,
          stopped_reason: cycle.stopped_reason,
          runtime_budget: cycle.runtime_budget,
          step_timings: cycle.step_timings,
          at: cycle.at,
        } : null,
        interactive_priority: runtime.interactive_priority,
      };
    } else if (response.ok && path.startsWith('/decision-traces')) {
      const traceBody = JSON.parse(Buffer.from(body).toString('utf8'));
      const traces = Array.isArray(traceBody) ? traceBody : traceBody.traces || traceBody.items || [];
      diagnostics = {
        interactive_latency: traces.filter(item => item.action === 'response_latency').map(item => ({
          channel: item.channel, decision: item.decision, created: item.created || item.at || null,
          latency_ms: item.outcome?.latency_ms, budget_ms: item.outcome?.budget_ms,
          stages: item.outcome?.stages || null,
        })),
      };
    }
    return {
      path,
      status: response.status,
      duration_ms: Math.round(performance.now() - started),
      response_kb: Math.round(body.byteLength / 1024),
      within_interactive_budget: response.ok && performance.now() - started <= budgetMs,
      ...(diagnostics ? { diagnostics } : {}),
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
