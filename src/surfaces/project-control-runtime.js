'use strict';

const fs = require('fs');
const path = require('path');
const projectControl = require('../intelligence/project-control');
const { registerProjectControlRoutes } = require('../routes/registerProjectControlRoutes');

function createProjectControlRuntime({ localDataDir, db, cache, isDbReady, writeThrough,
  intelligence }) {
  const filePath = path.join(localDataDir, 'nora-project-control.json');
  let writeQueue = Promise.resolve();

  function load() {
    if (isDbReady()) return projectControl.normalizeLedger(cache.projectControl);
    if (cache.projectControl) return projectControl.normalizeLedger(cache.projectControl);
    try { cache.projectControl = projectControl.normalizeLedger(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch { cache.projectControl = projectControl.emptyLedger(); }
    return cache.projectControl;
  }

  async function save(value) {
    const ledger = projectControl.normalizeLedger(value);
    cache.projectControl = ledger;
    if (isDbReady()) {
      await writeThrough('project_control', () => db.setState('project_control', ledger), { strict: true });
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(temp, JSON.stringify(ledger, null, 2));
      fs.renameSync(temp, filePath);
    }
    return ledger;
  }

  function mutate(operation) {
    const queued = writeQueue.then(async () => {
      const result = await operation(load());
      await save(result.ledger);
      return result;
    });
    writeQueue = queued.catch(() => {});
    return queued;
  }

  function hydrate(value) {
    cache.projectControl = projectControl.normalizeLedger(value);
    return cache.projectControl;
  }

  function ingestMeeting(input) {
    return mutate(ledger => projectControl.ingestMeeting(ledger, input));
  }

  function promptContext(options) {
    return projectControl.renderPromptContext(load(), options);
  }

  function appendPromptContext(base, options, diagnostics = {}) {
    const context = promptContext(options);
    if (!context) return base;
    diagnostics.pm_control_chars = context.length;
    return `${base}\n\n${context}`;
  }

  function ingestExtractedMeeting({ extracted, meetingMeta, botId, ended }) {
    return ingestMeeting({
      ...extracted,
      project: extracted.project || meetingMeta?.project || null,
      meeting_ref: `/transcripts/${botId}`,
      ended,
    });
  }

  function register(app, { requireAuth, requireOperatorAuth }) {
    registerProjectControlRoutes(app, {
      requireAuth,
      requireOperatorAuth,
      loadProjectControl: load,
      saveProjectControl: save,
      mutateProjectControl: mutate,
      getInitiativeStatus: scope => intelligence.initiativeStatus(scope),
      spendInitiative: (scope, metadata) => intelligence.spendInitiative(scope, metadata),
    });
  }

  return { load, save, mutate, hydrate, ingestMeeting, ingestExtractedMeeting,
    promptContext, appendPromptContext, register };
}

module.exports = { createProjectControlRuntime };
