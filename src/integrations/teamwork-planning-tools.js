'use strict';

const WRITE_TOOL_NAMES = Object.freeze([
  'teamwork_create_project',
  'teamwork_create_tasklist',
  'teamwork_create_milestone',
  'teamwork_apply_project_plan',
]);

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function projectDate(value, label, ymd) {
  if (value == null || value === '') return null;
  const compact = ymd(required(value, label));
  if (!/^\d{8}$/.test(compact)) throw new Error(`${label} must be YYYY-MM-DD`);
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${formatted}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== formatted) {
    throw new Error(`${label} must be a real calendar date`);
  }
  return formatted;
}

function uniqueByName(items, label, nameOf) {
  const seen = new Set();
  for (const item of items) {
    const name = normalizedName(nameOf(item));
    if (!name) throw new Error(`${label} names are required`);
    if (seen.has(name)) throw new Error(`${label} names must be unique within the plan: ${nameOf(item)}`);
    seen.add(name);
  }
}

async function pooled(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function loadPages(get, basePath, field, request, maxPages = 8) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await get(`${basePath}&page=${page}`, request);
    const batch = Array.isArray(data?.[field]) ? data[field] : [];
    rows.push(...batch);
    if (batch.length < 250) break;
  }
  return rows;
}

function tasklistId(task) {
  return String(task?.tasklistId || task?.tasklist?.id || '').trim();
}

function taskMatches(actual, desired, ymd) {
  if (!actual) return false;
  if (desired.description && String(actual.description || '') !== desired.description) return false;
  if (desired.start_date && ymd(actual.startDate) !== ymd(desired.start_date)) return false;
  if (desired.due_date && ymd(actual.dueDate) !== ymd(desired.due_date)) return false;
  if (desired.priority && String(actual.priority || '').toLowerCase() !== desired.priority) return false;
  if (desired.estimate_minutes != null
    && Number(actual.estimateMinutes) !== Number(desired.estimate_minutes)) return false;
  const actualIds = (actual.assignees || []).map(item => String(item.id)).sort();
  const desiredIds = desired.assignee_ids.slice().sort();
  if (actualIds.length !== desiredIds.length
    || actualIds.some((id, index) => id !== desiredIds[index])) return false;
  return true;
}

function planToolSchema() {
  const task = {
    type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' },
      assignee_ids: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      due_date: { type: 'string', description: 'YYYY-MM-DD' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      estimate_minutes: { type: 'integer', minimum: 0, maximum: 100000 },
    }, required: ['name'],
  };
  return { type: 'object', properties: {
    project_id: { type: 'string' },
    milestones: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
      title: { type: 'string' }, deadline: { type: 'string', description: 'YYYY-MM-DD' },
      responsible_person_id: { type: 'string' }, description: { type: 'string' },
    }, required: ['title', 'deadline', 'responsible_person_id'] } },
    tasklists: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' },
      milestone_title: { type: 'string', description: 'Optional exact milestone title from this plan.' },
      tasks: { type: 'array', maxItems: 80, items: task },
    }, required: ['name', 'tasks'] } },
  }, required: ['project_id', 'tasklists'] };
}

function createTeamworkPlanningTools({ send, get, ymd }) {
  if (typeof send !== 'function' || typeof get !== 'function' || typeof ymd !== 'function') {
    throw new Error('Teamwork planning tools require send, get, and ymd functions');
  }
  return [
    {
      definition: {
        name: 'teamwork_create_project',
        description: 'Create a Teamwork project only when the requester explicitly asks for a new project. Do not use this when an existing project should be updated. Resolve the client company id first when the project must be attached to a company.',
        input_schema: { type: 'object', properties: {
          name: { type: 'string', description: 'Project name.' },
          description: { type: 'string', description: 'Optional project objective or scope.' },
          company_id: { type: 'string', description: 'Optional Teamwork company id.' },
        }, required: ['name'] },
      },
      execute: async ({ name, description, company_id }) => {
        const project = { name: required(name, 'name') };
        if (description) project.description = String(description).trim();
        if (company_id) project['company-id'] = String(company_id).trim();
        const created = await send('post', '/projects.json', { project });
        const projectId = String(created?.id || '').trim();
        if (!projectId) return { error: 'Teamwork accepted the request without returning a project id.' };
        const readback = await get(`/projects/api/v3/projects/${encodeURIComponent(projectId)}.json?include=companies`);
        const verified = String(readback?.project?.id || readback?.projects?.[0]?.id || '') === projectId;
        return { ok: verified, verified, project_id: projectId,
          project: readback?.project || readback?.projects?.[0] || null,
          ...(!verified ? { error: 'Project creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'teamwork_create_tasklist',
        description: 'Create a task list inside an existing Teamwork project when the requester explicitly asks to add a phase, workstream, or task grouping. Resolve the project id first.',
        input_schema: { type: 'object', properties: {
          project_id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          milestone_id: { type: 'string', description: 'Optional milestone to associate with the list.' },
        }, required: ['project_id', 'name'] },
      },
      execute: async ({ project_id, name, description, milestone_id }) => {
        const projectId = required(project_id, 'project_id');
        const list = { name: required(name, 'name') };
        if (description) list.description = String(description).trim();
        if (milestone_id) list['milestone-id'] = String(milestone_id).trim();
        const created = await send('post', `/projects/${encodeURIComponent(projectId)}/tasklists.json`,
          { 'todo-list': list });
        const tasklistId = String(created?.TASKLISTID || created?.id || '').trim();
        if (!tasklistId) return { error: 'Teamwork accepted the request without returning a task-list id.' };
        const readback = await get(`/tasklists/${encodeURIComponent(tasklistId)}.json`);
        const actual = readback?.['todo-list'] || readback?.tasklist || null;
        const verified = String(actual?.id || '') === tasklistId;
        return { ok: verified, verified, tasklist_id: tasklistId, tasklist: actual,
          ...(!verified ? { error: 'Task-list creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'teamwork_create_milestone',
        description: 'Create a dated milestone in an existing Teamwork project only when explicitly requested. Resolve both the project id and responsible person id first.',
        input_schema: { type: 'object', properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          deadline: { type: 'string', description: 'Milestone deadline in YYYY-MM-DD format.' },
          responsible_person_id: { type: 'string', description: 'Teamwork person id responsible for the milestone.' },
          description: { type: 'string' },
        }, required: ['project_id', 'title', 'deadline', 'responsible_person_id'] },
      },
      execute: async ({ project_id, title, deadline, responsible_person_id, description }) => {
        const projectId = required(project_id, 'project_id');
        const milestone = {
          title: required(title, 'title'),
          deadline: ymd(required(deadline, 'deadline')),
          'responsible-party-ids': required(responsible_person_id, 'responsible_person_id'),
        };
        if (description) milestone.description = String(description).trim();
        if (!/^\d{8}$/.test(milestone.deadline)) throw new Error('deadline must be YYYY-MM-DD');
        const created = await send('post', `/projects/${encodeURIComponent(projectId)}/milestones.json`,
          { milestone });
        const milestoneId = String(created?.milestoneid || created?.id || '').trim();
        if (!milestoneId) return { error: 'Teamwork accepted the request without returning a milestone id.' };
        const readback = await get(`/projects/api/v3/milestones.json?ids=${encodeURIComponent(milestoneId)}&pageSize=1`);
        const actual = (readback?.milestones || []).find(item => String(item.id) === milestoneId) || null;
        const verified = Boolean(actual);
        return { ok: verified, verified, milestone_id: milestoneId, milestone: actual,
          ...(!verified ? { error: 'Milestone creation could not be verified by readback.' } : {}) };
      },
    },
    {
      definition: {
        name: 'teamwork_apply_project_plan',
        description: 'Apply an entire approved project plan to one existing Teamwork project in a single call. Creates missing milestones, task lists, and up to 80 scheduled tasks with assignments, dates, priority, and estimates. It first reads the project, skips exact existing records, never deletes or overwrites, rereads provider state, and reports any drift or partial failure. Use only after the requester clearly approves creating the plan. Resolve project and person ids before calling it.',
        input_schema: planToolSchema(),
      },
      execute: async ({ project_id, milestones = [], tasklists = [] }, request = {}) => {
        const projectId = required(project_id, 'project_id');
        if (!Array.isArray(milestones) || milestones.length > 12) {
          throw new Error('milestones must contain at most 12 items');
        }
        if (!Array.isArray(tasklists) || !tasklists.length || tasklists.length > 20) {
          throw new Error('tasklists must contain between 1 and 20 items');
        }
        uniqueByName(milestones, 'milestone', item => item.title);
        uniqueByName(tasklists, 'task-list', item => item.name);
        const normalizedMilestones = milestones.map(item => ({
          title: required(item.title, 'milestone title'),
          deadline: projectDate(item.deadline, `milestone ${item.title} deadline`, ymd),
          responsible_person_id: required(item.responsible_person_id, `milestone ${item.title} responsible_person_id`),
          description: item.description ? String(item.description).trim() : '',
        }));
        let taskCount = 0;
        const normalizedLists = tasklists.map(list => {
          if (!Array.isArray(list.tasks)) throw new Error(`tasks for ${list.name} must be an array`);
          uniqueByName(list.tasks, `task in ${list.name}`, item => item.name);
          taskCount += list.tasks.length;
          return {
            name: required(list.name, 'task-list name'),
            description: list.description ? String(list.description).trim() : '',
            milestone_title: list.milestone_title ? required(list.milestone_title, 'milestone_title') : '',
            tasks: list.tasks.map(task => {
              const startDate = projectDate(task.start_date, `${task.name} start_date`, ymd);
              const dueDate = projectDate(task.due_date, `${task.name} due_date`, ymd);
              if (startDate && dueDate && startDate > dueDate) {
                throw new Error(`${task.name} start_date must not be after due_date`);
              }
              const assigneeIds = task.assignee_ids == null ? [] : task.assignee_ids;
              if (!Array.isArray(assigneeIds) || assigneeIds.length > 20) {
                throw new Error(`${task.name} assignee_ids must contain at most 20 ids`);
              }
              const estimate = task.estimate_minutes == null ? null : Number(task.estimate_minutes);
              if (estimate != null && (!Number.isInteger(estimate) || estimate < 0 || estimate > 100000)) {
                throw new Error(`${task.name} estimate_minutes must be an integer from 0 to 100000`);
              }
              const priority = task.priority ? String(task.priority).toLowerCase() : '';
              if (priority && !['low', 'medium', 'high'].includes(priority)) {
                throw new Error(`${task.name} priority is invalid`);
              }
              return { name: required(task.name, 'task name'),
                description: task.description ? String(task.description) : '',
                assignee_ids: [...new Set(assigneeIds.map(id => required(id, `${task.name} assignee id`)))],
                start_date: startDate, due_date: dueDate, priority,
                estimate_minutes: estimate };
            }),
          };
        });
        if (taskCount > 80) throw new Error('a project plan may contain at most 80 tasks total');
        const knownMilestones = new Set(normalizedMilestones.map(item => normalizedName(item.title)));
        for (const list of normalizedLists) {
          if (list.milestone_title && !knownMilestones.has(normalizedName(list.milestone_title))) {
            throw new Error(`task list ${list.name} references a milestone not present in this plan: ${list.milestone_title}`);
          }
        }

        await get(`/projects/api/v3/projects/${encodeURIComponent(projectId)}.json`, request);
        const failures = [];
        const created = { milestones: [], tasklists: [], tasks: [] };
        const skipped = { milestones: [], tasklists: [], tasks: [] };

        const readMilestones = () => loadPages(get,
          `/projects/api/v3/milestones.json?projectIds=${encodeURIComponent(projectId)}&pageSize=250`,
          'milestones', request);
        const readTasklists = () => loadPages(get,
          `/projects/api/v3/tasklists.json?projectIds=${encodeURIComponent(projectId)}&pageSize=250`,
          'tasklists', request);
        const readTasks = () => loadPages(get,
          `/projects/api/v3/tasks.json?projectIds=${encodeURIComponent(projectId)}&pageSize=250&include=tasklists`,
          'tasks', request);

        let providerMilestones = await readMilestones();
        let milestoneByName = new Map(providerMilestones.map(item => [normalizedName(item.name || item.title), item]));
        const missingMilestones = normalizedMilestones.filter(item => {
          const actual = milestoneByName.get(normalizedName(item.title));
          if (!actual) return true;
          if (ymd(actual.deadline) === ymd(item.deadline)) skipped.milestones.push(item.title);
          else failures.push({ type: 'milestone_drift', name: item.title,
            detail: `existing deadline ${actual.deadline || 'none'} does not match ${item.deadline}` });
          return false;
        });
        const milestoneWrites = await pooled(missingMilestones, 4, async item => send('post',
          `/projects/${encodeURIComponent(projectId)}/milestones.json`, { milestone: {
            title: item.title, deadline: ymd(item.deadline),
            'responsible-party-ids': item.responsible_person_id,
            ...(item.description ? { description: item.description } : {}),
          } }, request));
        milestoneWrites.forEach((result, index) => {
          if (!result.ok) failures.push({ type: 'milestone_create_failed',
            name: missingMilestones[index].title, detail: String(result.error?.message || result.error) });
        });
        providerMilestones = await readMilestones();
        milestoneByName = new Map(providerMilestones.map(item => [normalizedName(item.name || item.title), item]));
        for (const item of missingMilestones) {
          const actual = milestoneByName.get(normalizedName(item.title));
          if (actual && ymd(actual.deadline) === ymd(item.deadline)) created.milestones.push(item.title);
          else if (!failures.some(failure => failure.name === item.title)) failures.push({
            type: 'milestone_not_verified', name: item.title, detail: 'provider readback did not match' });
        }

        let providerLists = await readTasklists();
        let listByName = new Map(providerLists.map(item => [normalizedName(item.name), item]));
        const missingLists = normalizedLists.filter(item => {
          const actual = listByName.get(normalizedName(item.name));
          if (!actual) return true;
          const expectedMilestone = item.milestone_title
            ? milestoneByName.get(normalizedName(item.milestone_title)) : null;
          const actualMilestoneId = String(actual.milestoneId || actual.milestone?.id || '');
          if (expectedMilestone && actualMilestoneId !== String(expectedMilestone.id)) {
            failures.push({ type: 'tasklist_drift', name: item.name,
              detail: `existing task list is not associated with milestone ${item.milestone_title}` });
          } else skipped.tasklists.push(item.name);
          return false;
        });
        const listWrites = await pooled(missingLists, 4, async item => {
          const milestone = item.milestone_title
            ? milestoneByName.get(normalizedName(item.milestone_title)) : null;
          if (item.milestone_title && !milestone) throw new Error(`milestone ${item.milestone_title} was not verified`);
          return send('post', `/projects/${encodeURIComponent(projectId)}/tasklists.json`, {
            'todo-list': { name: item.name,
              ...(item.description ? { description: item.description } : {}),
              ...(milestone?.id ? { 'milestone-id': String(milestone.id) } : {}) },
          }, request);
        });
        listWrites.forEach((result, index) => {
          if (!result.ok) failures.push({ type: 'tasklist_create_failed',
            name: missingLists[index].name, detail: String(result.error?.message || result.error) });
        });
        providerLists = await readTasklists();
        listByName = new Map(providerLists.map(item => [normalizedName(item.name), item]));
        for (const item of missingLists) {
          if (listByName.has(normalizedName(item.name))) created.tasklists.push(item.name);
          else if (!failures.some(failure => failure.name === item.name)) failures.push({
            type: 'tasklist_not_verified', name: item.name, detail: 'provider readback did not find it' });
        }

        let providerTasks = await readTasks();
        let taskByListAndName = new Map(providerTasks.map(item => [
          `${tasklistId(item)}:${normalizedName(item.name)}`, item,
        ]));
        const desiredTasks = normalizedLists.flatMap(list => {
          const providerList = listByName.get(normalizedName(list.name));
          if (!providerList) {
            failures.push({ type: 'tasklist_unavailable', name: list.name,
              detail: 'tasks were not started because the task list is unavailable' });
            return [];
          }
          return list.tasks.map(task => ({ ...task, tasklist_id: String(providerList.id),
            tasklist_name: list.name }));
        });
        const missingTasks = desiredTasks.filter(item => {
          const actual = taskByListAndName.get(`${item.tasklist_id}:${normalizedName(item.name)}`);
          if (!actual) return true;
          if (taskMatches(actual, item, ymd)) skipped.tasks.push(`${item.tasklist_name}: ${item.name}`);
          else failures.push({ type: 'task_drift', name: `${item.tasklist_name}: ${item.name}`,
            detail: 'an existing same-name task has different schedule, assignment, priority, or estimate' });
          return false;
        });
        const taskWrites = await pooled(missingTasks, 8, async item => send('post',
          `/projects/api/v3/tasklists/${encodeURIComponent(item.tasklist_id)}/tasks.json`, {
            task: { tasklistId: Number(item.tasklist_id) || item.tasklist_id, name: item.name,
              ...(item.description ? { description: item.description } : {}),
              ...(item.assignee_ids.length ? { assignees: {
                userIds: item.assignee_ids.map(id => Number(id) || id),
              } } : {}),
              ...(item.start_date ? { startAt: item.start_date } : {}),
              ...(item.due_date ? { dueAt: item.due_date } : {}),
              ...(item.priority ? { priority: item.priority } : {}),
              ...(item.estimate_minutes != null ? { estimatedMinutes: item.estimate_minutes } : {}),
            },
          }, request));
        taskWrites.forEach((result, index) => {
          if (!result.ok) failures.push({ type: 'task_create_failed',
            name: `${missingTasks[index].tasklist_name}: ${missingTasks[index].name}`,
            detail: String(result.error?.message || result.error) });
        });
        providerTasks = await readTasks();
        taskByListAndName = new Map(providerTasks.map(item => [
          `${tasklistId(item)}:${normalizedName(item.name)}`, item,
        ]));
        for (const item of missingTasks) {
          const actual = taskByListAndName.get(`${item.tasklist_id}:${normalizedName(item.name)}`);
          const label = `${item.tasklist_name}: ${item.name}`;
          if (taskMatches(actual, item, ymd)) created.tasks.push(label);
          else if (!failures.some(failure => failure.name === label)) failures.push({
            type: 'task_not_verified', name: label, detail: 'provider readback did not match' });
        }

        const createdTotal = Object.values(created).reduce((sum, items) => sum + items.length, 0);
        const skippedTotal = Object.values(skipped).reduce((sum, items) => sum + items.length, 0);
        const result = {
          ok: failures.length === 0,
          verified: failures.length === 0,
          status: failures.length ? (createdTotal ? 'partial' : 'blocked') : 'complete',
          project_id: projectId,
          requested: { milestones: normalizedMilestones.length, tasklists: normalizedLists.length,
            tasks: taskCount },
          created, skipped, failures: failures.slice(0, 50),
        };
        if (!createdTotal && failures.length) {
          result.error = 'No part of the project plan could be verified in Teamwork.';
        }
        return result;
      },
    },
  ];
}

module.exports = { WRITE_TOOL_NAMES, createTeamworkPlanningTools };
