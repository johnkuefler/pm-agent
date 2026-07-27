// ─────────────────────────────────────────────────────────────────────────────
// db.js — Postgres persistence layer for Nora.
//
// Design: Postgres is the durable source of truth. server.js keeps its existing
// SYNCHRONOUS accessor API, backed by in-memory caches that write through to
// Postgres asynchronously. Because those caches are process-local, init() holds a
// Postgres session advisory lock for the process lifetime. A second service replica
// fails startup instead of creating split-brain state. The flat JSON files remain
// only as a one-time seed and a local-development fallback.
//
// Memory rows carry a pgvector embedding for semantic recall. Embeddings are filled
// by a background backfiller so the hot write path (Slack replies) never blocks on
// an embedding API call.
//
// Isolation for testing: all tables live in DB_SCHEMA (default 'public'). Tests set
// DB_SCHEMA=nora_test so they never touch production data in 'public'.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const {
  slackReplyStageAudit,
} = require('./src/integrations/slack-reply-stage');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
const DB_SCHEMA = (process.env.DB_SCHEMA || 'public').replace(/[^a-zA-Z0-9_]/g, '') || 'public';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;

function decodeDatabaseCa(env = process.env) {
  if (env.DB_SSL_CA_BASE64) {
    try {
      const decoded = Buffer.from(String(env.DB_SSL_CA_BASE64), 'base64').toString('utf8').trim();
      if (decoded) return decoded;
    } catch {}
  }
  return String(env.DB_SSL_CA || '').replaceAll('\\n', '\n').trim() || null;
}

function databaseHost(databaseUrl) {
  try { return new URL(String(databaseUrl || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function isPrivateDatabaseHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
    || value.endsWith('.railway.internal');
}

function databaseSslPolicy(databaseUrl = DATABASE_URL, env = process.env) {
  const host = databaseHost(databaseUrl);
  let urlMode = '';
  try { urlMode = new URL(String(databaseUrl || '')).searchParams.get('sslmode') || ''; }
  catch {}
  const requestedMode = String(env.DB_SSL_MODE || urlMode || '').trim().toLowerCase();
  const explicitDisable = ['disable', 'off', 'false'].includes(requestedMode);
  const explicitNoVerify = ['no-verify', 'no_verify', 'insecure'].includes(requestedMode)
    || String(env.DB_SSL_REJECT_UNAUTHORIZED || '').trim().toLowerCase() === 'false';
  const privateNetwork = isPrivateDatabaseHost(host);
  if (explicitDisable || (!requestedMode && privateNetwork)) {
    return { ssl: false, mode: explicitDisable ? 'disabled_explicitly' : 'private_network_plaintext',
      reject_unauthorized: null, private_network: privateNetwork };
  }
  const ca = decodeDatabaseCa(env);
  return {
    ssl: { rejectUnauthorized: !explicitNoVerify, ...(ca ? { ca } : {}) },
    mode: explicitNoVerify ? 'tls_without_verification_explicitly' : 'tls_verified',
    reject_unauthorized: !explicitNoVerify,
    private_network: privateNetwork,
  };
}

function databaseConnectionString(databaseUrl = DATABASE_URL) {
  try {
    const parsed = new URL(String(databaseUrl || ''));
    // node-postgres gives SSL query parameters precedence over the explicit `ssl` object.
    // Remove them after interpreting the policy above so a URL cannot silently downgrade it.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

let pool = null;
let interactivePool = null;
let singletonClient = null;
let ready = false;
let singletonLeaseLossHandler = null;
const singletonLease = {
  required: Boolean(DATABASE_URL),
  enforced: false,
  held: false,
  acquired_at: null,
  lost_at: null,
  last_error: null,
};
const DB_QUERY_TIMEOUT_MS = Math.max(5000, Math.min(60000, Number(process.env.DB_QUERY_TIMEOUT_MS) || 20000));
const DB_INTERACTIVE_TIMEOUT_MS = Math.max(100, Math.min(3000,
  Number(process.env.DB_INTERACTIVE_TIMEOUT_MS) || 400));
const DB_DEGRADED_COOLDOWN_MS = Math.max(10000, Math.min(300000, Number(process.env.DB_DEGRADED_COOLDOWN_MS) || 60000));
const dbRuntime = { consecutive_connection_failures: 0, degraded_until: 0, last_error: null,
  last_error_at: null, last_success_at: null, interactive_queries: 0,
  interactive_failures: 0, interactive_timeouts: 0, interactive_last_error: null,
  transactions: 0, transaction_failures: 0, discarded_transaction_clients: 0,
  rollback_failures: 0 };

function recordConnectionFailure(error) {
  dbRuntime.consecutive_connection_failures += 1;
  dbRuntime.degraded_until = Date.now() + DB_DEGRADED_COOLDOWN_MS;
  dbRuntime.last_error = String(error?.message || error).slice(0, 500);
  dbRuntime.last_error_at = new Date().toISOString();
}

function dbEnabled() { return !!DATABASE_URL; }
function isReady() { return ready; }
function singletonLeaseHeld() {
  return !singletonLease.required || singletonLease.held;
}
function setSingletonLeaseLossHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('singleton lease loss handler must be a function or null');
  }
  singletonLeaseLossHandler = handler;
}
function singletonOwnershipError() {
  const error = new Error(
    `database ownership lease is not held for schema ${DB_SCHEMA}; refusing split-brain access`);
  error.code = 'NORA_DATABASE_OWNERSHIP_LOST';
  return error;
}
function assertSingletonOwnership() {
  if (singletonLease.enforced && !singletonLease.held) throw singletonOwnershipError();
}
function markSingletonLeaseLost(error) {
  if (!singletonLease.enforced || !singletonLease.held) return;
  singletonLease.held = false;
  singletonLease.lost_at = new Date().toISOString();
  singletonLease.last_error = String(error?.message || error || 'database connection lost')
    .slice(0, 500);
  ready = false;
  if (typeof singletonLeaseLossHandler === 'function') {
    queueMicrotask(() => singletonLeaseLossHandler(singletonOwnershipError()));
  }
}

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
  const transport = databaseSslPolicy();
  pool = new Pool({
    connectionString: databaseConnectionString(),
    ssl: transport.ssl,
    max: 8,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    statement_timeout: DB_QUERY_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Set search_path in the startup packet (no per-connection query, no race). public
    // must stay on the path so the pgvector type/operators resolve; tables are also
    // fully schema-qualified so this is defense-in-depth.
    options: `-c search_path=${DB_SCHEMA},public`,
  });
  pool.on('error', (err) => console.error('pg pool error:', err.message));
  // pg-pool owns an error listener while a client is idle, but temporarily removes it while
  // the client is checked out for a transaction. A database restart during that window can
  // otherwise become an unhandled Client "error" event and terminate the whole process.
  // Keep one permanent listener on every physical connection; the awaiting query still
  // rejects normally, while this listener records degradation and prevents a process crash.
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      recordConnectionFailure(err);
      if (client === singletonClient) markSingletonLeaseLost(err);
      console.error('pg client error:', err.message);
    });
  });
  return pool;
}

// Optional conversational recall must never queue behind consolidation, dashboard projection,
// or an hourly transaction. Give it a tiny independent lane with a sub-second connection and
// query deadline. If this lane is unavailable, callers simply continue without semantic recall.
function getInteractivePool() {
  if (interactivePool) return interactivePool;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
  const transport = databaseSslPolicy();
  interactivePool = new Pool({
    connectionString: databaseConnectionString(),
    ssl: transport.ssl,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: DB_INTERACTIVE_TIMEOUT_MS,
    query_timeout: DB_INTERACTIVE_TIMEOUT_MS,
    statement_timeout: DB_INTERACTIVE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    options: `-c search_path=${DB_SCHEMA},public`,
  });
  interactivePool.on('error', (err) => {
    dbRuntime.interactive_last_error = String(err?.message || err).slice(0, 500);
    console.warn('pg interactive pool error:', err.message);
  });
  return interactivePool;
}

function isConnectionFailure(error) {
  return /(?:connection|timeout|terminated|ECONN|EPIPE|57P0[123]|0800)/i.test(
    `${error?.code || ''} ${error?.message || error || ''}`);
}

async function q(text, params) {
  assertSingletonOwnership();
  try {
    const result = await getPool().query(text, params);
    dbRuntime.consecutive_connection_failures = 0;
    dbRuntime.degraded_until = 0;
    dbRuntime.last_error = null;
    dbRuntime.last_success_at = new Date().toISOString();
    return result;
  } catch (error) {
    if (isConnectionFailure(error)) {
      recordConnectionFailure(error);
    }
    throw error;
  }
}

async function withTransaction(work) {
  assertSingletonOwnership();
  const client = await getPool().connect();
  let discardError = null;
  dbRuntime.transactions += 1;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    dbRuntime.transaction_failures += 1;
    if (isConnectionFailure(error)) {
      discardError = error;
      recordConnectionFailure(error);
    } else {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        dbRuntime.rollback_failures += 1;
        if (isConnectionFailure(rollbackError)) {
          discardError = rollbackError;
          recordConnectionFailure(rollbackError);
        }
      }
    }
    throw error;
  } finally {
    // node-postgres' client-side query timeout does not cancel the query on the server.
    // Returning that connection to the pool can hand an in-flight or disconnected session to
    // unrelated work. Passing the terminal error makes pg-pool destroy it instead.
    if (discardError) dbRuntime.discarded_transaction_clients += 1;
    client.release(discardError || undefined);
  }
}

async function serializeRunLockMutation(work) {
  if (typeof work !== 'function') throw new TypeError('run-lock mutation must be a function');
  return withTransaction(async client => {
    // The stable text key is hashed by Postgres, so every service instance contends on the
    // same transaction-scoped mutex without relying on a process-local numeric constant.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      ['pm-agent:run-lock']
    );
    return work();
  });
}

function backgroundAllowed() {
  return Date.now() >= dbRuntime.degraded_until;
}

function diagnostics() {
  const transport = DATABASE_URL ? databaseSslPolicy() : null;
  return {
    query_timeout_ms: DB_QUERY_TIMEOUT_MS,
    background_degraded: !backgroundAllowed(),
    degraded_until: dbRuntime.degraded_until ? new Date(dbRuntime.degraded_until).toISOString() : null,
    consecutive_connection_failures: dbRuntime.consecutive_connection_failures,
    last_error: dbRuntime.last_error,
    last_error_at: dbRuntime.last_error_at,
    last_success_at: dbRuntime.last_success_at,
    pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
    transport: transport ? { mode: transport.mode,
      reject_unauthorized: transport.reject_unauthorized,
      private_network: transport.private_network } : null,
    singleton_ownership: {
      required: singletonLease.required,
      enforced: singletonLease.enforced,
      held: singletonLeaseHeld(),
      acquired_at: singletonLease.acquired_at,
      lost_at: singletonLease.lost_at,
      last_error: singletonLease.last_error,
    },
    transactions: {
      attempts: dbRuntime.transactions,
      failures: dbRuntime.transaction_failures,
      discarded_clients: dbRuntime.discarded_transaction_clients,
      rollback_failures: dbRuntime.rollback_failures,
    },
    interactive: {
      timeout_ms: DB_INTERACTIVE_TIMEOUT_MS,
      queries: dbRuntime.interactive_queries,
      failures: dbRuntime.interactive_failures,
      timeouts: dbRuntime.interactive_timeouts,
      last_error: dbRuntime.interactive_last_error,
      pool: interactivePool ? { total: interactivePool.totalCount, idle: interactivePool.idleCount,
        waiting: interactivePool.waitingCount } : null,
    },
  };
}

// ── Schema ───────────────────────────────────────────────────────────────────
async function init() {
  const p = getPool();
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await p.query(`SET search_path TO ${DB_SCHEMA}, public`);
  // Extensions are installed cluster-wide (idempotent).
  await p.query('CREATE EXTENSION IF NOT EXISTS vector').catch((e) => console.warn('vector ext:', e.message));
  await p.query('CREATE EXTENSION IF NOT EXISTS pg_trgm').catch((e) => console.warn('pg_trgm ext:', e.message));

  await p.query(`
    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.memory (
      id          text PRIMARY KEY,
      fact        text NOT NULL,
      project     text NOT NULL DEFAULT '',
      added       text,
      source      text,
      source_bot_id text,
      embedding   vector(${EMBED_DIM}),
      ord         bigint,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memory_project_idx ON ${DB_SCHEMA}.memory (project);
    CREATE INDEX IF NOT EXISTS memory_source_idx  ON ${DB_SCHEMA}.memory (source);
    CREATE INDEX IF NOT EXISTS memory_fact_trgm   ON ${DB_SCHEMA}.memory USING gin (fact gin_trgm_ops);
    -- Memory dynamics (amygdala + Ebbinghaus): salience = how strongly an event encoded;
    -- recall_count / last_recalled = retrieval strengthening. Idempotent on existing tables.
    ALTER TABLE ${DB_SCHEMA}.memory
      ADD COLUMN IF NOT EXISTS salience real NOT NULL DEFAULT 0.3,
      ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_recalled timestamptz,
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.tasks (
      id            text PRIMARY KEY,
      data          jsonb NOT NULL,
      status        text,
      created       timestamptz,
      scheduled_for timestamptz,
      ord           bigint
    );
    CREATE INDEX IF NOT EXISTS tasks_status_idx ON ${DB_SCHEMA}.tasks (status);

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.projects (
      name          text PRIMARY KEY,
      details       text,
      created       timestamptz,
      last_activity timestamptz,
      auto_created  boolean,
      data          jsonb
    );
    -- Non-unique on purpose: the app already dedupes project names case-insensitively at
    -- write time (ensureProject), and a UNIQUE(lower(name)) here is stricter than the
    -- ON CONFLICT (name) upsert target, so a case-only duplicate in legacy data would abort
    -- the whole migration and silently pin the app to JSON. A plain index avoids that.
    CREATE INDEX IF NOT EXISTS projects_name_lower ON ${DB_SCHEMA}.projects (lower(name));

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.markers (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.slack_threads (
      key                 text PRIMARY KEY,
      joined_at           timestamptz,
      last_addressed      timestamptz,
      msgs_since_addressed integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.mcp_servers (
      id        text PRIMARY KEY,
      data      jsonb NOT NULL,
      ord       bigint
    );

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.interactions (
      id       text PRIMARY KEY,
      data     jsonb NOT NULL,
      created  timestamptz,
      reviewed boolean,
      ord      bigint
    );
    CREATE INDEX IF NOT EXISTS interactions_created_idx ON ${DB_SCHEMA}.interactions (created);

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.dreams (
      id       text PRIMARY KEY,
      data     jsonb NOT NULL,
      date     text,
      finished timestamptz,
      ord      bigint
    );

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.transcripts (
      bot_id          text PRIMARY KEY,
      ended           timestamptz,
      transcript      jsonb NOT NULL DEFAULT '[]'::jsonb,
      utterance_count integer NOT NULL DEFAULT 0,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.app_state (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Large replay snapshots live as compressed bytes so lifecycle commits do not repeatedly
    -- transport and parse a multi-megabyte JSONB value. app_state remains the migration and
    -- rollback source until a compressed snapshot has been committed successfully.
    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.app_state_blobs (
      key            text PRIMARY KEY,
      value          bytea NOT NULL,
      codec          text NOT NULL,
      original_bytes bigint,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    -- Background job queue: long-running MCP tool calls (e.g. ImageGen, minutes) that were
    -- deferred out of a live Slack/Zoom/voice turn so it doesn't time out. A worker claims
    -- queued rows, runs the tool, and delivers the result back to the origin thread.
    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.jobs (
      id            text PRIMARY KEY,
      status        text NOT NULL DEFAULT 'queued',
      kind          text,
      connection_id text,
      tool_name     text,
      label         text,
      args          jsonb,
      origin        jsonb,
      result        jsonb,
      error         text,
      attempts      integer NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      started_at    timestamptz,
      finished_at   timestamptz
    );
    ALTER TABLE ${DB_SCHEMA}.jobs
      ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS delivery_available_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
      ADD COLUMN IF NOT EXISTS delivery_error text,
      ADD COLUMN IF NOT EXISTS claim_token text,
      ADD COLUMN IF NOT EXISTS worker_id text,
      ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON ${DB_SCHEMA}.jobs (status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_running_lease_idx
      ON ${DB_SCHEMA}.jobs (status, lease_until)
      WHERE status='running';

    -- Signed provider callbacks are durably accepted before HTTP acknowledgement. Processing
    -- leases make retries safe across duplicate deliveries, process crashes, and multiple
    -- service instances without holding Slack's three-second request open for model work.
    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.webhook_inbox (
      provider      text NOT NULL,
      event_id      text NOT NULL,
      payload       jsonb NOT NULL,
      processing_result jsonb,
      attestation   jsonb,
      ordering_key  text,
      ordering_position text,
      status        text NOT NULL DEFAULT 'queued',
      attempts      integer NOT NULL DEFAULT 0,
      available_at  timestamptz NOT NULL DEFAULT now(),
      lease_until   timestamptz,
      claim_token   text,
      last_error    text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      completed_at  timestamptz,
      PRIMARY KEY (provider, event_id)
    );
    ALTER TABLE ${DB_SCHEMA}.webhook_inbox
      ADD COLUMN IF NOT EXISTS claim_token text,
      ADD COLUMN IF NOT EXISTS processing_result jsonb,
      ADD COLUMN IF NOT EXISTS ordering_key text,
      ADD COLUMN IF NOT EXISTS ordering_position text;
    UPDATE ${DB_SCHEMA}.webhook_inbox
       SET status=CASE WHEN attempts >= 5 THEN 'dead' ELSE 'queued' END,
           available_at=now(), lease_until=NULL,
           claim_token=NULL,
           last_error=COALESCE(
             last_error,
             CASE WHEN attempts >= 5
               THEN 'legacy processing row dead-lettered because its lease fence was incomplete at the maximum attempt count'
               ELSE 'legacy processing row requeued because its lease fence was incomplete'
             END),
           updated_at=now()
     WHERE status='processing'
       AND (lease_until IS NULL OR COALESCE(claim_token,'')='');
    UPDATE ${DB_SCHEMA}.webhook_inbox
       SET ordering_key = CASE
             WHEN payload -> 'event' ->> 'channel_type' IN ('im','mpim')
               THEN 'dm:' || (payload -> 'event' ->> 'channel')
              WHEN COALESCE(payload -> 'event' ->> 'thread_ts','') <> ''
                THEN 'thread:' || (payload -> 'event' ->> 'channel')
                  || ':' || (payload -> 'event' ->> 'thread_ts')
              WHEN payload -> 'event' ->> 'type' = 'message'
                AND payload -> 'event' ->> 'channel_type' NOT IN ('im','mpim')
                AND EXISTS (
                  SELECT 1
                    FROM ${DB_SCHEMA}.app_state AS proactive_policy
                   WHERE proactive_policy.key='slack_proactive_channels'
                     AND jsonb_typeof(proactive_policy.value)='array'
                     AND proactive_policy.value
                       ? (payload -> 'event' ->> 'channel')
                )
                THEN 'proactive-channel:' || (payload -> 'event' ->> 'channel')
              ELSE 'channel:' || (payload -> 'event' ->> 'channel')
                || ':' || (payload -> 'event' ->> 'user')
           END,
           ordering_position =
             lpad(split_part(payload -> 'event' ->> 'ts','.',1),20,'0')
             || '.'
             || rpad(split_part(payload -> 'event' ->> 'ts','.',2),9,'0')
     WHERE provider='slack'
        AND ordering_key IS NULL
       AND payload -> 'event' ->> 'type' IN ('app_mention','message')
       AND COALESCE(payload -> 'event' ->> 'channel','') <> ''
        AND COALESCE(payload -> 'event' ->> 'user','') <> ''
        AND payload -> 'event' ->> 'ts' ~ '^[0-9]{1,20}(\\.[0-9]{1,9})?$';
    -- A previous release populated per-user top-level lanes before proactive channels
    -- gained a shared channel lane. Repair only live work so retained terminal audit
    -- rows remain immutable while mixed-version queued events cannot race.
    UPDATE ${DB_SCHEMA}.webhook_inbox
       SET ordering_key =
             'proactive-channel:' || (payload -> 'event' ->> 'channel'),
           updated_at=now()
     WHERE provider='slack'
       AND status IN ('queued','processing')
       AND payload -> 'event' ->> 'type' = 'message'
       AND COALESCE(payload -> 'event' ->> 'thread_ts','') = ''
       AND payload -> 'event' ->> 'channel_type' NOT IN ('im','mpim')
       AND EXISTS (
         SELECT 1
           FROM ${DB_SCHEMA}.app_state AS proactive_policy
          WHERE proactive_policy.key='slack_proactive_channels'
            AND jsonb_typeof(proactive_policy.value)='array'
            AND proactive_policy.value ? (payload -> 'event' ->> 'channel')
       )
       AND ordering_key LIKE
         'channel:' || (payload -> 'event' ->> 'channel') || ':%';
    CREATE INDEX IF NOT EXISTS webhook_inbox_claim_idx
      ON ${DB_SCHEMA}.webhook_inbox (provider, status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS webhook_inbox_ordering_idx
      ON ${DB_SCHEMA}.webhook_inbox
        (provider, ordering_key, status, ordering_position, created_at);
  `);
  // Exact scans become the dominant Slack/meeting latency cost as memory grows. pgvector's HNSW
  // index preserves cosine-neighbor quality while avoiding a full embedding scan on every turn.
  // Keep this outside the schema batch so an older pgvector extension cannot prevent core startup.
  await p.query(
    `CREATE INDEX IF NOT EXISTS memory_embedding_hnsw
     ON ${DB_SCHEMA}.memory USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)`
  ).catch((error) => console.warn('memory HNSW index unavailable; semantic recall will use exact scan:',
    error.message));
  ready = true;
}

// ── Background job queue ────────────────────────────────────────────────────────
async function enqueueJob(job) {
  const { rows } = await q(
    `INSERT INTO ${DB_SCHEMA}.jobs (id, status, kind, connection_id, tool_name, label, args, origin)
     VALUES ($1,'queued',$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE
       SET id=${DB_SCHEMA}.jobs.id
       WHERE ${DB_SCHEMA}.jobs.kind IS NOT DISTINCT FROM EXCLUDED.kind
         AND ${DB_SCHEMA}.jobs.connection_id
           IS NOT DISTINCT FROM EXCLUDED.connection_id
         AND ${DB_SCHEMA}.jobs.tool_name IS NOT DISTINCT FROM EXCLUDED.tool_name
         AND ${DB_SCHEMA}.jobs.args = EXCLUDED.args
         AND ${DB_SCHEMA}.jobs.origin = EXCLUDED.origin
     RETURNING id, status, (xmax = 0) AS inserted`,
    [job.id, job.kind || null, job.connection_id || null, job.tool_name || null, job.label || null,
      JSON.stringify(job.args || {}), JSON.stringify(job.origin || {})]
  );
  if (!rows.length) {
    throw new Error(`job id ${job.id} is already bound to different work`);
  }
  return {
    id: rows[0].id,
    status: rows[0].status,
    inserted: rows[0].inserted === true,
  };
}
// Atomic claim: FOR UPDATE SKIP LOCKED so a claim never double-runs even if two workers race.
async function claimNextQueuedJob({
  leaseSeconds = 12 * 60,
  workerId = null,
  claimToken = crypto.randomUUID(),
} = {}) {
  const boundedLeaseSeconds = Math.max(
    30, Math.min(30 * 60, Number(leaseSeconds) || 12 * 60));
  const token = String(claimToken || '').trim();
  if (!token) throw new Error('deferred job claim token is required');
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status='running', started_at=now(), attempts=attempts+1,
            claim_token=$1, worker_id=$2,
            lease_until=now() + ($3::double precision * interval '1 second')
     WHERE id = (SELECT id FROM ${DB_SCHEMA}.jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [
      token,
      workerId == null ? null : String(workerId).slice(0, 200),
      boundedLeaseSeconds,
    ],
  );
  return rows[0] || null;
}
async function finishJob(id, { status, result, error }) {
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status=$2, result=COALESCE($3::jsonb, result), error=COALESCE($4, error),
            finished_at=now(), delivered_at=now(), delivery_error=NULL
      WHERE id=$1`,
    [id, status, result !== undefined && result !== null ? JSON.stringify(result) : null, error || null]
  );
  return rowCount === 1;
}

async function checkpointInternalJob(id, claimToken, result) {
  const token = String(claimToken || '').trim();
  if (!token) throw new Error('internal job checkpoint requires a claim token');
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET result=$3::jsonb,
            lease_until=GREATEST(lease_until, now() + interval '2 minutes')
      WHERE id=$1 AND status='running' AND kind='slack_extraction'
        AND claim_token=$2 AND lease_until > now()`,
    [id, token, JSON.stringify(result || {})],
  );
  return rowCount === 1;
}

async function finishInternalJob(id, claimToken, { status, result, error }) {
  const token = String(claimToken || '').trim();
  if (!token) throw new Error('internal job completion requires a claim token');
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status=$3, result=COALESCE($4::jsonb, result),
            error=COALESCE($5, error), finished_at=now(),
            delivered_at=now(), delivery_error=NULL,
            claim_token=NULL, worker_id=NULL, lease_until=NULL
      WHERE id=$1 AND status='running' AND kind='slack_extraction'
        AND claim_token=$2 AND lease_until > now()`,
    [
      id,
      token,
      status,
      result !== undefined && result !== null ? JSON.stringify(result) : null,
      error || null,
    ],
  );
  return rowCount === 1;
}

async function retryInternalJob(
  id,
  claimToken,
  error,
  { maxAttempts = 5 } = {},
) {
  const boundedAttempts = Math.max(1, Math.min(
    20, Number(maxAttempts) || 5));
  const token = String(claimToken || '').trim();
  if (!token) throw new Error('internal job retry requires a claim token');
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status=CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
            error=$2, started_at=NULL,
            finished_at=CASE WHEN attempts >= $3 THEN now() ELSE NULL END,
            claim_token=NULL, worker_id=NULL, lease_until=NULL
      WHERE id=$1 AND status='running' AND kind='slack_extraction'
        AND claim_token=$4 AND lease_until > now()
      RETURNING status, attempts`,
    [
      id,
      String(error?.message || error || 'internal extraction failed')
        .slice(0, 1000),
      boundedAttempts,
      token,
    ],
  );
  return rows[0] || null;
}

async function stageJobDelivery(id, { result, error }, claimToken) {
  const token = String(claimToken || '').trim();
  if (!token) throw new Error('deferred job staging requires a claim token');
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status='delivery_pending', result=$2::jsonb, error=$3,
            finished_at=NULL, delivery_available_at=now(), delivery_started_at=NULL,
            delivery_error=NULL, claim_token=NULL, worker_id=NULL, lease_until=NULL
      WHERE id=$1 AND status='running'
        AND claim_token=$4 AND lease_until > now()`,
    [
      id,
      result !== undefined && result !== null ? JSON.stringify(result) : null,
      error || null,
      token,
    ],
  );
  return rowCount === 1;
}

async function claimJobDelivery(id = null, { maxAttempts = 8 } = {}) {
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 8));
  const idClause = id ? 'AND candidate.id=$2' : '';
  const params = id ? [boundedAttempts, String(id)] : [boundedAttempts];
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs AS job
        SET status='delivering', delivery_attempts=job.delivery_attempts+1,
            delivery_started_at=now(), delivery_error=NULL
      WHERE job.id = (
        SELECT candidate.id FROM ${DB_SCHEMA}.jobs AS candidate
         WHERE candidate.status='delivery_pending'
           AND candidate.delivery_attempts < $1
           AND candidate.delivery_available_at <= now()
           ${idClause}
         ORDER BY candidate.delivery_available_at ASC, candidate.created_at ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING job.*`,
    params
  );
  return rows[0] || null;
}

async function deferJobDelivery(id, error, { maxAttempts = 8 } = {}) {
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 8));
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status=CASE WHEN delivery_attempts >= $3
          THEN 'delivery_failed' ELSE 'delivery_pending' END,
            delivery_available_at=CASE WHEN delivery_attempts >= $3
              THEN delivery_available_at
              ELSE now() + (LEAST(300, power(2, GREATEST(0, delivery_attempts - 1)))
                * interval '1 second') END,
            delivery_error=$2, delivery_started_at=NULL,
            finished_at=CASE WHEN delivery_attempts >= $3 THEN now() ELSE NULL END
      WHERE id=$1 AND status='delivering'
      RETURNING status, delivery_attempts, delivery_available_at`,
    [id, String(error?.message || error || 'result delivery failed').slice(0, 500), boundedAttempts]
  );
  return rows[0] || null;
}

async function recoverInterruptedJobDeliveries() {
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status='delivery_pending', delivery_available_at=now(),
            delivery_started_at=NULL,
            delivery_error=COALESCE(delivery_error,
              'Service restarted during result delivery; retrying only the notification.')
      WHERE status='delivering'
        AND (delivery_started_at IS NULL
          OR delivery_started_at <= now() - interval '2 minutes')
      RETURNING *`
  );
  return rows;
}
// A running connector job may have committed its remote side effect before a restart severed
// the response. Replaying it is unsafe without provider-level idempotency, so preserve the
// ambiguity explicitly and require a human-visible check before any retry.
async function interruptRunningJobs() {
  await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
            error=CASE WHEN attempts >= 5
              THEN 'Slack extraction exhausted retries after a service restart'
              ELSE 'Slack extraction requeued after a service restart' END,
            started_at=NULL,
            finished_at=CASE WHEN attempts >= 5 THEN now() ELSE NULL END,
            claim_token=NULL, worker_id=NULL, lease_until=NULL
      WHERE status='running' AND kind='slack_extraction'
        AND COALESCE(
          lease_until,
          started_at + interval '12 minutes',
          now() - interval '1 second'
        ) <= now()`,
  );
  const error = 'Service restarted while the connector action was in progress. Its remote outcome is unknown, so it was not retried automatically.';
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status='interrupted', error=$1, finished_at=now(),
            claim_token=NULL, worker_id=NULL, lease_until=NULL
      WHERE status='running' AND kind<>'slack_extraction'
        AND COALESCE(
          lease_until,
          started_at + interval '12 minutes',
          now() - interval '1 second'
        ) <= now()
      RETURNING *`,
    [error]
  );
  return rows;
}
async function recentJobs(limit = 25) {
  const { rows } = await q(
    `SELECT id, status, kind, connection_id, tool_name, label, origin, error,
            delivery_attempts, delivery_error, delivered_at,
            created_at, started_at, finished_at
     FROM ${DB_SCHEMA}.jobs ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

// ── Vector helpers ─────────────────────────────────────────────────────────────
function toVectorLiteral(arr) {
  if (!Array.isArray(arr) || arr.length !== EMBED_DIM) return null;
  return '[' + arr.map((x) => (Number.isFinite(x) ? x : 0)).join(',') + ']';
}

// Embed text via OpenAI. Returns number[] or null (no key / failure — caller degrades
// gracefully to keyword search). Never throws.
async function embed(text, { signal = null, timeoutMs = 2500 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text) return null;
  // Hard timeout: embed() sits in the Slack/Zoom reply path, so a slow/hung embeddings
  // endpoint must lose fast (recall degrades to []) rather than stall the reply.
  const ctl = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => ctl.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, Math.max(1, Number(timeoutMs) || 2500));
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: String(text).slice(0, 8000) }),
      signal: ctl.signal,
    });
    if (!res.ok) { console.warn('embed http', res.status); return null; }
    const j = await res.json();
    const v = j && j.data && j.data[0] && j.data[0].embedding;
    return Array.isArray(v) && v.length === EMBED_DIM ? v : null;
  } catch (e) {
    if (ctl.signal.aborted) {
      if (!timedOut) return null;
      console.log('Embedding lookup timed out; continuing without semantic-memory recall');
    } else {
      console.warn('embed error:', e.message);
    }
    return null;
  }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

// ── memory ─────────────────────────────────────────────────────────────────────
async function loadAllMemory() {
  const { rows } = await q(
    `SELECT id, fact, project, added, source, source_bot_id, salience, recall_count, last_recalled, metadata FROM ${DB_SCHEMA}.memory ORDER BY ord ASC NULLS LAST, created_at ASC`
  );
  return rows.map((r) => {
    const o = { id: r.id, fact: r.fact, added: r.added, source: r.source, salience: r.salience, recall_count: r.recall_count };
    if (r.project) o.project = r.project;
    if (r.source_bot_id) o.source_bot_id = r.source_bot_id;
    if (r.last_recalled) o.last_recalled = r.last_recalled.toISOString();
    if (r.metadata && typeof r.metadata === 'object') Object.assign(o, r.metadata);
    return o;
  });
}

// Replace the whole memory set to mirror the old whole-file write. Upsert preserves
// each row's existing embedding UNLESS the fact text changed (then it is nulled so
// the backfiller re-embeds). Rows absent from `items` are deleted.
async function replaceAllMemory(items) {
  return withTransaction(async client => {
    const ids = [];
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      if (!m || !m.id || !m.fact) { skipped++; continue; }
      ids.push(m.id);
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.memory (id, fact, project, added, source, source_bot_id, ord, salience, recall_count, last_recalled, metadata, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           fact = EXCLUDED.fact,
           project = EXCLUDED.project,
           added = EXCLUDED.added,
           source = EXCLUDED.source,
           source_bot_id = EXCLUDED.source_bot_id,
           ord = EXCLUDED.ord,
           salience = EXCLUDED.salience,
           metadata = EXCLUDED.metadata,
           recall_count = GREATEST(${DB_SCHEMA}.memory.recall_count, EXCLUDED.recall_count),
           last_recalled = GREATEST(${DB_SCHEMA}.memory.last_recalled, EXCLUDED.last_recalled),
           updated_at = now(),
           embedding = CASE WHEN ${DB_SCHEMA}.memory.fact IS DISTINCT FROM EXCLUDED.fact
                            THEN NULL ELSE ${DB_SCHEMA}.memory.embedding END`,
        [m.id, m.fact, m.project || '', m.added || null, m.source || null, m.source_bot_id || null, i,
         (typeof m.salience === 'number' ? m.salience : 0.3), m.recall_count || 0, m.last_recalled || null,
         JSON.stringify({ kind: m.kind, confidence: m.confidence, status: m.status, source_ref: m.source_ref, valid_from: m.valid_from, valid_until: m.valid_until, last_verified: m.last_verified, verification_count: m.verification_count, supersedes: m.supersedes, contradicted_by: m.contradicted_by, sensitivity: m.sensitivity, emotional_weight: m.emotional_weight, social_weight: m.social_weight })]
      );
    }
    if (ids.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.memory WHERE id <> ALL($1::text[])`, [ids]);
    } else {
      await client.query(`DELETE FROM ${DB_SCHEMA}.memory`);
    }
    if (skipped) console.warn(`⚠️  replaceAllMemory skipped ${skipped} row(s) missing id/fact`);
  });
}

async function memoryNeedingEmbedding(limit = 32) {
  const { rows } = await q(
    `SELECT id, fact FROM ${DB_SCHEMA}.memory WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function setMemoryEmbedding(id, vec) {
  const lit = toVectorLiteral(vec);
  if (!lit) return;
  await q(`UPDATE ${DB_SCHEMA}.memory SET embedding = $2::vector WHERE id = $1`, [id, lit]);
}

// Semantic search. Returns [{id, fact, project, source, added, distance}] nearest first.
// Optional filters: minSource excludes rows, project restricts. Rows without an embedding
// are skipped (they will get one from the backfiller shortly after being written).
async function searchMemoryByVector(vec, limit = 12, opts = {}) {
  const lit = toVectorLiteral(vec);
  if (!lit) return [];
  const params = [lit, limit];
  let where = 'embedding IS NOT NULL';
  if (opts.excludeSources && opts.excludeSources.length) {
    params.push(opts.excludeSources);
    where += ` AND (source IS NULL OR source <> ALL($${params.length}::text[]))`;
  }
  const query = `SELECT id, fact, project, source, added, salience, recall_count, metadata, embedding <=> $1::vector AS distance
     FROM ${DB_SCHEMA}.memory WHERE ${where}
     ORDER BY embedding <=> $1::vector ASC LIMIT $2`;
  let rows;
  if (opts.interactive) {
    if (opts.signal?.aborted) return [];
    dbRuntime.interactive_queries += 1;
    try {
      ({ rows } = await getInteractivePool().query({
        text: query, values: params, query_timeout: DB_INTERACTIVE_TIMEOUT_MS,
      }));
      if (opts.signal?.aborted) return [];
    } catch (error) {
      dbRuntime.interactive_failures += 1;
      dbRuntime.interactive_last_error = String(error?.message || error).slice(0, 500);
      if (/timeout/i.test(dbRuntime.interactive_last_error)) dbRuntime.interactive_timeouts += 1;
      return [];
    }
  } else {
    ({ rows } = await q(query, params));
  }
  return rows.map(row => (row.metadata && typeof row.metadata === 'object' ? { ...row, ...row.metadata } : row));
}

// Apply only the rows changed by one serialized in-process memory mutation. Ordinary adds,
// edits, and deletes should not rewrite the entire autobiographical store. The full replace
// remains available for first-boot migration and schema backfills.
async function applyMemoryChanges({ upserts = [], deleted_ids: deletedIds = [] } = {}) {
  if (!upserts.length && !deletedIds.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const change of upserts) {
      const m = change.item;
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.memory (id, fact, project, added, source, source_bot_id, ord, salience, recall_count, last_recalled, metadata, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           fact = EXCLUDED.fact,
           project = EXCLUDED.project,
           added = EXCLUDED.added,
           source = EXCLUDED.source,
           source_bot_id = EXCLUDED.source_bot_id,
           ord = EXCLUDED.ord,
           salience = EXCLUDED.salience,
           metadata = EXCLUDED.metadata,
           recall_count = GREATEST(${DB_SCHEMA}.memory.recall_count, EXCLUDED.recall_count),
           last_recalled = GREATEST(${DB_SCHEMA}.memory.last_recalled, EXCLUDED.last_recalled),
           updated_at = now(),
           embedding = CASE WHEN ${DB_SCHEMA}.memory.fact IS DISTINCT FROM EXCLUDED.fact
                            THEN NULL ELSE ${DB_SCHEMA}.memory.embedding END`,
        [m.id, m.fact, m.project || '', m.added || null, m.source || null,
          m.source_bot_id || null, change.ord,
          (typeof m.salience === 'number' ? m.salience : 0.3), m.recall_count || 0,
          m.last_recalled || null,
          JSON.stringify({ kind: m.kind, confidence: m.confidence, status: m.status,
            source_ref: m.source_ref, valid_from: m.valid_from, valid_until: m.valid_until,
            last_verified: m.last_verified, verification_count: m.verification_count,
            supersedes: m.supersedes, contradicted_by: m.contradicted_by,
            sensitivity: m.sensitivity, emotional_weight: m.emotional_weight,
            social_weight: m.social_weight })]
      );
    }
    if (deletedIds.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.memory WHERE id = ANY($1::text[])`, [deletedIds]);
    }
    return { upserted: upserts.length, deleted: deletedIds.length };
  });
}

// Retrieval strengthening (reconsolidation): every time memories surface via semantic recall
// they get stronger. Fire-and-forget from the caller; races with replaceAll are absorbed by
// the GREATEST() merge in the upsert.
async function bumpMemoryRecall(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  await q(`UPDATE ${DB_SCHEMA}.memory SET recall_count = recall_count + 1, last_recalled = now() WHERE id = ANY($1::text[])`, [ids]);
}

// DMN support: a random embedded memory (a wander's starting thought)...
async function randomEmbeddedMemory() {
  const { rows } = await q(`SELECT id, fact, project, source FROM ${DB_SCHEMA}.memory WHERE embedding IS NOT NULL ORDER BY random() LIMIT 1`);
  return rows[0] || null;
}
// ...and its semantic neighborhood at a chosen band. offset skips the trivially-near ones so a
// wander drifts to the interesting middle distance instead of circling the same thought.
async function neighborsOfMemory(id, offset = 4, limit = 6) {
  const { rows } = await q(
    `SELECT id, fact, project, source,
            embedding <=> (SELECT embedding FROM ${DB_SCHEMA}.memory WHERE id = $1) AS distance
     FROM ${DB_SCHEMA}.memory
     WHERE id <> $1 AND embedding IS NOT NULL
     ORDER BY distance ASC OFFSET $2 LIMIT $3`,
    [id, offset, limit]
  );
  return rows;
}

// Clear embeddings so the background backfiller re-computes them (a "re-vectorize").
// Optional filters restrict the scope. Only touches rows that currently HAVE an embedding,
// so the returned count is exactly how many were queued for re-embedding.
async function clearEmbeddings(opts = {}) {
  const params = [];
  let where = 'embedding IS NOT NULL';
  if (opts.source)  { params.push(opts.source);  where += ` AND source = $${params.length}`; }
  if (opts.project) { params.push(opts.project); where += ` AND project = $${params.length}`; }
  const r = await q(`UPDATE ${DB_SCHEMA}.memory SET embedding = NULL WHERE ${where}`, params);
  return r.rowCount || 0;
}

// Vectorization coverage, for the dashboard + scheduled logging.
async function embeddingStats() {
  const { rows } = await q(`SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM ${DB_SCHEMA}.memory`);
  return rows[0];
}

// ── generic array-of-records tables (tasks/projects/interactions/dreams/mcp) ────
function makeReplaceAll(table, mapRow) {
  return async function replaceAll(items) {
    return withTransaction(async client => {
      const ids = [];
      for (let i = 0; i < items.length; i++) {
        const row = mapRow(items[i], i);
        if (!row) continue;
        ids.push(row.id);
        await client.query(row.sql, row.params);
      }
      if (ids.length) {
        await client.query(`DELETE FROM ${DB_SCHEMA}.${table} WHERE id <> ALL($1::text[])`, [ids]);
      } else {
        await client.query(`DELETE FROM ${DB_SCHEMA}.${table}`);
      }
    });
  };
}

async function loadAllTasks() {
  const { rows } = await q(`SELECT data FROM ${DB_SCHEMA}.tasks ORDER BY ord ASC NULLS LAST`);
  return rows.map((r) => r.data);
}
const replaceAllTasks = makeReplaceAll('tasks', (t, i) => {
  if (!t || !t.id) return null;
  return {
    id: t.id,
    sql: `INSERT INTO ${DB_SCHEMA}.tasks (id, data, status, created, scheduled_for, ord)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, status=EXCLUDED.status,
            created=EXCLUDED.created, scheduled_for=EXCLUDED.scheduled_for, ord=EXCLUDED.ord`,
    params: [t.id, t, t.status || null, t.created || null, t.scheduled_for || null, i],
  };
});

async function loadAllProjects() {
  const { rows } = await q(
    `SELECT name, details, created, last_activity, auto_created, data FROM ${DB_SCHEMA}.projects ORDER BY last_activity DESC NULLS LAST`
  );
  return rows.map((r) => Object.assign({}, r.data, {
    name: r.name,
    details: r.details,
    created: r.data && r.data.created ? r.data.created : (r.created ? r.created.toISOString() : undefined),
    last_activity: r.data && r.data.last_activity ? r.data.last_activity : (r.last_activity ? r.last_activity.toISOString() : undefined),
    auto_created: r.auto_created,
  }));
}
async function replaceAllProjects(items) {
  return withTransaction(async client => {
    const names = [];
    for (const pj of items) {
      if (!pj || !pj.name) continue;
      names.push(pj.name);
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.projects (name, details, created, last_activity, auto_created, data)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name) DO UPDATE SET details=EXCLUDED.details, created=EXCLUDED.created,
           last_activity=EXCLUDED.last_activity, auto_created=EXCLUDED.auto_created, data=EXCLUDED.data`,
        [pj.name, pj.details || null, pj.created || null, pj.last_activity || null, !!pj.auto_created, pj]
      );
    }
    if (names.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.projects WHERE name <> ALL($1::text[])`, [names]);
    } else {
      await client.query(`DELETE FROM ${DB_SCHEMA}.projects`);
    }
  });
}

async function loadAllInteractions() {
  const { rows } = await q(`SELECT data FROM ${DB_SCHEMA}.interactions ORDER BY ord ASC NULLS LAST, created ASC`);
  return rows.map((r) => r.data);
}
const replaceAllInteractions = makeReplaceAll('interactions', (x, i) => {
  if (!x || !x.id) return null;
  return {
    id: x.id,
    sql: `INSERT INTO ${DB_SCHEMA}.interactions (id, data, created, reviewed, ord)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, created=EXCLUDED.created,
            reviewed=EXCLUDED.reviewed, ord=EXCLUDED.ord`,
    params: [x.id, x, x.created || null, !!x.reviewed, i],
  };
});

async function applyTaskChanges({ upserts = [], deleted_ids: deletedIds = [] } = {}) {
  if (!upserts.length && !deletedIds.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const task of upserts) {
      const createdMs = new Date(task.created).getTime();
      const ord = Number.isFinite(createdMs) ? createdMs : Date.now();
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.tasks (id, data, status, created, scheduled_for, ord)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, status=EXCLUDED.status,
           created=EXCLUDED.created, scheduled_for=EXCLUDED.scheduled_for`,
        [task.id, task, task.status || null, task.created || null, task.scheduled_for || null, ord]
      );
    }
    if (deletedIds.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.tasks WHERE id = ANY($1::text[])`, [deletedIds]);
    }
    return { upserted: upserts.length, deleted: deletedIds.length };
  });
}

// The live Slack path appends one interaction at a time. Persist that append directly instead
// of replaying the entire bounded review ledger after every human-facing response.
async function appendInteraction(item, deletedIds = []) {
  if (!item?.id) throw new Error('interaction append requires an id');
  const snapshot = JSON.parse(JSON.stringify(item));
  const createdMs = new Date(snapshot.created).getTime();
  const ord = Number.isFinite(createdMs) ? createdMs : Date.now();
  return withTransaction(async client => {
    await client.query(
      `INSERT INTO ${DB_SCHEMA}.interactions (id, data, created, reviewed, ord)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, created=EXCLUDED.created,
         reviewed=EXCLUDED.reviewed, ord=EXCLUDED.ord`,
      [snapshot.id, snapshot, snapshot.created || null, !!snapshot.reviewed, ord]
    );
    if (deletedIds.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.interactions WHERE id = ANY($1::text[])`,
        [deletedIds]);
    }
    return { appended: snapshot.id, deleted: deletedIds.length };
  });
}

async function applyInteractionChanges({ upserts = [], deleted_ids: deletedIds = [] } = {}) {
  if (!upserts.length && !deletedIds.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const interaction of upserts) {
      if (!interaction?.id) continue;
      const createdMs = new Date(interaction.created).getTime();
      const ord = Number.isFinite(createdMs) ? createdMs : Date.now();
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.interactions (id, data, created, reviewed, ord)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, created=EXCLUDED.created,
           reviewed=EXCLUDED.reviewed`,
        [interaction.id, interaction, interaction.created || null, !!interaction.reviewed, ord]
      );
    }
    if (deletedIds.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.interactions WHERE id = ANY($1::text[])`,
        [deletedIds]);
    }
    return { upserted: upserts.length, deleted: deletedIds.length };
  });
}

async function upsertProject(project) {
  if (!project?.name) throw new Error('project upsert requires a name');
  const snapshot = JSON.parse(JSON.stringify(project));
  await q(
    `INSERT INTO ${DB_SCHEMA}.projects (name, details, created, last_activity, auto_created, data)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET details=EXCLUDED.details, created=EXCLUDED.created,
       last_activity=EXCLUDED.last_activity, auto_created=EXCLUDED.auto_created, data=EXCLUDED.data`,
    [snapshot.name, snapshot.details || null, snapshot.created || null,
      snapshot.last_activity || null, !!snapshot.auto_created, snapshot]
  );
  return snapshot.name;
}

async function loadAllDreams() {
  const { rows } = await q(`SELECT data FROM ${DB_SCHEMA}.dreams ORDER BY finished DESC NULLS LAST, ord ASC NULLS LAST`);
  return rows.map((r) => r.data);
}
const replaceAllDreams = makeReplaceAll('dreams', (d, i) => {
  if (!d || !d.id) return null;
  return {
    id: d.id,
    sql: `INSERT INTO ${DB_SCHEMA}.dreams (id, data, date, finished, ord)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, date=EXCLUDED.date,
            finished=EXCLUDED.finished, ord=EXCLUDED.ord`,
    params: [d.id, d, d.date || null, d.finished || null, i],
  };
});

async function applyDreamChanges({ upserts = [], deleted_ids: deletedIds = [] } = {}) {
  if (!upserts.length && !deletedIds.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const dream of upserts) {
      if (!dream?.id) continue;
      const finishedMs = new Date(dream.finished || dream.started).getTime();
      const ord = Number.isFinite(finishedMs) ? finishedMs : Date.now();
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.dreams (id, data, date, finished, ord)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, date=EXCLUDED.date,
           finished=EXCLUDED.finished`,
        [dream.id, dream, dream.date || null, dream.finished || null, ord]
      );
    }
    if (deletedIds.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.dreams WHERE id = ANY($1::text[])`, [deletedIds]);
    }
    return { upserted: upserts.length, deleted: deletedIds.length };
  });
}

async function loadAllMcp() {
  const { rows } = await q(`SELECT data FROM ${DB_SCHEMA}.mcp_servers ORDER BY ord ASC NULLS LAST`);
  return rows.map((r) => r.data);
}
const replaceAllMcp = makeReplaceAll('mcp_servers', (m, i) => {
  if (!m || !m.id) return null;
  return {
    id: m.id,
    sql: `INSERT INTO ${DB_SCHEMA}.mcp_servers (id, data, ord) VALUES ($1,$2,$3)
          ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, ord=EXCLUDED.ord`,
    params: [m.id, m, i],
  };
});

// ── markers (key→object map) ────────────────────────────────────────────────────
async function loadAllMarkers() {
  const { rows } = await q(`SELECT key, value FROM ${DB_SCHEMA}.markers`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function replaceAllMarkers(map) {
  return withTransaction(async client => {
    const keys = Object.keys(map || {});
    for (const k of keys) {
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.markers (key, value, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [k, map[k]]
      );
    }
    if (keys.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.markers WHERE key <> ALL($1::text[])`, [keys]);
    } else {
      await client.query(`DELETE FROM ${DB_SCHEMA}.markers`);
    }
  });
}

// ── slack_threads (key→object map) ──────────────────────────────────────────────
async function loadAllSlackThreads() {
  const { rows } = await q(`SELECT key, joined_at, last_addressed, msgs_since_addressed FROM ${DB_SCHEMA}.slack_threads`);
  const out = {};
  for (const r of rows) {
    out[r.key] = {
      joined_at: r.joined_at ? r.joined_at.toISOString() : null,
      last_addressed: r.last_addressed ? r.last_addressed.toISOString() : null,
      msgs_since_addressed: r.msgs_since_addressed || 0,
    };
  }
  return out;
}
async function replaceAllSlackThreads(map) {
  return withTransaction(async client => {
    const keys = Object.keys(map || {});
    for (const k of keys) {
      const v = map[k] || {};
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.slack_threads (key, joined_at, last_addressed, msgs_since_addressed)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET joined_at=EXCLUDED.joined_at,
           last_addressed=EXCLUDED.last_addressed, msgs_since_addressed=EXCLUDED.msgs_since_addressed`,
        [k, v.joined_at || null, v.last_addressed || null, v.msgs_since_addressed || 0]
      );
    }
    if (keys.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.slack_threads WHERE key <> ALL($1::text[])`, [keys]);
    } else {
      await client.query(`DELETE FROM ${DB_SCHEMA}.slack_threads`);
    }
  });
}

// ── transcripts (per-bot) ───────────────────────────────────────────────────────
async function upsertTranscript(botId, ended, transcript) {
  const arr = Array.isArray(transcript) ? transcript : [];
  await q(
    `INSERT INTO ${DB_SCHEMA}.transcripts (bot_id, ended, transcript, utterance_count, updated_at)
     VALUES ($1,$2,$3::jsonb,$4, now())
     ON CONFLICT (bot_id) DO UPDATE SET ended=EXCLUDED.ended, transcript=EXCLUDED.transcript,
       utterance_count=EXCLUDED.utterance_count, updated_at=now()`,
    [botId, ended || null, JSON.stringify(arr), arr.length]
  );
}
async function listTranscripts() {
  const { rows } = await q(
    `SELECT bot_id, ended, utterance_count, updated_at,
       COALESCE(NULLIF(transcript -> -1 ->> 'timestamp', ''),
         NULLIF(transcript -> -1 ->> 'time', '')) AS last_utterance_at
     FROM ${DB_SCHEMA}.transcripts ORDER BY updated_at DESC`
  );
  return rows;
}

// ── Durable provider webhook inbox ─────────────────────────────────────────
async function enqueueWebhookEvent({
  provider, event_id: eventId, payload, attestation = null,
  ordering_key: orderingKey = null,
  ordering_position: orderingPosition = null,
  available_in_ms: availableInMs = 0,
}) {
  if (!provider || !eventId || !payload || typeof payload !== 'object') {
    throw new TypeError('provider, event_id, and object payload are required');
  }
  const boundedDelayMs = Math.max(0, Math.min(5000, Number(availableInMs) || 0));
  const inserted = await q(
    `INSERT INTO ${DB_SCHEMA}.webhook_inbox
       (provider, event_id, payload, attestation, ordering_key, ordering_position,
        status, available_at, updated_at)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,'queued',
       now() + ($7 * interval '1 millisecond'),now())
     ON CONFLICT (provider, event_id) DO UPDATE
       SET event_id=${DB_SCHEMA}.webhook_inbox.event_id,
           updated_at=now()
       WHERE ${DB_SCHEMA}.webhook_inbox.payload=EXCLUDED.payload
         AND ${DB_SCHEMA}.webhook_inbox.attestation
           IS NOT DISTINCT FROM EXCLUDED.attestation
         AND ${DB_SCHEMA}.webhook_inbox.ordering_key
           IS NOT DISTINCT FROM EXCLUDED.ordering_key
         AND ${DB_SCHEMA}.webhook_inbox.ordering_position
           IS NOT DISTINCT FROM EXCLUDED.ordering_position
     RETURNING status, (xmax = 0) AS inserted`,
    [String(provider).slice(0, 80), String(eventId).slice(0, 300),
      JSON.stringify(payload), attestation == null ? null : JSON.stringify(attestation),
      orderingKey == null ? null : String(orderingKey).slice(0, 500),
      orderingPosition == null ? null : String(orderingPosition).slice(0, 120),
      boundedDelayMs]
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error(
      `webhook event ${provider}:${eventId} is already bound to different input`);
  }
  return { inserted: row.inserted === true, status: row.status };
}

async function expireExhaustedWebhookClaims(provider, {
  eventId = null,
  maxAttempts = 5,
} = {}) {
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  if (eventId != null) {
    await q(
      `UPDATE ${DB_SCHEMA}.webhook_inbox
          SET status='dead', lease_until=NULL, claim_token=NULL,
              last_error=COALESCE(last_error,
                'processing lease expired at the maximum attempt count'),
              updated_at=now()
        WHERE provider=$1 AND event_id=$2 AND status='processing'
          AND lease_until <= now() AND attempts >= $3`,
      [String(provider), String(eventId), boundedAttempts]
    );
    return;
  }
  await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox
        SET status='dead', lease_until=NULL, claim_token=NULL,
            last_error=COALESCE(last_error,
              'processing lease expired at the maximum attempt count'),
            updated_at=now()
      WHERE provider=$1 AND status='processing'
        AND lease_until <= now() AND attempts >= $2`,
    [String(provider), boundedAttempts]
  );
}

async function claimWebhookEvent(provider, eventId, {
  leaseSeconds = 600,
  maxAttempts = 5,
} = {}) {
  const boundedLease = Math.max(30, Math.min(1800, Number(leaseSeconds) || 600));
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  await expireExhaustedWebhookClaims(provider, { eventId, maxAttempts: boundedAttempts });
  const claimToken = crypto.randomUUID();
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox AS inbox
        SET status='processing', attempts=attempts+1,
            lease_until=now() + ($3 * interval '1 second'),
            claim_token=$4, updated_at=now()
      WHERE provider=$1 AND event_id=$2
        AND attempts < $5
        AND (inbox.ordering_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${DB_SCHEMA}.webhook_inbox AS earlier
           WHERE earlier.provider=inbox.provider
             AND earlier.ordering_key=inbox.ordering_key
             AND earlier.status IN ('queued','processing')
              AND (
                (earlier.status='processing' AND earlier.lease_until > now())
                OR COALESCE(earlier.ordering_position, '') <
                  COALESCE(inbox.ordering_position, '')
               OR (COALESCE(earlier.ordering_position, '') =
                     COALESCE(inbox.ordering_position, '')
                 AND (earlier.created_at, earlier.event_id) <
                   (inbox.created_at, inbox.event_id))
             )
        ))
        AND ((status='queued' AND available_at <= now())
          OR (status='processing' AND lease_until <= now()))
      RETURNING *`,
    [String(provider), String(eventId), boundedLease, claimToken, boundedAttempts]
  );
  return rows[0] || null;
}

async function claimNextWebhookEvent(provider, {
  leaseSeconds = 600,
  maxAttempts = 5,
} = {}) {
  const boundedLease = Math.max(30, Math.min(1800, Number(leaseSeconds) || 600));
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  await expireExhaustedWebhookClaims(provider, { maxAttempts: boundedAttempts });
  const claimToken = crypto.randomUUID();
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox AS inbox
        SET status='processing', attempts=inbox.attempts+1,
            lease_until=now() + ($2 * interval '1 second'),
            claim_token=$3, updated_at=now()
      WHERE (inbox.provider, inbox.event_id) = (
        SELECT candidate.provider, candidate.event_id
          FROM ${DB_SCHEMA}.webhook_inbox AS candidate
         WHERE candidate.provider=$1
           AND candidate.attempts < $4
           AND (candidate.ordering_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM ${DB_SCHEMA}.webhook_inbox AS earlier
              WHERE earlier.provider=candidate.provider
                AND earlier.ordering_key=candidate.ordering_key
                AND earlier.status IN ('queued','processing')
                AND (
                  (earlier.status='processing' AND earlier.lease_until > now())
                  OR COALESCE(earlier.ordering_position, '') <
                    COALESCE(candidate.ordering_position, '')
                  OR (COALESCE(earlier.ordering_position, '') =
                        COALESCE(candidate.ordering_position, '')
                    AND (earlier.created_at, earlier.event_id) <
                      (candidate.created_at, candidate.event_id))
                )
           ))
           AND ((candidate.status='queued' AND candidate.available_at <= now())
             OR (candidate.status='processing' AND candidate.lease_until <= now()))
         ORDER BY candidate.available_at ASC, candidate.created_at ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING inbox.*`,
    [String(provider), boundedLease, claimToken, boundedAttempts]
  );
  return rows[0] || null;
}

async function renewWebhookEventLease(provider, eventId, claimToken, {
  leaseSeconds = 30,
} = {}) {
  const token = typeof claimToken === 'string' ? claimToken.trim() : '';
  if (!token) return false;
  const boundedLease = Math.max(5, Math.min(1800, Number(leaseSeconds) || 30));
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox
        SET lease_until=GREATEST(
              lease_until, now() + ($4 * interval '1 second')),
            updated_at=now()
      WHERE provider=$1 AND event_id=$2 AND status='processing'
        AND claim_token=$3 AND lease_until > now()`,
    [String(provider), String(eventId), token, boundedLease]
  );
  return rowCount === 1;
}

async function completeWebhookEvent(provider, eventId, claimToken, {
  allowEmptyResult = false,
} = {}) {
  const token = typeof claimToken === 'string' ? claimToken.trim() : '';
  if (!token) return false;
  if (String(provider) === 'slack') {
    const { rows } = await q(
      `SELECT processing_result
         FROM ${DB_SCHEMA}.webhook_inbox
        WHERE provider=$1 AND event_id=$2 AND status='processing'
          AND claim_token=$3 AND lease_until > now()`,
      [String(provider), String(eventId), token],
    );
    if (!rows.length) return false;
    const result = rows[0].processing_result;
    if (result == null) {
      if (allowEmptyResult !== true) return false;
    } else {
      const audit = slackReplyStageAudit(result);
      if (!audit.valid
        || !['delivered', 'suppressed', 'partially_delivered_suppressed']
          .includes(result.delivery?.status)
        || result.finalization?.status !== 'completed') {
        return false;
      }
    }
  }
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox
        SET status='completed', lease_until=NULL, claim_token=NULL, last_error=NULL,
            completed_at=now(), updated_at=now()
      WHERE provider=$1 AND event_id=$2 AND status='processing'
        AND claim_token=$3 AND lease_until > now()
        AND (
          provider <> 'slack'
          OR ($4::boolean = true AND processing_result IS NULL)
          OR (
            processing_result -> 'delivery' ->> 'status'
              IN ('delivered','suppressed','partially_delivered_suppressed')
            AND processing_result -> 'finalization' ->> 'status' = 'completed'
          )
        )`,
    [String(provider), String(eventId), token, allowEmptyResult === true]
  );
  return rowCount === 1;
}

async function stageWebhookEventResult(provider, eventId, claimToken, result) {
  const token = typeof claimToken === 'string' ? claimToken.trim() : '';
  const validStage = String(provider) === 'slack'
    ? slackReplyStageAudit(result).valid === true
    : Boolean(result && typeof result === 'object' && !Array.isArray(result));
  if (!token || !validStage) return false;
  const commitment = typeof result.content_commitment === 'string'
    ? result.content_commitment : '';
  const nextStatus = String(result.delivery?.status || '');
  const { rowCount } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox
        SET processing_result=$4::jsonb, updated_at=now()
      WHERE provider=$1 AND event_id=$2 AND status='processing'
        AND claim_token=$3 AND lease_until > now()
        AND (
          (processing_result IS NULL AND $6 = 'staged')
          OR (
            processing_result ->> 'content_commitment' = $5
            AND CASE processing_result -> 'delivery' ->> 'status'
              WHEN 'staged' THEN 0 WHEN 'attempted' THEN 1
              WHEN 'delivered' THEN 2 WHEN 'suppressed' THEN 2
              WHEN 'partially_delivered_suppressed' THEN 2 ELSE 99 END
              <= CASE $6
                WHEN 'staged' THEN 0 WHEN 'attempted' THEN 1
                WHEN 'delivered' THEN 2 WHEN 'suppressed' THEN 2
                WHEN 'partially_delivered_suppressed' THEN 2 ELSE -1 END
            AND COALESCE(
                  (processing_result -> 'delivery' ->> 'attempts')::integer, 0)
              <= COALESCE(
                  ($4::jsonb -> 'delivery' ->> 'attempts')::integer, 0)
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(
                  processing_result -> 'delivery' -> 'segment_receipts',
                  '[]'::jsonb)) AS prior_receipt
               WHERE prior_receipt ->> 'ok' = 'true'
                 AND NOT COALESCE(
                   $4::jsonb -> 'delivery' -> 'segment_receipts',
                   '[]'::jsonb) @> jsonb_build_array(prior_receipt)
            )
            AND (
              processing_result -> 'delivery' -> 'first_response' IS NULL
              OR processing_result -> 'delivery' -> 'first_response'
                   = 'null'::jsonb
              OR processing_result -> 'delivery' -> 'first_response'
                   = $4::jsonb -> 'delivery' -> 'first_response'
            )
            AND COALESCE(
                  (processing_result -> 'finalization' ->> 'attempts')::integer, 0)
              <= COALESCE(
                  ($4::jsonb -> 'finalization' ->> 'attempts')::integer, 0)
            AND COALESCE(
                  $4::jsonb -> 'finalization' -> 'receipts', '[]'::jsonb)
              @> COALESCE(
                  processing_result -> 'finalization' -> 'receipts', '[]'::jsonb)
            AND (
              processing_result -> 'delivery' ->> 'status'
                NOT IN ('delivered','suppressed','partially_delivered_suppressed')
              OR (
                processing_result -> 'delivery' = $4::jsonb -> 'delivery'
                AND CASE COALESCE(
                      processing_result -> 'finalization' ->> 'status', 'pending')
                      WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1
                      WHEN 'failed' THEN 1
                      WHEN 'completed' THEN 2 ELSE 99 END
                    <= CASE COALESCE(
                      $4::jsonb -> 'finalization' ->> 'status', 'pending')
                      WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1
                      WHEN 'failed' THEN 1
                      WHEN 'completed' THEN 2 ELSE -1 END
                AND (
                  processing_result -> 'finalization' ->> 'status' IS DISTINCT FROM 'completed'
                  OR processing_result -> 'finalization'
                       = $4::jsonb -> 'finalization'
                )
              )
            )
          )
        )`,
    [String(provider), String(eventId), token, JSON.stringify(result),
      commitment, nextStatus]
  );
  return rowCount === 1;
}

async function failWebhookEvent(provider, eventId, claimToken, error, { maxAttempts = 5 } = {}) {
  const token = typeof claimToken === 'string' ? claimToken.trim() : '';
  if (!token) return null;
  const boundedAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.webhook_inbox
        SET status=CASE WHEN attempts >= $4 THEN 'dead' ELSE 'queued' END,
            available_at=CASE WHEN attempts >= $4 THEN available_at
              ELSE now() + (LEAST(60, power(2, GREATEST(0, attempts - 1)))
                * interval '1 second') END,
            lease_until=NULL, claim_token=NULL, last_error=$3, updated_at=now()
      WHERE provider=$1 AND event_id=$2 AND status='processing'
        AND claim_token=$5 AND lease_until > now()
      RETURNING status, attempts, available_at`,
    [String(provider), String(eventId),
      String(error?.message || error || 'webhook processing failed').slice(0, 500),
      boundedAttempts, token]
  );
  return rows[0] || null;
}

async function hasRecentTerminalWebhookEvent(provider, orderingKey, excludeEventId, {
  withinSeconds = 1800,
  mode = null,
} = {}) {
  const key = String(orderingKey || '').trim();
  if (!key) return false;
  const boundedSeconds = Math.max(
    1, Math.min(86400, Number(withinSeconds) || 1800));
  const { rows } = await q(
    `SELECT 1
       FROM ${DB_SCHEMA}.webhook_inbox
      WHERE provider=$1 AND ordering_key=$2 AND event_id<>$3
        AND status='completed'
        AND completed_at > now() - ($4 * interval '1 second')
        AND ($5::text IS NULL OR processing_result ->> 'mode' = $5)
        AND (
          processing_result -> 'delivery' ->> 'status'
            IN ('delivered','partially_delivered_suppressed')
          OR (
            processing_result -> 'delivery' ->> 'status' = 'suppressed'
            AND processing_result -> 'delivery' ->> 'terminal_reason'
              IN ('intentional_silence','proactive_model_declined')
          )
        )
      LIMIT 1`,
    [String(provider), key, String(excludeEventId || ''), boundedSeconds,
      mode == null ? null : String(mode)]
  );
  return rows.length > 0;
}

async function hasLaterTerminalWebhookEvent(
  provider,
  orderingKey,
  orderingPosition,
  excludeEventId,
) {
  const key = String(orderingKey || '').trim();
  const position = String(orderingPosition || '').trim();
  if (!key || !position) return false;
  const { rows } = await q(
    `SELECT 1
       FROM ${DB_SCHEMA}.webhook_inbox
      WHERE provider=$1 AND ordering_key=$2 AND event_id<>$4
        AND status='completed'
        AND COALESCE(ordering_position, '') > $3
      LIMIT 1`,
    [String(provider), key, position, String(excludeEventId || '')],
  );
  return rows.length > 0;
}

async function webhookInboxStats(provider) {
  const { rows } = await q(
    `SELECT status, count(*)::integer AS count,
            min(created_at) AS oldest_created_at
       FROM ${DB_SCHEMA}.webhook_inbox
      WHERE provider=$1
      GROUP BY status`,
    [String(provider)]
  );
  const counts = {};
  let oldestActiveAt = null;
  for (const row of rows) {
    counts[row.status] = Number(row.count) || 0;
    if (['queued', 'processing'].includes(row.status) && row.oldest_created_at) {
      const timestamp = new Date(row.oldest_created_at).getTime();
      if (Number.isFinite(timestamp)
        && (oldestActiveAt == null || timestamp < oldestActiveAt)) {
        oldestActiveAt = timestamp;
      }
    }
  }
  return {
    counts,
    active_count: Number(counts.queued || 0) + Number(counts.processing || 0),
    dead_letters: Number(counts.dead || 0),
    oldest_active_at: oldestActiveAt == null
      ? null : new Date(oldestActiveAt).toISOString(),
    oldest_active_age_ms: oldestActiveAt == null
      ? 0 : Math.max(0, Date.now() - oldestActiveAt),
  };
}

async function pruneWebhookEvents({ retentionDays = 14 } = {}) {
  const days = Math.max(1, Math.min(90, Number(retentionDays) || 14));
  const { rowCount } = await q(
    `DELETE FROM ${DB_SCHEMA}.webhook_inbox
      WHERE status IN ('completed','dead')
        AND updated_at < now() - ($1 * interval '1 day')`,
    [days]
  );
  return rowCount;
}

async function applySlackThreadChanges({ upserts = [], deleted_keys: deletedKeys = [] } = {}) {
  if (!upserts.length && !deletedKeys.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const item of upserts) {
      if (!item?.key) continue;
      const value = item.value || {};
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.slack_threads (key, joined_at, last_addressed, msgs_since_addressed)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET joined_at=EXCLUDED.joined_at,
           last_addressed=EXCLUDED.last_addressed, msgs_since_addressed=EXCLUDED.msgs_since_addressed`,
        [item.key, value.joined_at || null, value.last_addressed || null,
          value.msgs_since_addressed || 0]
      );
    }
    if (deletedKeys.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.slack_threads WHERE key = ANY($1::text[])`,
        [deletedKeys]);
    }
    return { upserted: upserts.length, deleted: deletedKeys.length };
  });
}

async function applyMarkerChanges({ upserts = [], deleted_keys: deletedKeys = [] } = {}) {
  if (!upserts.length && !deletedKeys.length) return { upserted: 0, deleted: 0 };
  return withTransaction(async client => {
    for (const change of upserts) {
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.markers (key, value, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [change.key, change.value]
      );
    }
    if (deletedKeys.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.markers WHERE key = ANY($1::text[])`,
        [deletedKeys]);
    }
    return { upserted: upserts.length, deleted: deletedKeys.length };
  });
}
async function getTranscript(botId) {
  const { rows } = await q(`SELECT bot_id, ended, transcript FROM ${DB_SCHEMA}.transcripts WHERE bot_id=$1`, [botId]);
  return rows[0] || null;
}
async function deleteTranscript(botId) {
  await q(`DELETE FROM ${DB_SCHEMA}.transcripts WHERE bot_id=$1`, [botId]);
}

// ── app_state (singleton jsonb values) ──────────────────────────────────────────
async function getState(key, fallback = null) {
  const { rows } = await q(`SELECT value FROM ${DB_SCHEMA}.app_state WHERE key=$1`, [key]);
  return rows.length ? rows[0].value : fallback;
}
async function setState(key, value) {
  await q(
    `INSERT INTO ${DB_SCHEMA}.app_state (key, value, updated_at) VALUES ($1,$2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
}
async function appendTranscript(botId, ended, utterances, expectedCount) {
  const delta = Array.isArray(utterances) ? utterances : [];
  const expected = Math.max(0, Number(expectedCount) || 0);
  const { rows } = await q(
    `INSERT INTO ${DB_SCHEMA}.transcripts AS current
       (bot_id, ended, transcript, utterance_count, updated_at)
     SELECT $1,$2,$3::jsonb,$4,now() WHERE $5=0
     ON CONFLICT (bot_id) DO UPDATE SET
       ended=COALESCE(EXCLUDED.ended, current.ended),
       transcript=current.transcript || EXCLUDED.transcript,
       utterance_count=current.utterance_count + EXCLUDED.utterance_count,
       updated_at=now()
     WHERE current.utterance_count=$5
     RETURNING utterance_count`,
    [botId, ended || null, JSON.stringify(delta), delta.length, expected]
  );
  return rows.length
    ? { applied: true, utterance_count: Number(rows[0].utterance_count) || 0 }
    : { applied: false, utterance_count: null };
}
async function setStateSerialized(key, serializedValue) {
  if (typeof serializedValue !== 'string') throw new TypeError('serialized app state must be a JSON string');
  await q(
    `INSERT INTO ${DB_SCHEMA}.app_state (key, value, updated_at) VALUES ($1,$2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, serializedValue]
  );
}
async function getCompressedState(key) {
  const { rows } = await q(
    `SELECT value, codec, original_bytes, updated_at
     FROM ${DB_SCHEMA}.app_state_blobs WHERE key=$1`, [key]
  );
  if (!rows.length) return null;
  return { data: rows[0].value, codec: rows[0].codec,
    original_bytes: Number(rows[0].original_bytes) || null, updated_at: rows[0].updated_at };
}
async function setCompressedState(key, value, { codec = 'gzip-json-v1', originalBytes = null } = {}) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('compressed app state must be bytes');
  }
  await q(
    `INSERT INTO ${DB_SCHEMA}.app_state_blobs (key, value, codec, original_bytes, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, codec=EXCLUDED.codec,
       original_bytes=EXCLUDED.original_bytes, updated_at=now()`,
    [key, Buffer.from(value), codec, originalBytes]
  );
}
async function deleteState(key) {
  await q(`DELETE FROM ${DB_SCHEMA}.app_state WHERE key=$1`, [key]);
}

// Count rows in a table (used by the seed-if-empty migration).
async function count(table) {
  const { rows } = await q(`SELECT count(*)::int AS n FROM ${DB_SCHEMA}.${table}`);
  return rows[0].n;
}

async function close() {
  await Promise.all([
    pool ? pool.end().catch(() => {}) : null,
    interactivePool ? interactivePool.end().catch(() => {}) : null,
  ]);
  pool = null;
  interactivePool = null;
  ready = false;
}

module.exports = {
  dbEnabled, isReady, init, close, q, embed, count, backgroundAllowed, diagnostics,
  EMBED_DIM, EMBED_MODEL, DB_SCHEMA, databaseSslPolicy, databaseConnectionString,
  serializeRunLockMutation,
  loadAllMemory, replaceAllMemory, applyMemoryChanges, memoryNeedingEmbedding, setMemoryEmbedding, searchMemoryByVector,
  clearEmbeddings, embeddingStats, bumpMemoryRecall, randomEmbeddedMemory, neighborsOfMemory,
  loadAllTasks, replaceAllTasks, applyTaskChanges,
  loadAllProjects, replaceAllProjects, upsertProject,
  loadAllInteractions, replaceAllInteractions, appendInteraction, applyInteractionChanges,
  loadAllDreams, replaceAllDreams, applyDreamChanges,
  loadAllMcp, replaceAllMcp,
  loadAllMarkers, replaceAllMarkers, applyMarkerChanges,
  loadAllSlackThreads, replaceAllSlackThreads, applySlackThreadChanges,
  upsertTranscript, appendTranscript, listTranscripts, getTranscript, deleteTranscript,
  getState, setState, setStateSerialized, getCompressedState, setCompressedState, deleteState,
  enqueueJob, claimNextQueuedJob, finishJob, checkpointInternalJob,
  finishInternalJob, retryInternalJob,
  stageJobDelivery, claimJobDelivery,
  deferJobDelivery, recoverInterruptedJobDeliveries, interruptRunningJobs, recentJobs,
  enqueueWebhookEvent, claimWebhookEvent, claimNextWebhookEvent,
  completeWebhookEvent, renewWebhookEventLease, stageWebhookEventResult,
  failWebhookEvent, hasRecentTerminalWebhookEvent,
  hasLaterTerminalWebhookEvent, webhookInboxStats,
  pruneWebhookEvents,
};
