// ─────────────────────────────────────────────────────────────────────────────
// db.js — Postgres persistence layer for Nora.
//
// Design: Postgres is the durable source of truth. server.js keeps its existing
// SYNCHRONOUS accessor API, backed by in-memory caches (this is a single-instance
// app, so a process-local cache stays coherent) that write through to Postgres
// asynchronously. The flat JSON files remain only as (a) a one-time seed on first
// boot and (b) an offline fallback when DATABASE_URL is unset (local dev).
//
// Isolation for testing: all tables live in DB_SCHEMA (default 'public'). Tests set
// DB_SCHEMA=nora_test so they never touch production data in 'public'.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
const DB_SCHEMA = (process.env.DB_SCHEMA || 'public').replace(/[^a-zA-Z0-9_]/g, '') || 'public';
let pool = null;
let ready = false;
const DB_QUERY_TIMEOUT_MS = Math.max(5000, Math.min(60000, Number(process.env.DB_QUERY_TIMEOUT_MS) || 20000));
const DB_DEGRADED_COOLDOWN_MS = Math.max(10000, Math.min(300000, Number(process.env.DB_DEGRADED_COOLDOWN_MS) || 60000));
const dbRuntime = { consecutive_connection_failures: 0, degraded_until: 0, last_error: null,
  last_error_at: null, last_success_at: null,
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

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
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
      console.error('pg client error:', err.message);
    });
  });
  return pool;
}

function isConnectionFailure(error) {
  return /(?:connection|timeout|terminated|ECONN|EPIPE|57P0[123]|0800)/i.test(
    `${error?.code || ''} ${error?.message || error || ''}`);
}

async function q(text, params) {
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

function backgroundAllowed() {
  return Date.now() >= dbRuntime.degraded_until;
}

function diagnostics() {
  return {
    query_timeout_ms: DB_QUERY_TIMEOUT_MS,
    background_degraded: !backgroundAllowed(),
    degraded_until: dbRuntime.degraded_until ? new Date(dbRuntime.degraded_until).toISOString() : null,
    consecutive_connection_failures: dbRuntime.consecutive_connection_failures,
    last_error: dbRuntime.last_error,
    last_error_at: dbRuntime.last_error_at,
    last_success_at: dbRuntime.last_success_at,
    pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
    transactions: {
      attempts: dbRuntime.transactions,
      failures: dbRuntime.transaction_failures,
      discarded_clients: dbRuntime.discarded_transaction_clients,
      rollback_failures: dbRuntime.rollback_failures,
    },
  };
}

// ── Schema ───────────────────────────────────────────────────────────────────
async function init() {
  const p = getPool();
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await p.query(`SET search_path TO ${DB_SCHEMA}, public`);
  await p.query(`
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

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.slack_conversation_audit (
      interaction_id              text PRIMARY KEY,
      slack_event_id              text,
      channel_id                  text NOT NULL,
      channel_name                text,
      channel_type                text,
      thread_ts                   text,
      inbound_ts                  text NOT NULL,
      user_id                     text,
      user_name                   text,
      inbound_text                text NOT NULL,
      received_at                 timestamptz NOT NULL DEFAULT now(),
      handling_status             text NOT NULL DEFAULT 'received',
      response_kind               text,
      response_text               text,
      response_slack_timestamps   jsonb NOT NULL DEFAULT '[]'::jsonb,
      responded_at                timestamptz,
      error                       text,
      metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS slack_conversation_audit_received_idx
      ON ${DB_SCHEMA}.slack_conversation_audit (received_at DESC);
    CREATE INDEX IF NOT EXISTS slack_conversation_audit_channel_idx
      ON ${DB_SCHEMA}.slack_conversation_audit (channel_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS slack_conversation_audit_user_idx
      ON ${DB_SCHEMA}.slack_conversation_audit (user_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS slack_conversation_audit_status_idx
      ON ${DB_SCHEMA}.slack_conversation_audit (handling_status, received_at DESC);

    CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.mcp_servers (
      id        text PRIMARY KEY,
      data      jsonb NOT NULL,
      ord       bigint
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
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON ${DB_SCHEMA}.jobs (status, created_at);
  `);
  ready = true;
}

// ── Background job queue ────────────────────────────────────────────────────────
async function enqueueJob(job) {
  await q(
    `INSERT INTO ${DB_SCHEMA}.jobs (id, status, kind, connection_id, tool_name, label, args, origin)
     VALUES ($1,'queued',$2,$3,$4,$5,$6,$7)`,
    [job.id, job.kind || null, job.connection_id || null, job.tool_name || null, job.label || null,
     JSON.stringify(job.args || {}), JSON.stringify(job.origin || {})]
  );
  return job.id;
}
// Atomic claim: FOR UPDATE SKIP LOCKED so a claim never double-runs even if two workers race.
async function claimNextQueuedJob() {
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs SET status='running', started_at=now(), attempts=attempts+1
     WHERE id = (SELECT id FROM ${DB_SCHEMA}.jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`
  );
  return rows[0] || null;
}
async function finishJob(id, { status, result, error }) {
  await q(
    `UPDATE ${DB_SCHEMA}.jobs SET status=$2, result=$3, error=$4, finished_at=now() WHERE id=$1`,
    [id, status, result !== undefined && result !== null ? JSON.stringify(result) : null, error || null]
  );
}
// A running connector job may have committed its remote side effect before a restart severed
// the response. Replaying it is unsafe without provider-level idempotency, so preserve the
// ambiguity explicitly and require a human-visible check before any retry.
async function interruptRunningJobs() {
  const error = 'Service restarted while the connector action was in progress. Its remote outcome is unknown, so it was not retried automatically.';
  const { rows } = await q(
    `UPDATE ${DB_SCHEMA}.jobs
        SET status='interrupted', error=$1, finished_at=now()
      WHERE status='running'
      RETURNING *`,
    [error]
  );
  return rows;
}
async function recentJobs(limit = 25) {
  const { rows } = await q(
    `SELECT id, status, kind, connection_id, tool_name, label, origin, error, created_at, started_at, finished_at
     FROM ${DB_SCHEMA}.jobs ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

// ── generic array-of-records tables (tasks/projects/mcp) ──────────
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
  if (pool) await pool.end().catch(() => {});
  pool = null;
  ready = false;
}

// ── Slack conversation audit ───────────────────────────────────────────────────
async function upsertSlackConversationAudit(item) {
  await q(
    `INSERT INTO ${DB_SCHEMA}.slack_conversation_audit
       (interaction_id, slack_event_id, channel_id, channel_type, thread_ts, inbound_ts,
        user_id, inbound_text, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (interaction_id) DO UPDATE SET
       slack_event_id=COALESCE(EXCLUDED.slack_event_id,
         ${DB_SCHEMA}.slack_conversation_audit.slack_event_id),
       channel_type=COALESCE(EXCLUDED.channel_type,
         ${DB_SCHEMA}.slack_conversation_audit.channel_type),
       thread_ts=COALESCE(EXCLUDED.thread_ts, ${DB_SCHEMA}.slack_conversation_audit.thread_ts),
       user_id=COALESCE(EXCLUDED.user_id, ${DB_SCHEMA}.slack_conversation_audit.user_id),
       inbound_text=EXCLUDED.inbound_text,
       metadata=${DB_SCHEMA}.slack_conversation_audit.metadata || EXCLUDED.metadata,
       updated_at=now()`,
    [item.interaction_id, item.slack_event_id || null, item.channel_id,
      item.channel_type || null, item.thread_ts || null, item.inbound_ts,
      item.user_id || null, item.inbound_text || '', JSON.stringify(item.metadata || {})]
  );
}

async function updateSlackConversationAudit(interactionId, patch = {}) {
  const columns = {
    handling_status: 'handling_status', response_kind: 'response_kind',
    response_text: 'response_text', user_name: 'user_name', channel_name: 'channel_name',
    error: 'error', response_slack_timestamps: 'response_slack_timestamps',
  };
  const values = [interactionId];
  const assignments = [];
  for (const [field, column] of Object.entries(columns)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    values.push(field === 'response_slack_timestamps'
      ? JSON.stringify(patch[field] || []) : patch[field]);
    assignments.push(`${column}=$${values.length}${field === 'response_slack_timestamps' ? '::jsonb' : ''}`);
  }
  if (patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)) {
    values.push(JSON.stringify(patch.metadata));
    assignments.push(`metadata=metadata || $${values.length}::jsonb`);
  }
  if (patch.responded === true) assignments.push('responded_at=now()');
  if (!assignments.length) return false;
  assignments.push('updated_at=now()');
  const result = await q(
    `UPDATE ${DB_SCHEMA}.slack_conversation_audit SET ${assignments.join(', ')}
     WHERE interaction_id=$1`, values);
  return result.rowCount > 0;
}

async function listSlackConversationAudit({ limit = 100, since = null, channel = null,
  user = null, status = null, q: search = null } = {}) {
  const params = [];
  const where = [];
  const add = value => { params.push(value); return `$${params.length}`; };
  if (since) where.push(`received_at >= ${add(since)}::timestamptz`);
  if (channel) where.push(`channel_id = ${add(channel)}`);
  if (user) where.push(`user_id = ${add(user)}`);
  if (status) where.push(`handling_status = ${add(status)}`);
  if (search) {
    const ref = add(`%${search}%`);
    where.push(`(inbound_text ILIKE ${ref} OR COALESCE(response_text, '') ILIKE ${ref}
      OR COALESCE(error, '') ILIKE ${ref} OR COALESCE(user_name, '') ILIKE ${ref}
      OR COALESCE(channel_name, '') ILIKE ${ref})`);
  }
  const boundedLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  params.push(boundedLimit);
  const { rows } = await q(
    `SELECT interaction_id, slack_event_id, channel_id, channel_name, channel_type, thread_ts,
       inbound_ts, user_id, user_name, inbound_text, received_at, handling_status,
       response_kind, response_text, response_slack_timestamps, responded_at, error,
       metadata, updated_at
     FROM ${DB_SCHEMA}.slack_conversation_audit
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY received_at DESC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = {
  dbEnabled, isReady, init, close, q, count, backgroundAllowed, diagnostics, DB_SCHEMA,
  loadAllTasks, replaceAllTasks, applyTaskChanges,
  loadAllProjects, replaceAllProjects, upsertProject,
  loadAllMcp, replaceAllMcp,
  loadAllMarkers, replaceAllMarkers, applyMarkerChanges,
  loadAllSlackThreads, replaceAllSlackThreads, applySlackThreadChanges,
  upsertSlackConversationAudit, updateSlackConversationAudit, listSlackConversationAudit,
  upsertTranscript, appendTranscript, listTranscripts, getTranscript, deleteTranscript,
  getState, setState, setStateSerialized, getCompressedState, setCompressedState, deleteState,
  enqueueJob, claimNextQueuedJob, finishJob, interruptRunningJobs, recentJobs,
};
