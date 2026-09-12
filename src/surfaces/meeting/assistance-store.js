'use strict';

const fs = require('fs');
const path = require('path');
const PREFIX = 'meeting-assistance:';

function createAssistanceStore({ db, databaseReady, directory, writeThrough }) {
  const records = {};
  let queue = Promise.resolve();
  const key = id => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid meeting id');
    return PREFIX + id;
  };
  const file = id => path.join(directory, `meeting-assistance-${id}.json`);
  async function load() {
    if (databaseReady()) {
      const result = await db.q(`SELECT value FROM ${db.DB_SCHEMA}.app_state
        WHERE key LIKE 'meeting-assistance:%' ORDER BY updated_at DESC LIMIT 300`);
      for (const row of result.rows) if (row.value?.bot_id) records[row.value.bot_id] = row.value;
    } else if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory).filter(n => /^meeting-assistance-[a-zA-Z0-9_-]+\.json$/.test(n)).slice(-300)) {
        const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        records[record.bot_id] = record;
      }
    }
  }
  async function get(id) {
    key(id);
    if (records[id]) return records[id];
    const record = databaseReady() ? await db.getState(key(id))
      : fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : null;
    if (record) records[id] = record;
    return record;
  }
  function update(id, mutate) {
    key(id);
    const work = queue.then(async () => {
      const current = await get(id) || { bot_id: id };
      const next = mutate(structuredClone(current));
      if (!next) return current;
      next.updated_at = new Date().toISOString();
      if (databaseReady()) await writeThrough(key(id), () => db.setState(key(id), next), { strict: true });
      else {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file(id) + '.tmp', JSON.stringify(next));
        fs.renameSync(file(id) + '.tmp', file(id));
      }
      records[id] = next;
      return next;
    });
    queue = work.catch(() => {});
    return work;
  }
  function remove(id) {
    // Retain only the ID tombstone so a delayed webhook/calendar replay cannot recreate deleted
    // notes. No meeting content survives this replacement.
    return update(id, () => ({ bot_id: id, deleted: true }));
  }
  return { records, load, get, update, remove, drain: () => queue };
}

module.exports = { createAssistanceStore };
