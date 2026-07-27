'use strict';

const DEFAULT_CORPUS_BASE_URL = 'https://web-production-f26c4.up.railway.app';
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;

function corpusConfiguration(env = process.env) {
  const baseValue = String(env.AGENTIC_CORPUS_BASE_URL || DEFAULT_CORPUS_BASE_URL).trim();
  let baseUrl;
  try {
    baseUrl = new URL(baseValue);
  } catch {
    return { enabled: false, reason: 'invalid_base_url', base_url: null, authorization: null };
  }
  if (baseUrl.protocol !== 'https:') {
    return { enabled: false, reason: 'https_required', base_url: null, authorization: null };
  }
  const combined = String(env.AGENTIC_CORPUS_BASIC_AUTH || '').trim();
  const username = String(env.AGENTIC_CORPUS_USERNAME || '').trim();
  const password = String(env.AGENTIC_CORPUS_PASSWORD || '');
  const credentials = combined || (username && password ? `${username}:${password}` : '');
  return {
    enabled: Boolean(credentials),
    reason: credentials ? null : 'credentials_unavailable',
    base_url: baseUrl,
    authorization: credentials
      ? `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}` : null,
  };
}

function safeAgentSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug) ? slug : null;
}

async function readBoundedBody(response, maxBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel('response too large').catch(() => {});
          const error = new Error('Agentic corpus response exceeded the byte limit');
          error.status = 502;
          throw error;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock?.();
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    const error = new Error('Agentic corpus response exceeded the byte limit');
    error.status = 502;
    throw error;
  }
  return bytes;
}

async function fetchCorpusResource(pathname, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  maxBytes = MAX_CORPUS_BYTES,
} = {}) {
  const config = corpusConfiguration(env);
  if (!config.enabled) {
    const error = new Error('Agentic corpus access is disabled until its server-side credentials are configured');
    error.code = config.reason;
    error.status = 503;
    throw error;
  }
  if (typeof fetchImpl !== 'function') throw new Error('Agentic corpus fetch is unavailable');
  const target = new URL(pathname, config.base_url);
  if (target.origin !== config.base_url.origin) {
    const error = new Error('Agentic corpus target must stay on the configured origin');
    error.status = 400;
    throw error;
  }
  const response = await fetchImpl(target, {
    headers: { Authorization: config.authorization, Accept: 'application/json, text/markdown, text/plain' },
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 8000)),
  });
  if (!response.ok) {
    const error = new Error(`Agentic corpus returned HTTP ${response.status}`);
    error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }
  const declaredBytes = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    const error = new Error('Agentic corpus response exceeded the byte limit');
    error.status = 502;
    throw error;
  }
  const bytes = await readBoundedBody(response, maxBytes);
  const upstreamContentType = String(response.headers?.get?.('content-type') || '');
  return {
    bytes,
    content_type: upstreamContentType.toLowerCase().includes('application/json')
      ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
  };
}

function registerAgenticCorpusRoutes(app, {
  requireAuth,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const proxy = pathname => async (_req, res) => {
    try {
      const result = await fetchCorpusResource(pathname, { env, fetchImpl });
      res.set('Content-Type', result.content_type);
      res.set('Cache-Control', 'private, no-store');
      return res.send(result.bytes);
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.message,
        code: error.code || 'agentic_corpus_unavailable',
      });
    }
  };
  app.get('/agentic-corpus/corpus', requireAuth, proxy('/corpus.md'));
  app.get('/agentic-corpus/agent/:slug', requireAuth, async (req, res) => {
    const slug = safeAgentSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'invalid agent slug' });
    return proxy(`/agent/${encodeURIComponent(slug)}`)(req, res);
  });
  app.get('/agentic-corpus/search', requireAuth, async (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 300);
    if (!query) return res.status(400).json({ error: 'q is required' });
    return proxy(`/api/search?q=${encodeURIComponent(query)}`)(req, res);
  });
}

module.exports = {
  DEFAULT_CORPUS_BASE_URL,
  MAX_CORPUS_BYTES,
  corpusConfiguration,
  safeAgentSlug,
  readBoundedBody,
  fetchCorpusResource,
  registerAgenticCorpusRoutes,
};
