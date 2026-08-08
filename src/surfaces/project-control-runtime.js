'use strict';

const fs = require('fs');
const path = require('path');
const projectControl = require('../intelligence/project-control');
const projectAutopilot = require('../intelligence/project-autopilot');
const teamworkProjectStory = require('../integrations/teamwork-project-story');
const { registerProjectControlRoutes } = require('../routes/registerProjectControlRoutes');

function createProjectControlRuntime({ localDataDir, db, cache, isDbReady, writeThrough,
  intelligence, projectStory = teamworkProjectStory }) {
  const filePath = path.join(localDataDir, 'nora-project-control.json');
  let writeQueue = Promise.resolve();
  let hydrationPromise = null;
  let hydrationStatus = {
    state: 'idle',
    source: 'teamwork_project_story',
    started_at: null,
    completed_at: null,
    error: null,
    result: null,
  };

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
    return mutate(ledger => {
      const control = projectControl.ingestMeeting(ledger, input);
      const autopilot = projectAutopilot.ingestMeetingEvidence(control.ledger, input);
      return { ...control, ledger: autopilot.ledger, autopilot };
    });
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

  function getHydrationStatus() {
    return JSON.parse(JSON.stringify(hydrationStatus));
  }

  async function hydrateFromTeamwork({ dryRun = false, signal } = {}) {
    if (hydrationPromise) return hydrationPromise;
    hydrationStatus = { ...hydrationStatus, state: 'running', started_at: new Date().toISOString(),
      completed_at: null, error: null, result: null };
    hydrationPromise = (async () => {
      const snapshot = await projectStory.fetchTeamworkPortfolio({ signal });
      const stories = projectStory.buildProjectStories(snapshot);
      const result = dryRun
        ? projectStory.applyProjectStories(load(), stories, { dryRun: true })
        : await mutate(ledger => {
          const applied = projectStory.applyProjectStories(ledger, stories);
          const autopilot = projectAutopilot.reconcilePortfolio(applied.ledger, {
            source: 'teamwork_project_story_hydration',
          });
          return { ...applied, ledger: autopilot.ledger, autopilot: {
            events_created: autopilot.events.length,
            actions_created: autopilot.actions.length,
            events_resolved: autopilot.resolved_events.length,
          } };
        });
      const summary = { projects_seen: result.projects_seen, created: result.created,
        updated: result.updated, unchanged: result.unchanged, fields_filled: result.fields_filled,
        dry_run: result.dry_run, pagination: snapshot.pagination,
        autopilot: result.autopilot || null };
      hydrationStatus = { ...hydrationStatus, state: 'succeeded',
        completed_at: new Date().toISOString(), result: summary };
      return { ...result, pagination: snapshot.pagination };
    })();
    try {
      return await hydrationPromise;
    } catch (error) {
      hydrationStatus = { ...hydrationStatus, state: 'failed', completed_at: new Date().toISOString(),
        error: String(error?.message || error), result: null };
      throw error;
    } finally {
      hydrationPromise = null;
    }
  }

  function scheduleHydration(scheduleRecurringRuntimeJob) {
    return scheduleRecurringRuntimeJob('teamwork-project-story-hydration', 30 * 60 * 1000,
      ({ signal }) => hydrateFromTeamwork({ signal }), { initialDelayMs: 45 * 1000, timeoutMs: 2 * 60 * 1000 });
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
      hydrateProjectStories: hydrateFromTeamwork,
      getProjectHydrationStatus: getHydrationStatus,
    });
  }

  return { load, save, mutate, hydrate, ingestMeeting, ingestExtractedMeeting,
    promptContext, appendPromptContext, hydrateFromTeamwork, getHydrationStatus,
    scheduleHydration, register };
}

module.exports = { createProjectControlRuntime };
