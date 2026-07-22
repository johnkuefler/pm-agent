'use strict';

function fingerprint(task) {
  return JSON.stringify(task);
}

function captureTaskPersistence(tasks = []) {
  return new Map(tasks.filter(task => task?.id).map(task => [task.id, fingerprint(task)]));
}

function diffTaskPersistence(before = new Map(), tasks = []) {
  const currentIds = new Set();
  const upserts = [];
  for (const task of tasks) {
    if (!task?.id) continue;
    currentIds.add(task.id);
    if (before.get(task.id) !== fingerprint(task)) {
      upserts.push(JSON.parse(JSON.stringify(task)));
    }
  }
  return { upserts, deleted_ids: [...before.keys()].filter(id => !currentIds.has(id)) };
}

module.exports = { captureTaskPersistence, diffTaskPersistence };
