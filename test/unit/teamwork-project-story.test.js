'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projectControl = require('../../src/intelligence/project-control');
const projectStory = require('../../src/integrations/teamwork-project-story');
const { createProjectControlRuntime } = require('../../src/surfaces/project-control-runtime');

const NOW = new Date('2026-08-08T14:00:00.000Z');

function snapshot() {
  return {
    observed_at: NOW.toISOString(),
    projects: [{
      id: '100',
      name: 'Client website',
      description: '',
      company: 'Client Company',
      status: 'active',
      start_at: '2026-07-01T00:00:00.000Z',
      end_at: '2026-09-01T00:00:00.000Z',
      owner: 'Morgan Lee',
      updated_at: '2026-08-08T12:00:00.000Z',
    }],
    milestones: [{
      id: '500', project_id: '100', name: 'Client approval',
      due_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-07T12:00:00.000Z',
    }],
    tasks: [{
      id: '700', project_id: '100', tasklist_id: '600', tasklist_name: 'Quality assurance',
      milestone_id: '500', name: 'UAT sign-off',
      description: 'Client must confirm UAT acceptance before launch.', priority: 'high', progress: 20,
      start_at: null, due_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-08T13:00:00.000Z', out_of_sequence: false,
      assignees: ['Taylor Reed'],
    }, {
      id: '701', project_id: '100', tasklist_id: '601', tasklist_name: 'Content',
      milestone_id: '', name: 'Load approved copy', description: '', priority: 'medium', progress: 0,
      start_at: null, due_at: '2026-08-10T00:00:00.000Z',
      updated_at: '2026-08-08T11:00:00.000Z', out_of_sequence: false,
      assignees: [],
    }],
  };
}

test('Teamwork project stories derive an evidence-bound operating picture', () => {
  const [story] = projectStory.buildProjectStories(snapshot(), { now: NOW });
  assert.equal(story.teamwork_id, '100');
  assert.equal(story.objective,
    'Advance Client website through quality assurance to Client approval by 2026-08-12.');
  assert.equal(story.phase, 'quality assurance');
  assert.equal(story.pm, 'Morgan Lee');
  assert.equal(story.next_milestone, 'Client approval');
  assert.equal(story.next_milestone_due, '2026-08-12T00:00:00.000Z');
  assert.deepEqual(story.critical_path, ['UAT sign-off due 2026-08-11']);
  assert.deepEqual(story.decision_refs, ['teamwork:task:700']);
  assert.equal(story.decision_state.open_count, 1);
  assert.deepEqual(story.decision_state.candidates[0], {
    id: '700', title: 'UAT sign-off',
    description: 'Client must confirm UAT acceptance before launch.',
    tasklist: 'Quality assurance', priority: 'high', progress: 20, start_at: null,
    due_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-08T13:00:00.000Z',
    out_of_sequence: false, assignees: ['Taylor Reed'], evidence_ref: 'teamwork:task:700',
  });
  assert.equal(story.hydration.version, 2);
  assert.equal(story.hydration.field_sources.objective.derived, true);
  assert.equal(story.hydration.field_sources.next_milestone.confidence, 1);
  assert.deepEqual(story.hydration.schedule, {
    open_tasks: 2, overdue_tasks: 0, unassigned_tasks: 1, open_milestones: 1,
  });
  assert.match(story.hydration.source_signature, /^[a-f0-9]{64}$/);
});

test('hydration fills gaps, preserves human curation, and becomes idempotent', () => {
  let ledger = projectControl.upsertProject(projectControl.emptyLedger(), {
    key: '100', teamwork_id: '100', name: 'Client website',
    phase: 'client review', pm: 'Human selected PM',
    critical_path: ['Human verified dependency'],
  }, { now: NOW }).ledger;
  const [story] = projectStory.buildProjectStories(snapshot(), { now: NOW });
  const first = projectStory.applyProjectStories(ledger, [story], { now: NOW });
  ledger = first.ledger;
  const project = ledger.projects[0];

  assert.equal(first.created, 0);
  assert.equal(first.updated, 1);
  assert.equal(project.objective,
    'Advance Client website through quality assurance to Client approval by 2026-08-12.');
  assert.equal(project.phase, 'client review');
  assert.equal(project.pm, 'Human selected PM');
  assert.deepEqual(project.critical_path, ['Human verified dependency']);
  assert.equal(project.decision_state.candidates[0].description,
    'Client must confirm UAT acceptance before launch.');
  assert.equal(project.decision_state.candidates[0].tasklist, 'Quality assurance');
  assert.equal(project.next_milestone, 'Client approval');
  assert.equal(project.completeness.ratio, 1);
  assert.equal(project.hydration.source, 'teamwork_project_story');
  assert.ok(project.hydration.managed_fields.includes('objective'));
  assert.ok(project.hydration.managed_fields.includes('next_milestone'));
  assert.equal(project.hydration.managed_fields.includes('phase'), false);
  assert.equal(project.hydration.managed_fields.includes('pm'), false);
  assert.equal(project.hydration.managed_fields.includes('critical_path'), false);
  assert.equal(projectControl.report(ledger, { now: NOW }).projects.teamwork_hydrated, 1);

  const second = projectStory.applyProjectStories(ledger, [story], {
    now: new Date('2026-08-08T15:00:00.000Z'),
  });
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.ledger.projects[0].hydration.hydrated_at, NOW.toISOString());
});

test('previously managed fields refresh while dry runs never mutate the ledger', () => {
  const [initialStory] = projectStory.buildProjectStories(snapshot(), { now: NOW });
  const first = projectStory.applyProjectStories(projectControl.emptyLedger(), [initialStory], { now: NOW });
  const changedSnapshot = snapshot();
  changedSnapshot.milestones[0].name = 'Launch approval';
  changedSnapshot.milestones[0].due_at = '2026-08-14T00:00:00.000Z';
  const [changedStory] = projectStory.buildProjectStories(changedSnapshot, { now: NOW });
  const before = JSON.stringify(first.ledger);
  const preview = projectStory.applyProjectStories(first.ledger, [changedStory], {
    now: new Date('2026-08-09T14:00:00.000Z'), dryRun: true,
  });

  assert.equal(preview.dry_run, true);
  assert.equal(preview.updated, 1);
  assert.ok(preview.preview[0].changed_fields.includes('next_milestone'));
  assert.equal(JSON.stringify(first.ledger), before);

  const applied = projectStory.applyProjectStories(first.ledger, [changedStory], {
    now: new Date('2026-08-09T14:00:00.000Z'),
  });
  assert.equal(applied.ledger.projects[0].next_milestone, 'Launch approval');
  assert.equal(applied.ledger.projects[0].next_milestone_due, '2026-08-14T00:00:00.000Z');
});

test('a later human edit permanently releases that field from machine management', () => {
  const [initialStory] = projectStory.buildProjectStories(snapshot(), { now: NOW });
  const first = projectStory.applyProjectStories(projectControl.emptyLedger(), [initialStory], { now: NOW });
  const corrected = projectControl.upsertProject(first.ledger, {
    key: '100', objective: 'Ship an accessible site that supports the client acquisition plan.',
  }, { now: new Date('2026-08-08T15:00:00.000Z') });
  assert.equal(corrected.project.hydration.managed_fields.includes('objective'), false);

  const changedSnapshot = snapshot();
  changedSnapshot.projects[0].description = 'A newer Teamwork description';
  const [changedStory] = projectStory.buildProjectStories(changedSnapshot, { now: NOW });
  const refreshed = projectStory.applyProjectStories(corrected.ledger, [changedStory], {
    now: new Date('2026-08-09T14:00:00.000Z'),
  });
  assert.equal(refreshed.ledger.projects[0].objective,
    'Ship an accessible site that supports the client acquisition plan.');
});

test('portfolio fetch resolves included relationships and excludes internal projects', async () => {
  const getJson = async path => {
    if (path.includes('/projects.json')) return {
      projects: [
        { id: 100, name: 'Client website', status: 'active', companyId: 10, projectOwnerId: 20 },
        { id: 101, name: 'LimeLight operations', status: 'active', companyId: 11 },
      ],
      included: { companies: {
        10: { id: 10, name: 'Client Company' }, 11: { id: 11, name: 'LimeLight Marketing' },
      } },
    };
    if (path.includes('/people.json')) return {
      people: [{ id: 20, firstName: 'Morgan', lastName: 'Lee' }], included: {},
    };
    if (path.includes('/milestones.json')) return {
      milestones: [{ id: 500, projectId: 100, name: 'Approval', deadline: '2026-08-12' }],
      included: {},
    };
    if (path.includes('/tasks.json')) return {
      tasks: [{ id: 700, name: 'UAT sign-off', tasklistId: 600, dueDate: '2026-08-11',
        assignees: [{ id: 20 }] }],
      included: { tasklists: { 600: { id: 600, projectId: 100, milestoneId: 500,
        name: 'Quality assurance' } }, users: {} },
    };
    throw new Error(`unexpected Teamwork path: ${path}`);
  };

  const result = await projectStory.fetchTeamworkPortfolio({ getJson });
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].owner, 'Morgan Lee');
  assert.equal(result.tasks[0].project_id, '100');
  assert.equal(result.tasks[0].milestone_id, '500');
  assert.deepEqual(result.tasks[0].assignees, ['Morgan Lee']);
  assert.equal(result.milestones[0].due_at, '2026-08-12T00:00:00.000Z');
  assert.deepEqual(result.pagination, {
    project_pages: 1, people_pages: 1, milestone_pages: 1, task_pages: 1,
  });
});

test('project control runtime persists hydration and registers the silent refresh cadence', async t => {
  const localDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-runtime-'));
  t.after(() => fs.rmSync(localDataDir, { recursive: true, force: true }));
  const fakeStory = {
    fetchTeamworkPortfolio: async () => ({ ...snapshot(), pagination: { task_pages: 1 } }),
    buildProjectStories: projectStory.buildProjectStories,
    applyProjectStories: projectStory.applyProjectStories,
  };
  const runtime = createProjectControlRuntime({
    localDataDir, db: {}, cache: {}, isDbReady: () => false,
    writeThrough: async (_name, operation) => operation(),
    intelligence: { initiativeStatus: () => ({ remaining: 0 }), spendInitiative: () => null },
    projectStory: fakeStory,
  });
  let registration = null;
  runtime.scheduleHydration((name, interval, work, options) => {
    registration = { name, interval, work, options };
    return registration;
  });
  assert.equal(registration.name, 'teamwork-project-story-hydration');
  assert.equal(registration.interval, 30 * 60 * 1000);
  assert.equal(registration.options.initialDelayMs, 45 * 1000);

  const result = await runtime.hydrateFromTeamwork();
  assert.equal(result.created, 1);
  assert.equal(runtime.getHydrationStatus().state, 'succeeded');
  assert.equal(runtime.getHydrationStatus().result.projects_seen, 1);
  assert.equal(runtime.load().projects[0].teamwork_id, '100');
  assert.equal(fs.existsSync(path.join(localDataDir, 'nora-project-control.json')), true);
});
