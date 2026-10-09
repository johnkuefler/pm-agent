'use strict';

function requiredDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is required and must be a real YYYY-MM-DD date. Ask the requester; never guess.`);
  }
  return value;
}

function validateTaskSchedule(args) {
  const start_date = requiredDate(args.start_date, 'start_date');
  const due_date = requiredDate(args.due_date, 'due_date');
  if (start_date > due_date) throw new Error('Start date must not be after due date. Ask the requester to clarify.');
  if (!Number.isInteger(args.estimate_minutes) || args.estimate_minutes <= 0 || args.estimate_minutes > 100000) {
    throw new Error('A positive estimate_minutes is required. Ask for the estimate; never invent one.');
  }
  return { start_date, due_date, estimate_minutes: args.estimate_minutes };
}

async function resolveTaskRequester(get, identity, request = {}) {
  if (!identity || identity.isBot || identity.isAppUser || identity.deleted || !identity.fullMember) {
    return { error: 'Cannot verify the requester as an active teammate. Ask who to assign.' };
  }
  const people = [];
  for (let page = 1; page <= 10; page++) {
    const d = await get(`/projects/api/v3/people.json?pageSize=200&page=${page}`, request);
    const batch = d.people || [];
    people.push(...batch.filter(p => !p.deleted && p.type !== 'contact'));
    if (d.meta?.page?.hasMore === false || batch.length < 200) break;
    if (page === 10) return { error: 'People lookup incomplete; ask for the exact Teamwork person.' };
  }
  const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let matches = identity.email ? people.filter(p => normalize(p.email) === normalize(identity.email)) : [];
  if (!matches.length && identity.name) matches = people.filter(p =>
    normalize(`${p.firstName} ${p.lastName}`) === normalize(identity.name));
  return matches.length === 1
    ? { person_id: String(matches[0].id), name: `${matches[0].firstName} ${matches[0].lastName}` }
    : { error: 'Requester identity is ambiguous. Ask which Teamwork person; do not use a fuzzy first-name match.' };
}

function createVerifiedTaskTool({ get, send, baseUrl = () => process.env.TEAMWORK_BASE_URL,
  identity = null, receipt = null, completed = async () => {} }) {
  return {
    definition: {
      name: 'teamwork_create_task',
      description: 'Create one explicitly requested task after resolving its active project and existing task list from live data. Requires an estimate, start date and due date supplied or approved by the requester. Ask one grouped clarification if anything is missing or ambiguous. Omitting assignee_ids assigns to the verified Slack requester. Returns a verified task link after readback. Never retry through another tool if the outcome is uncertain.',
      input_schema: { type: 'object', properties: {
        project_id: { type: 'string' }, tasklist_id: { type: 'string' }, name: { type: 'string' },
        assignee_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        start_date: { type: 'string', description: 'Required YYYY-MM-DD, supplied or confirmed by requester.' },
        due_date: { type: 'string', description: 'Required YYYY-MM-DD, supplied or confirmed by requester.' },
        estimate_minutes: { type: 'integer', minimum: 1, maximum: 100000 },
        description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      }, required: ['project_id', 'tasklist_id', 'name', 'start_date', 'due_date', 'estimate_minutes'] },
    },
    execute: async (args, request = {}) => {
      const schedule = validateTaskSchedule(args);
      const { project_id, tasklist_id } = args;
      if (![project_id, tasklist_id].every(id => /^\d+$/.test(String(id))) || !args.name?.trim()) {
        return { error: 'Resolve a project, task list and task title before creating.' };
      }
      let assigneeIds = args.assignee_ids;
      if (!assigneeIds?.length) {
        const person = await resolveTaskRequester(get, identity, request);
        if (person.error) return person;
        assigneeIds = [person.person_id];
      }
      if (!Array.isArray(assigneeIds) || !assigneeIds.every(id => /^\d+$/.test(String(id)))) {
        return { error: 'Valid Teamwork assignee IDs are required.' };
      }
      assigneeIds = [...new Set(assigneeIds.map(String))].sort();
      const desired = { project_id: String(project_id), tasklist_id: String(tasklist_id),
        name: args.name.trim(), assignee_ids: assigneeIds, ...schedule };
      const [projectData, listData] = await Promise.all([
        get(`/projects/api/v3/projects/${project_id}.json`, request),
        get(`/tasklists/${tasklist_id}.json`, request),
      ]);
      const project = projectData.project;
      const list = listData['todo-list'] || listData.tasklist;
      const listProject = list?.['project-id'] || list?.projectId || list?.project?.id;
      if (!project || String(project.id) !== String(project_id) || project.status !== 'active'
        || !list || String(list.id) !== String(tasklist_id) || String(listProject) !== String(project_id)
        || list.completed === true || list.complete === true || list.complete === 'true'
        || ['completed', 'archived', 'deleted'].includes(list.status)) {
        return { error: 'The destination is not a verified active project and open task list. Ask for another destination.' };
      }
      const prior = receipt ? await receipt.claim(desired) : null;
      if (prior?.error) return prior;
      let id = prior?.task_id;
      if (!id) {
        // A durable claim precedes the POST. If it times out, do not create another task on retry.
        const d = await send('post', `/projects/api/v3/tasklists/${tasklist_id}/tasks.json`, {
          task: { tasklistId: Number(tasklist_id), name: desired.name, description: args.description || '',
            startAt: schedule.start_date, dueAt: schedule.due_date, estimatedMinutes: schedule.estimate_minutes,
            assignees: { userIds: assigneeIds.map(Number) }, ...(args.priority ? { priority: args.priority } : {}) },
        }, request);
        id = d.task?.id || d.id || d.taskId;
        if (!id) return { error: 'Task creation outcome is uncertain: no task ID returned. Do not create another task.' };
        if (receipt) await receipt.created(String(id), desired);
      }
      const actual = (await get(`/projects/api/v3/tasks/${id}.json`, request)).task;
      const actualIds = (actual?.assignees || []).filter(a => a.type === 'users' || !a.type).map(a => String(a.id)).sort();
      const verified = actual && String(actual.id) === String(id) && actual.name === desired.name
        && String(actual.tasklist?.id || actual.tasklistId) === String(tasklist_id)
        && actual.startDate?.slice(0, 10) === schedule.start_date && actual.dueDate?.slice(0, 10) === schedule.due_date
        && Number(actual.estimateMinutes) === schedule.estimate_minutes
        && JSON.stringify(actualIds) === JSON.stringify(assigneeIds);
      const url = `${String(baseUrl() || '').replace(/\/$/, '')}/app/tasks/${id}`;
      if (!verified) return { error: 'Task was created but its readback differs from the request. Do not create another task.', task_id: String(id), url };
      await completed();
      return { ok: true, verified: true, task_id: String(id), url, ...desired,
        project: project.name, tasklist: list.name, already_created: Boolean(prior?.task_id) };
    },
  };
}

module.exports = { validateTaskSchedule, resolveTaskRequester, createVerifiedTaskTool };
