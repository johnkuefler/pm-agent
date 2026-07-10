// ─────────────────────────────────────────────────────────────────────────────
// db.js — Postgres persistence layer for Nora.
//
// Design: Postgres is the durable source of truth. server.js keeps its existing
// SYNCHRONOUS accessor API, backed by in-memory caches (this is a single-instance
// app, so a process-local cache stays coherent) that write through to Postgres
// asynchronously. The flat JSON files remain only as (a) a one-time seed on first
// boot and (b) an offline fallback when DATABASE_URL is unset (local dev).
//
// Memory rows carry a pgvector embedding for semantic recall. Embeddings are filled
// by a background backfiller so the hot write path (Slack replies) never blocks on
// an embedding API call.
//
// Isolation for testing: all tables live in DB_SCHEMA (default 'public'). Tests set
// DB_SCHEMA=nora_test so they never touch production data in 'public'.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
const DB_SCHEMA = (process.env.DB_SCHEMA || 'public').replace(/[^a-zA-Z0-9_]/g, '') || 'public';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;

let pool = null;
let ready = false;

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
    // Set search_path in the startup packet (no per-connection query, no race). public
    // must stay on the path so the pgvector type/operators resolve; tables are also
    // fully schema-qualified so this is defense-in-depth.
    options: `-c search_path=${DB_SCHEMA},public`,
  });
  pool.on('error', (err) => console.error('pg pool error:', err.message));
  return pool;
}

async function q(text, params) {
  return getPool().query(text, params);
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
    CREATE UNIQUE INDEX IF NOT EXISTS projects_name_lower ON ${DB_SCHEMA}.projects (lower(name));

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
  `);
  ready = true;
}

// ── Vector helpers ─────────────────────────────────────────────────────────────
function toVectorLiteral(arr) {
  if (!Array.isArray(arr) || arr.length !== EMBED_DIM) return null;
  return '[' + arr.map((x) => (Number.isFinite(x) ? x : 0)).join(',') + ']';
}

// Embed text via OpenAI. Returns number[] or null (no key / failure — caller degrades
// gracefully to keyword search). Never throws.
async function embed(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: String(text).slice(0, 8000) }),
    });
    if (!res.ok) { console.warn('embed http', res.status); return null; }
    const j = await res.json();
    const v = j && j.data && j.data[0] && j.data[0].embedding;
    return Array.isArray(v) && v.length === EMBED_DIM ? v : null;
  } catch (e) { console.warn('embed error:', e.message); return null; }
}

// ── memory ─────────────────────────────────────────────────────────────────────
async function loadAllMemory() {
  const { rows } = await q(
    `SELECT id, fact, project, added, source, source_bot_id FROM ${DB_SCHEMA}.memory ORDER BY ord ASC NULLS LAST, created_at ASC`
  );
  return rows.map((r) => {
    const o = { id: r.id, fact: r.fact, added: r.added, source: r.source };
    if (r.project) o.project = r.project;
    if (r.source_bot_id) o.source_bot_id = r.source_bot_id;
    return o;
  });
}

// Replace the whole memory set to mirror the old whole-file write. Upsert preserves
// each row's existing embedding UNLESS the fact text changed (then it is nulled so
// the backfiller re-embeds). Rows absent from `items` are deleted.
async function replaceAllMemory(items) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
    const ids = [];
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      if (!m || !m.id || !m.fact) continue;
      ids.push(m.id);
      await client.query(
        `INSERT INTO ${DB_SCHEMA}.memory (id, fact, project, added, source, source_bot_id, ord, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id) DO UPDATE SET
           fact = EXCLUDED.fact,
           project = EXCLUDED.project,
           added = EXCLUDED.added,
           source = EXCLUDED.source,
           source_bot_id = EXCLUDED.source_bot_id,
           ord = EXCLUDED.ord,
           updated_at = now(),
           embedding = CASE WHEN ${DB_SCHEMA}.memory.fact IS DISTINCT FROM EXCLUDED.fact
                            THEN NULL ELSE ${DB_SCHEMA}.memory.embedding END`,
        [m.id, m.fact, m.project || '', m.added || null, m.source || null, m.source_bot_id || null, i]
      );
    }
    if (ids.length) {
      await client.query(`DELETE FROM ${DB_SCHEMA}.memory WHERE id <> ALL($1::text[])`, [ids]);
    } else {
      await client.query(`DELETE FROM ${DB_SCHEMA}.memory`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
  const { rows } = await q(
    `SELECT id, fact, project, source, added, embedding <=> $1::vector AS distance
     FROM ${DB_SCHEMA}.memory WHERE ${where}
     ORDER BY embedding <=> $1::vector ASC LIMIT $2`,
    params
  );
  return rows;
}

// ── generic array-of-records tables (tasks/projects/interactions/dreams/mcp) ────
function makeReplaceAll(table, mapRow) {
  return async function replaceAll(items) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
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
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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

async function loadAllDreams() {
  const { rows } = await q(`SELECT data FROM ${DB_SCHEMA}.dreams ORDER BY ord ASC NULLS LAST, finished DESC`);
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${DB_SCHEMA}, public`);
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
    `SELECT bot_id, ended, utterance_count, updated_at FROM ${DB_SCHEMA}.transcripts ORDER BY updated_at DESC`
  );
  return rows;
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
async function deleteState(key) {
  await q(`DELETE FROM ${DB_SCHEMA}.app_state WHERE key=$1`, [key]);
}

// Count rows in a table (used by the seed-if-empty migration).
async function count(table) {
  const { rows } = await q(`SELECT count(*)::int AS n FROM ${DB_SCHEMA}.${table}`);
  return rows[0].n;
}

async function close() { if (pool) await pool.end().catch(() => {}); pool = null; ready = false; }

module.exports = {
  dbEnabled, isReady, init, close, q, embed, count,
  EMBED_DIM, DB_SCHEMA,
  loadAllMemory, replaceAllMemory, memoryNeedingEmbedding, setMemoryEmbedding, searchMemoryByVector,
  loadAllTasks, replaceAllTasks,
  loadAllProjects, replaceAllProjects,
  loadAllInteractions, replaceAllInteractions,
  loadAllDreams, replaceAllDreams,
  loadAllMcp, replaceAllMcp,
  loadAllMarkers, replaceAllMarkers,
  loadAllSlackThreads, replaceAllSlackThreads,
  upsertTranscript, listTranscripts, getTranscript, deleteTranscript,
  getState, setState, deleteState,
};
